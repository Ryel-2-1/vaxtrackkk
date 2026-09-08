/**
 * Expiry condition for a stock batch.
 *
 * `inventory.status` is stamped ONCE, when Add Stock creates the batch, from
 * the expiry date as it stood that day. Nothing ever recomputes it: the only
 * other write to an inventory document is the re-price, and the server's
 * settlement touches quantity and reservedQuantity only. So a batch added six
 * months before it expires reads "Stable" for the whole of those six months,
 * including after it has expired.
 *
 * The expiry DATE is the authority for the current condition, and it is already
 * the authority on the server: `evaluateBatch` refuses a batch whose date is
 * unparseable or past regardless of what its status says. This module gives the
 * web the same rule, so the pages agree with the server and with each other.
 *
 * Nothing here writes. A corrected status is never persisted — that would need
 * a migration and a writer to keep it true, which is the arrangement that
 * produced the stale field in the first place.
 *
 * Every function is pure and takes its reference date explicitly, so no React
 * render reads the clock. Callers resolve `manilaToday(Date.now())` once, where
 * the data arrives, and pass the result down.
 */

/** Asia/Manila is UTC+8 year-round — no daylight saving to account for. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The existing business thresholds, unchanged. Taken from `getBatchStatus` in
 * Add Stock, which is what wrote every stored value: 30 days or fewer is
 * critical, 90 or fewer is a warning.
 */
export const CRITICAL_WITHIN_DAYS = 30;
export const WARNING_WITHIN_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Today's date in Manila as "YYYY-MM-DD".
 *
 * @param {number} nowMs epoch milliseconds — passed in, never read here.
 */
export function manilaToday(nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  return new Date(nowMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * "YYYY-MM-DD" if the value is exactly that, else null. Never guesses a date.
 *
 * The round-trip guard is what rejects "2026-02-31", which `Date` would
 * silently roll over to March 3rd. Mirrors `isoDateOnly` in functions/policy.js
 * so the two sides cannot disagree about what a valid date is.
 */
export function isoDateOnly(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * Whole days from `todayIso` to `expiryIso`, both date-only Manila dates.
 * 0 on the expiry date itself, negative once past. Null if either is unusable.
 */
export function daysUntilExpiry(expiryDate, todayIso) {
  const expiry = isoDateOnly(expiryDate);
  const today = isoDateOnly(todayIso);
  if (expiry === null || today === null) return null;
  return Math.round(
    (Date.parse(`${expiry}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / MS_PER_DAY
  );
}

/** Levels, worst first. `unknown` is a real answer, not a default. */
export const EXPIRY_LEVELS = Object.freeze([
  "expired",
  "critical",
  "warning",
  "stable",
  "unknown",
]);

const LABELS = Object.freeze({
  expired: "Expired",
  critical: "Expiring soon",
  warning: "Expiring later",
  stable: "In date",
  unknown: "No expiry date",
});

/**
 * The batch's expiry condition right now.
 *
 * A stored `status` is never consulted. Stock is usable through the whole of
 * its expiry date, so expiry is strictly-before-today in Manila — the same
 * boundary the server applies.
 *
 * A missing or malformed date returns `unknown`, never `stable`: not knowing
 * when something expires is not the same as knowing it is fine, and the server
 * refuses such a batch outright.
 *
 * @param {object} batch    raw inventory document
 * @param {string} todayIso today in Manila, from `manilaToday(Date.now())`
 */
export function deriveExpiryCondition(batch, todayIso) {
  const expiry = isoDateOnly(batch?.expiryDate);
  const today = isoDateOnly(todayIso);

  if (expiry === null || today === null) {
    return { level: "unknown", label: LABELS.unknown, daysRemaining: null, expiryDate: null };
  }

  const daysRemaining = daysUntilExpiry(expiry, today);
  const level =
    expiry < today
      ? "expired"
      : daysRemaining <= CRITICAL_WITHIN_DAYS
        ? "critical"
        : daysRemaining <= WARNING_WITHIN_DAYS
          ? "warning"
          : "stable";

  return { level, label: LABELS[level], daysRemaining, expiryDate: expiry };
}

/** True when the batch cannot be ordered on expiry grounds. Mirrors the server. */
export function isExpiredOrUndated(batch, todayIso) {
  const { level } = deriveExpiryCondition(batch, todayIso);
  return level === "expired" || level === "unknown";
}
