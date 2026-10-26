"use strict";

/**
 * Stale rider location — the contract (pure: no Firestore, no SDK).
 * Transactions: riderLocationStaleOps.js.
 *
 * WHAT IT WATCHES
 *   A Rider on a DEPARTED, server-owned trip: riderDispatchStates/{rider}.state
 *   == "on_trip" whose `tripId` names a riderTrips document of THAT Rider. A
 *   forming trip (not left yet) and a Rider returning to the hub (every order
 *   finished) are never watched. The route optimizer's client-generated
 *   `tripId` on orders is never read.
 *
 * WHAT COUNTS AS A CURRENT FIX (trustworthyFixMs)
 *   riderLocations/{rider} with coordinates, not `ended`, whose SERVER write
 *   time (`updatedAt`, pinned to request.time by firestore.rules) is within
 *   maxDeliveryLagMs of the device capture time — a fix replayed late from an
 *   offline queue says where the phone WAS, not that it is reporting now. The
 *   fix's time is the capture time, never later than the server write.
 *
 * WHEN IT IS STALE
 *   No current fix for staleAfterMs (10 min), measured from the LATER of the
 *   trip's departure and the last current fix. A fix from before departure
 *   never counts. Detection is the 5-minute scheduled sweep, so a phone that
 *   went offline — and therefore writes nothing — still raises the alert.
 *
 * THE DEPARTURE ANCHOR
 *   riderDispatchStates.departedAt — server time written by Finalize Dispatch
 *   (or by the reconciler when it adopted a departure). A legacy trip with no
 *   departure time is anchored at the moment the sweep FIRST observed it on
 *   the road (stored, server time). Nothing earlier is invented, so the alert
 *   can only come later than it ideally would, never falsely early.
 *
 * ONE INCIDENT PER RIDER AND TRIP
 *   Alert `rider_location_stale_<rider>_<trip>`. Fresh again → resolved; stale
 *   again on the same trip → the same alert reopens (episodeCount + 1). The
 *   trip ending (returning, available, re-forming) resolves it.
 */

const STALE_RULES = Object.freeze({
  staleAfterMs: 10 * 60 * 1000,
  /** A fix written more than this after capture was replayed from an offline queue. */
  maxDeliveryLagMs: 2 * 60 * 1000,
});

const ALERT_TYPE = "rider_location_stale";
const ID_PART = /^[A-Za-z0-9_-]{1,128}$/;

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  return null;
}

const validCoord = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/**
 * The time of the Rider's current, trustworthy fix, or null. Server write time
 * decides "is reporting now"; capture time (clamped to it) is the fix's time.
 */
function trustworthyFixMs(location, rules = STALE_RULES) {
  if (!location || location.trackingState === "ended") return null;
  if (!validCoord(location.latitude, location.longitude)) return null;
  const writtenMs = millisOf(location.updatedAt);
  const capturedMs = millisOf(location.capturedAt);
  if (writtenMs === null || capturedMs === null) return null;
  if (writtenMs - capturedMs > rules.maxDeliveryLagMs) return null;
  return Math.min(capturedMs, writtenMs);
}

function alertId(riderUid, tripId) {
  if (!ID_PART.test(riderUid ?? "") || !ID_PART.test(tripId ?? "")) throw new Error("unsafe id part");
  return `${ALERT_TYPE}_${riderUid}_${tripId}`;
}

/**
 * The trip being watched, or why there is none.
 *   { watched: true, tripId, departedMs|null }  departed, server-owned trip
 *   { watched: false, reason }                  forming / returning / unproven …
 */
function watchedTrip({ riderUid, state, trip }) {
  if (!state) return { watched: false, reason: "no_trip_state" };
  if (state.state !== "on_trip") return { watched: false, reason: state.state === "returning_to_hub" ? "returning" : "not_departed" };
  const tripId = typeof state.tripId === "string" && ID_PART.test(state.tripId) ? state.tripId : null;
  if (!tripId) return { watched: false, reason: "no_server_trip" };
  // Only a trip document of THIS Rider proves the trip is real and theirs.
  if (!trip || trip.riderUid !== riderUid) return { watched: false, reason: "trip_unproven" };
  return { watched: true, tripId, departedMs: millisOf(state.departedAt) ?? millisOf(trip.departedAt) };
}

/**
 * The decision for one Rider at server time `nowMs`, from documents read in one
 * transaction:
 *   state     riderDispatchStates/{rider}       trip  riderTrips/{state.tripId}
 *   location  riderLocations/{rider}            watch riderLocationWatches/{rider}
 *   alert     the CURRENT trip's stale alert (null when none), and
 *   previousAlert  the watched-before trip's alert, when the trip changed.
 *
 * Returns { watch, alert, previousAlert } — each the write to make, or null:
 *   watch: { set: {...} } | { close: true }
 *   alert: { create: {...} } | { reopen: {...} } | { resolve: reason }
 */
function staleDecision({ riderUid, state, trip, location, watch, alert, previousAlert = null, nowMs, rules = STALE_RULES }) {
  const target = watchedTrip({ riderUid, state, trip });
  const out = { watch: null, alert: null, previousAlert: null, stale: false, target };
  const watchedTripId = typeof watch?.tripId === "string" ? watch.tripId : null;
  const watchOpen = watch && watch.status !== "closed";

  // The trip the watch was on is over (or replaced): resolve its open alert.
  if (watchOpen && watchedTripId && (!target.watched || target.tripId !== watchedTripId)) {
    if (previousAlert?.status === "active") {
      out.previousAlert = { resolve: target.watched ? "trip_superseded" : "trip_ended" };
    }
  }
  if (!target.watched) {
    if (watchOpen) out.watch = { close: true, reason: target.reason };
    return out;
  }

  // The departure anchor: the stored departure, else the first observation.
  const sameTrip = watchOpen && watchedTripId === target.tripId;
  let anchorMs = target.departedMs;
  let anchorSource = "departure";
  if (anchorMs === null) {
    anchorMs = sameTrip ? millisOf(watch.anchorAt) : null;
    anchorSource = "first_observed";
    if (anchorMs === null) anchorMs = nowMs;
  }
  const fixMs = trustworthyFixMs(location, rules);
  const lastSignalMs = fixMs !== null && fixMs > anchorMs ? fixMs : anchorMs;
  const stale = nowMs - lastSignalMs >= rules.staleAfterMs;
  out.stale = stale;

  const alertActive = alert?.status === "active";
  // Raise only on ENTERING stale. An episode already raised (the watch says
  // stale) is not raised again — so an alert an Admin resolved by hand stays
  // resolved until the location has been fresh in between.
  const enteringStale = stale && !(sameTrip && watch.status === "stale");
  if (enteringStale && !alertActive) {
    const fields = { staleSinceMs: lastSignalMs, lastFixMs: fixMs !== null && fixMs > anchorMs ? fixMs : null, anchorSource };
    out.alert = alert ? { reopen: fields } : { create: fields };
  } else if (!stale && alertActive) {
    out.alert = { resolve: "location_updating" };
  }

  const nextStatus = stale ? "stale" : "watching";
  const changed =
    !sameTrip ||
    watch.status !== nextStatus ||
    millisOf(watch.anchorAt) !== anchorMs ||
    watch.anchorSource !== anchorSource;
  if (changed) {
    out.watch = { set: { tripId: target.tripId, anchorMs, anchorSource, status: nextStatus } };
  }
  return out;
}

/** Alert wording from display fields only: a name and minutes, never a place or an id. */
function staleAlertText({ status, riderName, minutes, resolutionReason }) {
  const rider = typeof riderName === "string" && riderName.trim() ? riderName.trim() : "The rider";
  if (status === "resolved") {
    if (resolutionReason === "location_updating") return `${rider}'s location is updating again.`;
    return `${rider}'s trip has ended, so location monitoring stopped.`;
  }
  const mins = Number.isFinite(minutes) && minutes >= 10 ? Math.floor(minutes) : 10;
  return `${rider}'s location hasn't updated for ${mins} minutes during a delivery trip. ` +
    "Check that the rider app is open and has signal.";
}

module.exports = {
  STALE_RULES,
  ALERT_TYPE,
  millisOf,
  trustworthyFixMs,
  alertId,
  watchedTrip,
  staleDecision,
  staleAlertText,
};
