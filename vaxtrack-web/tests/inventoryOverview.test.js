import assert from "node:assert/strict";
import test from "node:test";
import { buildVaccineAvailabilitySummary } from "../src/services/inventoryOverview.js";

test("stock chart sends products with flagged batches to review and keeps each category drilldown accurate", () => {
  const summary = buildVaccineAvailabilitySummary([
    { vaccineId: "a", name: "Alpha", type: "mRNA", onHandValue: 150, reservedValue: 20, availableValue: 120, level: "critical" },
    { vaccineId: "a", name: "Alpha", type: "mRNA", onHandValue: 100000001, reservedValue: 1, availableValue: 100000000, level: "stable" },
    { vaccineId: "b", name: "Beta", type: "Subunit", onHandValue: 40, reservedValue: 0, availableValue: 40, level: "expired" },
    { vaccineId: "c", name: "Gamma", type: "Toxoid", onHandValue: 10, reservedValue: 10, availableValue: 0, level: "stable" },
    { vaccineId: "d", name: "Delta", type: "Viral", onHandValue: 100000001629, reservedValue: 0, availableValue: 100000001629, level: "stable" },
    { vaccineId: "f", name: "Foxtrot", type: "Subunit", onHandValue: 25, reservedValue: 5, availableValue: 20, level: "stable" },
    { vaccineId: "e", name: "Voided", onHandValue: 20, reservedValue: 0, availableValue: 20, level: "stable", voided: true },
  ]);
  assert.deepEqual(
    { total: summary.total, stocked: summary.stocked, empty: summary.empty, review: summary.review },
    { total: 5, stocked: 1, empty: 1, review: 3 }
  );
  assert.deepEqual(summary.availableProducts.map((product) => [product.name, product.availableDoses]), [["Foxtrot", 20]]);
  assert.deepEqual(summary.emptyProducts.map((product) => product.name), ["Gamma"]);
  assert.deepEqual(summary.reviewProducts.map((product) => [product.name, product.availableDoses]), [
    ["Alpha", 120], ["Beta", 0], ["Delta", 0],
  ]);
  assert.ok(summary.reviewProducts[0].reasons.includes("Quantity above allowed limit"));
});

test("invalid or undated stock needs review rather than appearing empty", () => {
  const summary = buildVaccineAvailabilitySummary([
    { vaccineId: "a", name: "Alpha", onHandValue: null, reservedValue: 0, availableValue: null, level: "stable" },
    { vaccineId: "b", name: "Beta", onHandValue: 10, reservedValue: 0, availableValue: 10, level: "unknown" },
  ]);
  assert.deepEqual(
    { total: summary.total, stocked: summary.stocked, empty: summary.empty, review: summary.review },
    { total: 2, stocked: 0, empty: 0, review: 2 }
  );
  assert.deepEqual(summary.availableProducts, []);
  assert.equal(summary.reviewProducts.length, 2);
});
