"use strict";

/**
 * Arrival proximity — the transactions (rules in arrivalProximity.js).
 *
 *   arrivalProximity/{orderId}   server-owned: exists only while the order's
 *                                Rider is provably near its destination.
 *   alerts/{awaiting_completion_<orderId>_<confirmedAtMs>}
 *                                "Delivery still awaiting completion", raised
 *                                once per confirmed visit after NEAR_WAIT_MS.
 *
 * processLocationProximity runs from the riderLocations trigger on every fix;
 * settleProximityOnOrderWrite from the orders trigger, so a delivered, failed,
 * cancelled or reassigned order clears its state and resolves its alert even
 * when the Rider sends no further fix. All writes are idempotent: a replayed
 * fix or order write changes nothing.
 */

const P = require("./arrivalProximity");
const { SHIPMENT_PATH, destinationLabel } = require("./deliveryTimingOps");

const ORDERS = "orders";
const ALERTS = "alerts";

const sameState = (a, b) =>
  Boolean(a) && Boolean(b) &&
  ["orderId", "riderUid", "firstFixMs", "lastFixMs", "confirmedAtMs", "radiusM", "distanceM"].every((k) => a[k] === b[k]);

function awaitingAlert({ FieldValue, orderId, order, state }) {
  const number = typeof order.orderNumber === "string" && order.orderNumber.trim() ? order.orderNumber.trim() : null;
  const rider = typeof order.assignedRiderName === "string" && order.assignedRiderName.trim()
    ? order.assignedRiderName.trim() : "The rider";
  const dest = destinationLabel(order);
  const minutes = Math.floor((state.lastFixMs - state.confirmedAtMs) / 60000);
  return {
    type: P.ALERT_TYPE,
    severity: "warning",
    status: "active",
    read: false,
    title: "Delivery still awaiting completion",
    message: `${rider} has been within ${state.radiusM} m of ${dest} for ${minutes} minutes, ` +
      `but ${number ? `Order ${number}` : "the order"} has not been completed. Check with the rider.`,
    orderId,
    deliveryId: orderId,
    orderNumber: number,
    riderId: order.assignedRiderId ?? null,
    riderName: order.assignedRiderName ?? null,
    destinationLabel: dest,
    nearSinceMs: state.confirmedAtMs,
    minutesNearAtDetection: minutes,
    radiusMeters: state.radiusM,
    path: SHIPMENT_PATH(orderId),
    source: "server",
    resolutionReason: null,
    createdAt: FieldValue.serverTimestamp(),
    lastDetectedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** One order, one fix: advance (or clear) its proximity; raise the alert once. */
async function advanceOrder({ db, FieldValue, orderId, riderUid, location, nowMs }) {
  const orderRef = db.collection(ORDERS).doc(orderId);
  const proxRef = db.collection(P.PROXIMITY_COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const proxSnap = await tx.get(proxRef);
    const order = orderSnap.exists ? orderSnap.data() : null;
    const previous = proxSnap.exists ? proxSnap.data() : null;
    const { next, reason } = P.nextProximity({ previous, order, orderId, riderUid, location, nowMs });

    let alertRef = null;
    let alertExists = true;
    if (next && P.awaitingCompletionDue(next)) {
      alertRef = db.collection(ALERTS).doc(P.proximityAlertId(orderId, next.confirmedAtMs));
      alertExists = (await tx.get(alertRef)).exists;
    }

    if (!next) {
      if (previous) tx.delete(proxRef);
    } else if (!sameState(previous, next)) {
      tx.set(proxRef, { ...next, updatedAt: FieldValue.serverTimestamp() });
    }
    if (alertRef && !alertExists) tx.create(alertRef, awaitingAlert({ FieldValue, orderId, order, state: next }));
    return { orderId, reason, near: Boolean(next), confirmed: Boolean(next?.confirmedAtMs), alertRaised: Boolean(alertRef && !alertExists) };
  });
}

/**
 * A Rider's location changed: evaluate every order they are carrying, and
 * clear proximity left on orders they no longer carry. Two indexed reads.
 */
async function processLocationProximity({ db, FieldValue, riderUid, location, nowMs }) {
  const [carrying, held] = await Promise.all([
    db.collection(ORDERS).where("assignedRiderId", "==", riderUid).where("status", "in", [...P.NEAR_STATUSES]).get(),
    db.collection(P.PROXIMITY_COLLECTION).where("riderUid", "==", riderUid).get(),
  ]);
  const orderIds = new Set([...carrying.docs.map((d) => d.id), ...held.docs.map((d) => d.id)]);
  const results = [];
  for (const orderId of orderIds) {
    results.push(await advanceOrder({ db, FieldValue, orderId, riderUid, location, nowMs }));
  }
  return results;
}

/**
 * An order was written. Once it is no longer in transit for the Rider it was
 * near — delivered, failed, cancelled, parked or reassigned — its proximity
 * state is cleared and an open awaiting-completion alert is resolved with the
 * reason. Cheap no-op otherwise.
 */
async function settleProximityOnOrderWrite({ db, FieldValue, orderId, before, after }) {
  const was = before && P.NEAR_STATUSES.includes(String(before.status ?? "").trim().toLowerCase());
  const riderUid = typeof before?.assignedRiderId === "string" ? before.assignedRiderId : null;
  if (!was || !riderUid) return { settled: false };
  const reason = P.resolutionReasonFor(after, riderUid);
  if (!reason) return { settled: false };

  const open = await db.collection(ALERTS)
    .where("orderId", "==", orderId).where("type", "==", P.ALERT_TYPE).where("status", "==", "active").get();
  const proxRef = db.collection(P.PROXIMITY_COLLECTION).doc(orderId);
  await db.runTransaction(async (tx) => {
    const proxSnap = await tx.get(proxRef);
    const alerts = [];
    for (const doc of open.docs) {
      const snap = await tx.get(doc.ref);
      if (snap.exists && snap.get("status") === "active") alerts.push(doc.ref);
    }
    if (proxSnap.exists) tx.delete(proxRef);
    for (const ref of alerts) {
      tx.update(ref, {
        status: "resolved",
        resolutionReason: reason,
        resolvedBy: "server",
        resolvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  return { settled: true, reason, alertsResolved: open.size };
}

module.exports = { processLocationProximity, settleProximityOnOrderWrite, advanceOrder };
