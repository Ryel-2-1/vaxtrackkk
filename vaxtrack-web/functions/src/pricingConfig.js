"use strict";

/**
 * THE pricing configuration — the one authoritative definition on the server.
 *
 * Two rules confirmed by the client:
 *   1. VATable sales carry VAT at exactly 12%.
 *   2. Vaccine prices entered and displayed in VaxTrack are VAT-INCLUSIVE.
 *
 * So VAT is never added on top of a price: for an amount already known to be
 * VATable, the VAT is EXTRACTED from it and the amount itself stays the total.
 *
 * Nothing here decides WHETHER an amount is VATable. Classification (VATable /
 * VAT-exempt / unclassified) is unresolved and stays wherever it already was;
 * an unclassified or VAT-exempt amount gets no VAT from this module.
 *
 * The web app mirrors these two values in src/services/pricingConfig.js for
 * DISPLAY only; tests/pricingConfig.test.js pins the two together. Stored
 * financial amounts are computed here, on the server.
 */

/** VAT rate for VATable sales, in percent. */
const VAT_RATE_PERCENT = 12;
/** Prices entered and shown in VaxTrack already include VAT (for VATable products). */
const PRICES_INCLUDE_VAT = true;

/**
 * Split a VAT-inclusive VATable amount into its VAT and its net-of-VAT part.
 *
 *   vatCentavos = round(gross × 12 ÷ 112), half up, in exact integer arithmetic
 *   netCentavos = gross − vatCentavos              (so net + VAT = gross, always)
 *
 * Computed on the AGGREGATED VATable gross (one rounding per invoice or
 * receipt — the policy the invoice has always documented), never per line.
 */
function splitVatInclusiveCentavos(grossCentavos) {
  if (!Number.isSafeInteger(grossCentavos) || grossCentavos < 0) {
    throw new RangeError("A VAT-inclusive amount must be a whole, non-negative number of centavos.");
  }
  const rate = BigInt(VAT_RATE_PERCENT);
  const divisor = 100n + rate; // 112
  // round-half-up(g × 12 / 112) == floor((g × 12 + 56) / 112) for g ≥ 0.
  const vatCentavos = Number((BigInt(grossCentavos) * rate + divisor / 2n) / divisor);
  return { grossCentavos, vatCentavos, netCentavos: grossCentavos - vatCentavos };
}

module.exports = { VAT_RATE_PERCENT, PRICES_INCLUDE_VAT, splitVatInclusiveCentavos };
