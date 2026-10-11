/**
 * Scheduled-order dispatch eligibility — pure and dependency-free.
 *
 * Every order must carry a `requestedDeliveryDate`: a date-only 'YYYY-MM-DD'
 * string, interpreted as a Manila calendar day. It is written only by the
 * `createOrderWithReservation` callable (functions/src/policy.js →
 * normalizeRequestedDeliveryDate), which refuses an order without one.
 *
 * The rule FAILS CLOSED:
 *
 *   - a real 'YYYY-MM-DD' date → dispatchable from 00:00 Asia/Manila on that
 *                     day, and not one millisecond earlier.
 *   - field ABSENT  → `scheduled-date-missing`. Orders created before the date
 *                     became required. Not dispatchable until an authorized
 *                     correction stores a valid date. Nothing is migrated.
 *   - null, blank, malformed, an impossible date ("2026-02-31") or not a
 *                     string at all (e.g. a legacy Timestamp) →
 *                     `scheduled-date-invalid`. Same: blocked until corrected.
 *
 * "Dispatch" means any move INTO assigned, loading or in_transit. The same
 * instant is enforced in firestore.rules (`scheduleAllowsDispatch`), which is
 * the authority; this module is what the services' transactions and the
 * dispatcher UI check first, so a refused write is explained rather than
 * surfacing as a bare permission error.
 *
 * Every comparison is on an absolute instant computed from the date with a
 * fixed +08:00 offset — the Philippines has no daylight saving — so neither the
 * device's timezone nor the UTC calendar date can move the boundary.
 */

import { isoDateOnly } from "./requestedDate.js";

export const SCHEDULED_DATE_FIELD = "requestedDeliveryDate";

/** Stable, non-sensitive codes. Mirrored by the rules' refusal. */
export const SCHEDULED_DATE_NOT_REACHED = "scheduled-date-not-reached";
export const SCHEDULED_DATE_MISSING = "scheduled-date-missing";
export const SCHEDULED_DATE_INVALID = "scheduled-date-invalid";

export const MISSING_DATE_MESSAGE =
  "This order needs a delivery date before it can be dispatched.";
export const INVALID_DATE_MESSAGE =
  "This order has an invalid delivery date and cannot be dispatched.";

/** The statuses an order enters when it is assigned or dispatched. */
export const DISPATCH_STATUSES = Object.freeze(["assigned", "loading", "in_transit"]);

/** Statuses meaning the order has already left the pending queue on its way out. */
const DISPATCHED_STATUSES = Object.freeze(["assigned", "loading", "in_transit", "delayed"]);

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The instant 00:00 Asia/Manila begins on `iso` — i.e. 16:00 UTC the day
 * before. Null when `iso` is not a real date-only string.
 */
export function manilaStartOfDayMs(iso) {
  const valid = isoDateOnly(iso);
  if (!valid) return null;
  return Date.parse(`${valid}T00:00:00.000Z`) - MANILA_OFFSET_MS;
}

/** "Oct 4, 2026" for a date-only ISO string, independent of device timezone. */
export function formatScheduledDate(iso) {
  const valid = isoDateOnly(iso);
  if (!valid) return String(iso ?? "");
  return new Date(`${valid}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The operator-facing refusal for a not-yet-due order. */
export function notYetDispatchableMessage(iso) {
  return `This order is scheduled for ${formatScheduledDate(iso)} and cannot be dispatched yet.`;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.now();
}

/**
 * Whether `order` may be assigned or dispatched at `now`.
 *
 * Takes the RAW order data (or anything that spreads it), never a display
 * model that may have defaulted the date. A property that exists with the
 * value `undefined` is treated as absent: Firestore cannot store undefined, so
 * it can only mean a client object that never carried the field.
 *
 * @returns {{eligible: true, iso: string} |
 *           {eligible: false, code: string, message: string, iso: string|null}}
 */
export function dispatchEligibility(order, now = new Date()) {
  const hasField =
    order != null &&
    Object.prototype.hasOwnProperty.call(order, SCHEDULED_DATE_FIELD) &&
    order[SCHEDULED_DATE_FIELD] !== undefined;
  if (!hasField) {
    return { eligible: false, code: SCHEDULED_DATE_MISSING, message: MISSING_DATE_MESSAGE, iso: null };
  }

  const raw = order[SCHEDULED_DATE_FIELD];
  // Strict: the stored value must already BE the canonical string. Trimming
  // here would let "2026-10-04 " through while the rules refuse it.
  const iso = typeof raw === "string" ? isoDateOnly(raw) : null;
  if (iso === null || iso !== raw) {
    return { eligible: false, code: SCHEDULED_DATE_INVALID, message: INVALID_DATE_MESSAGE, iso: null };
  }

  if (toMs(now) < manilaStartOfDayMs(iso)) {
    return {
      eligible: false,
      code: SCHEDULED_DATE_NOT_REACHED,
      message: notYetDispatchableMessage(iso),
      iso,
    };
  }
  return { eligible: true, iso };
}

export function isDispatchEligible(order, now = new Date()) {
  return dispatchEligibility(order, now).eligible;
}

/**
 * Split the pending-dispatch queue.
 *   actionable — a valid date that has begun (due today or overdue)
 *   upcoming   — a valid future date; read-only until 00:00 Manila that day
 *   missing    — no date at all; "Needs scheduling", blocked until corrected
 *   invalid    — an unusable date; blocked until corrected
 */
export function partitionPendingDispatch(orders, now = new Date()) {
  const actionable = [];
  const upcoming = [];
  const missing = [];
  const invalid = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const result = dispatchEligibility(order, now);
    if (result.eligible) actionable.push(order);
    else if (result.code === SCHEDULED_DATE_NOT_REACHED) upcoming.push(order);
    else if (result.code === SCHEDULED_DATE_MISSING) missing.push(order);
    else invalid.push(order);
  }
  return { actionable, upcoming, missing, invalid };
}

/**
 * An order that has ALREADY been assigned or dispatched although its schedule
 * says it should not have been yet — data written before this guard existed.
 * Flagged for a human; never changed automatically.
 */
export function isEarlyDispatchAnomaly(order, statusKey, now = new Date()) {
  if (!DISPATCHED_STATUSES.includes(statusKey)) return false;
  const result = dispatchEligibility(order, now);
  return !result.eligible && result.code === SCHEDULED_DATE_NOT_REACHED;
}

/**
 * The next 00:00 Manila after `now`, in ms. Pages use it to re-evaluate the
 * queue at the boundary so a scheduled order becomes actionable on its day
 * without a reload and without any server-side scheduled job.
 */
export function nextManilaMidnightMs(now = new Date()) {
  const shifted = toMs(now) + MANILA_OFFSET_MS;
  const dayStart = shifted - (((shifted % 86400000) + 86400000) % 86400000);
  return dayStart + 86400000 - MANILA_OFFSET_MS;
}

// ---------------------------------------------------------------- queue order
// Shared by the Dispatcher Dashboard queue and the Assign Rider queue.

// How a pending order relates to its requested delivery date, measured against
// today (Manila). `none` = the order carries no valid date — such an order is
// never actionable (it sits in Needs scheduling), so the live queue only ever
// sees `overdue` and `today`.
export function requestedDateMeta(order, today) {
  const iso = isoDateOnly(order?.requestedDeliveryDate);
  if (!iso) return { kind: "none", iso: null };
  if (iso < today) return { kind: "overdue", iso };
  if (iso === today) return { kind: "today", iso };
  return { kind: "scheduled", iso };
}

const createdMs = (o) => o.createdAt?.toMillis?.() ?? 0;
const isUrgentOrder = (o) => (o?.priority || "").toLowerCase() === "urgent";

// Dispatch order: honour the schedule first. Dated orders come before undated;
// among dated ones the soonest date leads (so overdue floats to the very top);
// within a single date urgent wins; oldest-waiting breaks any remaining tie.
// Date-only ISO strings sort correctly lexicographically, so "today" isn't
// needed here — an earlier date is always earlier in the queue.
export function comparePending(a, b) {
  const isoA = isoDateOnly(a?.requestedDeliveryDate);
  const isoB = isoDateOnly(b?.requestedDeliveryDate);
  if ((isoA !== null) !== (isoB !== null)) return isoA !== null ? -1 : 1;
  if (isoA !== null && isoB !== null && isoA !== isoB) return isoA < isoB ? -1 : 1;
  const urgentDelta = (isUrgentOrder(a) ? 0 : 1) - (isUrgentOrder(b) ? 0 : 1);
  if (urgentDelta !== 0) return urgentDelta;
  return createdMs(a) - createdMs(b);
}
