"use strict";

/**
 * Offline delivery completion — the rules (transactions in offlineCompletionOps.js).
 *
 * A Rider at a clinic with GPS but no mobile data cannot reach the live
 * geofence check. The Rider app instead records, ON THE PHONE, the handoff:
 * both photos, the recipient, and a GPS fix taken at that moment. Once signal
 * returns it uploads the photos and submits that fix here.
 *
 * The fix comes from the phone, so it is never trusted on its own. It is
 * accepted automatically only when ALL of these hold (decided here, pure):
 *   - it was received within MAX_OFFLINE_AGE_MS of being taken, and is not
 *     dated in the future (beyond a small clock allowance);
 *   - it was taken after the order left the hub;
 *   - its accuracy is within the live geofence's MAX_ACCURACY_M;
 *   - it is inside the order's own arrival geofence (same rule as live);
 *   - it fits the Rider's SERVER-recorded trail: the last trusted fix before
 *     it, and the first after it (when there is one), are reachable from it at
 *     a plausible motorcycle speed. With no trusted fix before it, it cannot
 *     be placed, so a person reviews it.
 * Anything else is never discarded and never completes the order: it goes to
 * the Dispatcher as a review (Needs action) with the evidence attached.
 *
 * The trail (riderLocationTrails/{uid}) is server-owned: built only from
 * riderLocations writes stored promptly after capture, so fixes queued offline
 * and uploaded late never enter it.
 */

const { PolicyError } = require("./policy");
const {
  MAX_ACCURACY_M,
  haversineMeters,
  isValidCoordinate,
  millisOf,
  normalizeOrderDestination,
} = require("./deliveryGeofence");

/** An offline record older than this on arrival goes to a person, not auto-completion. */
const MAX_OFFLINE_AGE_MS = 3 * 60 * 60 * 1000;

/** How far ahead of the server's clock a phone may claim a capture time. */
const MAX_CLOCK_AHEAD_MS = 2 * 60 * 1000;

/** Fastest plausible average speed between two fixes (90 km/h), plus a margin. */
const MAX_SPEED_MPS = 25;
const TRAIL_SLACK_M = 150;

/** Trail: trusted fixes only, at most one a minute unless the Rider moved. */
const TRAIL_COLLECTION = "riderLocationTrails";
const TRAIL_KEEP_MS = 4 * 60 * 60 * 1000;
const TRAIL_MIN_SPACING_MS = 60 * 1000;
const TRAIL_MIN_MOVE_M = 100;
const TRAIL_MAX_POINTS = 300;
/** A fix stored later than this after capture was queued (offline): not trusted. */
const TRAIL_MAX_STORE_DELAY_MS = 60 * 1000;

const REVIEW_COLLECTION_FIELD = "offlineCompletionReview";
const ALERT_REVIEW = "offline_completion_review";

/** Why an offline record needs a person (stable codes; messages for the Dispatcher). */
const REVIEW_REASONS = Object.freeze({
  too_old: "It reached VaxTrack more than 3 hours after it was recorded.",
  clock_ahead: "The phone's clock was ahead of VaxTrack's when it was recorded.",
  before_dispatch: "It was recorded before the order left the hub.",
  poor_accuracy: "The phone's GPS accuracy was too low to place the rider at the clinic.",
  outside_geofence: "The recorded position is outside the clinic's delivery area.",
  no_track: "There is no earlier tracked position to check it against.",
  implausible_track: "It does not fit the rider's tracked route around that time.",
  destination_invalid: "This order's clinic location is not configured correctly.",
  mocked_location: "The phone reported that a mock-location app supplied the recorded position.",
});

const ageText = (ms) => {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/**
 * The offline payload: { orderId, capture: { latitude, longitude, accuracyMeters,
 * capturedAtMs, mocked? } } only. mocked (optional, older builds omit it) is
 * the phone's own report that the fix came from a mock-location app.
 */
function parseOfflinePayload(payload) {
  const bad = (msg = "That offline delivery record could not be read.") => new PolicyError("invalid-payload", msg);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw bad();
  if (Object.keys(payload).some((k) => !["orderId", "capture"].includes(k))) throw bad("Only the delivery id and its recorded location may be sent.");
  const { orderId, capture } = payload;
  if (typeof orderId !== "string" || orderId.trim() === "" || orderId.includes("/")) throw bad("That delivery could not be identified.");
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) throw bad();
  if (Object.keys(capture).some((k) => !["latitude", "longitude", "accuracyMeters", "capturedAtMs", "mocked"].includes(k))) throw bad();
  const { latitude, longitude, accuracyMeters, capturedAtMs } = capture;
  if (capture.mocked !== undefined && typeof capture.mocked !== "boolean") throw bad();
  if (!isValidCoordinate(latitude, longitude)) throw bad();
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) throw bad();
  if (!Number.isInteger(capturedAtMs) || capturedAtMs <= 0) throw bad();
  return { orderId, capture: { lat: latitude, lng: longitude, accuracyM: accuracyMeters, capturedAtMs, mocked: capture.mocked === true } };
}

/**
 * A riderLocations document as a trail point, or null when it may not enter
 * the trail (not active, no position, poor accuracy, from a mock-location app,
 * or stored late — a fix that was queued offline).
 */
function trailPointFrom(location) {
  if (!location || location.trackingState !== "active") return null;
  if (location.mockedLocation === true) return null;
  if (!isValidCoordinate(location.latitude, location.longitude)) return null;
  const captured = millisOf(location.capturedAt);
  const written = millisOf(location.updatedAt);
  if (captured === null || written === null) return null;
  if (written - captured > TRAIL_MAX_STORE_DELAY_MS) return null;
  const acc = location.accuracyMeters;
  if (typeof acc !== "number" || !Number.isFinite(acc) || acc < 0 || acc > MAX_ACCURACY_M) return null;
  return { lat: location.latitude, lng: location.longitude, accuracyM: acc, atMs: Math.min(captured, written) };
}

/**
 * The trail with [point] added, or null when nothing changes (older than the
 * last point, or too close in time AND place to be worth keeping). Points
 * older than TRAIL_KEEP_MS are dropped; at most TRAIL_MAX_POINTS are kept.
 */
function appendTrailPoint(points, point, nowMs) {
  const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p?.atMs)) : [];
  const last = list[list.length - 1];
  if (last) {
    if (point.atMs <= last.atMs) return null;
    if (point.atMs - last.atMs < TRAIL_MIN_SPACING_MS && haversineMeters(last, point) < TRAIL_MIN_MOVE_M) return null;
  }
  const kept = [...list, point].filter((p) => p.atMs >= nowMs - TRAIL_KEEP_MS);
  return kept.slice(-TRAIL_MAX_POINTS);
}

/** Could the Rider have been at both points, given the time between them? */
function reachable(a, b) {
  const dtS = Math.abs(b.atMs - a.atMs) / 1000;
  const gap = haversineMeters(a, b) - (a.accuracyM ?? 0) - (b.accuracyM ?? 0);
  return gap <= MAX_SPEED_MPS * dtS + TRAIL_SLACK_M;
}

/**
 * Decide an offline record. Pure.
 *   order        the order (already checked: assigned to this Rider, in transit)
 *   capture      { lat, lng, accuracyM, capturedAtMs } from parseOfflinePayload
 *   trail        the Rider's trail points (riderLocationTrails/{uid}.points)
 *   receivedAtMs the server's time now
 * Returns { ok: true, distanceM, radiusM, ageMs } or { ok: false, reason }.
 */
function evaluateOfflineCapture({ order, capture, trail, receivedAtMs }) {
  const review = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  const destination = normalizeOrderDestination(order);
  if (!destination) return review("destination_invalid");
  if (capture.capturedAtMs > receivedAtMs + MAX_CLOCK_AHEAD_MS) return review("clock_ahead");
  const ageMs = Math.max(0, receivedAtMs - capture.capturedAtMs);
  if (ageMs > MAX_OFFLINE_AGE_MS) return review("too_old", { ageMs });
  const leftHubMs = millisOf(order.dispatchedAt) ?? millisOf(order.startedAt);
  if (leftHubMs !== null && capture.capturedAtMs < leftHubMs - MAX_CLOCK_AHEAD_MS) return review("before_dispatch", { ageMs });
  if (capture.accuracyM > MAX_ACCURACY_M) return review("poor_accuracy", { ageMs });
  const distanceM = haversineMeters(capture, destination);
  const summary = { distanceM: Math.ceil(distanceM), radiusM: destination.radiusM, ageMs };
  // Never automatic, wherever it claims to be; a person looks at the photos.
  if (capture.mocked) return review("mocked_location", summary);
  if (!(distanceM <= destination.radiusM)) return review("outside_geofence", summary);

  const points = (Array.isArray(trail) ? trail : []).filter((p) => Number.isFinite(p?.atMs));
  const at = { lat: capture.lat, lng: capture.lng, accuracyM: capture.accuracyM, atMs: capture.capturedAtMs };
  let before = null;
  let after = null;
  for (const p of points) {
    if (p.atMs <= at.atMs) before = p;
    else if (!after) after = p;
  }
  if (!before) return review("no_track", summary);
  if (!reachable(before, at) || (after && !reachable(at, after))) return review("implausible_track", summary);
  return { ok: true, ...summary };
}

/** The Dispatcher-facing sentence for a review reason. */
function reviewMessage(reason, { ageMs } = {}) {
  const base = REVIEW_REASONS[reason] ?? "It could not be verified automatically.";
  return reason === "too_old" && Number.isFinite(ageMs) ? `${base} (${ageText(ageMs)} after it was recorded)` : base;
}

const reviewAlertId = (orderId, capturedAtMs) => `offline_review_${orderId}_${capturedAtMs}`;

module.exports = {
  MAX_OFFLINE_AGE_MS,
  MAX_CLOCK_AHEAD_MS,
  MAX_SPEED_MPS,
  TRAIL_COLLECTION,
  TRAIL_KEEP_MS,
  TRAIL_MAX_POINTS,
  TRAIL_MAX_STORE_DELAY_MS,
  REVIEW_COLLECTION_FIELD,
  ALERT_REVIEW,
  REVIEW_REASONS,
  parseOfflinePayload,
  trailPointFrom,
  appendTrailPoint,
  evaluateOfflineCapture,
  reviewMessage,
  reviewAlertId,
};
