import { legacyVatOnTopCentavos, splitVatInclusiveCentavos } from "./pricingConfig.js";

/** Display mirror of the server's quoteUnitPrice. The server sets the order price. */
export function quoteUnitPrice({ enteredCentavos, priceIsVatInclusive, productVatClassification, approvedZeroRate = false }) {
  if (!Number.isSafeInteger(enteredCentavos) || enteredCentavos <= 0) throw new RangeError("A batch price must be positive whole centavos.");
  if (typeof priceIsVatInclusive !== "boolean") throw new TypeError("A batch price needs an explicit VAT basis.");
  if (!["vatable", "vat_exempt", "zero_rated"].includes(productVatClassification)) throw new TypeError("A product needs a VAT classification.");
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
  if (!Number.isSafeInteger(unitPriceCentavos) || unitPriceCentavos <= 0) throw new RangeError("The quoted unit price is outside the supported range.");
  return { baseCentavos, unitPriceCentavos, vatClassification };
}
