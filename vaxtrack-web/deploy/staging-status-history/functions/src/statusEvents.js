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
 */
async function recordStatusEvent({ db, orderId, eventId, event, at }) {
  const orderRef = db.collection("orders").doc(orderId);
  const eventRef = orderRef.collection(STATUS_EVENTS).doc(eventId);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(eventRef);
    if (existing.exists) return { recorded: false, reason: "duplicate-delivery" };

    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { recorded: false, reason: "order-deleted" };

    tx.create(eventRef, { ...event, at, eventId });

    let stampedFirstDispatch = false;
    if (event.to === "in_transit" && orderSnap.get("firstDispatchedAt") == null) {
      tx.update(orderRef, { firstDispatchedAt: at });
      stampedFirstDispatch = true;
    }
    return { recorded: true, stampedFirstDispatch };
  });
}

module.exports = {
  STATUS_EVENTS,
  deriveStatusEvent,
  recordStatusEvent,
};
