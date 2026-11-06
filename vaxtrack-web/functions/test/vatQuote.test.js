"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { quoteUnitPrice } = require("../src/vatQuote");

test("before-VAT and VAT-included batch prices quote the same ₱112 standard sale", () => {
  const before = quoteUnitPrice({ enteredCentavos: 10000, priceIsVatInclusive: false, productVatClassification: "vatable" });
  const included = quoteUnitPrice({ enteredCentavos: 11200, priceIsVatInclusive: true, productVatClassification: "vatable" });
  assert.deepEqual(before, { baseCentavos: 10000, unitPriceCentavos: 11200, vatClassification: "vatable" });
  assert.deepEqual(included, before);
});

test("one approved zero-rated sale removes VAT without changing either batch price", () => {
  for (const [enteredCentavos, priceIsVatInclusive] of [[10000, false], [11200, true]]) {
    assert.deepEqual(
      quoteUnitPrice({ enteredCentavos, priceIsVatInclusive, productVatClassification: "vatable", approvedZeroRate: true }),
      { baseCentavos: 10000, unitPriceCentavos: 10000, vatClassification: "zero_rated" }
    );
  }
});

test("a product exemption stays distinct and needs no VAT removal", () => {
  assert.deepEqual(
    quoteUnitPrice({ enteredCentavos: 10000, priceIsVatInclusive: false, productVatClassification: "vat_exempt", approvedZeroRate: true }),
    { baseCentavos: 10000, unitPriceCentavos: 10000, vatClassification: "vat_exempt" }
  );
});
