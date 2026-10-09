"use strict";

/**
 * Materializing an order's initial-allocation history from its outbox marker.
 *
 * The order's creation transaction commits the order, its receipt, its first
 * ledger entry AND orderHistoryOutbox/{orderId} { status: "pending" } together
 * (operations.createOrderTransaction). The order's first allocation pass runs
 * after that commit, in its own bounded transactions (allocation.js). This
 * module records that pass's outcome — requested, initially reserved,
 * initially backordered, state — as the `{orderId}__confirmed` ledger entry.
 *
 * Two callers, one result:
 *   - createOrderWithReservation, right after its own allocation pass (the
 *     normal path; the record exists before the Med Rep sees the confirmation);
 *   - the materializeOrderHistory trigger (index.js, retry: true), fired by the
 *     marker's creation. If the callable stopped between transactions, the
 *     trigger runs its own allocation pass first (idempotent and concurrency
 *     safe), then records — so an accepted order never stays unrecorded.
 *
 * Exactly once: the final step is ONE transaction that re-reads the marker,
 * creates the event (create-only, orderHistory.prepareEvents) and marks the
 * marker "done". A second materializer — a concurrent trigger, a retry, the
 * callable racing the trigger — reads "done" and writes nothing. An existing
 * DIFFERENT event under the id is an integrity conflict: nothing is written,
 * the marker is set to "conflict" with the field names, and it is logged.
 */

const { PolicyError } = require("./policy");
const { allocateProducts } = require("./allocation");
const { OUTBOX, initialAllocationEvent, prepareEvents, createPreparedEvents } = require("./orderHistory");

async function materializeInitialHistory({ db, FieldValue, orderId, now = new Date(), materializedBy, allocate = true }) {
  if (typeof orderId !== "string" || orderId === "" || orderId.includes("/")) {
    return { materialized: false, reason: "invalid-order-id" };
  }
  const markerRef = db.collection(OUTBOX).doc(orderId);
  const first = await markerRef.get();
  if (!first.exists) return { materialized: false, reason: "no-marker" };
  if (first.get("status") !== "pending") return { materialized: false, reason: `marker-${first.get("status")}` };

  // The first allocation pass. The placing call has already run it (allocate:
  // false); a recovery runs its own so the record reflects a completed pass.
  // A failure here throws: the marker stays pending and the trigger retries.
  if (allocate) {
    const productKeys = Array.isArray(first.get("productKeys")) ? first.get("productKeys") : [];
    if (productKeys.length > 0) {
      await allocateProducts({ db, FieldValue, productKeys, now, source: { operation: materializedBy } });
    }
  }

  const orderRef = db.collection("orders").doc(orderId);
  try {
    return await db.runTransaction(async (tx) => {
      const marker = await tx.get(markerRef);
      if (!marker.exists || marker.get("status") !== "pending") {
        return { materialized: false, reason: "already-complete" };
      }
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        // The order was deleted before its history could be recorded. Nothing
        // is invented; the marker says why it closed.
        tx.update(markerRef, { status: "abandoned", reason: "order-missing", completedAt: FieldValue.serverTimestamp() });
        return { materialized: false, reason: "order-missing" };
      }
      const order = orderSnap.data();
      if (order.allocationVersion !== 2 || !Array.isArray(order.items)) {
        tx.update(markerRef, { status: "abandoned", reason: "not-tracked", completedAt: FieldValue.serverTimestamp() });
        return { materialized: false, reason: "not-tracked" };
      }
      const prepared = await prepareEvents(tx, { db, events: [initialAllocationEvent({ orderId, order, materializedBy })] });
      createPreparedEvents(tx, { FieldValue, prepared });
      tx.update(markerRef, {
        status: "done",
        materializedBy,
        completedAt: FieldValue.serverTimestamp(),
      });
      return { materialized: prepared.length === 1, reason: prepared.length === 1 ? "created" : "already-recorded" };
    });
  } catch (error) {
    if (error instanceof PolicyError && error.code === "history-integrity-conflict") {
      // Never overwrite. Close the marker as a conflict for Admin review so
      // the trigger does not retry a write that must not happen.
      await db.runTransaction(async (tx) => {
        const marker = await tx.get(markerRef);
        if (marker.exists && marker.get("status") === "pending") {
          tx.update(markerRef, {
            status: "conflict",
            conflictFields: error.details?.fields ?? [],
            completedAt: FieldValue.serverTimestamp(),
          });
        }
      });
      return { materialized: false, reason: "integrity-conflict", fields: error.details?.fields ?? [] };
    }
    throw error;
  }
}

module.exports = { materializeInitialHistory };
