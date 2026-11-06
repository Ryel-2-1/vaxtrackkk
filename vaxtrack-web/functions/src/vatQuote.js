"use strict";

const { splitVatInclusiveCentavos, legacyVatOnTopCentavos } = require("./pricingConfig");

/**
 * Convert the Admin's entered batch price to the amount charged for one vial.
 * The batch's price basis and the transaction's VAT treatment are separate.
 * No stored price is changed by a zero-rating decision.
 */
function quoteUnitPrice({ enteredCentavos, priceIsVatInclusive, productVatClassification, approvedZeroRate = false }) {
  if (!Number.isSafeInteger(enteredCentavos) || enteredCentavos <= 0) {
    throw new RangeError("A batch price must be positive whole centavos.");
  }
  if (typeof priceIsVatInclusive !== "boolean") {
    throw new TypeError("A batch price needs an explicit VAT basis.");
  }
  if (!["vatable", "vat_exempt", "zero_rated"].includes(productVatClassification)) {
    throw new TypeError("A product needs a VAT classification.");
  }
  const vatable = productVatClassification === "vatable";
  const baseCentavos = vatable && priceIsVatInclusive
    ? splitVatInclusiveCentavos(enteredCentavos).netCentavos
    : enteredCentavos;
  const vatClassification = vatable && approvedZeroRate ? "zero_rated" : productVatClassification;
  const unitPriceCentavos = vatable && !approvedZeroRate
    ? priceIsVatInclusive
      ? enteredCentavos
      : enteredCentavos + legacyVatOnTopCentavos(enteredCentavos)
    : baseCentavos;
  if (!Number.isSafeInteger(unitPriceCentavos) || unitPriceCentavos <= 0) {
    throw new RangeError("The quoted unit price is outside the supported range.");
  }
  return { baseCentavos, unitPriceCentavos, vatClassification };
}

module.exports = { quoteUnitPrice };
