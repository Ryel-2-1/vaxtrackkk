/**
 * Pricing configuration — the web app's single definition, for DISPLAY.
 *
 * Mirrors functions/src/pricingConfig.js, which is authoritative: the Cloud
 * Functions compute every stored financial amount. tests/pricingConfig.test.js
 * pins the two together, so the rate and the convention cannot drift apart.
 *
 * VATable sales carry 12% VAT. Admin chooses the basis of each batch's entered
 * price: Before VAT or VAT included. The order snapshot still records its
 * charged amount as VAT-inclusive, so existing receipt and invoice readers
 * can use their established calculations.
 *
 * PRICES_INCLUDE_VAT is the convention for charged order totals, not a default
 * for the Admin's batch price entry. Each batch records its own basis.
 *
 * Pure module (no Firebase) so node tests import it directly.
 */

/** VAT rate for VATable sales, in percent. */
export const VAT_RATE_PERCENT = 12;
/** The convention stamped on NEW records: their prices already include VAT (for VATable products). */
export const PRICES_INCLUDE_VAT = true;

/** The wording for VAT-inclusive data. Never claims every vaccine is VATable. */
export const VAT_INCLUSIVE_NOTE = "Prices are VAT-inclusive for VATable products.";
/** The wording for a record whose prices were recorded VAT-exclusive. */
export const LEGACY_VAT_EXCLUSIVE_NOTE = "Price entered before VAT.";

/** A record's stored convention: true, false, or null when it carries no boolean. */
export function readPriceConvention(value) {
  return typeof value === "boolean" ? value : null;
}

/**
 * The pricing note for ONE record, from its own stored convention. Null when
 * the record does not say — neither wording is ever shown on a guess, and the
 * VAT-inclusive wording is never shown on a legacy record.
 */
export function priceConventionNote(priceIsVatInclusive) {
  const inclusive = readPriceConvention(priceIsVatInclusive);
  if (inclusive === true) return VAT_INCLUSIVE_NOTE;
  if (inclusive === false) return LEGACY_VAT_EXCLUSIVE_NOTE;
  return null;
}

/**
 * LEGACY: the VAT a VAT-EXCLUSIVE VATable amount carried — 12% on top,
 * Math.round. Identical to legacyVatOnTopCentavos on the server. Used only to
 * DESCRIBE a legacy record (e.g. what a legacy batch price came to with VAT);
 * never to price a new record.
 */
export function legacyVatOnTopCentavos(netCentavos) {
  if (!Number.isSafeInteger(netCentavos) || netCentavos < 0) {
    throw new RangeError("A VAT-exclusive amount must be a whole, non-negative number of centavos.");
  }
  return Math.round((netCentavos * VAT_RATE_PERCENT) / 100);
}

/**
 * Split a VAT-inclusive VATable amount (integer centavos) into VAT and net:
 *   vat = round(gross × 12 ÷ 112), half up, exact integers;  net = gross − vat.
 * Identical to splitVatInclusiveCentavos on the server.
 */
export function splitVatInclusiveCentavos(grossCentavos) {
  if (!Number.isSafeInteger(grossCentavos) || grossCentavos < 0) {
    throw new RangeError("A VAT-inclusive amount must be a whole, non-negative number of centavos.");
  }
  const rate = BigInt(VAT_RATE_PERCENT);
  const divisor = 100n + rate;
  const vatCentavos = Number((BigInt(grossCentavos) * rate + divisor / 2n) / divisor);
  return { grossCentavos, vatCentavos, netCentavos: grossCentavos - vatCentavos };
}
