/**
 * Stock batch dates — pure, date-only, timezone-free (runs under `node --test`).
 *
 * Every batch date is stored as a 'YYYY-MM-DD' string and compared AS that
 * string: two valid date-only strings order correctly lexicographically, so no
 * value ever passes through `new Date("YYYY-MM-DD")`, which reads it as UTC
 * midnight and lands on the previous day for anyone west of UTC. "Today" is the
 * Asia/Manila calendar day (expiry.js `manilaToday`).
 *
 * The canonical stored field is `manufacturingDate`. No alias has ever been
 * written, so none is read; a batch created before this field existed simply
 * has none and shows "Not recorded" — no date is ever invented for it.
 */

import { isoDateOnly, manilaToday } from "./expiry.js";

export const NOT_RECORDED = "Not recorded";

/** Arrival may be scheduled up to this many days ahead (unchanged rule). */
export const MAX_FUTURE_ARRIVAL_DAYS = 30;

export const STOCK_DATE_MESSAGES = Object.freeze({
  manufacturingRequired: "Enter the manufacturing date.",
  manufacturingInvalid: "Enter a valid manufacturing date.",
  manufacturingFuture: "Manufacturing date cannot be in the future.",
  manufacturingAfterArrival: "Manufacturing date cannot be after the arrival date.",
  manufacturingNotBeforeExpiry: "Manufacturing date must be before the expiry date.",
  arrivalRequired: "Arrival date is required.",
  arrivalInvalid: "Arrival date is invalid.",
  arrivalTooFar: "Arrival date cannot be more than 30 days in the future.",
  expiryRequired: "Expiry date is required.",
  expiryInvalid: "Expiry date is invalid.",
  expiryNotAfterArrival: "Expiry date must be after the arrival date.",
  expired: "Expired stock cannot be added to inventory.",
});

/** `iso` + `days`, date-only, via UTC arithmetic (no local-time drift). */
export function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Validate the three dates of a NEW batch. Returns the first problem as
 * { ok: false, field, message }, or { ok: true, value } with the trimmed
 * canonical strings. `todayIso` is the Manila calendar day; it defaults to now.
 *
 * Manufacturing may equal arrival (made and received the same day) but must be
 * strictly before expiry. The arrival/expiry rules are the ones Add Stock
 * already enforced, now applied date-only.
 */
export function validateStockBatchDates({ manufacturingDate, arrivalDate, expiryDate, todayIso } = {}) {
  const today = todayIso ?? manilaToday(Date.now());
  const fail = (field, key) => ({ ok: false, field, message: STOCK_DATE_MESSAGES[key] });
  const blank = (v) => typeof v !== "string" || v.trim() === "";

  if (blank(manufacturingDate)) return fail("manufacturingDate", "manufacturingRequired");
  const mfg = isoDateOnly(manufacturingDate);
  if (!mfg) return fail("manufacturingDate", "manufacturingInvalid");
  if (mfg > today) return fail("manufacturingDate", "manufacturingFuture");

  if (blank(arrivalDate)) return fail("arrivalDate", "arrivalRequired");
  const arrival = isoDateOnly(arrivalDate);
  if (!arrival) return fail("arrivalDate", "arrivalInvalid");

  if (blank(expiryDate)) return fail("expiryDate", "expiryRequired");
  const expiry = isoDateOnly(expiryDate);
  if (!expiry) return fail("expiryDate", "expiryInvalid");

  // Manufacturing is checked against both other dates first, so each of its
  // messages can actually be shown (once arrival < expiry holds, mfg <= arrival
  // would already imply mfg < expiry).
  if (mfg > arrival) return fail("manufacturingDate", "manufacturingAfterArrival");
  if (mfg >= expiry) return fail("manufacturingDate", "manufacturingNotBeforeExpiry");

  if (arrival > addDaysIso(today, MAX_FUTURE_ARRIVAL_DAYS)) return fail("arrivalDate", "arrivalTooFar");
  if (expiry <= arrival) return fail("expiryDate", "expiryNotAfterArrival");
  if (expiry <= today) return fail("expiryDate", "expired");

  return { ok: true, value: { manufacturingDate: mfg, arrivalDate: arrival, expiryDate: expiry } };
}

/** The batch's manufacturing date as stored, or null when absent/unusable. */
export function readManufacturingDate(batch) {
  return isoDateOnly(batch?.manufacturingDate);
}

const DISPLAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", // the string IS the calendar day; format it as-is
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Oct 4, 2026" for a valid 'YYYY-MM-DD'; `fallback` for anything else — never "Invalid Date". */
export function formatBatchDate(value, fallback = NOT_RECORDED) {
  const iso = isoDateOnly(value);
  return iso ? DISPLAY.format(new Date(`${iso}T00:00:00.000Z`)) : fallback;
}
