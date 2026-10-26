/**
 * What the Admin Riders page says about each Rider — computed only from data
 * that exists. Pure; no Firebase.
 *
 *  - Trip:            the server-owned trip state (riderDispatchStates), the
 *                     same labels Dispatch uses.
 *  - Current orders:  orders assigned to the Rider and not finished.
 *  - Delivered today: orders the Rider delivered on today's Manila date.
 *  - On-time rate:    deliveryMetrics.onTimeStats over the Rider's delivered
 *                     orders — the same definition as Admin Analytics
 *                     (delivered on or before the Med Rep's requested date).
 *                     Orders without a requested date are not measured.
 *  - Last location:   the newest location fix the rider app sent
 *                     (riderLocations). It is the only activity signal the
 *                     app records, so it is labelled as a location update,
 *                     never as "last active".
 *
 * Nothing is estimated: a figure with no data says so.
 */

import { onTimeStats, timestampMs, formatRate } from "./deliveryMetrics.js";
import { manilaToday } from "./requestedDate.js";
import { riderTripStatus } from "./riderTrip.js";
import { locationTimeMs, formatAge } from "./riderTracking.js";
import { orderReference } from "./orderLabel.js";

const ACTIVE = new Set(["assigned", "loading", "in_transit", "delayed"]);
const isDelivered = (o) => o?.statusKey === "delivered" || o?.statusKey === "completed";

/** riderUid → that Rider's orders. */
export function ordersByRider(orders) {
  const map = new Map();
  for (const order of orders || []) {
    const uid = typeof order?.assignedRiderId === "string" ? order.assignedRiderId : "";
    if (!uid) continue;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(order);
  }
  return map;
}

/** The newest location fix, as words. */
export function lastLocationText(location, nowMs) {
  const ms = location ? locationTimeMs(location) : null;
  if (ms === null || ms === undefined) return "No location received yet";
  const age = formatAge(ms, nowMs);
  return location?.trackingState === "ended" ? `${age} (tracking ended)` : age;
}

/** "83% (10 of 12)" / "No measured deliveries yet". */
export function onTimeText(stats) {
  if (!stats || !stats.measured) return "No measured deliveries yet";
  return `${formatRate(stats.rate)} (${stats.onTime} of ${stats.measured})`;
}

/**
 * Everything the Riders page shows for one Rider.
 * @param {{ rider: {uid: string, statusRaw: string}, orders?: object[], tripState?: object, location?: object, nowMs?: number }} args
 */
export function riderActivity({ rider, orders = [], tripState, location, nowMs = Date.now() }) {
  const today = manilaToday(new Date(nowMs));
  const active = orders.filter((o) => ACTIVE.has(o?.statusKey));
  const delivered = orders.filter(isDelivered);
  const deliveredToday = delivered.filter((o) => {
    const ms = timestampMs(o.deliveredAt);
    return ms !== null && manilaToday(new Date(ms)) === today;
  }).length;
  const onTime = onTimeStats(delivered);
  const approved = rider?.statusRaw === "approved";

  return {
    // Only an approved Rider has a trip; for the others their account status
    // is the whole story.
    trip: approved ? riderTripStatus(tripState) : null,
    currentOrders: active.map((o) => orderReference(o, "Order without a reference")),
    deliveredToday,
    onTime,
    onTimeText: onTimeText(onTime),
    lastLocation: lastLocationText(location, nowMs),
  };
}

/** Fleet-wide on-time figure over every delivered order that had a Rider. */
export function fleetOnTime(orders) {
  return onTimeStats((orders || []).filter((o) => typeof o?.assignedRiderId === "string" && o.assignedRiderId && isDelivered(o)));
}
