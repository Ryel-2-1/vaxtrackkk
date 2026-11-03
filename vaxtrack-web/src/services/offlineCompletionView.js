/**
 * Offline delivery completion — what staff see and do (web).
 *
 * A Rider at a clinic with GPS but no signal records the handoff on the phone
 * and sends it once back online. The server (functions/src/offlineCompletion
 * .js) checks the recorded position against the clinic area and the Rider's
 * tracked trail: a record that fits completes the order with completionMode
 * "offline"; anything else waits on `offlineCompletionReview` (status
 * "pending") for a Dispatcher/Admin to approve or reject. Pure helpers
 * (no Firebase); the call is in offlineCompletion.js.
 */

export const OFFLINE_REVIEW_ALERT = "offline_completion_review";

/** Mirrors functions/src/offlineCompletion.js REVIEW_REASONS. */
export const OFFLINE_REVIEW_REASONS = Object.freeze({
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

const manilaTime = (ms) =>
  new Date(ms).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * How an order was completed, for the shipment views and the bell:
 * null for a normal (live) completion.
 */
export function offlineCompletionNote(order) {
  const mode = order?.completionMode;
  if (mode !== "offline" && mode !== "offline_approved") return null;
  const ev = order.offlineEvidence ?? {};
  const at = Number.isFinite(ev.capturedAtMs) ? manilaTime(ev.capturedAtMs) : null;
  const where = Number.isFinite(ev.distanceMeters) && Number.isFinite(ev.radiusMeters)
    ? `${Math.round(ev.distanceMeters)} m from the clinic (area ${ev.radiusMeters} m)` : null;
  const recorded = `Recorded on the rider's phone without signal${at ? ` at ${at}` : ""}`;
  return mode === "offline"
    ? `Completed offline. ${recorded}${where ? `, ${where}` : ""}; the position was verified when it was sent.`
    : `Completed offline after dispatcher review. ${recorded}${where ? `, ${where}` : ""}.`;
}

/** The pending review on an order, shaped for the review panel; null when none. */
export function pendingOfflineReview(order) {
  const r = order?.offlineCompletionReview;
  if (!r || r.status !== "pending") return null;
  return {
    reason: r.reason ?? null,
    reasonText: OFFLINE_REVIEW_REASONS[r.reason] ?? r.message ?? "It could not be verified automatically.",
    recordedAt: Number.isFinite(r.capturedAtMs) ? manilaTime(r.capturedAtMs) : null,
    receivedAt: Number.isFinite(r.receivedAtMs) ? manilaTime(r.receivedAtMs) : null,
    distanceMeters: Number.isFinite(r.distanceMeters) ? Math.round(r.distanceMeters) : null,
    radiusMeters: Number.isFinite(r.radiusMeters) ? r.radiusMeters : null,
    accuracyMeters: Number.isFinite(r.accuracyMeters) ? Math.round(r.accuracyMeters) : null,
    latitude: Number.isFinite(r.latitude) ? r.latitude : null,
    longitude: Number.isFinite(r.longitude) ? r.longitude : null,
  };
}

