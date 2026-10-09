/**
 * Re-confirming a batch price recorded under the legacy VAT-exclusive convention.
 *
 * A batch stamped `priceIsVatInclusive: false` (priced before the client
 * confirmed that prices are VAT-inclusive) cannot be ordered until an Admin
 * re-confirms its price; saving a price stamps the current convention
 * (vaccineService.updateStockPrice). This module only DESCRIBES the choice for
 * the Admin — the recorded figure and what it amounts to with 12% on top. It
 * never picks the new price and never converts anything: the Admin types or
 * chooses the figure, then saves it explicitly.
 *
 * Pure module (no Firebase, no React) so node tests import it directly.
 */

import {
  LEGACY_VAT_EXCLUSIVE_NOTE,
  PRICES_INCLUDE_VAT,
  VAT_RATE_PERCENT,
  legacyVatOnTopCentavos,
  readPriceConvention,
} from "./pricingConfig.js";
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
    batch?.priceIsVatInclusive !== PRICES_INCLUDE_VAT
  );
}

/** The Inventory row flag for such a batch, or null when none is needed. */
export function priceReconfirmationFlag(batch) {
  if (!priceNeedsReconfirmation(batch)) return null;
  const recorded =
    readPriceConvention(batch.priceIsVatInclusive) === false
      ? LEGACY_VAT_EXCLUSIVE_NOTE
      : CONVENTION_NOT_RECORDED_NOTE;
  return `${recorded} Re-confirm the price before this batch can be ordered.`;
}

/**
 * What the re-confirmation dialog shows: the recorded figure, what it came to
 * with VAT on top, and the two figures the Admin can choose between. Null when
 * the batch needs no re-confirmation.
 *
 * `vatClassification` is the product's ("vatable" | "vat_exempt" | null). VAT
 * only ever applied to VATable sales, so for a VAT-exempt product the two
 * readings are the same amount and there is only one figure to offer.
 */
export function describePriceReconfirmation({ priceCentavos, priceIsVatInclusive, vatClassification }) {
  const recordedCentavos = readPriceCentavos(priceCentavos);
  if (recordedCentavos === null || priceIsVatInclusive === PRICES_INCLUDE_VAT) return null;

  const legacy = readPriceConvention(priceIsVatInclusive) === false;
  const withVatCentavos = recordedCentavos + legacyVatOnTopCentavos(recordedCentavos);
  const recorded = formatCentavos(recordedCentavos);
  const withVat = formatCentavos(withVatCentavos);

  const sameFigure = {
    key: "same-figure",
    centavos: recordedCentavos,
    label: `Use ${recorded}`,
    detail: "Same figure, now including VAT — the clinic pays less than before.",
  };
  const sameAmount = {
    key: "same-amount",
    centavos: withVatCentavos,
    label: `Use ${withVat}`,
    detail: `The recorded price plus ${VAT_RATE_PERCENT}% VAT — the clinic pays the same as before.`,
  };

  let explanation;
  let options;
  if (vatClassification === "vat_exempt") {
    explanation = `This product is VAT-exempt, so no VAT applied to it — ${recorded} is the same amount under either convention.`;
    options = [{ ...sameFigure, detail: "No VAT applies to this product, so the amount is unchanged." }];
  } else if (vatClassification === "vatable") {
    explanation = `With ${VAT_RATE_PERCENT}% VAT added on top, the clinic was charged ${withVat} per vial.`;
    options = [sameAmount, sameFigure];
  } else {
    explanation = `This product is not classified yet. If it is VATable, ${recorded} plus ${VAT_RATE_PERCENT}% VAT is ${withVat}; if it is VAT-exempt, the amount is ${recorded} either way.`;
    options = [sameAmount, sameFigure];
  }

  return {
    legacy,
    recordedCentavos,
    withVatCentavos,
    recordedNote: legacy ? LEGACY_VAT_EXCLUSIVE_NOTE : CONVENTION_NOT_RECORDED_NOTE,
    recordedLine: `Recorded price: ${recorded} per vial.`,
    explanation,
    options,
  };
}
