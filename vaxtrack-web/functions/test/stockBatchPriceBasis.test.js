"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateStockBatchPayload } = require("../src/inventoryWorkflow");

// Every batch price is entered with VAT included (2026-11-11).
const now = new Date("2026-11-11T04:00:00Z");
const base = {
  vaccineId: "v1", batchId: "26URAAB026", manufacturingDate: "2026-02-21", arrivalDate: "2026-11-11",
  expiryDate: "2027-02-21", quantity: 100, sellingPriceCentavos: 100000,
};

test("a new batch's price is stored as VAT included; Before VAT is refused", () => {
  assert.equal(validateStockBatchPayload(base, now).priceIsVatInclusive, true, "omitted means VAT included");
  assert.equal(validateStockBatchPayload({ ...base, priceIsVatInclusive: true }, now).priceIsVatInclusive, true);
  for (const bad of [false, "true", null, 1]) {
    assert.throws(
      () => validateStockBatchPayload({ ...base, priceIsVatInclusive: bad }, now),
      (e) => e.code === "invalid-stock-batch" && /with VAT included/.test(e.message),
      JSON.stringify(bad)
    );
  }
});
