/** A priced batch with no recorded VAT basis needs Admin confirmation. */

import { readPriceConvention } from "./pricingConfig.js";
import { formatCentavos, readPriceCentavos } from "./money.js";

/** Shown on a priced batch whose convention was never recorded at all. */
export const CONVENTION_NOT_RECORDED_NOTE = "VAT convention not recorded for this price.";

/**
 * Does this batch's price need an Admin to re-confirm it before it can be
 * ordered? Only a PRICED batch can; an unpriced one is simply unpriced.
 * Mirrors the server's `batch-price-convention-legacy` refusal (policy.js).
 */
export function priceNeedsReconfirmation(batch) {
  return (
    readPriceCentavos(batch?.sellingPriceCentavos) !== null &&
    readPriceConvention(batch?.priceIsVatInclusive) === null
  );
}

/** The Inventory row flag for such a batch, or null when none is needed. */
export function priceReconfirmationFlag(batch) {
  if (!priceNeedsReconfirmation(batch)) return null;
  return `${CONVENTION_NOT_RECORDED_NOTE} Confirm its price basis before this batch can be ordered.`;
}

/**
 * Show the old figure without guessing how it was intended. Admin must enter
 * the price and explicitly choose its basis before the batch is orderable.
 */
export function describePriceReconfirmation({ priceCentavos, priceIsVatInclusive, vatClassification }) {
  const recordedCentavos = readPriceCentavos(priceCentavos);
  if (recordedCentavos === null || readPriceConvention(priceIsVatInclusive) !== null) return null;
  return {
    recordedCentavos,
    recordedNote: CONVENTION_NOT_RECORDED_NOTE,
    recordedLine: `Recorded price: ${formatCentavos(recordedCentavos)} per vial.`,
    explanation: `The original price basis is unknown${vatClassification === "vatable" ? " for this VATable product" : ""}. Enter the intended amount, with VAT included, before new orders use this batch.`,
    options: [],
  };
}
