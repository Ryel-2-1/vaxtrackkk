"use strict";

/**
 * The three inventory-affecting operations, as Admin SDK transactions.
 *
 * `db`, `FieldValue` and `now` are injected so the whole layer runs against the
 * Firestore emulator in tests without the Functions emulator in the way. All
 * authorization decisions are made here from the SERVER-loaded user document —
 * nothing an authorization decision depends on comes from the caller.
 *
 * Firestore retries a transaction callback on contention, so every callback
 * below is pure with respect to state outside it: nothing is mutated in an
 * enclosing scope and every result is returned from the callback.
 */

const {
  DESTINATION_VERSION,
  PRICING_VERSION,
  PRICE_CURRENCY,
  PRICE_IS_VAT_INCLUSIVE,
  centavosToPesos,
  sumLineTotalsCentavos,
  PolicyError,
  buildOrderDestinationSnapshot,
  canonicalRequestFingerprint,
  evaluateBatch,
  isLegacyOrder,
  resolveLineVatClassification,
  territoryOf,
  assertOrderWithinTerritory,
  settleBatch,
  validateCreatePayload,
  validateDocumentId,
  validateReason,
  validateRequestId,
  normalizeRequestedDeliveryDate,
  CANCELLABLE_FROM,
  DELIVERABLE_FROM,
  HOME_ADDRESS_ID,
} = require("./policy");
const { readPriceConvention } = require("./pricingConfig");
const { deliveryEvidenceProblem } = require("./deliveryEvidence");
const { statusUpdatedByEmailValue } = require("./attribution");
const { settleFailureReturn } = require("./failureReturn");
const {
  ALLOCATION_VERSION_BACKORDER,
  allocationPriorityKey,
  initialAllocationLines,
  summarizeAllocation,
  unitsByBatch,
  allocateProducts,
} = require("./allocation");
const {
  OUTBOX,
  buildOrderReceipt,
  orderPlacedEvent,
  initialHistoryMarker,
  cancellationEvent,
  consumptionEvent,
  prepareEvents,
  createPreparedEvents,
  prepareReceipt,
  createPreparedReceipt,
} = require("./orderHistory");
const { materializeInitialHistory } = require("./orderHistoryOutbox");

const ORDERS = "orders";
const INVENTORY = "inventory";
const VACCINES = "vaccines";
const RESERVATIONS = "inventoryReservations";
const REQUEST_KEYS = "orderRequestKeys";
const USERS = "users";
const DOCTORS = "doctors";
const DOCTOR_ADDRESSES = "deliveryAddresses";
const CLINICS = "clinics";
const AREAS = "areas";

/** Role/status gate. Both are read from the server-side user document. */
function requireRole(userData, role) {
  if (!userData) {
    throw new PolicyError("profile-missing", "Your account profile could not be found.");
  }
  const actual = typeof userData.role === "string" ? userData.role.trim().toLowerCase() : "";
  const status = typeof userData.status === "string" ? userData.status.trim().toLowerCase() : "";
  if (actual !== role) {
    throw new PolicyError("wrong-role", "Your account is not allowed to do this.");
  }
  if (status !== "approved") {
    throw new PolicyError("not-approved", "Your account is not approved.");
  }
}

/** Load the caller's own user document. Never trusts a caller-supplied role. */
async function loadUser(db, uid) {
  const snap = await db.collection(USERS).doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Create an order and reserve its stock, atomically.
 *
 * Reads (idempotency key, Doctor, destination, Area, and every batch) all
 * happen before any write, as Firestore requires. On success the order, the reservation and every
 * `reservedQuantity` increment commit together or not at all — there is no
 * window in which an order exists without its reservation.
 */
async function createOrderWithReservation({ db, FieldValue, uid, email = null, payload, now }) {
  const result = await createOrderTransaction({ db, FieldValue, uid, email, payload, now });
  const { productKeys, ...response } = result;
  // Allocation runs AFTER the order commits, per product, in its own bounded
  // transactions — so a new order competes for stock in priority order instead
  // of jumping ahead of waiting higher-priority orders. A failure here leaves a
  // valid, fully-backordered order; the inventory/order triggers retry it.
  let allocationFailed = false;
  if (!response.replayed && Array.isArray(productKeys) && productKeys.length > 0) {
    try {
      await allocateProducts({
        db,
        FieldValue,
        productKeys,
        now,
        source: { operation: "createOrderWithReservation", triggeredBy: { uid, role: "salesrep" } },
      });
    } catch (error) {
      allocationFailed = true;
      console.error("createOrderWithReservation: allocation deferred", { orderId: response.orderId, code: error?.code ?? null });
    }
  }
  // The reservation at confirmation (orderHistoryOutbox.js). Normal path: this
  // call completed the first allocation pass above, so it records the outcome
  // now. If allocation failed, it leaves the marker pending for the trigger,
  // which runs its own pass first. A replay finishes a marker the original
  // call left pending. Either way the outbox marker created with the order
  // guarantees the record; this only makes it immediate.
  if (!allocationFailed) {
    try {
      await materializeInitialHistory({
        db,
        FieldValue,
        orderId: response.orderId,
        now,
        materializedBy: response.replayed ? "createOrderWithReservation:replay" : "createOrderWithReservation",
        allocate: response.replayed === true,
      });
    } catch (error) {
      console.error("createOrderWithReservation: initial history deferred to the outbox trigger", { orderId: response.orderId, code: error?.code ?? null });
    }
  }
  const orderSnap = await db.collection(ORDERS).doc(response.orderId).get();
  return { ...response, allocation: allocationFromOrder(orderSnap.exists ? orderSnap.data() : null) };
}

/**
 * The allocation block a confirmation screen shows: per line, requested /
 * reserved / backordered, and the order's state. Null for an order that does
 * not use backorder-aware allocation.
 */
function allocationFromOrder(order) {
  if (!order || order.allocationVersion !== ALLOCATION_VERSION_BACKORDER) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    allocationState: order.allocationState ?? null,
    lines: items.map((i) => ({
      inventoryId: i.inventoryId ?? null,
      productKey: i.productKey ?? null,
      name: i.name ?? null,
      quantity: i.quantity,
      reservedQuantity: i.reservedQuantity ?? 0,
      backorderedQuantity: i.backorderedQuantity ?? i.quantity,
    })),
  };
}

async function createOrderTransaction({ db, FieldValue, uid, email = null, payload, now }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "salesrep");

  const requestId = validateRequestId(payload?.requestId);
  const { doctorId, doctorAddressId, items } = validateCreatePayload(payload);
  // Required booking date. Validated here (before any read/write) so a missing,
  // invalid or past date fails fast without touching stock or the idempotency
  // record — an undated order could never be dispatched, so it is never made.
  const requestedDeliveryDate = normalizeRequestedDeliveryDate(
    payload?.requestedDeliveryDate,
    now
  );

  const fingerprint = canonicalRequestFingerprint({
    uid,
    doctorId,
    doctorAddressId,
    items,
  });

  // Allocated outside the transaction so the id — and therefore the order
  // number derived from it — stays stable across a retry.
  const orderRef = db.collection(ORDERS).doc();
  const orderNumber = `VT-ORD-${now.getTime()}-${orderRef.id.slice(0, 4).toUpperCase()}`;

  const keyRef = db.collection(REQUEST_KEYS).doc(`${uid}__${requestId}`);
  const doctorRef = db.collection(DOCTORS).doc(doctorId);
  const doctorAddressRef = doctorRef
    .collection(DOCTOR_ADDRESSES)
    .doc(doctorAddressId);

  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const keySnap = await tx.get(keyRef);
    if (keySnap.exists) {
      const prior = keySnap.data();
      if (prior.fingerprint !== fingerprint) {
        throw new PolicyError(
          "idempotency-conflict",
          "This checkout was already submitted with different contents. Start a new order."
        );
      }
      // A retry of the SAME request. Return what the first call committed and
      // write nothing — this is what makes five simultaneous submits one order.
      //
      // The committed order is re-read so a replay reports the SAME
      // server-generated prices as the original call. Without this a retry
      // would hand the confirmation screen nothing to show and it would fall
      // back to the client's own expectation, which is the exact figure the
      // whole boundary exists to stop anyone trusting.
      const priorSnap = await tx.get(db.collection(ORDERS).doc(prior.orderId));
      return {
        orderId: prior.orderId,
        orderNumber: prior.orderNumber,
        replayed: true,
        pricing: pricingFromOrder(priorSnap.exists ? priorSnap.data() : null),
        destination: destinationFromOrder(
          priorSnap.exists ? priorSnap.data() : null
        ),
      };
    }

    const doctorSnap = await tx.get(doctorRef);
    const doctorAddressSnap = await tx.get(doctorAddressRef);
    if (!doctorSnap.exists) {
      throw new PolicyError("doctor-not-found", "That doctor no longer exists.");
    }
    if (!doctorAddressSnap.exists) {
      throw new PolicyError(
        "destination-not-found",
        "That delivery address is no longer linked to this doctor."
      );
    }

    const doctor = doctorSnap.data();
    const relationship = doctorAddressSnap.data();
    let clinic = null;
    let destinationAreaId;

    if (doctorAddressId === HOME_ADDRESS_ID) {
      destinationAreaId = validateDocumentId(
        relationship.areaId,
        "That Home address is not assigned to a valid Area."
      );
    } else {
      const clinicRef = db.collection(CLINICS).doc(doctorAddressId);
      const clinicSnap = await tx.get(clinicRef);
      if (!clinicSnap.exists) {
        throw new PolicyError(
          "clinic-not-found",
          "The selected clinic no longer exists."
        );
      }
      clinic = clinicSnap.data();
      destinationAreaId = validateDocumentId(
        clinic.areaId,
        "That clinic is not assigned to a valid Area."
      );
    }

    const areaSnap = await tx.get(
      db.collection(AREAS).doc(destinationAreaId)
    );
    const destination = buildOrderDestinationSnapshot({
      doctorId,
      doctorAddressId,
      doctor,
      relationship,
      clinic,
      area: areaSnap.exists ? areaSnap.data() : null,
    });

    // ---- territory ----
    // The caller's assignment is re-read INSIDE the transaction, so the one
    // that counts is the one current when this order commits — an Admin who
    // removes a territory mid-checkout wins. The role/status gate repeats on
    // this read for the same reason. Nothing has been written yet, so a
    // refusal here leaves no order, reservation, request key or counter change.
    const callerSnap = await tx.get(db.collection(USERS).doc(uid));
    const caller = callerSnap.exists ? callerSnap.data() : null;
    requireRole(caller, "salesrep");
    const linksSnap = await tx.get(doctorRef.collection(DOCTOR_ADDRESSES));
    assertOrderWithinTerritory({
      territory: territoryOf(caller),
      doctorLinks: linksSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
      destination: {
        type: destination.orderFields.destinationType,
        areaId: destination.orderFields.destinationAreaId,
        clinicDocId: destination.orderFields.clinicDocId,
      },
    });

    const invRefs = items.map((i) => db.collection(INVENTORY).doc(i.inventoryId));
    const invSnaps = [];
    for (const ref of invRefs) {
      invSnaps.push(await tx.get(ref));
    }

    // ---- decide ----
    const evaluated = items.map((line, index) => {
      const snap = invSnaps[index];
      return evaluateBatch({
        // The Firestore DOCUMENT id, taken from the snapshot itself. A stored
        // field named `id` inside the data is never consulted.
        inventoryId: snap.id,
        data: snap.exists ? snap.data() : null,
        requested: line.quantity,
        // Compared against the batch's live price, never used as one. A
        // difference in either direction refuses the checkout.
        expectedUnitPriceCentavos: line.expectedUnitPriceCentavos,
        now,
        // A future order: the batch is the line's quote, not a promise of its
        // shelf. A shortfall is backordered; dispatch waits for full stock.
        allowBackorder: true,
      });
    });

    // ---- VAT classification (per item) ----
    // Each batch resolves to its vaccine product through `vaccineId`, and the
    // product's Admin-set classification is read HERE, inside the transaction.
    // A missing or unclassified product refuses the whole order before any
    // write — no order, reservation, request key or stock change. The caller
    // cannot send a classification at all (validateCreatePayload refuses
    // unknown line keys), so the snapshot is always the product's own value.
    const vaccineSnaps = new Map();
    for (const snap of invSnaps) {
      const vaccineId = snap.exists ? snap.data().vaccineId : null;
      if (typeof vaccineId === "string" && vaccineId && !vaccineId.includes("/") && !vaccineSnaps.has(vaccineId)) {
        vaccineSnaps.set(vaccineId, await tx.get(db.collection(VACCINES).doc(vaccineId)));
      }
    }
    const lineVat = evaluated.map((e, index) => {
      const batch = invSnaps[index].exists ? invSnaps[index].data() : null;
      const vSnap = batch ? vaccineSnaps.get(batch.vaccineId) : null;
      return resolveLineVatClassification({
        inventoryId: e.inventoryId,
        batch,
        vaccine: vSnap && vSnap.exists ? vSnap.data() : null,
      });
    });
    // The canonical SKU is the catalog vaccine's internalSku, snapshotted per
    // line so the receipt and the history keep the identifier the order used.
    const lineSku = invSnaps.map((snap) => {
      const v = snap.exists ? vaccineSnaps.get(snap.data().vaccineId) : null;
      const sku = v && v.exists ? v.data().internalSku : null;
      return typeof sku === "string" && sku.trim() !== "" ? sku.trim() : null;
    });

    const subtotalCentavos = sumLineTotalsCentavos(evaluated);
    const orderItems = evaluated.map((e, index) => ({
      inventoryId: e.inventoryId,
      batchId: e.batchId,
      name: e.name,
      chain: e.chain,
      quantity: e.quantity,
      // Money, read from the batch INSIDE this transaction. The caller supplied
      // no price — only the price it expected, which was checked above — so a
      // reduced, inflated or malformed figure cannot reach this document.
      unitPriceCentavos: e.unitPriceCentavos,
      lineTotalCentavos: e.lineTotalCentavos,
      // Decimal pesos, derived. The invoice module and every invoice already
      // written speak this; centavos above stay the authoritative figure.
      unitPrice: centavosToPesos(e.unitPriceCentavos),
      // Immutable VAT snapshot from the vaccine product at this instant. A
      // later re-classification changes future items only.
      vatClassification: lineVat[index],
      // The product this line is DEMAND for. Allocation reserves any eligible
      // batch of it (FEFO); the quoted batch above only fixes price and VAT.
      productKey: invSnaps[index].data().vaccineId,
      ...(lineSku[index] ? { sku: lineSku[index] } : {}),
    }));
    const allocationLines = initialAllocationLines(orderItems);
    const allocationSummary = summarizeAllocation(allocationLines, { open: true });

    // ---- writes ----
    // No stock counter changes here: the order is written fully backordered and
    // the allocation engine reserves for it — in priority order — right after.

    const orderData = {
      orderNumber,
      status: "pending_dispatch",
      ...destination.orderFields,
      destinationSnapshotAt: FieldValue.serverTimestamp(),
      clinicLocationSnapshotAt: FieldValue.serverTimestamp(),
      quantity: orderItems.reduce((sum, i) => sum + i.quantity, 0),
      unit: "vials",
      vaccineName:
        orderItems.length === 1
          ? orderItems[0].name
          : `${orderItems[0].name} +${orderItems.length - 1} more`,
      vaccineType: orderItems[0].chain ?? "",
      priority: payload?.priority === "Urgent" ? "Urgent" : "Standard",
      deliveryInstructions:
        typeof payload?.deliveryInstructions === "string"
          ? payload.deliveryInstructions.trim().slice(0, 1000)
          : "",
      // Always present on a new order: normalizeRequestedDeliveryDate has
      // already refused a missing or invalid one.
      requestedDeliveryDate,
      items: allocationLines,
      // ---- immutable price snapshot ----
      //
      // What this clinic was quoted, at this instant, in integers. A later
      // price change on the batch does not reach back into a placed order:
      // re-deriving a total from today's catalog would misreport what was
      // actually agreed. The currency and the VAT convention (prices are
      // VAT-inclusive — pricingConfig.js) are RECORDED rather than implied, so
      // no future reader has to infer which convention applied.
      pricingVersion: PRICING_VERSION,
      priceCurrency: PRICE_CURRENCY,
      priceIsVatInclusive: PRICE_IS_VAT_INCLUSIVE,
      subtotalCentavos,
      subtotal: centavosToPesos(subtotalCentavos),
      pricedAt: FieldValue.serverTimestamp(),
      // ---- allocation (backorder-aware; see allocation.js) ----
      allocationVersion: ALLOCATION_VERSION_BACKORDER,
      // The reservation document is active (possibly still empty).
      allocationStatus: "reserved",
      allocationState: allocationSummary.allocationState,
      allocationOpen: true,
      backorderedProductKeys: allocationSummary.backorderedProductKeys,
      allocationCreatedAtMillis: now.getTime(),
      allocationPriorityKey: allocationPriorityKey(
        {
          priority: payload?.priority === "Urgent" ? "Urgent" : "Standard",
          requestedDeliveryDate,
          allocationCreatedAtMillis: now.getTime(),
        },
        orderRef.id
      ),
      reservedAt: FieldValue.serverTimestamp(),
      reservedByUid: uid,
      assignedRiderId: null,
      assignedRiderName: null,
      createdByRole: "sales_rep",
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // ---- history: READ phase (orderHistory.js), still before any write ----
    // The Order Confirmation Receipt — the order exactly as accepted — and the
    // first ledger entry. Both are create-only: an existing identical record is
    // left as it is, a different one aborts this transaction (integrity
    // conflict), and the order cannot commit without them.
    const preparedReceipt = await prepareReceipt(tx, {
      db,
      orderId: orderRef.id,
      receipt: buildOrderReceipt({
        orderId: orderRef.id,
        orderNumber,
        requestId,
        uid,
        user: userData,
        email,
        orderFields: orderData,
        items: orderItems,
        FieldValue,
      }),
    });
    const preparedHistory = await prepareEvents(tx, {
      db,
      events: [orderPlacedEvent({
        orderId: orderRef.id,
        order: orderData,
        actor: { actorUid: uid, actorRole: "salesrep" },
      })],
    });

    // ---- writes (continued) ----
    tx.set(orderRef, orderData);
    createPreparedReceipt(tx, preparedReceipt);
    createPreparedEvents(tx, { FieldValue, prepared: preparedHistory });
    // The initial-allocation outbox marker: the order's first allocation pass
    // runs after this commit, and whoever completes it records the outcome —
    // the callable below, or the materializeOrderHistory trigger if the call
    // stops first (orderHistoryOutbox.js). Never left permanently unrecorded.
    tx.create(
      db.collection(OUTBOX).doc(orderRef.id),
      initialHistoryMarker({
        orderId: orderRef.id,
        orderNumber,
        medRepUid: uid,
        productKeys: allocationSummary.backorderedProductKeys,
        FieldValue,
      })
    );

    // Empty until the allocation engine reserves: one slice per (line, batch).
    tx.set(db.collection(RESERVATIONS).doc(orderRef.id), {
      orderId: orderRef.id,
      allocationVersion: ALLOCATION_VERSION_BACKORDER,
      status: "reserved",
      items: [],
      inventoryIds: [],
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: uid,
    });

    tx.set(keyRef, {
      uid,
      fingerprint,
      orderId: orderRef.id,
      orderNumber,
      createdAt: FieldValue.serverTimestamp(),
    });

    // The prices the SERVER wrote, returned so the confirmation screen shows
    // what was actually recorded rather than what the client asked for. The two
    // agree by construction — a difference would have been refused above — but
    // displaying the server's copy means the screen cannot drift from the
    // document even if that ever stops being true.
    return {
      orderId: orderRef.id,
      orderNumber,
      replayed: false,
      productKeys: allocationSummary.backorderedProductKeys,
      destination: destination.response,
      pricing: {
        items: orderItems.map((i) => ({
          inventoryId: i.inventoryId,
          batchId: i.batchId,
          name: i.name,
          quantity: i.quantity,
          unitPriceCentavos: i.unitPriceCentavos,
          lineTotalCentavos: i.lineTotalCentavos,
        })),
        subtotalCentavos,
        priceCurrency: PRICE_CURRENCY,
        priceIsVatInclusive: PRICE_IS_VAT_INCLUSIVE,
        pricingVersion: PRICING_VERSION,
      },
    };
  });
}

/**
 * The pricing block of an already-committed order, for a replayed create.
 *
 * Returns null rather than a zeroed shape when the order cannot be read: a
 * confirmation screen must show nothing rather than ₱0.00, which would read as
 * a real price.
 */
function pricingFromOrder(order) {
  if (!order || order.pricingVersion !== PRICING_VERSION) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    items: items.map((i) => ({
      inventoryId: i.inventoryId ?? null,
      batchId: i.batchId ?? null,
      name: i.name ?? null,
      quantity: i.quantity,
      unitPriceCentavos: i.unitPriceCentavos,
      lineTotalCentavos: i.lineTotalCentavos,
    })),
    subtotalCentavos: order.subtotalCentavos,
    priceCurrency: order.priceCurrency ?? PRICE_CURRENCY,
    // The order's own recorded convention — a replay never re-labels it.
    priceIsVatInclusive: readPriceConvention(order.priceIsVatInclusive),
    pricingVersion: PRICING_VERSION,
  };
}

/**
 * The destination block of an already-committed order, for an idempotent
 * replay. Returning null for a legacy or unreadable order is deliberate: the
 * client must never invent a destination from its previous selection after the
 * server has reported that an order already exists.
 */
function destinationFromOrder(order) {
  if (!order || order.destinationVersion !== DESTINATION_VERSION) return null;

  return {
    doctorId: order.doctorId ?? null,
    doctorName: order.doctorName ?? null,
    doctorAddressId: order.doctorAddressId ?? null,
    type: order.destinationType ?? null,
    name: order.destinationName ?? null,
    displayName: order.clinicName ?? null,
    address: order.deliveryAddress ?? order.clinicAddress ?? null,
    areaId: order.destinationAreaId ?? null,
    area: order.destinationArea ?? null,
    latitude: order.destinationLat,
    longitude: order.destinationLng,
    geofenceRadiusM: order.destinationGeofenceRadiusM,
    clinicDocId: order.clinicDocId ?? null,
    ...(order.clinicId ? { clinicId: order.clinicId } : {}),
  };
}

/**
 * Cancel an order and release its reservation exactly once.
 *
 * A legacy order (no allocationVersion) still cancels — its delivery lifecycle
 * is untouched — but moves no stock and gets an explicit reconciliation marker
 * rather than an invented allocation.
 */
async function cancelOrderWithInventoryRelease({ db, FieldValue, uid, email = null, orderId, reason, now = new Date() }) {
  const result = await cancelOrderTransaction({ db, FieldValue, uid, email, orderId, reason });
  const { releasedProductKeys = [], ...response } = result;
  // Released stock goes straight to the next waiting order, by priority.
  let reallocated = [];
  if (releasedProductKeys.length > 0) {
    try {
      reallocated = await allocateProducts({
        db,
        FieldValue,
        productKeys: releasedProductKeys,
        now,
        source: { operation: "cancelOrderWithInventoryRelease", triggeredBy: { uid, role: "dispatcher" } },
      });
    } catch (error) {
      console.error("cancelOrderWithInventoryRelease: reallocation deferred", { orderId, code: error?.code ?? null });
    }
  }
  return { ...response, reallocated: reallocated.flatMap((r) => r.allocations) };
}

async function cancelOrderTransaction({ db, FieldValue, uid, email, orderId, reason }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "dispatcher");
  if (typeof orderId !== "string" || orderId.trim() === "" || orderId.includes("/")) {
    throw new PolicyError("invalid-payload", "That order could not be identified.");
  }
  const cancelReason = validateReason(reason, "reason for cancelling");

  const orderRef = db.collection(ORDERS).doc(orderId);
  const reservationRef = db.collection(RESERVATIONS).doc(orderId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new PolicyError("order-not-found", "That order no longer exists.");
    }
    const order = orderSnap.data();
    const reservationSnap = await tx.get(reservationRef);
    const reservation = reservationSnap.exists ? reservationSnap.data() : null;

    // Idempotent replay: already cancelled AND already settled means the first
    // call succeeded. Return it without releasing a second time.
    if (order.status === "cancelled") {
      // `returned`: a failed delivery whose units were already in
      // return-pending when it was cancelled — that cancel moved no stock, so
      // a retry has nothing to do either.
      if (!reservation || reservation.status === "released" || reservation.status === "returned") {
        return { orderId, status: "cancelled", released: false, replayed: true };
      }
      throw new PolicyError(
        "reservation-already-settled",
        "This order is cancelled but its stock was already settled differently."
      );
    }

    if (!CANCELLABLE_FROM.includes(order.status)) {
      throw new PolicyError(
        "invalid-status-transition",
        "This order can no longer be cancelled."
      );
    }

    const legacy = isLegacyOrder(order);
    const settlements = [];
    const releasedProductKeys = new Set();
    // A failed delivery whose units already went to return-pending holds no
    // reservation: cancelling it moves no stock (the return is resolved by an
    // admin disposition, not here).
    let alreadyReturned = !legacy && reservation?.status === "returned";

    // A version-2 failed delivery whose units are STILL reserved (reported by
    // an older Rider build; the compatibility trigger has not settled it yet)
    // goes through the same return-pending settlement as every failure — its
    // units came back unchecked, so they are never released straight to
    // available. Version-1 failed orders keep their original behaviour.
    let failureSettlement = null;
    if (
      !legacy &&
      order.status === "delivery_failed" &&
      order.allocationVersion === ALLOCATION_VERSION_BACKORDER &&
      reservation?.status === "reserved"
    ) {
      failureSettlement = await settleFailureReturn(tx, {
        db,
        FieldValue,
        orderId,
        order,
        reservationRef,
        reservation,
        reason: order.deliveryFailureReason ?? null,
        reportedByUid: order.deliveryFailedByUid ?? null,
        sourceOperation: "cancelOrderWithInventoryRelease",
      });
      alreadyReturned = true;
    }

    if (!legacy && !alreadyReturned) {
      if (!reservation) {
        throw new PolicyError(
          "reservation-not-found",
          "This order's stock reservation is missing and needs admin review."
        );
      }
      if (reservation.status !== "reserved") {
        throw new PolicyError(
          "reservation-already-settled",
          reservation.status === "consumed"
            ? "This order's stock was already consumed by a delivery."
            : "This order's stock was already released."
        );
      }
      // One counter update per batch, however many slices it holds.
      const perBatch = [...unitsByBatch(reservation.items)];
      const refs = perBatch.map(([inventoryId]) => db.collection(INVENTORY).doc(inventoryId));
      const snaps = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      perBatch.forEach(([inventoryId, quantity], index) => {
        const data = snaps[index].exists ? snaps[index].data() : null;
        if (data && typeof data.vaccineId === "string" && data.vaccineId) releasedProductKeys.add(data.vaccineId);
        settlements.push({
          ref: refs[index],
          update: settleBatch({ inventoryId, data, quantity, mode: "release" }),
        });
      });
    }
    // History, READ phase: the release (or withdrawn backorder), create-only.
    // A retried cancel replays above and never reaches this.
    const preparedHistory = !legacy && !alreadyReturned
      ? await prepareEvents(tx, { db, events: [cancellationEvent({ orderId, order, reservationItems: reservation.items, uid })] })
      : [];

    // ---- writes ----
    for (const s of settlements) tx.update(s.ref, s.update);

    const orderUpdate = {
      status: "cancelled",
      cancelReason,
      cancelledAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      // Written with the uid, so Activity never shows the previous writer
      // (see attribution.js).
      statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (legacy) {
      // Explicit, non-fabricated: we are recording that this order's stock
      // effect is UNKNOWN, not asserting anything about which batch it used.
      orderUpdate.inventoryReconciliation = "legacy-unallocated";
    } else if (alreadyReturned) {
      orderUpdate.allocationOpen = false;
      orderUpdate.backorderedProductKeys = [];
      if (failureSettlement?.settled) {
        orderUpdate.failureCount = failureSettlement.orderFields.failureCount;
        orderUpdate.allocationStatus = "returned";
        orderUpdate.pendingReturnId = failureSettlement.returnId;
      }
    } else {
      orderUpdate.allocationStatus = "released";
      orderUpdate.releasedAt = FieldValue.serverTimestamp();
      orderUpdate.releasedByUid = uid;
      if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
        // Out of the queue for good; nothing reserved any more.
        orderUpdate.allocationOpen = false;
        orderUpdate.backorderedProductKeys = [];
        orderUpdate.items = (Array.isArray(order.items) ? order.items : []).map((l) => ({
          ...l,
          reservedQuantity: 0,
          backorderedQuantity: 0,
        }));
      }
      tx.update(reservationRef, {
        status: "released",
        settledAt: FieldValue.serverTimestamp(),
        settledByUid: uid,
        settlementType: "cancelled",
      });
      // Released units (and any backorder no longer awaited), recorded once.
      createPreparedEvents(tx, { FieldValue, prepared: preparedHistory });
    }
    tx.update(orderRef, orderUpdate);

    return {
      orderId,
      status: "cancelled",
      released: !legacy && !alreadyReturned,
      replayed: false,
      legacy,
      releasedProductKeys: [...releasedProductKeys],
    };
  });
}

/**
 * Complete a delivery and consume its reservation exactly once.
 *
 * Proof of delivery is deliberately NOT required here — that contract is
 * unchanged and stays deferred until the physical-phone checkpoint.
 */
async function markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid, email = null, orderId }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "rider");
  if (typeof orderId !== "string" || orderId.trim() === "" || orderId.includes("/")) {
    throw new PolicyError("invalid-payload", "That delivery could not be identified.");
  }

  const orderRef = db.collection(ORDERS).doc(orderId);
  const reservationRef = db.collection(RESERVATIONS).doc(orderId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new PolicyError("order-not-found", "That delivery no longer exists.");
    }
    const order = orderSnap.data();
    // Identity is the Auth uid compared in full against the order's CURRENT
    // assigned rider. No employee id, name or fragment is accepted anywhere.
    if (order.assignedRiderId !== uid) {
      throw new PolicyError("not-assigned-rider", "This delivery is not assigned to you.");
    }

    const reservationSnap = await tx.get(reservationRef);
    const reservation = reservationSnap.exists ? reservationSnap.data() : null;

    if (order.status === "delivered") {
      if (!reservation || reservation.status === "consumed") {
        return { orderId, status: "delivered", consumed: false, replayed: true };
      }
      throw new PolicyError(
        "reservation-already-settled",
        "This delivery is complete but its stock was already settled differently."
      );
    }

    if (!DELIVERABLE_FROM.includes(order.status)) {
      throw new PolicyError(
        "invalid-status-transition",
        "This delivery cannot be completed from its current status."
      );
    }

    // Both evidence photos must be RECORDED on the order (not merely present in
    // Storage) by this rider before the delivery closes. Checked after the
    // already-delivered replay above, so a repeated call stays idempotent.
    const evidence = deliveryEvidenceProblem(order, orderId, uid);
    if (evidence) throw new PolicyError(evidence.code, evidence.message);

    const legacy = isLegacyOrder(order);
    const settlements = [];

    if (!legacy) {
      if (!reservation) {
        throw new PolicyError(
          "reservation-not-found",
          "This delivery's stock reservation is missing and needs admin review."
        );
      }
      if (reservation.status !== "reserved") {
        throw new PolicyError(
          "reservation-already-settled",
          reservation.status === "released"
            ? "This order's stock was already released by a cancellation."
            : "This order's stock was already consumed."
        );
      }
      if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
        // Never deliver what was never fully reserved, and consume exactly the
        // reserved slices — their total must equal what was ordered.
        const requested = (Array.isArray(order.items) ? order.items : []).reduce((s, l) => s + (l.quantity || 0), 0);
        const reservedTotal = [...unitsByBatch(reservation.items).values()].reduce((s, q) => s + q, 0);
        if (order.allocationState !== "fully_reserved" || reservedTotal !== requested) {
          throw new PolicyError(
            "order-not-fully-reserved",
            "This delivery's stock is not fully reserved and needs dispatcher review."
          );
        }
      }
      // One counter update per batch, however many slices it holds.
      const perBatch = [...unitsByBatch(reservation.items)];
      const refs = perBatch.map(([inventoryId]) => db.collection(INVENTORY).doc(inventoryId));
      const snaps = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      perBatch.forEach(([inventoryId, quantity], index) => {
        settlements.push({
          ref: refs[index],
          update: settleBatch({
            inventoryId,
            data: snaps[index].exists ? snaps[index].data() : null,
            quantity,
            mode: "consume",
          }),
        });
      });
    }
    // History, READ phase: the consumption, create-only. A retried completion
    // replays above and never reaches this.
    const preparedHistory = !legacy
      ? await prepareEvents(tx, { db, events: [consumptionEvent({ orderId, order, reservationItems: reservation.items, uid })] })
      : [];

    // ---- writes ----
    for (const s of settlements) tx.update(s.ref, s.update);

    const orderUpdate = {
      status: "delivered",
      deliveredAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      // The status-attribution trio is written TOGETHER. Writing only the uid
      // left the previous writer's email (the dispatcher who dispatched it) on
      // the order, so Admin's Activity panel showed "Updated by <dispatcher>"
      // for a delivery the rider completed. With no email on the rider's
      // token, the stale one is removed rather than left to mislead.
      statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (legacy) {
      orderUpdate.inventoryReconciliation = "legacy-unallocated";
    } else {
      orderUpdate.allocationStatus = "consumed";
      orderUpdate.consumedAt = FieldValue.serverTimestamp();
      orderUpdate.consumedByUid = uid;
      if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
        // Delivered: out of the allocation queue for good.
        orderUpdate.allocationOpen = false;
        orderUpdate.backorderedProductKeys = [];
      }
      tx.update(reservationRef, {
        status: "consumed",
        settledAt: FieldValue.serverTimestamp(),
        settledByUid: uid,
        settlementType: "delivered",
      });
      // Consumption recorded once: a retried completion replays above.
      createPreparedEvents(tx, { FieldValue, prepared: preparedHistory });
    }
    tx.update(orderRef, orderUpdate);

    return { orderId, status: "delivered", consumed: !legacy, replayed: false, legacy };
  });
}

module.exports = {
  createOrderWithReservation,
  cancelOrderWithInventoryRelease,
  markOrderDeliveredWithInventoryConsumption,
  requireRole,
  loadUser,
  // The creation transaction alone — exactly what is committed if the callable
  // stops right after it. Exported for the failure-injection tests.
  createOrderTransaction,
  COLLECTIONS: { ORDERS, INVENTORY, RESERVATIONS, REQUEST_KEYS, USERS },
};
