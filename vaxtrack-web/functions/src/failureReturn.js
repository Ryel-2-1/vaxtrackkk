"use strict";

/**
 * Settling stock that has physically left the warehouse: still-reserved units
 * → return-pending, never straight back to available.
 *
 * ONE implementation, used by every path that can meet such an order:
 *
 *   reportDeliveryFailure       the rider's callable (the normal path)
 *   settleClientReportedFailure the compatibility trigger for Rider builds that
 *                               still write `delivery_failed` directly
 *   requeueFailedOrder          if the trigger has not run yet
 *   cancelOrderWithInventoryRelease  likewise, for allocation-version-2 orders;
 *                               and (kind "cancelled_after_dispatch") for an
 *                               order cancelled while In Transit or Delayed —
 *                               the vials are with the rider, so they come back
 *                               through the same Admin check as a failure.
 *
 * Whichever runs first moves the units; the reservation becomes `returned`, so
 * every later caller sees nothing left to move. That is what makes the paths
 * safe to race and to retry.
 *
 * Reads first, then writes: the caller must not have written in [tx] yet, and
 * must apply the returned order fields in its own order update.
 */

const { isLegacyOrder, settleBatch } = require("./policy");
const { ALLOCATION_VERSION_BACKORDER, unitsByBatch } = require("./allocation");
const { returnPendingEvent, prepareEvents, createPreparedEvents } = require("./orderHistory");

/**
 * Whether settleFailureReturn will move units for this order: true exactly
 * when it will advance the failure epoch AND create a return. Callers that
 * must name history before settlement writes anything (requeue) use this.
 */
function failureWouldSettle(order, reservation) {
  if (isLegacyOrder(order) || reservation?.status !== "reserved") return false;
  return unitsByBatch(reservation.items).size > 0;
}

const INVENTORY = "inventory";
const RETURNS = "inventoryReturns";

/** Why units went to return-pending. Stored on the return as `source`. */
const RETURN_SOURCES = Object.freeze({
  DELIVERY_FAILED: "delivery_failed",
  CANCELLED_AFTER_DISPATCH: "cancelled_after_dispatch",
});

/** The one return a cancelled order can have (cancelled is terminal). */
function cancellationReturnId(orderId) {
  return `${orderId}_cancel`;
}

/**
 * [order] / [reservation] are the documents as read in [tx] (reservation may be
 * null). Returns `{ settled, returnId, returnItems, orderFields }`; `settled` is
 * false — and nothing is written — when there is nothing reserved to return.
 *
 * When units move, the Stock Allocation History event is written here too, in
 * [tx], under the return's deterministic id — so all four paths record it the
 * same way and at most once. [sourceOperation] names the path that settled it.
 *
 * [kind] "delivery_failed" (default): a failure — the failure epoch advances,
 * a version-2 order waits for stock again, and the return id is
 * `<orderId>_<failureCount>`. "cancelled_after_dispatch": the order is being
 * cancelled — no failure is counted, nothing is awaited any more, and the
 * return id is `<orderId>_cancel`; [reason] is the cancel reason and
 * [reportedByUid] the dispatcher.
 */
async function settleFailureReturn(tx, {
  db,
  FieldValue,
  orderId,
  order,
  reservationRef,
  reservation,
  reason,
  reportedByUid,
  sourceOperation = "reportDeliveryFailure",
  kind = RETURN_SOURCES.DELIVERY_FAILED,
}) {
  const cancelling = kind === RETURN_SOURCES.CANCELLED_AFTER_DISPATCH;
  const failureSeq = (Number.isInteger(order.failureCount) ? order.failureCount : 0) + 1;
  const orderFields = cancelling ? {} : { failureCount: failureSeq };
  if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
    // No active reservation. A failed order is out of the queue until a
    // dispatcher requeues it (every line awaited again); a cancelled one is
    // out for good (nothing awaited).
    Object.assign(orderFields, {
      allocationOpen: false,
      backorderedProductKeys: [],
      ...(cancelling ? {} : { allocationState: "awaiting_stock" }),
      items: (Array.isArray(order.items) ? order.items : []).map((l) => ({
        ...l,
        reservedQuantity: 0,
        backorderedQuantity: cancelling ? 0 : l.quantity,
      })),
    });
  }

  if (!failureWouldSettle(order, reservation)) {
    return { settled: false, returnId: null, returnItems: [], orderFields };
  }
  const perBatch = [...unitsByBatch(reservation.items)];

  const refs = perBatch.map(([id]) => db.collection(INVENTORY).doc(id));
  const snaps = [];
  for (const ref of refs) snaps.push(await tx.get(ref));

  const returnId = cancelling ? cancellationReturnId(orderId) : `${orderId}_${failureSeq}`;
  // History, READ phase (before this function's first write): create-only.
  const history = returnPendingEvent({
    orderId,
    order,
    reservationItems: reservation.items,
    returnId,
    reportedByUid,
    sourceOperation,
    kind,
  });
  const preparedHistory = await prepareEvents(tx, { db, events: [history] });

  const returnItems = [];
  perBatch.forEach(([inventoryId, quantity], i) => {
    const data = snaps[i].exists ? snaps[i].data() : null;
    tx.update(refs[i], settleBatch({ inventoryId, data, quantity, mode: "return" }));
    returnItems.push({
      inventoryId,
      batchId: typeof data?.batchId === "string" ? data.batchId : null,
      productKey: typeof data?.vaccineId === "string" ? data.vaccineId : null,
      quantity,
    });
  });

  tx.set(db.collection(RETURNS).doc(returnId), {
    orderId,
    orderNumber: order.orderNumber ?? null,
    status: "pending",
    items: returnItems,
    inventoryIds: returnItems.map((r) => r.inventoryId).sort(),
    productKeys: [...new Set(returnItems.map((r) => r.productKey).filter(Boolean))].sort(),
    totalQuantity: returnItems.reduce((s, r) => s + r.quantity, 0),
    source: kind,
    failureReason: !cancelling && typeof reason === "string" ? reason : null,
    ...(cancelling
      ? {
          cancelReason: typeof reason === "string" ? reason : null,
          // loading (confirmed loaded), in_transit or delayed.
          cancelledFromStatus: typeof order.status === "string" ? order.status : null,
        }
      : {}),
    reportedByUid: reportedByUid ?? null,
    reportedAt: FieldValue.serverTimestamp(),
  });
  tx.update(reservationRef, {
    status: "returned",
    settledAt: FieldValue.serverTimestamp(),
    settledByUid: reportedByUid ?? null,
    settlementType: kind,
    returnId,
  });
  createPreparedEvents(tx, { FieldValue, prepared: preparedHistory });
  Object.assign(orderFields, { allocationStatus: "returned", pendingReturnId: returnId });
  return { settled: true, returnId, returnItems, orderFields };
}

/**
 * COMPATIBILITY TRIGGER BODY (temporary — remove with the rider-direct-failure
 * rules window, see docs). Rider builds released before reportDeliveryFailure
 * write `in_transit|delayed → delivery_failed` straight to the order. The rules
 * keep that one write legal during the window; this settles its stock exactly
 * as the callable would.
 *
 * Acts only on that transition (never on an order that was ALREADY failed, so
 * legacy failed orders are not rewritten), and re-checks inside the transaction
 * that the order is still in that same failure. Idempotent: once the
 * reservation is `returned` there is nothing left to move.
 */
async function settleClientReportedFailure({ db, FieldValue, orderId, before, after }) {
  if (!before || !after) return null;
  if (after.status !== "delivery_failed") return null;
  if (before.status !== "in_transit" && before.status !== "delayed") return null;
  // A callable-reported failure already settled itself in the same write.
  if (Number.isInteger(after.failureCount) && after.failureCount > (Number.isInteger(before.failureCount) ? before.failureCount : 0)) {
    return null;
  }
  const orderRef = db.collection("orders").doc(orderId);
  const reservationRef = db.collection("inventoryReservations").doc(orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { settled: false, reason: "order-missing" };
    const order = orderSnap.data();
    if (order.status !== "delivery_failed") return { settled: false, reason: "no-longer-failed" };
    // A redelivered event: this failure was already processed (the first run
    // advanced failureCount), so nothing is touched a second time.
    const count = (v) => (Number.isInteger(v) ? v : 0);
    if (count(order.failureCount) !== count(after.failureCount)) return { settled: false, reason: "already-processed" };
    const resSnap = await tx.get(reservationRef);
    const result = await settleFailureReturn(tx, {
      db,
      FieldValue,
      orderId,
      order,
      reservationRef,
      reservation: resSnap.exists ? resSnap.data() : null,
      reason: order.deliveryFailureReason ?? null,
      reportedByUid: order.deliveryFailedByUid ?? null,
      sourceOperation: "settleClientReportedFailure",
    });
    if (result.settled || order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
      tx.update(orderRef, { ...result.orderFields, updatedAt: FieldValue.serverTimestamp() });
    }
    return { settled: result.settled, returnId: result.returnId };
  });
}

module.exports = {
  settleFailureReturn,
  settleClientReportedFailure,
  failureWouldSettle,
  RETURN_SOURCES,
  cancellationReturnId,
};
