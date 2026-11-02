"use strict";

/**
 * Arrival proximity — is a Rider staying near an in-transit order's clinic,
 * and has the delivery gone uncompleted there for too long?
 *
 * Pure: no Firebase. The trigger on riderLocations (arrivalProximityOps.js)
 * runs it on every fix, so detection no longer depends on a Dispatcher having
 * the web app open. It reuses the delivery geofence's own rules
 * (deliveryGeofence.js): the order's verified destination and radius, and a
 * "trusted" position (active sharing, ≤ 3 min old, ≤ 100 m accuracy).
 *
 * "Near" is advisory and never changes the order: it never marks arrival or
 * delivery. Two trusted fixes at least NEAR_DWELL_MS apart, both inside the
 * radius, with no gap longer than CONTINUITY_MS, confirm it; one GPS point
 * never does. Any untrusted, outside or discontinuous fix resets it.
 */

const { haversineMeters, normalizeOrderDestination, trustedRiderPosition } = require("./deliveryGeofence");

const NEAR_DWELL_MS = 2 * 60 * 1000;
const NEAR_WAIT_MS = 15 * 60 * 1000;
/** Same window as the rider-location freshness rule (riderTracking.js). */
const CONTINUITY_MS = 3 * 60 * 1000;

const PROXIMITY_COLLECTION = "arrivalProximity";
const ALERT_TYPE = "delivery_awaiting_completion";
const NEAR_STATUSES = Object.freeze(["in_transit", "delayed"]);

const millisOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
};

const statusOf = (order) => String(order?.status ?? "").trim().toLowerCase();

/** One alert per confirmed visit, so a later visit can raise a new one. */
function proximityAlertId(orderId, confirmedAtMs) {
  return `awaiting_completion_${orderId}_${confirmedAtMs}`;
}

/**
 * The next proximity state for one order after a fix, or `next: null` when
 * the Rider is not (or no longer provably) near its destination.
 * `previous` is the stored arrivalProximity document, or null.
 */
function nextProximity({ previous = null, order, orderId, riderUid, location, nowMs }) {
  if (!order || !NEAR_STATUSES.includes(statusOf(order)) || order.assignedRiderId !== riderUid) {
    return { next: null, reason: "not_on_delivery" };
  }
  const destination = normalizeOrderDestination(order);
  if (!destination) return { next: null, reason: "no_destination" };
  const position = trustedRiderPosition(location, { uid: riderUid, nowMs });
  if (position.problem) return { next: null, reason: "untrusted_fix" };

  // The EARLIER of capture and server-write time, as the geofence measures age.
  const fixMs = Math.min(millisOf(location.capturedAt), millisOf(location.updatedAt));
  const distanceM = haversineMeters({ lat: position.lat, lng: position.lng }, destination);
  if (!(distanceM <= destination.radiusM)) return { next: null, reason: "outside" };

  const same = previous && previous.orderId === orderId && previous.riderUid === riderUid;
  if (same && previous.lastFixMs === fixMs) return { next: previous, reason: "replay" };
  const continuous = same && fixMs > previous.lastFixMs && fixMs - previous.lastFixMs <= CONTINUITY_MS;
  const firstFixMs = continuous ? previous.firstFixMs : fixMs;
  const confirmedAtMs = continuous
    ? previous.confirmedAtMs ?? (fixMs - firstFixMs >= NEAR_DWELL_MS ? fixMs : null)
    : null;
  return {
    next: {
      orderId,
      riderUid,
      firstFixMs,
      lastFixMs: fixMs,
      confirmedAtMs,
      radiusM: destination.radiusM,
      distanceM: Math.ceil(distanceM),
    },
    reason: continuous ? "continued" : "started",
  };
}

/** Confirmed near the clinic for NEAR_WAIT_MS, by the Rider's own fixes. */
function awaitingCompletionDue(state) {
  return Number.isFinite(state?.confirmedAtMs) && state.lastFixMs - state.confirmedAtMs >= NEAR_WAIT_MS;
}

/** Why an awaiting-completion alert ends, from the order write that ends it. */
function resolutionReasonFor(order, riderUid) {
  if (!order) return "order_removed";
  const status = statusOf(order);
  if (status === "delivered" || status === "completed") return "delivered";
  if (status === "delivery_failed") return "delivery_failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (order.assignedRiderId !== riderUid) return "reassigned";
  if (!NEAR_STATUSES.includes(status)) return "no_longer_in_transit";
  return null;
}

module.exports = {
  NEAR_DWELL_MS,
  NEAR_WAIT_MS,
  CONTINUITY_MS,
  PROXIMITY_COLLECTION,
  ALERT_TYPE,
  NEAR_STATUSES,
  proximityAlertId,
  nextProximity,
  awaitingCompletionDue,
  resolutionReasonFor,
};
