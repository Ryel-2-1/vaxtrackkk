/**
 * PHP money, as integer centavos.
 *
 * Every price in VaxTrack is stored and compared as a whole number of centavos.
 * Pesos are a DISPLAY form and a typing form — never a storage or arithmetic
 * form — because 0.1 + 0.2 is not 0.3 in binary floating point and a subtotal
 * built from peso floats drifts by a centavo or two on a long enough invoice.
 *
 * Pure: no Firestore, no React, no formatting locale surprises beyond
 * Intl.NumberFormat. Everything here is unit-tested in tests/money.test.js.
 */

/**
 * There is NO business maximum on a price. See functions/src/policy.js — an
 * invented ceiling is a business rule smuggled in as a validation, and nobody
 * approved one. The only limit is arithmetic: a figure past
 * Number.MAX_SAFE_INTEGER can no longer be represented exactly, so it cannot be
 * stored or summed honestly.
 */
export const PRICE_CURRENCY = "PHP";

/**
 * Parse a typed peso amount into integer centavos.
 *
 * Deliberately strict, and deliberately NOT `Math.round(Number(text) * 100)`:
 * that route turns "19.99" into 1998.9999999999998 and then, depending on which
 * way you round, into the wrong centavo. Parsing the decimal digits as text
 * cannot drift.
 *
 * Accepts: "500", "500.5", "500.50", " 1,250.00 ".
 * Refuses: "", "abc", "-5", "5.005", "1e3", "5.", ".5", "Infinity".
 *
 * Returns { ok: true, value } or { ok: false, reason } — never a number that
 * silently means "we could not read this".
 */
export function parsePesosToCentavos(input) {
  if (typeof input === "number") {
    // A number has already lost the distinction between 19.99 and 19.990000001.
    // Accept only whole pesos from this path; anything else must arrive as text.
    if (!Number.isInteger(input) || input < 0) return { ok: false, reason: "invalid" };
    return finish(input * 100);
  }
  if (typeof input !== "string") return { ok: false, reason: "invalid" };

  // Thousands separators are a typing convenience; the decimal point is not.
  const text = input.trim().replace(/,/g, "");
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, reason: "invalid" };

  const [whole, fraction = ""] = text.split(".");
  const centavos = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return finish(centavos);
}

function finish(centavos) {
  if (typeof centavos !== "number" || !Number.isInteger(centavos)) {
    return { ok: false, reason: "invalid" };
  }
  // Not a price cap. Past this point the number is no longer the number typed.
  if (!Number.isSafeInteger(centavos)) return { ok: false, reason: "not-safe-integer" };
  if (centavos <= 0) return { ok: false, reason: "not-positive" };
  return { ok: true, value: centavos };
}

/**
 * A stored price, or null.
 *
 * Mirrors readSellingPriceCentavos in functions/src/policy.js: a numeric string
 * is NOT coerced, because a batch whose price is stored as text has a data
 * problem an admin needs to see, not a price the catalog should quietly use.
 */
export function readPriceCentavos(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

/**
 * An ADJUSTMENT amount in pesos — a discount, other charges, withholding tax.
 *
 * Separate from parsePesosToCentavos because zero is a perfectly good
 * adjustment (and the usual one), while zero is never a selling price. An empty
 * field means "none", not "invalid": the editor leaves these blank by default.
 */
export function parseAdjustmentPesosToCentavos(input) {
  if (input === undefined || input === null || String(input).trim() === "") {
    return { ok: true, value: 0 };
  }
  const parsed = parsePesosToCentavos(input);
  if (parsed.ok) return parsed;
  // The one difference: an explicit zero is accepted here.
  if (parsed.reason === "not-positive") return { ok: true, value: 0 };
  return parsed;
}

/** Centavos as a peso number. For the invoice layer, which speaks decimals. */
export function centavosToPesos(centavos) {
  return Math.round(centavos) / 100;
}

/** Centavos as "₱1,250.00". Returns the dash the UI uses when there is no price. */
export function formatCentavos(centavos) {
  const value = readPriceCentavos(centavos);
  if (value === null) return "—";
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: PRICE_CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

/** Centavos as a bare "1250.00", for prefilling an input the admin will edit. */
export function centavosToInputValue(centavos) {
  const value = readPriceCentavos(centavos);
  return value === null ? "" : (value / 100).toFixed(2);
}
