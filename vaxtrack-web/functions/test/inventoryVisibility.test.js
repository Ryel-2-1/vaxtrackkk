"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { physicalStockState, planObservation, inactiveAfter } = require("../src/inventoryVisibility");
const { productIds } = require("../src/inventoryVisibilityOps");
const at = (iso) => new Date(iso);
const NOW = at("2026-10-27T02:00:00Z");
const empty = [{ quantity: 0 }];
const observe = (product, batches = empty, rest = {}) => planObservation({ product, batches, now: NOW, ...rest });

test("empty means PHYSICAL zero, not free/available zero, expired, quarantined or reserved", () => {
  assert.equal(physicalStockState(empty), "empty");
  assert.equal(physicalStockState([]), "empty");
  for (const batch of [
    { quantity: 10, reservedQuantity: 10 }, { quantity: 10, returnPendingQuantity: 10 },
    { quantity: 10, quarantinedQuantity: 10 }, { quantity: 10, expiryDate: "2000-01-01", status: "Expired" },
  ]) assert.equal(physicalStockState([batch]), "in_stock");
});

test("corrupt counters, contradictory custody or incomplete queries must remain visible", () => {
  for (const batch of [{}, { quantity: "0" }, { quantity: -1 }, { quantity: 0.5 },
    { quantity: 0, reservedQuantity: 1 }, { quantity: 0, returnPendingQuantity: "0" },
    { quantity: 0, quarantinedQuantity: -1 }, { voided: true, reservedQuantity: 1 },
  ]) assert.equal(physicalStockState([batch]), "needs_review", JSON.stringify(batch));
  assert.equal(physicalStockState(empty, false), "needs_review");
  assert.equal(physicalStockState([{ voided: true, quantity: 999 }]), "empty", "voided isn't physical stock");
});

test("all product batches participate: one positive batch keeps it in stock", () => {
  assert.equal(physicalStockState([{ quantity: 0 }, { quantity: 1 }]), "in_stock");
});

test("legacy clock starts at first server observation, never creation, expiry or last sale", () => {
  const p = observe({ createdAt: at("2000-01-01"), updatedAt: at("2001-01-01"), archived: true });
  assert.deepEqual(p.update.inventoryEmptySince, NOW);
  assert.equal(p.changed, true);
  assert.deepEqual(Object.keys(p.update).sort(), ["inventoryEmptySince", "inventoryPositiveEvidenceAt", "inventoryStockState", "inventoryVisibilityVersion"]);
  assert.equal(p.update.archived, undefined, "manual archive isn't restored");
});

test("repeated observations are no-ops and never restart an empty interval", () => {
  const p = observe({}).update;
  assert.equal(observe(p, empty, { now: at("2027-01-28T02:00:00Z") }).changed, false);
  assert.deepEqual(observe(p, empty, { now: at("2027-01-28T02:00:00Z") }).update.inventoryEmptySince, NOW);
});

test("restock clears empty clock; depletion starts a fresh clock", () => {
  const p = observe({}).update;
  const restocked = observe(p, [{ quantity: 1 }]).update;
  assert.equal(restocked.inventoryEmptySince, null);
  const later = at("2027-02-01T00:00:00Z");
  assert.deepEqual(observe(restocked, empty, { now: later }).update.inventoryEmptySince, later);
});

test("new positive evidence after a quick restock/depletion resets conservatively; replay doesn't", () => {
  const older = { ...observe({}).update, inventoryEmptySince: at("2026-01-01T00:00:00Z") };
  const evidence = at("2026-10-26T00:00:00Z");
  const reset = observe(older, empty, { positiveEvidenceAt: evidence }).update;
  assert.deepEqual(reset.inventoryEmptySince, NOW);
  assert.equal(observe(reset, empty, { positiveEvidenceAt: evidence, now: at("2027-01-01T00:00:00Z") }).changed, false);
  assert.equal(observe(reset, empty, { positiveEvidenceAt: at("2026-01-01T00:00:00Z") }).changed, false);
});

test("review/invalid/future clocks cannot inherit an old empty interval", () => {
  const p = { ...observe({}).update, inventoryEmptySince: at("2026-01-01") };
  assert.equal(observe(p, [{}]).update.inventoryEmptySince, null);
  assert.deepEqual(observe({ ...p, inventoryStockState: "needs_review" }).update.inventoryEmptySince, NOW);
  assert.deepEqual(observe({ ...p, inventoryEmptySince: at("2030-01-01") }).update.inventoryEmptySince, NOW);
  assert.deepEqual(observe({ ...p, inventoryEmptySince: "2020-01-01" }).update.inventoryEmptySince, NOW);
});

test("three calendar months in PHT, clamped at month end, including leap/year boundaries", () => {
  for (const [from, to] of [
    ["2026-10-27T02:00:00Z", "2027-01-27T02:00:00Z"],
    ["2026-11-30T16:30:00Z", "2027-02-28T16:30:00Z"], // PHT Dec 1 -> Mar 1
    ["2027-11-30T02:00:00Z", "2028-02-29T02:00:00Z"],
    ["2026-08-31T02:00:00Z", "2026-11-30T02:00:00Z"],
  ]) assert.equal(inactiveAfter(at(from)), Date.parse(to), from);
  assert.equal(inactiveAfter(null), null);
});

test("product identity is document id only; a moved/deleted batch checks both products", () => {
  assert.deepEqual(productIds({ vaccineId: "v1" }, { vaccineId: "v2" }), ["v1", "v2"]);
  assert.deepEqual(productIds(null, { vaccineId: "v1" }), ["v1"]);
  assert.deepEqual(productIds({ vaccineId: "v1" }, { vaccineId: "v1" }), ["v1"]);
  assert.deepEqual(productIds({ vaccineId: "bad/id" }, { vaccineName: "Not an id" }), []);
});

test("observer is independent of allocation, bounded and explicitly separate from existing scheduled jobs", () => {
  const index = readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(index, /exports\.observeInventoryVisibility = onDocumentWritten\([\s\S]*?document: "inventory\/\{inventoryId\}", retry: true/);
  assert.match(index, /exports\.reviewInventoryVisibility = onSchedule\([\s\S]*?schedule: "every day 03:00", timeZone: "Asia\/Manila"/);
  const ops = readFileSync(path.join(__dirname, "../src/inventoryVisibilityOps.js"), "utf8");
  assert.match(ops, /MAX_PRODUCT_BATCHES \+ 1/);
  assert.match(ops, /query = query\.startAfter\(cursor\)/);
  assert.match(ops, /offset \+= 5/);
  assert.doesNotMatch(ops, /\.collection\("(?:orders|inventoryReservations|inventoryReturns|alerts)"\)/);
  assert.doesNotMatch(ops, /tx\.(?:set|update|delete)\([^\n]*inventory/);
});
