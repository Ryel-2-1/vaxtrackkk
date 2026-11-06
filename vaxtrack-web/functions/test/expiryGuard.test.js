"use strict";
/**
 * Reserved stock must still be usable on the day it is delivered (audit
 * finding 1): a batch is never reserved for an order delivered after it
 * expires, and dispatch, delivery, reschedule and batch edits refuse a
 * reserved batch that would be expired.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { usableThrough, coversDate, assertBatchesCover, reservedInventoryIds } = require("../src/expiryGuard");
const { planAllocation, initialAllocationLines } = require("../src/allocation");

const NOW = new Date("2026-10-31T02:00:00Z"); // 10:00, Oct 31, Manila
const P = "prodA";
const batch = (id, expiryDate, quantity = 10) => ({
  id,
  data: { vaccineId: P, batchId: id.toUpperCase(), status: "Stable", expiryDate, quantity, reservedQuantity: 0 },
});
const order = (id, requestedDeliveryDate, quantity, over = {}) => ({
  id,
  data: {
    orderNumber: `VT-${id}`,
    status: "pending_dispatch",
    allocationVersion: 2,
    allocationOpen: true,
    priority: "Standard",
    requestedDeliveryDate,
    allocationCreatedAtMillis: 1000,
    items: initialAllocationLines([{ productKey: P, quantity, inventoryId: "quote" }]),
    ...over,
  },
});

test("an order's stock must be usable through its delivery date — never earlier than today", () => {
  assert.equal(usableThrough({ requestedDeliveryDate: "2026-11-07" }, NOW), "2026-11-07");
  assert.equal(usableThrough({ requestedDeliveryDate: "2026-10-20" }, NOW), "2026-10-31", "a past date means today");
  assert.equal(usableThrough({}, NOW), "2026-10-31");
  assert.equal(usableThrough(null, NOW), "2026-10-31");
});

test("a batch covers a date through its whole expiry day; a missing expiry never covers", () => {
  assert.equal(coversDate({ expiryDate: "2026-11-01" }, "2026-11-01"), true);
  assert.equal(coversDate({ expiryDate: "2026-11-01" }, "2026-11-02"), false);
  assert.equal(coversDate({}, "2026-10-31"), false);
  assert.equal(coversDate({ expiryDate: "01/11/2026" }, "2026-10-31"), false);
  assert.equal(coversDate(null, "2026-10-31"), false);
});

test("allocation never reserves a batch for an order delivered after it expires", () => {
  // The audit case: a batch expiring tomorrow, an order for next week.
  const batches = [batch("soon", "2026-11-01", 10), batch("late", "2027-06-30", 10)];
  const nextWeek = order("o-later", "2026-11-07", 4);
  const plan = planAllocation({ productKey: P, batches, orders: [nextWeek], now: NOW });
  assert.deepEqual(plan.orderUpdates[0].slices.map((s) => [s.inventoryId, s.quantity]), [["late", 4]]);
});

test("the near-expiry batch still serves the order it can reach; the later order gets later stock", () => {
  const batches = [batch("soon", "2026-11-01", 5), batch("late", "2027-06-30", 10)];
  const orders = [order("today", "2026-10-31", 3), order("later", "2026-11-07", 3, { allocationCreatedAtMillis: 2000 })];
  const plan = planAllocation({ productKey: P, batches, orders, now: NOW });
  const slices = Object.fromEntries(plan.orderUpdates.map((u) => [u.orderId, u.slices.map((s) => s.inventoryId)]));
  assert.deepEqual(slices.today, ["soon"]);
  assert.deepEqual(slices.later, ["late"]);
});

test("when only near-expiry stock exists, a later order waits backordered — it is not given doomed stock", () => {
  const plan = planAllocation({ productKey: P, batches: [batch("soon", "2026-11-01", 10)], orders: [order("o", "2026-11-07", 2)], now: NOW });
  assert.deepEqual(plan.orderUpdates, []);
  assert.deepEqual(plan.batchUpdates, []);
});

test("dispatch / delivery / reschedule refusal gives both dates and what to do — never an identifier", () => {
  // Batch IDs like "AB_2026-001" would trip the web's user-message filter and
  // turn the whole refusal into "please try again" (seen on staging).
  assert.throws(
    () => assertBatchesCover([{ id: "invDocId", data: { batchId: "AB_2026-009", expiryDate: "2026-10-30" } }], "2026-10-31", { action: "Do not hand it over." }),
    (e) => e.code === "reserved-batch-expired"
      && e.message === "A reserved batch expires on 2026-10-30, before 2026-10-31. Do not hand it over."
  );
  assert.throws(
    () => assertBatchesCover([{ id: "inv2", data: null }], "2026-10-31", { code: "x", action: "Check it." }),
    (e) => e.code === "x" && e.message === "A reserved batch has no valid expiry date, before 2026-10-31. Check it."
  );
  assert.doesNotThrow(() => assertBatchesCover([{ id: "ok", data: { expiryDate: "2026-10-31" } }], "2026-10-31", { action: "" }));
});

test("only a live reservation's batches are checked", () => {
  const items = [{ inventoryId: "a", quantity: 2 }, { inventoryId: "b", quantity: 1 }, { inventoryId: "a", quantity: 1 }, { inventoryId: "z", quantity: 0 }];
  assert.deepEqual(reservedInventoryIds({ status: "reserved", items }), ["a", "b"]);
  assert.deepEqual(reservedInventoryIds({ items }), ["a", "b"], "older documents without a status");
  for (const status of ["released", "consumed", "returned"]) assert.deepEqual(reservedInventoryIds({ status, items }), [], status);
  assert.deepEqual(reservedInventoryIds(null), []);
});

test("wiring: allocation, dispatch, delivery, reschedule and batch edits all apply the rule", () => {
  const fs = require("node:fs");
  const read = (f) => fs.readFileSync(require.resolve(`../src/${f}`), "utf8");
  assert.match(read("allocation.js"), /if \(!coversDate\(batch\.data, needUsableThrough\)\) continue;/);
  const dispatch = read("riderDispatchOps.js");
  assert.match(dispatch, /const reservedBatches = await readReservedBatches\(tx, db, requested\);\s*\/\/[^\n]*\n\s*const \{ view, cur \} = await settle\(/, "batches are read before settle() may write");
  assert.match(dispatch, /assertBatchesCover\(reservedBatches\.get\(id\) \?\? \[\], usableThrough\(o, now\)/);
  assert.match(read("operations.js"), /assertBatchesCover\(\s*perBatch\.map/);
  assert.match(read("scheduleOperations.js"), /assertBatchesCover\(reserved, usableThrough\(\{ requestedDeliveryDate: date \}, now\)/);
  assert.match(read("batchMetadata.js"), /"batch-expiry-before-reservation"/);
});
