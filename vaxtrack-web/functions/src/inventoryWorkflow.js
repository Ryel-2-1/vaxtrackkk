"use strict";

/**
 * Stock addition, delivery failure, return disposition and failed-order
 * requeue — the inventory events around the order lifecycle.
 *
 * Every path here runs on the server, inside a transaction, as an authenticated
 * and role-checked caller. No client writes a stock counter, a reservation, an
 * allocation field or one of these statuses (firestore.rules).
 *
 *   addStockBatchWithAllocation   Admin    new batch + allocation, one transaction
 *   reportDeliveryFailure         Rider    in_transit|delayed → delivery_failed;
 *                                          reserved units → return_pending
 *   confirmReturnDisposition      Admin    return_pending → usable (reallocated)
 *                                          | quarantined | written off
 *   requeueFailedOrder            Dispatcher  delivery_failed → pending_dispatch,
 *                                          back into the allocation queue
 *   getReservationProvenance      Admin    which orders/returns explain a batch's
 *                                          reserved and return-pending figures
 */

const {
  PolicyError,
  validateReason,
  validateDocumentId,
  isoDateOnly,
  manilaDateString,
  readStockInteger,
  readReservedQuantity,
  readSellingPriceCentavos,
  MAX_STOCK_QUANTITY,
} = require("./policy");
const {
  ALLOCATION_VERSION_BACKORDER,
  allocateInTransaction,
  allocateProduct,
  allocateProducts,
  allocatableUnits,
  isAllocatableOrder,
  nextAllocationStep,
  summarizeAllocation,
  unitsByBatch,
} = require("./allocation");
const { statusUpdatedByEmailValue } = require("./attribution");
const { settleFailureReturn } = require("./failureReturn");

const ORDERS = "orders";
const INVENTORY = "inventory";
const VACCINES = "vaccines";
const RESERVATIONS = "inventoryReservations";
const RETURNS = "inventoryReturns";
const USERS = "users";

const RIDER_FAILABLE_FROM = Object.freeze(["in_transit", "delayed"]);
const RETURN_DISPOSITIONS = Object.freeze(["usable", "damaged", "temperature_excursion", "missing"]);
const MAX_FUTURE_ARRIVAL_DAYS = 30;
const MAX_NOTES_LENGTH = 500;

async function loadApproved(db, uid, role) {
  const snap = await db.collection(USERS).doc(uid).get();
  const user = snap.exists ? snap.data() : null;
  if (!user) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (user.role !== role) throw new PolicyError("wrong-role", "Your account cannot perform this action.");
  if (user.status !== "approved") throw new PolicyError("not-approved", "Your account is not approved.");
  return user;
}

function validateOrderId(orderId) {
  return validateDocumentId(orderId, "That order could not be identified.");
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The status Add Stock assigns from expiry (same thresholds as the page). */
function statusFromExpiry(expiryIso, todayIso) {
  const days = Math.round((Date.parse(`${expiryIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
  if (days <= 30) return "Critical";
  if (days <= 90) return "Warning";
  return "Stable";
}

/** Server-side Add Stock validation; mirrors src/services/stockBatchDates.js. */
function validateStockBatchPayload(payload, now) {
  const allowed = ["vaccineId", "batchId", "manufacturingDate", "arrivalDate", "expiryDate", "quantity", "sellingPriceCentavos", "manufacturer"];
  for (const key of Object.keys(payload ?? {})) {
    if (!allowed.includes(key)) throw new PolicyError("unknown-field", `Unexpected field: ${key}.`);
  }
  const fail = (code, message) => {
    throw new PolicyError(code, message);
  };
  const vaccineId = validateDocumentId(payload?.vaccineId, "Choose a vaccine for this batch.");
  const batchId = typeof payload?.batchId === "string" ? payload.batchId.trim().toUpperCase() : "";
  if (batchId.length < 2 || batchId.length > 64) fail("invalid-stock-batch", "Enter a batch ID.");
  const today = manilaDateString(now);
  const mfg = isoDateOnly(payload?.manufacturingDate);
  const arrival = isoDateOnly(payload?.arrivalDate);
  const expiry = isoDateOnly(payload?.expiryDate);
  if (!mfg) fail("invalid-stock-batch", "Enter a valid manufacturing date.");
  if (mfg > today) fail("invalid-stock-batch", "Manufacturing date cannot be in the future.");
  if (!arrival) fail("invalid-stock-batch", "Arrival date is invalid.");
  if (!expiry) fail("invalid-stock-batch", "Expiry date is invalid.");
  if (mfg > arrival) fail("invalid-stock-batch", "Manufacturing date cannot be after the arrival date.");
  if (mfg >= expiry) fail("invalid-stock-batch", "Manufacturing date must be before the expiry date.");
  if (arrival > addDaysIso(today, MAX_FUTURE_ARRIVAL_DAYS)) fail("invalid-stock-batch", "Arrival date cannot be more than 30 days in the future.");
  if (expiry <= arrival) fail("invalid-stock-batch", "Expiry date must be after the arrival date.");
  if (expiry <= today) fail("invalid-stock-batch", "Expired stock cannot be added to inventory.");
  const quantity = payload?.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_STOCK_QUANTITY) {
    fail("invalid-stock-batch", "Quantity must be a whole number of at least 1.");
  }
  const price = readSellingPriceCentavos(payload?.sellingPriceCentavos);
  if (!price.ok) fail("invalid-stock-batch", "A stock batch needs a selling price in whole centavos.");
  const manufacturer =
    typeof payload?.manufacturer === "string" ? payload.manufacturer.trim().slice(0, 120) : "";
  return {
    vaccineId,
    batchId,
    manufacturingDate: mfg,
    arrivalDate: arrival,
    expiryDate: expiry,
    quantity,
    sellingPriceCentavos: price.value,
    manufacturer,
    status: statusFromExpiry(expiry, today),
  };
}

// ---------------------------------------------------------------- add stock

/**
 * Add a batch and, in the SAME transaction, allocate it to waiting orders by
 * priority (FEFO among the product's batches). Remaining demand beyond one
 * bounded round is filled by follow-up rounds. Reports what happened.
 */
async function addStockBatchWithAllocation({ db, FieldValue, uid, payload, now }) {
  await loadApproved(db, uid, "admin");
  const input = validateStockBatchPayload(payload, now);
  const batchRef = db.collection(INVENTORY).doc();

  const first = await db.runTransaction(async (tx) => {
    const dupe = await tx.get(db.collection(INVENTORY).where("batchId", "==", input.batchId).limit(1));
    if (!dupe.empty) throw new PolicyError("batch-id-exists", "That batch ID already exists.");
    const vaccineSnap = await tx.get(db.collection(VACCINES).doc(input.vaccineId));
    if (!vaccineSnap.exists) throw new PolicyError("vaccine-not-found", "That vaccine no longer exists.");
    const vaccine = vaccineSnap.data();

    const batchData = {
      // Identity and description come from the catalog document, never the caller.
      vaccineId: input.vaccineId,
      vaccineName: typeof vaccine.vaccineName === "string" ? vaccine.vaccineName : "",
      vaccineType: typeof vaccine.vaccineType === "string" ? vaccine.vaccineType : "",
      manufacturer: input.manufacturer || (typeof vaccine.manufacturer === "string" ? vaccine.manufacturer : ""),
      internalSku: typeof vaccine.internalSku === "string" ? vaccine.internalSku : "",
      batchId: input.batchId,
      manufacturingDate: input.manufacturingDate,
      arrivalDate: input.arrivalDate,
      expiryDate: input.expiryDate,
      quantity: input.quantity,
      reservedQuantity: 0,
      returnPendingQuantity: 0,
      quarantinedQuantity: 0,
      sellingPriceCentavos: input.sellingPriceCentavos,
      priceCurrency: "PHP",
      priceIsVatInclusive: false,
      status: input.status,
    };

    const r = await allocateInTransaction(tx, {
      db,
      FieldValue,
      productKey: input.vaccineId,
      now,
      extraBatches: [{ id: batchRef.id, data: batchData }],
    });
    const reservedFromNew = r.extraReserved.get(batchRef.id) ?? 0;
    tx.set(batchRef, {
      ...batchData,
      reservedQuantity: reservedFromNew,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { r, reservedFromNew };
  });

  const allocations = first.r.orderUpdates.map((u) => ({
    orderId: u.orderId,
    orderNumber: u.orderNumber,
    units: u.units,
    allocationState: u.allocationState,
  }));
  let reservedFromNew = first.reservedFromNew;
  // The same continuation rule as every other run: keep going (bounded) while
  // stock and eligible demand may both remain beyond the first pages.
  const step = nextAllocationStep(first.r, {});
  if (!step.done) {
    const more = await allocateProduct({
      db,
      FieldValue,
      productKey: input.vaccineId,
      now,
      cursors: { batchCursor: step.batchCursor, orderCursor: step.orderCursor },
    });
    allocations.push(...more.allocations);
    const snap = await batchRef.get();
    reservedFromNew = readReservedQuantity(snap.data().reservedQuantity).value;
  }
  return {
    inventoryId: batchRef.id,
    batchId: input.batchId,
    status: input.status,
    added: input.quantity,
    allocatedToOrders: reservedFromNew,
    leftAvailable: input.quantity - reservedFromNew,
    allocations,
  };
}

// ---------------------------------------------------------------- failure

/**
 * The rider reports that a delivery failed. The order parks in delivery_failed
 * and its reserved units move — exact batch and quantity — to return_pending:
 * no longer reserved, NOT available, waiting for an admin to confirm their
 * physical condition. One inventoryReturns document records the event.
 */
async function reportDeliveryFailure({ db, FieldValue, uid, email = null, payload }) {
  await loadApproved(db, uid, "rider");
  const orderId = validateOrderId(payload?.orderId);
  const reason = validateReason(payload?.reason, "reason this delivery failed");
  const orderRef = db.collection(ORDERS).doc(orderId);
  const reservationRef = db.collection(RESERVATIONS).doc(orderId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new PolicyError("order-not-found", "That delivery no longer exists.");
    const order = orderSnap.data();
    if (order.assignedRiderId !== uid) {
      throw new PolicyError("not-assigned-rider", "This delivery is not assigned to you.");
    }
    // Idempotent replay: already failed by this rider in this cycle.
    if (order.status === "delivery_failed" && order.deliveryFailedByUid === uid) {
      return { orderId, status: "delivery_failed", replayed: true, returnId: order.pendingReturnId ?? null };
    }
    if (!RIDER_FAILABLE_FROM.includes(order.status)) {
      throw new PolicyError("invalid-status-transition", "This delivery cannot be reported as failed from its current status.");
    }

    const reservationSnap = await tx.get(reservationRef);
    const settlement = await settleFailureReturn(tx, {
      db,
      FieldValue,
      orderId,
      order,
      reservationRef,
      reservation: reservationSnap.exists ? reservationSnap.data() : null,
      reason,
      reportedByUid: uid,
    });

    tx.update(orderRef, {
      status: "delivery_failed",
      deliveryFailureReason: reason,
      deliveryFailedAt: FieldValue.serverTimestamp(),
      deliveryFailedByUid: uid,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
      updatedAt: FieldValue.serverTimestamp(),
      ...settlement.orderFields,
    });
    return {
      orderId,
      status: "delivery_failed",
      replayed: false,
      returnId: settlement.returnId,
      returned: settlement.returnItems,
    };
  });
}

// ---------------------------------------------------------------- disposition

/**
 * An admin records what physically came back. usable → available again and
 * immediately reallocated; damaged / temperature_excursion → quarantined
 * (still on hand, never allocated); missing → written off (on hand reduced).
 */
async function confirmReturnDisposition({ db, FieldValue, uid, payload, now }) {
  await loadApproved(db, uid, "admin");
  const returnId = validateDocumentId(payload?.returnId, "That return could not be identified.");
  const disposition = payload?.disposition;
  if (!RETURN_DISPOSITIONS.includes(disposition)) {
    throw new PolicyError("invalid-disposition", "Choose returned and usable, damaged, temperature excursion or missing.");
  }
  let notes = null;
  if (payload?.notes !== undefined && payload?.notes !== null && String(payload.notes).trim() !== "") {
    if (typeof payload.notes !== "string" || payload.notes.trim().length > MAX_NOTES_LENGTH) {
      throw new PolicyError("invalid-notes", "Notes must be text of at most 500 characters.");
    }
    notes = payload.notes.trim();
  }
  const returnRef = db.collection(RETURNS).doc(returnId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(returnRef);
    if (!snap.exists) throw new PolicyError("return-not-found", "That return no longer exists.");
    const ret = snap.data();
    if (ret.status === "resolved") {
      if (ret.disposition === disposition) {
        return { returnId, disposition, replayed: true, productKeys: [] };
      }
      throw new PolicyError("return-already-resolved", "This return was already resolved with a different disposition.");
    }
    const perBatch = [...unitsByBatch(ret.items)];
    const refs = perBatch.map(([id]) => db.collection(INVENTORY).doc(id));
    const snaps = [];
    for (const ref of refs) snaps.push(await tx.get(ref));
    perBatch.forEach(([inventoryId, quantity], i) => {
      const data = snaps[i].exists ? snaps[i].data() : null;
      if (!data) throw new PolicyError("inventory-not-found", "A batch on this return no longer exists.", { inventoryId });
      const returning = readReservedQuantity(data.returnPendingQuantity);
      if (!returning.ok || returning.value < quantity) {
        throw new PolicyError("inventory-invariant-broken", "This batch's return-pending figure does not cover the return and needs review.", { inventoryId });
      }
      const update = { returnPendingQuantity: returning.value - quantity, updatedAt: FieldValue.serverTimestamp() };
      if (disposition === "damaged" || disposition === "temperature_excursion") {
        const q = readReservedQuantity(data.quarantinedQuantity);
        if (!q.ok) throw new PolicyError("inventory-invariant-broken", "This batch's quarantine figure is not valid.", { inventoryId });
        update.quarantinedQuantity = q.value + quantity;
      } else if (disposition === "missing") {
        const onHand = readStockInteger(data.quantity);
        if (!onHand.ok || onHand.value < quantity) {
          throw new PolicyError("inventory-invariant-broken", "This batch's stock does not cover the write-off.", { inventoryId });
        }
        update.quantity = onHand.value - quantity;
        const w = readReservedQuantity(data.writtenOffQuantity);
        update.writtenOffQuantity = (w.ok ? w.value : 0) + quantity;
      }
      tx.update(refs[i], update);
    });
    tx.update(returnRef, {
      status: "resolved",
      disposition,
      notes,
      resolvedByUid: uid,
      resolvedAt: FieldValue.serverTimestamp(),
    });
    if (typeof ret.orderId === "string" && ret.orderId) {
      tx.update(db.collection(ORDERS).doc(ret.orderId), {
        returnDisposition: disposition,
        returnResolvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return {
      returnId,
      disposition,
      replayed: false,
      productKeys: disposition === "usable" ? (ret.productKeys ?? []) : [],
    };
  });

  let reallocated = [];
  if (result.productKeys.length > 0) {
    const runs = await allocateProducts({ db, FieldValue, productKeys: result.productKeys, now });
    reallocated = runs.flatMap((r) => r.allocations);
  }
  const { productKeys, ...rest } = result;
  void productKeys;
  return { ...rest, reallocated };
}

// ---------------------------------------------------------------- requeue

/**
 * A dispatcher sends a failed delivery back to the dispatch queue. The failure
 * record stays. A backorder-aware order rejoins allocation with nothing
 * reserved (its old units are in return_pending) and becomes assignable only
 * once it is fully reserved again. A version-1 order that still holds its
 * full reservation (failed before this workflow existed) keeps it.
 */
async function requeueFailedOrder({ db, FieldValue, uid, email = null, payload, now }) {
  await loadApproved(db, uid, "dispatcher");
  const orderId = validateOrderId(payload?.orderId);
  const orderRef = db.collection(ORDERS).doc(orderId);
  const reservationRef = db.collection(RESERVATIONS).doc(orderId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
    const order = snap.data();
    if (order.status === "pending_dispatch" && order.requeuedByUid) {
      return { orderId, status: "pending_dispatch", replayed: true, productKeys: [] };
    }
    if (order.status !== "delivery_failed") {
      throw new PolicyError("order-not-failed", "Only a failed delivery can be returned to the dispatch queue.");
    }
    const resSnap = await tx.get(reservationRef);
    const reservation = resSnap.exists ? resSnap.data() : null;
    // An order placed before future-order allocation (version 1) cannot be
    // re-reserved: once its stock has gone to return-pending, sending it back
    // into dispatch would put an order on the road with nothing reserved for
    // it, and it could never be delivered. Cancel it and place a new order.
    if (order.allocationVersion === 1 && reservation?.status === "returned") {
      throw new PolicyError(
        "legacy-order-not-requeueable",
        "This order predates future-order allocation and its stock has been returned. Cancel it and place a new order."
      );
    }
    // If the failure arrived as a direct write from an older Rider build and
    // the compatibility trigger has not run yet, settle it here first — the
    // fresh reservation below must never overwrite reserved units.
    let settlement = { settled: false, orderFields: {} };
    if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
      settlement = await settleFailureReturn(tx, {
        db,
        FieldValue,
        orderId,
        order,
        reservationRef,
        reservation,
        reason: order.deliveryFailureReason ?? null,
        reportedByUid: order.deliveryFailedByUid ?? null,
      });
    }
    const update = {
      status: "pending_dispatch",
      requeuedAt: FieldValue.serverTimestamp(),
      requeuedByUid: uid,
      previousAssignedRiderId: order.assignedRiderId ?? null,
      assignedRiderId: null,
      assignedRiderName: null,
      assignedRiderPhone: null,
      isLoaded: false,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
      updatedAt: FieldValue.serverTimestamp(),
    };
    let productKeys = [];
    if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
      const items = (Array.isArray(order.items) ? order.items : []).map((l) => ({
        ...l,
        reservedQuantity: 0,
        backorderedQuantity: l.quantity,
      }));
      const summary = summarizeAllocation(items, { open: true });
      Object.assign(update, {
        items,
        allocationOpen: true,
        allocationStatus: "reserved",
        allocationState: summary.allocationState,
        backorderedProductKeys: summary.backorderedProductKeys,
      });
      productKeys = summary.backorderedProductKeys;
      // A fresh, empty active reservation; the returned slices stay on the
      // inventoryReturns record.
      tx.set(reservationRef, {
        orderId,
        allocationVersion: ALLOCATION_VERSION_BACKORDER,
        status: "reserved",
        items: [],
        inventoryIds: [],
        requeuedAt: FieldValue.serverTimestamp(),
        previousReturnId: settlement.settled ? settlement.returnId : reservation?.returnId ?? null,
      }, { merge: false });
      if (settlement.settled) {
        update.failureCount = settlement.orderFields.failureCount;
        update.pendingReturnId = settlement.returnId;
      }
    }
    tx.update(orderRef, update);
    return { orderId, status: "pending_dispatch", replayed: false, productKeys };
  });

  let reallocated = [];
  if (result.productKeys.length > 0) {
    const runs = await allocateProducts({ db, FieldValue, productKeys: result.productKeys, now });
    reallocated = runs.flatMap((r) => r.allocations);
  }
  const orderSnap = await orderRef.get();
  const { productKeys, ...rest } = result;
  void productKeys;
  return { ...rest, reallocated, allocationState: orderSnap.exists ? orderSnap.data().allocationState ?? null : null };
}

// ---------------------------------------------------------------- provenance

/**
 * What explains a batch's figures: every active reservation slice on it (with
 * its order) and every pending return, plus whether they reconcile with the
 * batch's counters. Reads are bounded; version-1 reservations, which predate
 * the `inventoryIds` index, are found through a bounded status query.
 */
async function getReservationProvenance({ db, uid, payload, now }) {
  await loadApproved(db, uid, "admin");
  const inventoryId = validateDocumentId(payload?.inventoryId, "That batch could not be identified.");
  const batchSnap = await db.collection(INVENTORY).doc(inventoryId).get();
  if (!batchSnap.exists) throw new PolicyError("inventory-not-found", "That batch no longer exists.");
  const batch = batchSnap.data();

  const [indexed, legacy, returns] = await Promise.all([
    db.collection(RESERVATIONS).where("inventoryIds", "array-contains", inventoryId).where("status", "==", "reserved").limit(200).get(),
    db.collection(RESERVATIONS).where("status", "==", "reserved").where("allocationVersion", "==", 1).limit(500).get(),
    db.collection(RETURNS).where("inventoryIds", "array-contains", inventoryId).where("status", "==", "pending").limit(200).get(),
  ]);
  const seen = new Set();
  const reservations = [];
  for (const d of [...indexed.docs, ...legacy.docs]) {
    if (seen.has(d.id)) continue;
    const slices = (d.data().items ?? []).filter((s) => s?.inventoryId === inventoryId);
    if (slices.length === 0) continue;
    seen.add(d.id);
    reservations.push({ orderId: d.id, quantity: slices.reduce((s, x) => s + (x.quantity || 0), 0) });
  }
  const orderSnaps = await Promise.all(reservations.map((r) => db.collection(ORDERS).doc(r.orderId).get()));
  const rows = reservations.map((r, i) => {
    const o = orderSnaps[i].exists ? orderSnaps[i].data() : {};
    return {
      orderId: r.orderId,
      orderNumber: o.orderNumber ?? null,
      status: o.status ?? null,
      priority: o.priority ?? null,
      requestedDeliveryDate: o.requestedDeliveryDate ?? null,
      allocationState: o.allocationState ?? (o.allocationVersion === 1 ? "fully_reserved" : null),
      reservedQuantity: r.quantity,
    };
  });
  const returnRows = returns.docs.map((d) => {
    const r = d.data();
    return {
      returnId: d.id,
      orderId: r.orderId ?? null,
      orderNumber: r.orderNumber ?? null,
      quantity: (r.items ?? []).filter((x) => x?.inventoryId === inventoryId).reduce((s, x) => s + (x.quantity || 0), 0),
      failureReason: r.failureReason ?? null,
    };
  });
  const reserved = readReservedQuantity(batch.reservedQuantity);
  const returning = readReservedQuantity(batch.returnPendingQuantity);
  const reservedExplained = rows.reduce((s, r) => s + r.reservedQuantity, 0);
  const returnExplained = returnRows.reduce((s, r) => s + r.quantity, 0);
  return {
    inventoryId,
    batchId: batch.batchId ?? null,
    vaccineName: batch.vaccineName ?? null,
    onHand: readStockInteger(batch.quantity).ok ? batch.quantity : null,
    reservedQuantity: reserved.ok ? reserved.value : null,
    returnPendingQuantity: returning.ok ? returning.value : null,
    quarantinedQuantity: readReservedQuantity(batch.quarantinedQuantity).value,
    available: allocatableUnits(batch, now),
    reservations: rows,
    returns: returnRows,
    reconciled: reserved.ok && returning.ok && reserved.value === reservedExplained && returning.value === returnExplained,
  };
}

// ---------------------------------------------------------------- triggers

/** Products to (re)allocate after an inventory write: only when free stock grew. */
function productKeysForInventoryWrite(before, after, now) {
  if (!after || typeof after.vaccineId !== "string" || !after.vaccineId) return [];
  const was = before && before.vaccineId === after.vaccineId ? allocatableUnits(before, now) : 0;
  return allocatableUnits(after, now) > was ? [after.vaccineId] : [];
}

/** Products to allocate after an order write: only when it newly joined the queue. */
function productKeysForOrderWrite(before, after) {
  if (!isAllocatableOrder(after)) return [];
  if (before && isAllocatableOrder(before)) return [];
  return Array.isArray(after.backorderedProductKeys) ? after.backorderedProductKeys : [];
}

module.exports = {
  RETURN_DISPOSITIONS,
  RIDER_FAILABLE_FROM,
  statusFromExpiry,
  validateStockBatchPayload,
  addStockBatchWithAllocation,
  reportDeliveryFailure,
  confirmReturnDisposition,
  requeueFailedOrder,
  getReservationProvenance,
  productKeysForInventoryWrite,
  productKeysForOrderWrite,
};
