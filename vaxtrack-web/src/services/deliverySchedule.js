/**
 * Delivery Calendar — pure rules, no Firebase import (runs under node --test).
 *
 * THE AUTHORITATIVE SCHEDULE is the order's `requestedDeliveryDate` — a
 * 'YYYY-MM-DD' Manila calendar day, the same field dispatch eligibility and the
 * Firestore rules gate on — plus the optional `scheduledDeliveryTime` ('HH:MM',
 * Asia/Manila) that only an Admin reschedule sets. `originalRequestedDeliveryDate`
 * is audit only: the Med Rep's first request, captured on the first reschedule.
 * An order without a real date is UNSCHEDULED — never given a placeholder day.
 *
 * Urgency orders the list (Urgent first). It never affects any fee or figure.
 */

import { isoDateOnly } from "./requestedDate.js";
import { manilaToday } from "./deliveryCalendar.js";

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const PRIORITY_FILTERS = Object.freeze([
  { value: "all", label: "All priorities" },
  { value: "urgent", label: "Urgent" },
  { value: "standard", label: "Standard" },
]);

/** Urgent is the only elevated priority; anything else ("Standard", legacy "Normal") is standard. */
export function isUrgent(order) {
  return String(order?.priority ?? "").trim().toLowerCase() === "urgent";
}

export function priorityLabel(order) {
  return isUrgent(order) ? "Urgent" : "Standard";
}

/** The schedule's date, or null when the order has no real one. */
export function scheduledDateOf(order) {
  return isoDateOnly(order?.requestedDeliveryDate);
}

/** The scheduled time 'HH:MM', or null when none (or malformed). */
export function scheduledTimeOf(order) {
  const t = order?.scheduledDeliveryTime;
  return typeof t === "string" && TIME_PATTERN.test(t) ? t : null;
}

function shortDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "9:30 AM" from '09:30' — the time is Manila wall-clock, shown as stored. */
export function formatScheduleTime(hhmm) {
  if (!TIME_PATTERN.test(hhmm ?? "")) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Oct 6, 2026 · 9:30 AM", "Oct 6, 2026", or "Unscheduled". */
export function scheduleLabel(order) {
  const date = scheduledDateOf(order);
  if (!date) return "Unscheduled";
  const time = scheduledTimeOf(order);
  return time ? `${shortDate(date)} · ${formatScheduleTime(time)}` : shortDate(date);
}

/** The Med Rep's original request when an Admin has since moved it, else null. */
export function originalRequestNote(order) {
  const original = isoDateOnly(order?.originalRequestedDeliveryDate);
  const current = scheduledDateOf(order);
  if (!original || original === current) return null;
  return `Originally requested for ${shortDate(original)}`;
}

/**
 * Calendar ordering within a day: Urgent before Standard, then by scheduled
 * time (an order with a time before one without), then order number.
 */
export function compareCalendarOrders(a, b) {
  const urgency = Number(isUrgent(b)) - Number(isUrgent(a));
  if (urgency !== 0) return urgency;
  const ta = scheduledTimeOf(a);
  const tb = scheduledTimeOf(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta < tb ? -1 : 1;
  }
  return String(a?.orderNumber ?? a?.id ?? "").localeCompare(String(b?.orderNumber ?? b?.id ?? ""));
}

/**
 * Apply the status and priority filters. `status` is a canonical status key
 * (or "all"), matched against the `statusType` deliveryService already derives;
 * `priority` is "all" | "urgent" | "standard".
 */
export function filterCalendarOrders(orders, { status = "all", priority = "all" } = {}) {
  return (Array.isArray(orders) ? orders : []).filter((o) => {
    if (status !== "all" && o?.statusType !== status) return false;
    if (priority === "urgent" && !isUrgent(o)) return false;
    if (priority === "standard" && isUrgent(o)) return false;
    return true;
  });
}

/** Orders on one Manila day, Urgent first. */
export function calendarDay(orders, iso) {
  const target = isoDateOnly(iso);
  if (!target) return [];
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => scheduledDateOf(o) === target)
    .sort(compareCalendarOrders);
}

/** Per-day counts, plus how many of each day are Urgent (for the markers). */
export function calendarCounts(orders) {
  const counts = {};
  const urgent = {};
  for (const o of Array.isArray(orders) ? orders : []) {
    const d = scheduledDateOf(o);
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
    if (isUrgent(o)) urgent[d] = (urgent[d] || 0) + 1;
  }
  return { counts, urgent };
}

/** Orders without a real date, Urgent first. Shown as "Unscheduled". */
export function unscheduledOrders(orders, { activeOnly = true } = {}) {
  const ACTIVE = new Set(["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivery_failed"]);
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => !scheduledDateOf(o) && (!activeOnly || ACTIVE.has(o?.statusType)))
    .sort(compareCalendarOrders);
}

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * What a calendar entry shows about where the delivery goes, read from the
 * order's own snapshot (doctor-first orders) with the legacy clinic fields as
 * fallback. Missing values stay null — the UI says "Not recorded".
 */
export function eventDestination(order) {
  return {
    doctor: text(order?.doctorName),
    clinic: text(order?.destinationName) ?? text(order?.clinicName),
    location: text(order?.deliveryAddress) ?? text(order?.clinicAddress),
  };
}

/**
 * The Med Rep who placed the order: resolved from the user directory by uid
 * (Admin can read it), else a name/email snapshot the order itself carries
 * (legacy orders). Never guessed — null when neither exists. Dispatchers cannot
 * read Med Rep user documents, so for them only the snapshot can answer.
 */
export function medRepNameFor(order, usersById) {
  const uid = typeof order?.createdByUid === "string" ? order.createdByUid : "";
  const user = uid && usersById ? usersById.get(uid) : null;
  return (
    text(user?.fullName) ?? text(user?.name) ?? text(user?.displayName) ??
    text(order?.salesRepName) ?? text(order?.createdByEmail) ?? null
  );
}

/** Statuses a reschedule is allowed from (everything except finished orders). */
export function canReschedule(order) {
  return !["delivered", "cancelled"].includes(order?.statusType);
}

export const RESCHEDULE_MESSAGES = Object.freeze({
  dateRequired: "Choose a delivery date.",
  dateInvalid: "Choose a real delivery date.",
  datePast: "A delivery cannot be scheduled for a day that has already passed.",
  timeInvalid: "Enter a delivery time as HH:MM (00:00–23:59), or leave it blank.",
  unchanged: "That is already this order's delivery schedule.",
});

/**
 * The same checks rescheduleOrderDelivery applies (functions/src/
 * scheduleOperations.js), for immediate feedback. The server is authoritative.
 */
export function validateReschedule({ date, time, order, todayIso = manilaToday() } = {}) {
  const fail = (key) => ({ ok: false, message: RESCHEDULE_MESSAGES[key] });
  if (typeof date !== "string" || date.trim() === "") return fail("dateRequired");
  const iso = isoDateOnly(date);
  if (!iso) return fail("dateInvalid");
  if (iso < todayIso) return fail("datePast");
  const t = typeof time === "string" ? time.trim() : "";
  if (t && !TIME_PATTERN.test(t)) return fail("timeInvalid");
  const nextTime = t || null;
  if (order && scheduledDateOf(order) === iso && scheduledTimeOf(order) === nextTime) return fail("unchanged");
  return { ok: true, value: { requestedDeliveryDate: iso, scheduledDeliveryTime: nextTime } };
}
