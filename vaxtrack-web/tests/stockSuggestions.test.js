import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addShelfLife,
  nextBatchId,
  shelfLife,
  shelfLifeLabel,
  stockSuggestions,
  suggestionSource,
} from "../src/services/stockSuggestions.js";

const at = (ms) => ({ toMillis: () => ms });
const abhayrab = { id: "v1", vaccineName: "ABHAYRAB", vaccineType: "ANTI - RABIES", manufacturer: "HUMAN BIOLOGICALS INSTITUTE", vatClassification: "vatable" };
const batches = [
  { id: "b1", vaccineId: "v1", batchId: "26URAAB024", createdAt: at(1), sellingPriceCentavos: 95000, priceIsVatInclusive: true, manufacturingDate: "2025-11-01", expiryDate: "2026-11-01" },
  { id: "b2", vaccineId: "v1", batchId: "26URAAB025", createdAt: at(2), sellingPriceCentavos: 100000, priceIsVatInclusive: true, manufacturingDate: "2026-02-21", expiryDate: "2027-02-21" },
  { id: "b3", vaccineId: "v1", batchId: "26URAAB099", createdAt: at(3), voided: true, sellingPriceCentavos: 1, priceIsVatInclusive: false },
  { id: "b4", vaccineId: "v9", vaccineType: "anti -  rabies", manufacturer: "Human Biologicals Institute", batchId: "HBI-7", createdAt: at(4), sellingPriceCentavos: 88000, priceIsVatInclusive: false, manufacturingDate: "2026-01-15", expiryDate: "2027-07-15" },
];

test("suggestions come from the newest non-voided batch of the same vaccine", () => {
  const s = stockSuggestions({ batches, vaccine: abhayrab, manufacturer: abhayrab.manufacturer });
  assert.equal(s.match, "same_vaccine");
  assert.equal(s.sourceBatchId, "26URAAB025", "the voided 26URAAB099 is ignored");
  assert.deepEqual([s.price, s.priceConverted, s.nextBatchId], ["1000.00", false, "26URAAB026"]);
  assert.deepEqual(s.shelfLife, { months: 12 });
});

test("with no batch of that vaccine, a batch of the same type and manufacturer is used", () => {
  const fresh = { id: "v2", vaccineName: "New rabies brand", vaccineType: "ANTI - RABIES", manufacturer: "HUMAN BIOLOGICALS INSTITUTE", vatClassification: "vatable" };
  const s = stockSuggestions({ batches, vaccine: fresh, manufacturer: fresh.manufacturer });
  assert.equal(s.match, "same_type_manufacturer", "type and manufacturer match ignoring case and spacing");
  assert.equal(s.sourceBatchId, "HBI-7");
  // HBI-7 was entered BEFORE VAT (₱880.00): suggested as the VAT-inclusive ₱985.60.
  assert.deepEqual([s.price, s.priceConverted, s.nextBatchId], ["985.60", true, "HBI-8"]);
  assert.equal(stockSuggestions({ batches, vaccine: { ...fresh, vatClassification: "vat_exempt" } }).price, "880.00", "no VAT to add on an exempt product");
  assert.deepEqual(s.shelfLife, { months: 18 });
  assert.equal(suggestionSource(batches, { ...fresh, manufacturer: "Other Maker" }, "Other Maker"), null, "a different manufacturer is not a match");
  assert.equal(stockSuggestions({ batches: [], vaccine: fresh }), null);
  assert.equal(stockSuggestions({ batches, vaccine: null }), null);
});

test("batch numbers, shelf life and expiry are worked out exactly", () => {
  assert.equal(nextBatchId("26URAAB025"), "26URAAB026");
  assert.equal(nextBatchId("LOT-099"), "LOT-100");
  assert.equal(nextBatchId("A9"), "A10");
  assert.equal(nextBatchId("BATCH-X"), null, "no trailing number, no guess");
  assert.deepEqual(shelfLife("2026-02-21", "2027-02-21"), { months: 12 });
  assert.deepEqual(shelfLife("2026-02-21", "2026-08-20"), { days: 180 });
  assert.equal(shelfLife("2027-01-01", "2026-01-01"), null);
  assert.equal(addShelfLife("2026-03-05", { months: 12 }), "2027-03-05");
  assert.equal(addShelfLife("2026-01-31", { months: 1 }), "2026-02-28", "month ends clamp");
  assert.equal(addShelfLife("2026-02-21", { days: 180 }), "2026-08-20");
  assert.deepEqual([shelfLifeLabel({ months: 12 }), shelfLifeLabel({ months: 24 }), shelfLifeLabel({ months: 18 }), shelfLifeLabel({ days: 1 })], ["1 year", "2 years", "18 months", "1 day"]);
});

test("Add Stock fills only empty price fields and offers the rest as one-click suggestions", () => {
  const page = readFileSync(new URL("../src/pages/admin/AddStock.jsx", import.meta.url), "utf8");
  assert.match(page, /const pricePristine = unitPrice\.trim\(\) === "" \|\| prefilledFrom !== null;/);
  assert.match(page, /with 12% VAT added \(it was entered before VAT\)/);
  assert.match(page, /\{!batchId && suggestion\?\.nextBatchId && \(/, "batch ID is a suggestion, never filled in");
  assert.match(page, /\{!expiryDate && suggestedExpiry && \(/, "expiry is a suggestion, never filled in");
  assert.match(page, /onClick=\{\(\) => setArrivalDate\(today\)\}/);
  assert.match(page, /Filled in from batch \{prefilledFrom\.batchId/);
});

test("an older before-VAT price is shown with VAT included wherever it is re-entered", async () => {
  const { vatInclusivePriceCentavos } = await import("../src/services/stockSuggestions.js");
  assert.equal(vatInclusivePriceCentavos({ sellingPriceCentavos: 100000, priceIsVatInclusive: true }, "vatable"), 100000);
  assert.equal(vatInclusivePriceCentavos({ sellingPriceCentavos: 100000, priceIsVatInclusive: false }, "vatable"), 112000);
  assert.equal(vatInclusivePriceCentavos({ sellingPriceCentavos: 100000, priceIsVatInclusive: false }, "vat_exempt"), 100000);
  assert.equal(vatInclusivePriceCentavos({ sellingPriceCentavos: 100000 }, "vatable"), null, "no recorded basis, no guess");
  const inventory = readFileSync(new URL("../src/pages/admin/Inventory.jsx", import.meta.url), "utf8");
  assert.match(inventory, /if \(item\.priceIsVatInclusive === false && !item\.vatClassification\) return "";/);
  assert.match(inventory, /This batch was entered before VAT/);
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.match(rules, /&& d\.get\('priceIsVatInclusive', null\) == true/);
});
