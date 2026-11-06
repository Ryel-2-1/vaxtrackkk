import test from "node:test";
import assert from "node:assert/strict";
import { priceNeedsReconfirmation, priceReconfirmationFlag, describePriceReconfirmation } from "../src/services/priceReconfirmation.js";
import { evaluateBatchEligibility } from "../src/services/orderEligibility.js";

const batch = (extra = {}) => ({
  id: "batch1", sellingPriceCentavos: 10000, priceIsVatInclusive: true,
  quantity: 5, reservedQuantity: 0, status: "Stable", expiryDate: "2030-01-01",
  ...extra,
});

test("an explicit Before VAT or VAT included price basis permits an otherwise eligible batch", () => {
  for (const basis of [false, true]) {
    const record = batch({ priceIsVatInclusive: basis });
    assert.equal(priceNeedsReconfirmation(record), false);
    assert.equal(priceReconfirmationFlag(record), null);
    assert.equal(evaluateBatchEligibility(record, "2026-10-09").eligible, true);
  }
});

test("missing price basis blocks orders until Admin explicitly confirms the amount and basis", () => {
  const record = batch({ priceIsVatInclusive: null });
  assert.equal(priceNeedsReconfirmation(record), true);
  assert.match(priceReconfirmationFlag(record), /Confirm its price basis/);
  assert.equal(evaluateBatchEligibility(record, "2026-10-09").eligible, false);
  const review = describePriceReconfirmation({ priceCentavos: 10000, priceIsVatInclusive: null, vatClassification: "vatable" });
  assert.equal(review.recordedCentavos, 10000);
  assert.deepEqual(review.options, []);
  assert.match(review.explanation, /unknown/);
  assert.equal(describePriceReconfirmation({ priceCentavos: 10000, priceIsVatInclusive: false }), null);
});
