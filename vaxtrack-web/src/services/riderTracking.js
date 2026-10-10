// Rider live tracking — the web portal's view of the tracking contract.
//
// Pure (no Firebase), so pages and tests share one definition of what a rider
// marker shows. The AUTHORITATIVE contract is functions/src/riderTracking.js
// (server) and vaxtrack_mobile/lib/tracking/tracking_contract.dart (rider app);
// tests/riderTracking.test.js parses both and fails if these values drift.
//
// The web only DISPLAYS: riders write their own riderLocations/{uid}; the
// server decides route deviation (riderDeviationStates/{uid}) and raises the
// alert. Nothing here writes.

/** A rider is tracked while assigned to at least one order in these statuses. */
export const TRACKED_ORDER_STATUSES = Object.freeze(["assigned", "loading", "in_transit", "delayed"]);

/** Fix age (from capture time) that separates fresh / stale / offline. */
export const FRESHNESS = Object.freeze({ freshMs: 2 * 60 * 1000, offlineMs: 10 * 60 * 1000 });

/** The server's deviation rule, for display text only. */
export const DEVIATION_RULES = Object.freeze({
  offRouteMeters: 500,
  returnMeters: 400,
  confirmDeviationMs: 3 * 60 * 1000,
  confirmReturnMs: 2 * 60 * 1000,
  maxAccuracyMeters: 100,
});

export const TRACKING_COLLECTIONS = Object.freeze({
  LOCATIONS: "riderLocations",
  DEVIATION_STATES: "riderDeviationStates",
});

/** Marker states, most to least urgent. */
export const MARKER_STATES = Object.freeze(["deviating", "fresh", "stale", "offline", "unavailable"]);

export const MARKER_LABELS = Object.freeze({
  fresh: "Fresh",
  stale: "Stale",
  offline: "Offline",
  deviating: "Route Deviating",
  unavailable: "Location Unavailable",
});

export const DEVIATION_LABELS = Object.freeze({
  not_navigating: "Not navigating",
  route_unavailable: "Route not available",
  on_route: "On route",
  pending_deviation: "Off route — confirming",
  deviating: "Route deviating",
});

/**
 * Why the server would not use a stored route (riderDeviationStates
 * .routeUnavailableReason; mirrors ROUTE_UNAVAILABLE_REASONS on the server).
 */
export const ROUTE_UNAVAILABLE_LABELS = Object.freeze({
  missing: "no saved route",
  malformed: "the saved route could not be read",
  generated_before_assignment: "saved before the current assignment — regenerate it",
  destination_changed: "the destination changed — regenerate it",
});

/** "In Transit" / "in-transit" → "in_transit"; legacy aliases mapped. */
export function normalizeStatus(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return key === "completed" ? "delivered" : key === "canceled" ? "cancelled" : key;
}

export const isTrackedStatus = (status) => TRACKED_ORDER_STATUSES.includes(normalizeStatus(status));

/** Same validity rule as the server and the rider app: in range, not (0, 0). */
export function isValidCoordinate(lat, lng) {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Epoch millis from a Firestore Timestamp / Date / number, else null. */
export function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** [lat, lng] of a riderLocations doc, or null when it has no usable position. */
export function locationLatLng(location) {
  if (!location || location.trackingState === "ended") return null;
  return isValidCoordinate(location.latitude, location.longitude) ? [location.latitude, location.longitude] : null;
}

/**
 * When the position was true: min(capture time, server write time). A fix that
 * was queued offline and written late is shown as OLD, never as live.
 */
export function locationTimeMs(location) {
  const times = [millisOf(location?.capturedAt), millisOf(location?.updatedAt)].filter((v) => v !== null);
  return times.length ? Math.min(...times) : null;
}

/** fresh | stale | offline | unavailable. Mirrors server locationFreshness. */
export function locationFreshness(location, nowMs) {
  if (!location || !isValidCoordinate(location.latitude, location.longitude)) return "unavailable";
  if (location.trackingState === "ended") return "offline";
  const at = locationTimeMs(location);
  if (at === null) return "unavailable";
  const age = nowMs - at;
  if (age > FRESHNESS.offlineMs) return "offline";
  if (age > FRESHNESS.freshMs) return "stale";
  return "fresh";
}

/** Mirrors server deviationDisplayState. */
export function deviationDisplayState(stateDoc) {
  if (!stateDoc || stateDoc.sessionState !== "navigating") return "not_navigating";
  if (stateDoc.routeStatus !== "available") return "route_unavailable";
  if (stateDoc.phase === "deviating") return "deviating";
  if (stateDoc.pendingOffSinceMs != null) return "pending_deviation";
  return "on_route";
}

/** The route-monitoring line staff see, with the reason when there is no route. */
export function deviationText(stateDoc) {
  const display = deviationDisplayState(stateDoc);
  const reason = display === "route_unavailable" ? ROUTE_UNAVAILABLE_LABELS[stateDoc?.routeUnavailableReason] : null;
  return reason ? `${DEVIATION_LABELS[display]} (${reason})` : DEVIATION_LABELS[display];
}

/**
 * The one state a rider marker shows. A confirmed deviation outranks
 * freshness, but never invents a position: no coordinates → unavailable.
 */
export function riderMarkerState({ location, deviation, nowMs }) {
  const freshness = locationFreshness(location, nowMs);
  if (freshness === "unavailable") return "unavailable";
  if (deviationDisplayState(deviation) === "deviating") return "deviating";
  return freshness;
}

/** "Just now" / "4m ago" / "2h ago" / a date. */
export function formatAge(ms, nowMs) {
  if (ms === null || ms === undefined) return null;
  const min = Math.floor((nowMs - ms) / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Riders the Admin / Dispatcher fleet map shows: every rider with at least one
 * tracked order, with their active orders, joined to location + deviation
 * state + rider profile. Sorted most-urgent first, then by name.
 */
export function buildFleet({ orders, locations, deviations, riders, nowMs }) {
  const byRider = new Map();
  for (const order of orders || []) {
    const uid = order?.assignedRiderId;
    if (typeof uid !== "string" || uid === "" || !isTrackedStatus(order.status ?? order.rawStatus)) continue;
    if (!byRider.has(uid)) byRider.set(uid, []);
    byRider.get(uid).push(order);
  }
  const fleet = [];
  for (const [uid, riderOrders] of byRider) {
    const location = locations?.[uid] ?? null;
    const deviation = deviations?.[uid] ?? null;
    const profile = riders?.[uid] ?? null;
    const name =
      profile?.fullName || profile?.name || profile?.displayName ||
      riderOrders.find((o) => o.assignedRiderName)?.assignedRiderName || "Unnamed rider";
    const navigatingOrderId =
      deviation?.sessionState === "navigating" ? deviation.orderId ?? null : null;
    fleet.push({
      uid,
      name,
      phone: profile?.phone || profile?.contactNumber || riderOrders.find((o) => o.assignedRiderPhone)?.assignedRiderPhone || null,
      orders: riderOrders
        .map((o) => ({ id: o.id, orderNumber: o.orderNumber || o.id, clinicName: o.clinicName || null, status: normalizeStatus(o.status ?? o.rawStatus) }))
        .sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber))),
      location,
      latLng: locationLatLng(location),
      locationAtMs: locationTimeMs(location),
      accuracyMeters: Number.isFinite(location?.accuracyMeters) ? location.accuracyMeters : null,
      deviation: deviationDisplayState(deviation),
      deviationText: deviationText(deviation),
      // Distance at the last deviation transition (the server stores anchors,
      // not a per-fix distance), so it is labelled as such — never as live.
      deviationDistanceMeters: Number.isFinite(deviation?.distanceAtTransitionMeters) ? deviation.distanceAtTransitionMeters : null,
      navigatingOrderId,
      state: riderMarkerState({ location, deviation, nowMs }),
    });
  }
  const rank = (s) => MARKER_STATES.indexOf(s);
  return fleet.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

/** Count of riders per marker state (summary chips). */
export function countByState(fleet) {
  const counts = Object.fromEntries(MARKER_STATES.map((s) => [s, 0]));
  for (const r of fleet) counts[r.state] += 1;
  return counts;
}
