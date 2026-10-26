"use strict";

/**
 * Order status history.
 *
 * Every status change on an order is recorded as an append-only event in
 * `orders/{orderId}/statusEvents/{eventId}`. Until now each transition only
 * overwrote a "latest" timestamp on the order — resuming a delayed delivery
 * re-stamps `startedAt` — so the system could not say how long a delivery
 * really took, whether it arrived on the requested day, or what happened to it
 * in between.
 *
 * The events are written by a Firestore TRIGGER (index.js), not by the clients
 * or the callables that change the status. That is deliberate:
 *   - one writer sees every path — callables, the dispatcher web pages and the
 *     rider app's direct writes — so no transition can be missed or forged;
 *   - clients cannot write events at all (firestore.rules), so the history is
 *     server-attested;
 *   - the event time is the commit time of the write that changed the status,
 *     read from the document itself, never a client clock.
 *
 * The trigger also stamps `firstDispatchedAt` on the order the first time it
 * enters `in_transit`, and never again. Together with `deliveredAt` that gives
 * the true delivery duration — delays and resumed legs included.
 *
 * History starts when this is deployed. Earlier transitions are not
 * reconstructed: their timestamps were overwritten, and inventing them would
 * be fabrication.
 */

const STATUS_EVENTS = "statusEvents";
// Lazily required: the timing layer pulls in the tracking contract and order
// history, which plain status-event tests never need.
const timingOps = () => require("./deliveryTimingOps");
const MAX_REASON_LENGTH = 500; // identical to policy.js / orderWorkflow.js

function normalizeStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_REASON_LENGTH);
}

/** The reason the order carries for entering `to`, when that status has one. */
function reasonFor(to, after) {
  if (to === "delayed") return textOrNull(after.delayReason);
  if (to === "delivery_failed") return textOrNull(after.deliveryFailureReason);
  if (to === "cancelled") return textOrNull(after.cancelReason);
  return null;
}

/**
 * The event for one document write, or null when the write did not change the
 * status (most writes: location ticks, loading checkboxes, route saves).
 *
 * `before` / `after` are plain document data, or null for create / delete.
 * A deletion records nothing — the history goes with the order.
 */
function deriveStatusEvent({ before, after }) {
  if (!after) return null;
  const to = normalizeStatus(after.status);
  if (!to) return null;
  const from = before ? normalizeStatus(before.status) || null : null;
  if (from === to) return null;

  return {
    from,
    to,
    // Who made the change, as the write itself recorded it. A newly created
    // order is attributed to its creator. Never guessed beyond that.
    actorUid:
      textOrNull(after.statusUpdatedByUid) ??
      (before ? null : textOrNull(after.createdByUid)) ??
      null,
    riderId: textOrNull(after.assignedRiderId),
    reason: reasonFor(to, after),
  };
}

/**
 * Persist one event, idempotently.
 *
 * Firestore triggers are delivered at least once, so the CloudEvent id is the
 * event document id: a retry finds its own earlier write and does nothing. The
 * `firstDispatchedAt` milestone is set inside the same transaction, and only
 * while it is absent, so a resumed delivery can never move it.
 *
 * `at` is the commit time of the write that changed the status (the snapshot's
 * updateTime), passed in by the trigger.
 *
 * The DISPATCH event (loading → in_transit) also freezes the order's automatic
 * delivery-timing baseline (deliveryTiming.js) in this same transaction, once:
 * from `after` — that write's own snapshot, so a route regenerated later can
 * never move the deadline — and `at`, its server commit time. Given
 * `FieldValue` and `Timestamp` by the trigger; without them (older callers)
 * nothing about timing is written.
 */
async function recordStatusEvent({ db, orderId, eventId, event, at, after = null, FieldValue = null, Timestamp = null }) {
  const orderRef = db.collection("orders").doc(orderId);
  const eventRef = orderRef.collection(STATUS_EVENTS).doc(eventId);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(eventRef);
    if (existing.exists) return { recorded: false, reason: "duplicate-delivery" };

    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { recorded: false, reason: "order-deleted" };

    // Timing baseline: the dispatch event registers ITS attempt, once — only
    // while the order is still on that attempt (same failure epoch and
    // dispatch time, clock-running lifecycle). A late trigger of an earlier
    // attempt — after a requeue or a redispatch — registers nothing. Only the
    // baseline is armed here; the scheduler evaluates it when it falls due.
    let timing = null;
    const current = orderSnap.data();
    if (event.from === "loading" && event.to === "in_transit" && after && FieldValue && Timestamp
      && current.timingContractVersion == null
      && require("./deliveryTiming").sameDispatchAttempt(current, after)) {
      timing = timingOps().timingFieldsOnDispatch({ dispatched: after, dispatchedAt: at, current, Timestamp });
    }

    // The attempt this event ENDS (delivered, failed, cancelled …): its late
    // alert, if one was raised and is still open, is resolved now. Named from
    // the ending write's own snapshot, so a late trigger of an earlier attempt
    // can never resolve a newer attempt's alert (deliveryTiming.endedTimingAttempt).
    let lateAlert = null;
    const ended = FieldValue ? require("./deliveryTiming").endedTimingAttempt(event, after) : null;
    if (ended) {
      let alertId;
      try {
        alertId = require("./deliveryTiming").timingAlertId(orderId, ended.epoch);
      } catch {
        alertId = null; // an id that could never have carried an alert
      }
      if (alertId) {
        const ref = db.collection("alerts").doc(alertId);
        const snap = await tx.get(ref);
        if (snap.exists && snap.get("status") === "active") lateAlert = { ref, reason: ended.reason };
      }
    }

    tx.create(eventRef, { ...event, at, eventId });
    if (lateAlert) {
      tx.update(lateAlert.ref, {
        status: "resolved",
        resolvedAt: FieldValue.serverTimestamp(),
        resolutionReason: lateAlert.reason,
        resolvedBy: "server",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // One update of the order carries every field this event sets.
    const orderUpdate = {};
    if (timing) {
      Object.assign(orderUpdate, timing,
        timing.timingStatus !== "unknown" ? { timingStatusChangedAt: FieldValue.serverTimestamp() } : {});
    }

    let stampedFirstDispatch = false;
    if (event.to === "in_transit" && orderSnap.get("firstDispatchedAt") == null) {
      orderUpdate.firstDispatchedAt = at;
      stampedFirstDispatch = true;
    }
    if (Object.keys(orderUpdate).length > 0) tx.update(orderRef, orderUpdate);
    return {
      recorded: true,
      stampedFirstDispatch,
      timingStatus: timing ? timing.timingStatus : null,
      lateAlertResolved: lateAlert ? lateAlert.reason : null,
    };
  });
}

module.exports = {
  STATUS_EVENTS,
  deriveStatusEvent,
  recordStatusEvent,
};
