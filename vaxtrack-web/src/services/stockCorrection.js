/**
 * Admin stock-correction logic — pure and dependency-free.
 *
 * Correcting a batch's on-hand quantity fixes a RECORD: a data-entry error in
 * Add Stock, or a physical recount that differs from what was recorded. It is
 * deliberately NOT a general stock mover and NOT a way to remove unusable
 * doses: damaged, expired or recalled doses leave stock through Remove unusable
 * stock (quarantine, then dispose), which keeps their own audit trail.
 *
 * This mirrors the server's correctStockQuantity callable
 * (functions/src/inventoryRemoval.js), which is the authority: it re-checks
 * everything against the batch as it is when the correction commits, and
 * Firestore rules refuse every direct client write to a stock counter.
 */

export const MAX_CORRECTION_REASON_LENGTH = 500;
/** A meaningful explanation, not "x" — the same minimum the server applies. */
export const MIN_CORRECTION_REASON_LENGTH = 10;

/** The two kinds of correction — CORRECTION_REASON_CODES on the server. */
export const CORRECTION_REASON_CODES = Object.freeze(["entry_error", "count_discrepancy"]);
export const CORRECTION_REASON_LABELS = Object.freeze({
  entry_error: "Data-entry error (the figure was recorded wrong)",
  count_discrepancy: "Physical count differs from the record",
});

/** Reserved figure, defaulting a missing/blank value to zero (a legacy batch). */
export function readReserved(reservedQuantity) {
  return Number.isInteger(reservedQuantity) && reservedQuantity > 0
    ? reservedQuantity
    : 0;
}

/**
 * Validate a correction before it is sent. Returns the cleaned values on
 * success so the caller sends exactly what was checked.
 *
 * `currentQuantity` may be a non-integer for a data-corrupt batch (a quantity
 * stored as text); that is precisely a batch a correction should be ABLE to fix,
 * so the same-value and expired-decrease guards apply only when the current
 * value is itself a clean integer. `expired` is whether the batch's expiry date
 * has passed (Manila), from the shared expiry helper.
 */
export function validateStockCorrection({
  newQuantity,
  currentQuantity,
  reservedQuantity,
  // Stock back from a failed delivery and stock in quarantine is on hand too,
  // and the server keeps quantity >= reserved + returnPending + quarantined.
  returnPendingQuantity,
  quarantinedQuantity,
  reasonCode,
  reason,
  expired = false,
}) {
  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    return {
      ok: false,
      field: "quantity",
      message: "Enter the corrected quantity as a whole number of vials (0 or more).",
    };
  }

  const reserved = readReserved(reservedQuantity);
  if (newQuantity < reserved) {
    return {
      ok: false,
      field: "quantity",
      message:
        `This batch has ${reserved} vial(s) reserved for open orders, so the ` +
        `on-hand quantity cannot be set below ${reserved}. Cancel those orders first.`,
    };
  }

  const held = reserved + readReserved(returnPendingQuantity) + readReserved(quarantinedQuantity);
  if (newQuantity < held) {
    return {
      ok: false,
      field: "quantity",
      message:
        `This batch holds ${held} vial(s) that are reserved, returned awaiting a ` +
        `decision, or quarantined, so the on-hand quantity cannot be set below ${held}.`,
    };
  }

  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < MIN_CORRECTION_REASON_LENGTH) {
    return {
      ok: false,
      field: "reason",
      message:
        `Explain the correction in at least ${MIN_CORRECTION_REASON_LENGTH} characters — ` +
        "what was wrong and how the right figure was confirmed.",
    };
  }
  if (cleanReason.length > MAX_CORRECTION_REASON_LENGTH) {
    return {
      ok: false,
      field: "reason",
      message: `The reason must be ${MAX_CORRECTION_REASON_LENGTH} characters or fewer.`,
    };
  }

  if (!CORRECTION_REASON_CODES.includes(reasonCode)) {
    return {
      ok: false,
      field: "reasonCode",
      message: "Choose whether this fixes a data-entry error or a physical count difference.",
    };
  }

  if (Number.isInteger(currentQuantity) && newQuantity === currentQuantity) {
    return {
      ok: false,
      field: "quantity",
      message: "The corrected quantity is the same as the current quantity — nothing to change.",
    };
  }

  // Expired doses are unusable physical stock: quarantine, then dispose.
  if (expired && Number.isInteger(currentQuantity) && newQuantity < currentQuantity) {
    return {
      ok: false,
      field: "quantity",
      message:
        "This batch has expired. Expired doses must leave stock through Remove unusable stock (quarantine, then dispose), not a correction.",
    };
  }

  return { ok: true, value: { newQuantity, reasonCode, reason: cleanReason } };
}
