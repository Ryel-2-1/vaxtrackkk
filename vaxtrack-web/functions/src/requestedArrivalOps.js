"use strict";

/**
 * Past requested arrival — the sweep, run by the evaluateDeliveryTiming
 * schedule (rules in requestedArrival.js).
 *
 * `timingStatus` measures a delivery against its ROUTE: dispatch time + ETA +
 * grace. It never looks at the time the Med Rep asked for, so an order
 * dispatched after its window would read "On time". This records the second,
 * separate fact: the latest requested minute has gone by and the order is
 * still not delivered.
 *
 *   orders/{id}.requestedArrivalDeadlineAt   the first instant past the request
 *   orders/{id}.requestedArrivalMissedAt     when the server recorded the miss
 *
 * Both are server-only (firestore.rules serverOnlyOrderFields). The lifecycle
 * status and timingStatus are never touched. A reschedule to a later time
 * clears the marker on the next pass.
 *
 * Each write re-reads the order in a transaction and decides from it, so a
 * stale page cannot mark an order delivered or rescheduled meanwhile. One
 * order's failure never stops the sweep.
 */

const R = require("./requestedArrival");

const ORDERS = "orders";
/** Bounds one pass; the active set is far smaller than this. */
const MAX_ORDERS = 1000;

async function reviewRequestedArrival({ db, FieldValue, Timestamp, orderId, now }) {
  const ref = db.collection(ORDERS).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const decision = snap.exists ? R.requestedArrivalDecision(snap.data(), now.getTime()) : null;
    if (decision?.action === "mark") {
      const fields = { requestedArrivalDeadlineAt: Timestamp.fromMillis(decision.deadlineMs) };
      if (decision.firstMiss) fields.requestedArrivalMissedAt = FieldValue.serverTimestamp();
      tx.update(ref, fields);
    } else if (decision?.action === "clear") {
      tx.update(ref, {
        requestedArrivalMissedAt: FieldValue.delete(),
        requestedArrivalDeadlineAt: FieldValue.delete(),
      });
    }
    return decision?.action ?? null;
  });
}

async function evaluateRequestedArrivalRun({ db, FieldValue, Timestamp, now }) {
  const snap = await db.collection(ORDERS).where("status", "in", R.REQUESTED_ARRIVAL_WATCHED).limit(MAX_ORDERS).get();
  const counts = { scanned: snap.size, marked: 0, cleared: 0, failed: 0 };
  for (const doc of snap.docs) {
    // Most orders need nothing: decide before opening a transaction.
    if (!R.requestedArrivalDecision(doc.data(), now.getTime())) continue;
    try {
      const action = await reviewRequestedArrival({ db, FieldValue, Timestamp, orderId: doc.id, now });
      if (action === "mark") counts.marked += 1;
      if (action === "clear") counts.cleared += 1;
    } catch (error) {
      counts.failed += 1;
      console.error("requested-arrival: order failed", { orderId: doc.id, code: error?.code ?? null });
    }
  }
  return counts;
}

module.exports = { reviewRequestedArrival, evaluateRequestedArrivalRun };
