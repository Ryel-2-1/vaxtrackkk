/**
 * Requested-delivery-date logic — pure and dependency-free.
 *
 * The Med Rep may OPTIONALLY add a booking date to an order. This is a UX
 * pre-check and the source of the date input's `min`; the Cloud Function
 * re-validates the same rule (functions/src/policy.js → normalizeRequestedDeliveryDate)
 * and is the real authority. Kept in step with it deliberately: date-only,
 * measured in Manila time, absent is allowed, and never in the past.
 */

// The Philippines has no daylight saving, so a fixed UTC+8 offset is exact and
// matches the server's manilaDateString. Using a fixed offset (not a locale
// formatter) keeps the two definitions of "today" identical.
const MANILA_OFFSET_MINUTES = 8 * 60;

/** Today's date in Manila as 'YYYY-MM-DD'. */
export function manilaToday(now = new Date()) {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** A real 'YYYY-MM-DD' calendar date, or null. Rejects "2026-02-31" etc. */
export function isoDateOnly(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * Validate the optional requested date.
 *   absent/blank -> ok with value null (the field is optional)
 *   present      -> must be a real date, today (Manila) or later
 */
export function validateRequestedDate(value, { today = manilaToday() } = {}) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, value: null };
  }
  const iso = isoDateOnly(value);
  if (iso === null) {
    return { ok: false, message: "Enter a valid delivery date." };
  }
  if (iso < today) {
    return { ok: false, message: "The requested date cannot be in the past." };
  }
  return { ok: true, value: iso };
}
