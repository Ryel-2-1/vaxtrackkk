/**
 * Delivery performance metrics — pure and dependency-free.
 *
 * Two figures the order history now makes honest:
 *
 *  - Average delivery time: FIRST dispatch → delivered. `firstDispatchedAt` is
 *    stamped once, server-side, by the status-history trigger
 *    (functions/src/statusEvents.js) the first time an order enters
 *    in_transit, and never moved again — so delays and resumed legs are inside
 *    the window. Orders dispatched before the history existed have no
 *    `firstDispatchedAt` and are simply not measured; nothing is back-filled.
 *
 *  - On-time rate: a delivered order is on time when its Manila delivery date is
 *    on or before its `requestedDeliveryDate` — the mandatory, server-validated
 *    date the Med Rep chose at checkout. That is the deadline; no other one is
 *    invented.
 */

import { isoDateOnly, manilaToday } from "./requestedDate.js";

/** Milliseconds from any timestamp shape the app sees, or null (never NaN). */
export function timestampMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const isDelivered = (order) => order.statusKey === "delivered" || order.statusKey === "completed";

/** First dispatch → delivered, over delivered orders whose dispatch was recorded. */
export function averageDeliveryTime(orders) {
  let sum = 0;
  let count = 0;
  for (const order of orders) {
    if (!isDelivered(order)) continue;
    const start = timestampMs(order.firstDispatchedAt);
    const end = timestampMs(order.deliveredAt);
    if (start == null || end == null || end <= start) continue;
    sum += end - start;
    count += 1;
  }
  return { averageMinutes: count ? sum / count / 60000 : null, count };
}

/** Delivered on or before the requested Manila date. */
export function onTimeStats(orders) {
  let measured = 0;
  let onTime = 0;
  for (const order of orders) {
    if (!isDelivered(order)) continue;
    const due = isoDateOnly(order.requestedDeliveryDate);
    const end = timestampMs(order.deliveredAt);
    if (!due || end == null) continue;
    measured += 1;
    if (manilaToday(new Date(end)) <= due) onTime += 1;
  }
  return {
    measured,
    onTime,
    late: measured - onTime,
    rate: measured ? onTime / measured : null,
  };
}

/** "42 min" below an hour; "1h 25m" at an hour or more; "—" when unavailable. */
export function formatDuration(minutes) {
  if (minutes == null) return "—";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

export function formatRate(rate) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}
