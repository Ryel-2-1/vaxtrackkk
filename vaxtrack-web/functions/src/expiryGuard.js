"use strict";
/**
 * Reserved stock must still be usable on the day it is delivered.
 *
 * A batch is usable through the whole of its expiry date (policy.isExpired:
 * expired = expiry strictly before the day, Manila). An order's stock must be
 * usable through its delivery date — `requestedDeliveryDate`, never earlier
 * than today. One rule, applied wherever a batch meets an order:
 *   - allocation      a batch is never reserved for an order delivered after it expires;
 *   - reschedule      a new date the reserved batches cannot reach is refused;
 *   - batch edit      an expiry cannot move before a reserved order's delivery date;
 *   - dispatch        nothing leaves with a batch that has expired;
 *   - delivery        nothing is completed with a batch that has expired.
 * Pure: no Firestore.
 */
const { PolicyError, isoDateOnly, manilaDateString } = require("./policy");

/** The date an order's stock must still be usable on (ISO, Manila). */
function usableThrough(order, now) {
  const today = manilaDateString(now);
  const date = isoDateOnly(order?.requestedDeliveryDate);
  return date && date > today ? date : today;
}

/** Does the batch stay usable through [isoDate]? A missing or invalid expiry never does. */
function coversDate(batchData, isoDate) {
  const expiry = isoDateOnly(batchData?.expiryDate);
  return expiry !== null && expiry >= isoDate;
}

/**
 * Throw when any of [batches] ({ id, data }) is not usable through [isoDate].
 * The message gives both dates; [action] says what to do next. It does not
 * name the batch: batch IDs such as "AB_2026-001" read as identifiers to the
 * web's user-message filter (liveDataErrors.isSafeUserMessage), which would
 * replace the whole sentence with a generic "please try again".
 */
function assertBatchesCover(batches, isoDate, { code = "reserved-batch-expired", action }) {
  for (const { data } of batches) {
    if (coversDate(data, isoDate)) continue;
    const expiry = isoDateOnly(data?.expiryDate);
    throw new PolicyError(
      code,
      `A reserved batch ${expiry ? `expires on ${expiry}` : "has no valid expiry date"}, before ${isoDate}. ${action}`
    );
  }
}

/**
 * The batch ids an `inventoryReservations` document still holds (its slices),
 * or [] once it is no longer reserved (released, consumed, returned).
 */
function reservedInventoryIds(reservation) {
  if (reservation?.status !== undefined && reservation.status !== "reserved") return [];
  const items = Array.isArray(reservation?.items) ? reservation.items : [];
  return [...new Set(items
    .filter((s) => typeof s?.inventoryId === "string" && s.inventoryId && Number.isInteger(s.quantity) && s.quantity > 0)
    .map((s) => s.inventoryId))];
}

/**
 * Read-only, inside a transaction: orderId → [{ id, data }] of the batches its
 * reservation holds (none for an order without a reservation — a legacy order
 * is not checked here). Lives here so the dispatch module never names stock.
 */
async function readReservedBatches(tx, db, orderIds) {
  const out = new Map();
  const batchCache = new Map();
  for (const orderId of orderIds) {
    const resSnap = await tx.get(db.collection("inventoryReservations").doc(orderId));
    const batches = [];
    for (const inventoryId of resSnap.exists ? reservedInventoryIds(resSnap.data()) : []) {
      if (!batchCache.has(inventoryId)) {
        const snap = await tx.get(db.collection("inventory").doc(inventoryId));
        batchCache.set(inventoryId, snap.exists ? snap.data() : null);
      }
      batches.push({ id: inventoryId, data: batchCache.get(inventoryId) });
    }
    out.set(orderId, batches);
  }
  return out;
}

module.exports = { usableThrough, coversDate, assertBatchesCover, reservedInventoryIds, readReservedBatches };
