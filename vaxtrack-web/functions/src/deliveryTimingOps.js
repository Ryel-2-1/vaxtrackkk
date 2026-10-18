"use strict";

/**
 * Automatic delivery timing — the Firestore transaction layer over
 * deliveryTiming.js.
 *
 *   timingFieldsOnDispatch     the attempt's baseline, written by the
 *                              status-history trigger inside its own
 *                              transaction (statusEvents.recordStatusEvent);
 *   advanceDeliveryTiming      one order, from its state NOW, in a transaction;
 *   evaluateDeliveryTimingRun  the scheduled sweep over DUE orders
 *                              (timingActive && timingNextCheckAt <= now).
 *
 * Retry-safe: every write re-reads the order inside a transaction and decides
 * from it; a status already recorded writes nothing; the history event and the
 * alert have deterministic, attempt-scoped ids and are created only when
 * absent. The lifecycle `status` is never written here.
 */

const D = require("./deliveryTiming");
const { routeForOrder } = require("./riderTracking");
const history = require("./orderHistory");

const ORDERS = "orders";
const ALERTS = "alerts";
/** Where a Dispatcher acts on a late delivery (the alert's `path`). */
const SHIPMENT_PATH = (orderId) => `/dispatcher/shipments?order=${encodeURIComponent(orderId)}`;
/** The due query, in one place (firestore.indexes.json carries its index). */
const DUE_FIELD = "timingNextCheckAt";

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

const timeText = (ms) =>
  new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/** The attempt an order's stored timing belongs to (falls back to its failure epoch). */
const attemptOf = (order) => (Number.isInteger(order?.timingEpoch) ? order.timingEpoch : D.epochOf(order));

/**
 * A destination label safe for alerts: a clinic by name; a doctor's home only
 * as a generic label — never its name or street address.
 */
function destinationLabel(order) {
  if (order?.destinationType === "home") return "Doctor's private address";
  const name = [order?.destinationName, order?.clinicName].find((v) => typeof v === "string" && v.trim() !== "");
  return name ? name.trim() : "the destination";
}

/**
 * The fields that register a dispatch attempt for the order as stored now
 * (`current`), from the dispatch write's snapshot (`dispatched`) and server
 * commit time (`dispatchedAt`). The caller has already checked it is the same
 * attempt (D.sameDispatchAttempt).
 *   known ETA   → on_time, active, next check at the expected arrival;
 *   unknown ETA → unknown, inactive, no deadlines, no next check — for good.
 */
function timingFieldsOnDispatch({ dispatched, dispatchedAt, current, Timestamp }) {
  const contract = {
    timingContractVersion: D.TIMING_CONTRACT_VERSION,
    timingEpoch: D.epochOf(current),
    timingBaselineAt: dispatchedAt,
  };
  const base = D.timingBaseline({ order: dispatched, dispatchedAtMs: millisOf(dispatchedAt), routeForOrder });
  if (!base.known) {
    return {
      ...contract,
      timingActive: false,
      timingStatus: "unknown",
      timingUnknownReason: base.reason,
    };
  }
  return {
    ...contract,
    timingActive: true,
    timingStatus: "on_time",
    expectedArrivalAt: Timestamp.fromMillis(base.expectedArrivalMs),
    automaticDelayedAt: Timestamp.fromMillis(base.automaticDelayedMs),
    timingNextCheckAt: Timestamp.fromMillis(base.expectedArrivalMs),
    timingEtaSeconds: base.etaSeconds,
    timingGraceSeconds: base.graceSeconds,
    timingRouteSource: base.source,
  };
}

/** The history event recorded once per attempt when it first becomes automatically delayed. */
function runningLateEvent({ orderId, order, nowMs }) {
  const epoch = attemptOf(order);
  const expectedMs = millisOf(order.expectedArrivalAt);
  const deadlineMs = millisOf(order.automaticDelayedAt);
  const hold = String(order.status).toLowerCase() === "delayed";
  return {
    eventId: history.eventIdOf(orderId, `e${epoch}`, "running_late"),
    event: history.buildEvent({
      orderId,
      order,
      eventType: history.EVENT_TYPES.DELIVERY_RUNNING_LATE,
      sourceOperation: "evaluateDeliveryTiming",
      epoch,
      ordinal: 1,
      summary: `Running late: expected by ${timeText(expectedMs)}; the grace period ended at ${timeText(deadlineMs)}. ` +
        (hold ? "The rider has the delivery on hold." : "Still in transit."),
      extra: {
        timingReason: D.AUTOMATIC_DELAY_REASON,
        expectedArrivalMs: expectedMs,
        automaticDelayedMs: deadlineMs,
        lateMinutesAtDetection: D.minutesLate(expectedMs, nowMs),
      },
    }),
  };
}

/** Reads for the first-delay side effects (must precede any write). */
async function prepareFirstDelay(tx, { db, orderId, order, nowMs }) {
  const alertRef = db.collection(ALERTS).doc(D.timingAlertId(orderId, attemptOf(order)));
  const alertExists = (await tx.get(alertRef)).exists;
  const prepared = await history.prepareEvents(tx, { db, events: [runningLateEvent({ orderId, order, nowMs })] });
  return { alertRef, alertExists, prepared };
}

/**
 * Writes for the first-delay side effects: one history event (Med Rep visible
 * through its owner field) and one alert, visible to Admin (Alerts page) and
 * Dispatcher (notification bell, with a direct link to the shipment). The
 * alert carries no street address. Reading or resolving it never touches the
 * order.
 */
function writeFirstDelay(tx, { FieldValue, orderId, order, prep, nowMs }) {
  history.createPreparedEvents(tx, { FieldValue, prepared: prep.prepared });
  if (prep.alertExists) return;
  const number = order.orderNumber || orderId;
  const expectedMs = millisOf(order.expectedArrivalAt);
  const deadlineMs = millisOf(order.automaticDelayedAt);
  const rider = typeof order.assignedRiderName === "string" && order.assignedRiderName.trim() ? order.assignedRiderName.trim() : "the rider";
  const dest = destinationLabel(order);
  const late = D.minutesLate(expectedMs, nowMs);
  const hold = String(order.status).toLowerCase() === "delayed";
  tx.create(prep.alertRef, {
    type: "delivery_delay",
    severity: "warning",
    status: "active",
    read: false,
    title: "Delivery running late",
    message: `Order ${number} with ${rider} to ${dest} was expected by ${timeText(expectedMs)}; ` +
      `the grace period ended at ${timeText(deadlineMs)} (${late} min past expected arrival when detected). ` +
      (hold ? "The rider has it on hold." : "It is still in transit."),
    orderId,
    deliveryId: orderId,
    orderNumber: order.orderNumber ?? null,
    riderId: order.assignedRiderId ?? null,
    riderName: order.assignedRiderName ?? null,
    destinationLabel: dest,
    expectedArrivalAt: order.expectedArrivalAt ?? null,
    automaticDelayedAt: order.automaticDelayedAt ?? null,
    lateMinutesAtDetection: late,
    lifecycleAtDetection: hold ? "delayed" : "in_transit",
    dispatchAttempt: attemptOf(order),
    reason: D.AUTOMATIC_DELAY_REASON,
    path: SHIPMENT_PATH(orderId),
    source: "server",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Advance (or retire) one order's timing at server time `now`, in a
 * transaction, from the order as stored NOW. Returns
 * { advanced, deactivated, rescheduled, to?, firstDelay?, reason? }.
 */
async function advanceDeliveryTiming({ db, FieldValue, Timestamp, orderId, now }) {
  const ref = db.collection(ORDERS).doc(orderId);
  const nowMs = now.getTime();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.exists ? snap.data() : null;
    const decision = D.timingDecision(order, nowMs);
    const none = { advanced: false, deactivated: false, rescheduled: false };
    if (decision.action === "deactivate") {
      tx.update(ref, { timingActive: false, [DUE_FIELD]: FieldValue.delete() });
      return { ...none, deactivated: true, reason: decision.reason };
    }
    if (decision.action === "reschedule") {
      tx.update(ref, { [DUE_FIELD]: Timestamp.fromMillis(decision.nextCheckMs) });
      return { ...none, rescheduled: true };
    }
    if (decision.action !== "advance") return { ...none, reason: decision.reason };
    const prep = decision.firstDelay ? await prepareFirstDelay(tx, { db, orderId, order, nowMs }) : null;
    const finished = decision.nextCheckMs === null;
    tx.update(ref, {
      timingStatus: decision.to,
      timingStatusChangedAt: FieldValue.serverTimestamp(),
      ...(finished
        ? { timingActive: false, [DUE_FIELD]: FieldValue.delete() }
        : { [DUE_FIELD]: Timestamp.fromMillis(decision.nextCheckMs) }),
      ...(decision.firstDelay ? { timingDelayedAt: FieldValue.serverTimestamp(), timingDelayReason: D.AUTOMATIC_DELAY_REASON } : {}),
    });
    if (prep) writeFirstDelay(tx, { FieldValue, orderId, order, prep, nowMs });
    return { ...none, advanced: true, deactivated: finished, to: decision.to, firstDelay: decision.firstDelay };
  });
}

/**
 * The scheduled sweep over DUE orders only:
 *   timingActive == true AND timingNextCheckAt <= now,
 *   ordered by (timingNextCheckAt, document id) — the oldest due first.
 * Every processed order leaves this set (its next check moves past `now`, or
 * it becomes inactive), so the next page — or the next invocation — reaches
 * the orders behind it; within a run the cursor also moves past any order
 * whose transaction failed, so one stuck order never blocks the rest.
 * Bounded per invocation by pageSize × maxPages; a larger backlog continues
 * from the oldest remaining due order on the next run.
 */
async function evaluateDeliveryTimingRun({ db, FieldValue, Timestamp, now, pageSize = 200, maxPages = 25 }) {
  const counts = { scanned: 0, advanced: 0, delayed: 0, deactivated: 0, rescheduled: 0, failed: 0, pages: 0 };
  const dueBy = Timestamp.fromMillis(now.getTime());
  let last = null;
  for (let page = 0; page < maxPages; page += 1) {
    let q = db.collection(ORDERS)
      .where("timingActive", "==", true)
      .where(DUE_FIELD, "<=", dueBy)
      .orderBy(DUE_FIELD)
      .orderBy("__name__")
      .limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    counts.pages += 1;
    if (snap.empty) break;
    for (const doc of snap.docs) {
      counts.scanned += 1;
      try {
        const r = await advanceDeliveryTiming({ db, FieldValue, Timestamp, orderId: doc.id, now });
        if (r.advanced) counts.advanced += 1;
        if (r.firstDelay) counts.delayed += 1;
        if (r.deactivated) counts.deactivated += 1;
        if (r.rescheduled) counts.rescheduled += 1;
      } catch (error) {
        // One order's failure never stops the sweep; it stays due and is
        // retried first next run, while the cursor moves on past it now.
        counts.failed += 1;
        console.error("evaluateDeliveryTiming: order failed", { orderId: doc.id, code: error?.code ?? null });
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return counts;
}

module.exports = {
  SHIPMENT_PATH,
  DUE_FIELD,
  destinationLabel,
  timingFieldsOnDispatch,
  prepareFirstDelay,
  writeFirstDelay,
  advanceDeliveryTiming,
  evaluateDeliveryTimingRun,
  runningLateEvent,
};
