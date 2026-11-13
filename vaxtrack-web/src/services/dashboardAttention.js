import { isoDateOnly } from "./expiry.js";

/**
 * What the role dashboards raise as needing attention (2026-11-14). Pure.
 *
 * "Overdue before dispatch": the order has not left with a rider yet
 * (waiting for dispatch, assigned or loading) and its requested delivery day
 * is already in the past (Manila). Such an order needs a person: dispatch it,
 * or agree a new date with the Med Rep. An order with no valid date is not
 * counted here; the calendar lists those as needing scheduling.
 */
export const NOT_YET_DISPATCHED = Object.freeze(["pending_dispatch", "assigned", "loading"]);

export function isOverdueBeforeDispatch(order, todayIso) {
  if (!NOT_YET_DISPATCHED.includes(order?.statusKey)) return false;
  const date = isoDateOnly(order?.requestedDeliveryDate);
  return Boolean(date && todayIso && date < todayIso);
}

export function countOverdueBeforeDispatch(orders, todayIso) {
  return (Array.isArray(orders) ? orders : []).filter((o) => isOverdueBeforeDispatch(o, todayIso)).length;
}

/**
 * Why a Med Rep should follow up on one of their orders, or null (2026-11-14).
 * The same facts the Med Rep alerts use (deliveryTiming.lateNotice), plus an
 * order that has not left and whose requested day has passed. Cancelled and
 * delivered orders are history, not follow-up.
 */
export function medRepFollowUpReason(order, todayIso) {
  const status = order?.statusKey;
  if (status === "delivery_failed") return "Delivery failed";
  if (status === "delayed" || (status === "in_transit" && order?.timingStatus === "delayed")) return "Running late";
  if (["assigned", "loading", "in_transit"].includes(status) && order?.requestedArrivalMissedAt) return "Past the requested time";
  if (isOverdueBeforeDispatch(order, todayIso)) return "Past the requested date, not dispatched yet";
  return null;
}

/** The Med Rep's orders needing follow-up, most serious first, then oldest date. */
export function medRepFollowUps(orders, todayIso) {
  const rank = ["Delivery failed", "Running late", "Past the requested time", "Past the requested date, not dispatched yet"];
  return (Array.isArray(orders) ? orders : [])
    .map((order) => ({ order, reason: medRepFollowUpReason(order, todayIso) }))
    .filter((row) => row.reason)
    .sort((a, b) => rank.indexOf(a.reason) - rank.indexOf(b.reason)
      || String(a.order.requestedDeliveryDate || "").localeCompare(String(b.order.requestedDeliveryDate || "")));
}
