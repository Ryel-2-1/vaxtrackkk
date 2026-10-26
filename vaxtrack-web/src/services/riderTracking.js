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

import { orderReference } from "./orderLabel.js";

/** A rider is tracked while assigned to at least one order in these statuses. */
export const TRACKED_ORDER_STATUSES = Object.freeze(["assigned", "loading", "in_transit", "delayed"]);

/**
 * Fix age that separates fresh / stale / offline — the one display boundary
 * every web view uses. Age is measured from the earlier of the fix's capture
 * time and the server's write time (locationTimeMs).
 *
 *   fresh    age <= 3 min
 *   stale    3 min < age <= 10 min
 *   offline  age > 10 min, or tracking explicitly ended
 *
 * The Fresh window must be longer than the rider app's stationary heartbeat
 * (one write at least every 2 min): at exactly 2 min a locked, stationary
 * phone showed Stale before its next heartbeat could arrive. 3 min leaves a
 * full minute for the heartbeat and its upload.
 */
export const FRESHNESS = Object.freeze({ freshMs: 3 * 60 * 1000, offlineMs: 10 * 60 * 1000 });

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

/**
 * A Rider whose trip is over (every order settled) but whose return to the hub
 * a Dispatcher has not confirmed yet: riderDispatchStates/{uid}.state, written
 * by the server only (functions/src/riderDispatch.js). The rider app keeps
 * sharing location until that confirmation. Arrival is NEVER inferred here —
 * not from coordinates, not from a missing or stale marker.
 */
export const TRIP_STATE_RETURNING = "returning_to_hub";
export const RETURNING_TO_HUB_LABEL = "Returning to hub";
export const RETURNING_MONITORING_TEXT = "Not monitored — no active delivery";

/** The server trip state of a rider: tripStates is a Map or a plain object of state docs. */
export function tripStateOf(tripStates, uid) {
  const doc = typeof tripStates?.get === "function" ? tripStates.get(uid) : tripStates?.[uid];
  return typeof doc?.state === "string" ? doc.state : null;
}

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

/**
 * fresh | stale | offline | unavailable, by the FRESHNESS boundaries.
 * Explicitly stopped tracking is Offline whatever its timestamp — the app
 * clears the coordinates when it stops, so this is checked before them.
 * Unavailable means no usable position was ever reported.
 */
export function locationFreshness(location, nowMs) {
  if (location?.trackingState === "ended") return "offline";
  if (!location || !isValidCoordinate(location.latitude, location.longitude)) return "unavailable";
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
  // No position to show: never reported, or sharing explicitly stopped.
  if (freshness === "unavailable" || location?.trackingState === "ended") return freshness;
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
 * state + rider profile — plus every rider the server says is returning to
 * the hub (tripStates), even with no active order. Sorted most-urgent first,
 * then by name.
 */
export function buildFleet({ orders, locations, deviations, riders, tripStates = null, nowMs }) {
  const byRider = new Map();
  for (const order of orders || []) {
    const uid = order?.assignedRiderId;
    if (typeof uid !== "string" || uid === "" || !isTrackedStatus(order.status ?? order.rawStatus)) continue;
    if (!byRider.has(uid)) byRider.set(uid, []);
    byRider.get(uid).push(order);
  }
  const tripUids = typeof tripStates?.keys === "function" ? [...tripStates.keys()] : Object.keys(tripStates || {});
  for (const uid of tripUids) {
    if (typeof uid === "string" && uid !== "" && !byRider.has(uid) && tripStateOf(tripStates, uid) === TRIP_STATE_RETURNING) {
      byRider.set(uid, []);
    }
  }
  const fleet = [];
  for (const [uid, riderOrders] of byRider) {
    const location = locations?.[uid] ?? null;
    // Returning with no active order: there is no route to monitor, so a
    // leftover deviation document is ignored rather than shown as live.
    const returningToHub = riderOrders.length === 0;
    const deviation = returningToHub ? null : deviations?.[uid] ?? null;
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
        // orderNumber is display text on the map and panels: never the document id.
        .map((o) => ({ id: o.id, orderNumber: orderReference(o, "Order without a number"), clinicName: o.clinicName || null, status: normalizeStatus(o.status ?? o.rawStatus) }))
        .sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber))),
      location,
      latLng: locationLatLng(location),
      locationAtMs: locationTimeMs(location),
      accuracyMeters: Number.isFinite(location?.accuracyMeters) ? location.accuracyMeters : null,
      deviation: deviationDisplayState(deviation),
      deviationText: returningToHub ? RETURNING_MONITORING_TEXT : deviationText(deviation),
      returningToHub,
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

// ---------------------------------------------------------------- Dispatcher dashboard overview

/** How many riders the dashboard overview lists before "+ N more riders". */
export const OVERVIEW_RIDER_LIMIT = 3;

/** Riders with an active delivery, and riders returning to the hub. */
export function fleetCounts(fleet) {
  const returning = (fleet || []).filter((r) => r.returningToHub).length;
  return { onDelivery: (fleet || []).length - returning, returning };
}

/** Uids of riders carrying at least one active (tracked) order. */
export function riderUidsOnDelivery(orders) {
  const uids = new Set();
  for (const o of orders || []) {
    const uid = o?.assignedRiderId;
    if (typeof uid === "string" && uid !== "" && isTrackedStatus(o.status ?? o.rawStatus)) uids.add(uid);
  }
  return uids;
}

/**
 * Riders genuinely free to take a delivery: approved accounts not currently
 * carrying an active order. (Not derived from live locations.)
 *
 * With the server's Rider trip states (`tripStates`, riderUid → state doc), a
 * Rider who has left on a trip or is returning to the hub is not free either,
 * even once their last order is delivered — they take new orders only after
 * a Dispatcher confirms they are back at the hub.
 */
export function availableRiderCount(riders, orders, tripStates = null) {
  const busy = riderUidsOnDelivery(orders);
  const away = (uid) => {
    const state = tripStates?.get?.(uid)?.state;
    return state === "on_trip" || state === "returning_to_hub";
  };
  return (riders || []).filter((r) => r?.status === "approved" && !busy.has(r.uid) && !away(r.uid)).length;
}

/**
 * Which view the overview shows. Errors are never shown as an empty result,
 * and nothing is counted while the feeds are still loading.
 *   permission | error | loading | empty (no rider on delivery)
 *   waiting (riders on delivery, none has a position) | live
 */
export function trackingOverviewState({ error, orders, locations, fleet }) {
  if (error === "permission") return "permission";
  if (error) return "error";
  if (!orders || !locations) return "loading";
  if (!fleet || fleet.length === 0) return "empty";
  if (!fleet.some((r) => r.latLng)) return "waiting";
  return "live";
}

/**
 * The overview's rider rows: the first `limit` riders in fleet order (most
 * urgent state first, then by name — buildFleet), and a "+ N more riders"
 * label for the rest. State and label come from buildFleet / MARKER_LABELS.
 */
export function trackingOverviewRows(fleet, nowMs, limit = OVERVIEW_RIDER_LIMIT) {
  const list = fleet || [];
  const rows = list.slice(0, limit).map((r) => {
    const count = r.orders.length;
    return {
      uid: r.uid,
      name: r.name,
      state: r.state,
      label: MARKER_LABELS[r.state],
      deliveryLabel: r.returningToHub ? RETURNING_TO_HUB_LABEL : `${count} ${count === 1 ? "delivery" : "deliveries"}`,
      returningToHub: Boolean(r.returningToHub),
      orderNumbers: r.orders.map((o) => o.orderNumber).join(", "),
      age: formatAge(r.locationAtMs, nowMs),
    };
  });
  const moreCount = Math.max(0, list.length - limit);
  return {
    rows,
    moreCount,
    moreLabel: moreCount > 0 ? `+ ${moreCount} more rider${moreCount === 1 ? "" : "s"}` : null,
  };
}
