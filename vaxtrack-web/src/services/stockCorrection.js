/**
 * Admin stock-correction logic — pure and dependency-free.
 *
 * Correcting a batch's on-hand quantity is the fix for a human error in Add
 * Stock or in a batch's recorded figure. It is deliberately NOT a general stock
 * mover: reservations, releases and consumption still happen only inside the
 * order callables' transactions. A correction changes `quantity` alone, and it
 * must respect the one invariant the whole reservation system rests on —
 * availability (quantity − reservedQuantity) can never go negative, so a
 * correction may never set quantity below what open orders have already
 * reserved. No Firebase here; vaccineService supplies the real read/write and
 * the Firestore rules enforce the same bound as the true authority.
 */

export const MAX_CORRECTION_REASON_LENGTH = 500;

/** Reserved figure, defaulting a missing/blank value to zero (a legacy batch). */
export function readReserved(reservedQuantity) {
  return Number.isInteger(reservedQuantity) && reservedQuantity > 0
    ? reservedQuantity
    : 0;
}

/**
 * Validate a correction before it is written. Returns the cleaned values on
 * success so the caller stores exactly what was checked.
 *
 * `currentQuantity` may be a non-integer for a data-corrupt batch (a quantity
 * stored as text); that is precisely a batch a correction should be ABLE to fix,
 * so the same-value no-op guard is only applied when the current value is itself
 * a clean integer.
 */
export function validateStockCorrection({
  newQuantity,
  currentQuantity,
  reservedQuantity,
  reason,
}) {
  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    return {
      ok: false,
      message: "Enter the corrected quantity as a whole number of vials (0 or more).",
    };
  }

  const reserved = readReserved(reservedQuantity);
  if (newQuantity < reserved) {
    return {
      ok: false,
      message:
        `This batch has ${reserved} vial(s) reserved for open orders, so the ` +
        `on-hand quantity cannot be set below ${reserved}. Cancel those orders first.`,
    };
  }

  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) {
    return { ok: false, message: "Give a short reason for this correction (for the audit trail)." };
  }
  if (cleanReason.length > MAX_CORRECTION_REASON_LENGTH) {
    return {
      ok: false,
      message: `The reason must be ${MAX_CORRECTION_REASON_LENGTH} characters or fewer.`,
    };
  }

  if (Number.isInteger(currentQuantity) && newQuantity === currentQuantity) {
    return {
      ok: false,
      message: "The corrected quantity is the same as the current quantity — nothing to change.",
    };
  }

  return { ok: true, value: { newQuantity, reason: cleanReason } };
}
