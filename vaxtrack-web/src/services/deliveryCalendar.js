/**
 * Delivery-calendar logic — pure and dependency-free.
 *
 * The planner (Sales Rep dashboard) and the day-view (Dispatcher schedule) both
 * lay orders out on a month grid keyed by their optional `requestedDeliveryDate`
 * (a 'YYYY-MM-DD' date-only value, Manila time — see requestedDate.js /
 * functions policy.js). Everything here is date arithmetic and grouping with no
 * React and no Firestore, so the awkward parts — month rollover, the leading and
 * trailing days that pad a grid, "which orders have no date" — are exercised as
 * plain functions by tests rather than only through the UI.
 */

import { isoDateOnly, manilaToday } from "./requestedDate.js";

// All grid maths is done in UTC on date-only values. The dates carry no time and
// no zone; using UTC everywhere keeps "the 1st of the month" from sliding into
// the 30th under a negative local offset. "Today" still comes from manilaToday
// so the highlighted cell matches the same definition the order form validates.
export { manilaToday, isoDateOnly };

/**
 * Move a year/month(0-based) by a whole number of months, normalising overflow.
 * addMonths(2026, 11, 1) -> { year: 2027, month: 0 }.
 */
export function addMonths(year, month, delta) {
  const base = new Date(Date.UTC(year, month + delta, 1));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() };
}

/** The {year, month} a given ISO date falls in, or null when it is not a date. */
export function monthOf(iso) {
  const valid = isoDateOnly(iso);
  if (!valid) return null;
  const d = new Date(`${valid}T00:00:00.000Z`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/** Human month heading, e.g. "September 2026". */
export function monthLabel(year, month) {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short weekday headers, Sunday first (matches the en-US grids used elsewhere). */
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A fixed six-row (42-cell) month grid, Sunday-first, as weeks of day cells.
 *
 * Six rows always, so the calendar never changes height between a 28-day
 * February that fits in five rows and a 31-day month that needs six — a jumping
 * layout is the usual bug here. Leading/trailing cells belong to the
 * neighbouring months and are marked `inMonth: false` so the UI can dim them.
 *
 * @param {number} year
 * @param {number} month  0-based
 * @param {{ today?: string }} [opts]
 * @returns {{ iso: string, day: number, inMonth: boolean, isToday: boolean,
 *            weekday: number }[][]}  weeks -> days
 */
export function buildMonthGrid(year, month, { today = manilaToday() } = {}) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const weeks = [];
  for (let row = 0; row < 6; row += 1) {
    const week = [];
    for (let col = 0; col < 7; col += 1) {
      const offset = row * 7 + col - firstWeekday;
      const cell = new Date(Date.UTC(year, month, 1 + offset));
      const iso = cell.toISOString().slice(0, 10);
      week.push({
        iso,
        day: cell.getUTCDate(),
        inMonth: cell.getUTCMonth() === month,
        isToday: iso === today,
        weekday: cell.getUTCDay(),
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Split orders into those with a valid requested date and those without.
 *
 * The date is optional, and every order that predates the feature has none, so
 * "unscheduled" is a first-class bucket — never dropped, never silently folded
 * into today. Orders with a malformed date land in `unscheduled` too: better
 * shown out of band than hidden on a day that does not exist.
 *
 * @param {Array<object>} orders
 * @param {{ dateField?: string }} [opts]
 * @returns {{ byDate: Map<string, object[]>, unscheduled: object[] }}
 */
export function groupOrdersByRequestedDate(orders, { dateField = "requestedDeliveryDate" } = {}) {
  const byDate = new Map();
  const unscheduled = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const iso = isoDateOnly(order?.[dateField]);
    if (!iso) {
      unscheduled.push(order);
      continue;
    }
    const bucket = byDate.get(iso);
    if (bucket) bucket.push(order);
    else byDate.set(iso, [order]);
  }
  return { byDate, unscheduled };
}

/**
 * Per-day counts for the little markers on each cell, as a plain object so the
 * component can read `counts[iso]` without a Map. Undated orders contribute to
 * nothing here — they are surfaced through the unscheduled bucket instead.
 */
export function countsByDate(orders, { dateField = "requestedDeliveryDate" } = {}) {
  const { byDate } = groupOrdersByRequestedDate(orders, { dateField });
  const counts = {};
  for (const [iso, list] of byDate) counts[iso] = list.length;
  return counts;
}

/** Orders requested for one ISO day, in the order given. */
export function ordersOnDate(orders, iso, { dateField = "requestedDeliveryDate" } = {}) {
  const target = isoDateOnly(iso);
  if (!target) return [];
  return (Array.isArray(orders) ? orders : []).filter(
    (order) => isoDateOnly(order?.[dateField]) === target
  );
}
