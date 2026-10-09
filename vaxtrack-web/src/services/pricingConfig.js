/**
 * Pricing configuration — the web app's single definition, for DISPLAY.
 *
 * Mirrors functions/src/pricingConfig.js, which is authoritative: the Cloud
 * Functions compute every stored financial amount. tests/pricingConfig.test.js
 * pins the two together, so the rate and the convention cannot drift apart.
 *
 * Confirmed client rules:
 *   1. VATable sales carry VAT at exactly 12%.
 *   2. Vaccine prices entered and displayed in VaxTrack are VAT-INCLUSIVE.
 *
 * VAT is extracted from a VATable amount, never added on top. Whether an
 * amount IS VATable is not decided here (classification is unresolved).
 *
 * Pure module (no Firebase) so node tests import it directly.
 */

/** VAT rate for VATable sales, in percent. */
export const VAT_RATE_PERCENT = 12;
/** Prices entered and shown in VaxTrack already include VAT (for VATable products). */
export const PRICES_INCLUDE_VAT = true;

/** The wording shown wherever prices appear. Never claims every vaccine is VATable. */
export const VAT_INCLUSIVE_NOTE = "Prices are VAT-inclusive for VATable products.";

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
