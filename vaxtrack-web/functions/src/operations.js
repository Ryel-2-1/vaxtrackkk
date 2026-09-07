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
  ALLOCATION_VERSION,
  PRICING_VERSION,
  PRICE_CURRENCY,
  PRICE_IS_VAT_INCLUSIVE,
  centavosToPesos,
  sumLineTotalsCentavos,
  PolicyError,
  canonicalRequestFingerprint,
  evaluateBatch,
  isLegacyOrder,
  settleBatch,
  validateCreatePayload,
  validateReason,
  validateRequestId,
  CANCELLABLE_FROM,
  DELIVERABLE_FROM,
} = require("./policy");

const ORDERS = "orders";
const INVENTORY = "inventory";
const RESERVATIONS = "inventoryReservations";
const REQUEST_KEYS = "orderRequestKeys";
const USERS = "users";

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
 * Reads (idempotency key, clinic, every batch) all happen before any write, as
 * Firestore requires. On success the order, the reservation and every
 * `reservedQuantity` increment commit together or not at all — there is no
 * window in which an order exists without its reservation.
 */
async function createOrderWithReservation({ db, FieldValue, uid, payload, now }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "salesrep");

  const requestId = validateRequestId(payload?.requestId);
  const { items } = validateCreatePayload(payload);
  const clinicDocId = payload?.clinicDocId;
  if (typeof clinicDocId !== "string" || clinicDocId.trim() === "" || clinicDocId.includes("/")) {
    throw new PolicyError("invalid-payload", "Select a clinic for this order.");
  }

  const fingerprint = canonicalRequestFingerprint({ uid, clinicDocId, items });

  // Allocated outside the transaction so the id — and therefore the order
  // number derived from it — stays stable across a retry.
  const orderRef = db.collection(ORDERS).doc();
  const orderNumber = `VT-ORD-${now.getTime()}-${orderRef.id.slice(0, 4).toUpperCase()}`;

  const keyRef = db.collection(REQUEST_KEYS).doc(`${uid}__${requestId}`);
  const clinicRef = db.collection("clinics").doc(clinicDocId);

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
      };
    }

    const clinicSnap = await tx.get(clinicRef);
    if (!clinicSnap.exists) {
      throw new PolicyError("clinic-not-found", "That clinic no longer exists.");
    }

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
      });
    });

    const clinic = clinicSnap.data();
    const subtotalCentavos = sumLineTotalsCentavos(evaluated);
    const orderItems = evaluated.map((e) => ({
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
    }));

    // ---- writes ----
    evaluated.forEach((e, index) => {
      tx.update(invRefs[index], { reservedQuantity: e.nextReservedQuantity });
    });

    tx.set(orderRef, {
      orderNumber,
      status: "pending_dispatch",
      clinicDocId,
      clinicName: clinic.name ?? "",
      clinicAddress: clinic.location ?? clinic.address ?? "",
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
      items: orderItems,
      // ---- immutable price snapshot ----
      //
      // What this clinic was quoted, at this instant, in integers. A later
      // price change on the batch does not reach back into a placed order:
      // re-deriving a total from today's catalog would misreport what was
      // actually agreed. The currency and the VAT convention are RECORDED
      // rather than implied, so no future reader has to infer them from the
      // fact that the invoice happens to apply 12%.
      pricingVersion: PRICING_VERSION,
      priceCurrency: PRICE_CURRENCY,
      priceIsVatInclusive: PRICE_IS_VAT_INCLUSIVE,
      subtotalCentavos,
      subtotal: centavosToPesos(subtotalCentavos),
      pricedAt: FieldValue.serverTimestamp(),
      allocationVersion: ALLOCATION_VERSION,
      allocationStatus: "reserved",
      reservedAt: FieldValue.serverTimestamp(),
      reservedByUid: uid,
      assignedRiderId: null,
      assignedRiderName: null,
      createdByRole: "sales_rep",
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection(RESERVATIONS).doc(orderRef.id), {
      orderId: orderRef.id,
      allocationVersion: ALLOCATION_VERSION,
      status: "reserved",
      items: orderItems.map((i) => ({
        inventoryId: i.inventoryId,
        batchId: i.batchId,
        quantity: i.quantity,
      })),
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
    priceIsVatInclusive: order.priceIsVatInclusive ?? PRICE_IS_VAT_INCLUSIVE,
    pricingVersion: PRICING_VERSION,
  };
}

/**
 * Cancel an order and release its reservation exactly once.
 *
 * A legacy order (no allocationVersion) still cancels — its delivery lifecycle
 * is untouched — but moves no stock and gets an explicit reconciliation marker
 * rather than an invented allocation.
 */
async function cancelOrderWithInventoryRelease({ db, FieldValue, uid, orderId, reason }) {
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
      if (!reservation || reservation.status === "released") {
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

    if (!legacy) {
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
      const refs = reservation.items.map((i) => db.collection(INVENTORY).doc(i.inventoryId));
      const snaps = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      reservation.items.forEach((item, index) => {
        settlements.push({
          ref: refs[index],
          update: settleBatch({
            inventoryId: item.inventoryId,
            data: snaps[index].exists ? snaps[index].data() : null,
            quantity: item.quantity,
            mode: "release",
          }),
        });
      });
    }

    // ---- writes ----
    for (const s of settlements) tx.update(s.ref, s.update);

    const orderUpdate = {
      status: "cancelled",
      cancelReason,
      cancelledAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (legacy) {
      // Explicit, non-fabricated: we are recording that this order's stock
      // effect is UNKNOWN, not asserting anything about which batch it used.
      orderUpdate.inventoryReconciliation = "legacy-unallocated";
    } else {
      orderUpdate.allocationStatus = "released";
      orderUpdate.releasedAt = FieldValue.serverTimestamp();
      orderUpdate.releasedByUid = uid;
      tx.update(reservationRef, {
        status: "released",
        settledAt: FieldValue.serverTimestamp(),
        settledByUid: uid,
        settlementType: "cancelled",
      });
    }
    tx.update(orderRef, orderUpdate);

    return { orderId, status: "cancelled", released: !legacy, replayed: false, legacy };
  });
}

/**
 * Complete a delivery and consume its reservation exactly once.
 *
 * Proof of delivery is deliberately NOT required here — that contract is
 * unchanged and stays deferred until the physical-phone checkpoint.
 */
async function markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid, orderId }) {
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
      const refs = reservation.items.map((i) => db.collection(INVENTORY).doc(i.inventoryId));
      const snaps = [];
      for (const ref of refs) snaps.push(await tx.get(ref));
      reservation.items.forEach((item, index) => {
        settlements.push({
          ref: refs[index],
          update: settleBatch({
            inventoryId: item.inventoryId,
            data: snaps[index].exists ? snaps[index].data() : null,
            quantity: item.quantity,
            mode: "consume",
          }),
        });
      });
    }

    // ---- writes ----
    for (const s of settlements) tx.update(s.ref, s.update);

    const orderUpdate = {
      status: "delivered",
      deliveredAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (legacy) {
      orderUpdate.inventoryReconciliation = "legacy-unallocated";
    } else {
      orderUpdate.allocationStatus = "consumed";
      orderUpdate.consumedAt = FieldValue.serverTimestamp();
      orderUpdate.consumedByUid = uid;
      tx.update(reservationRef, {
        status: "consumed",
        settledAt: FieldValue.serverTimestamp(),
        settledByUid: uid,
        settlementType: "delivered",
      });
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
  COLLECTIONS: { ORDERS, INVENTORY, RESERVATIONS, REQUEST_KEYS, USERS },
};
