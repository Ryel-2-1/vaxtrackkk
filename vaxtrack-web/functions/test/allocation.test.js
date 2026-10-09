"use strict";

/**
 * The allocation engine's decisions, without Firestore: priority, FEFO,
 * partial reservation, multi-line blocking, product independence and the
 * per-line invariants. The emulator suite (integration/allocation.test.js)
 * proves the same engine against real transactions.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allocatableUnits,
  allocationPriorityKey,
  compareAllocationPriority,
  priorityTuple,
  planAllocation,
  summarizeAllocation,
  initialAllocationLines,
  mergeSlices,
  unitsByBatch,
  lineCounts,
} = require("../src/allocation");
const {
  productKeysForInventoryWrite,
  productKeysForOrderWrite,
  validateStockBatchPayload,
  statusFromExpiry,
} = require("../src/inventoryWorkflow");

const NOW = new Date("2026-10-05T02:00:00Z"); // Oct 5, Manila
const P = "prodA";
const Q = "prodB";

const batch = (id, over = {}) => ({
  id,
  data: { vaccineId: P, batchId: id.toUpperCase(), status: "Stable", expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, ...over },
});
const order = (id, lines, over = {}) => ({
  id,
  data: {
    orderNumber: `VT-${id}`,
    status: "pending_dispatch",
    allocationVersion: 2,
    allocationOpen: true,
    priority: "Standard",
    requestedDeliveryDate: "2026-10-10",
    allocationCreatedAtMillis: 1000,
    items: initialAllocationLines(lines.map(([productKey, quantity]) => ({ productKey, quantity, inventoryId: "quote" }))),
    ...over,
  },
});
/** Apply a plan to in-memory state, as the transaction would. */
function apply(plan, batches, orders) {
  for (const u of plan.batchUpdates) batches.find((b) => b.id === u.id).data.reservedQuantity = u.reservedQuantity;
  for (const u of plan.orderUpdates) {
    const o = orders.find((x) => x.id === u.orderId);
    o.data.items = u.items;
    o.data.allocationState = u.allocationState;
    o.data.backorderedProductKeys = u.backorderedProductKeys;
  }
}
const run = (batches, orders, productKey = P) => {
  const plan = planAllocation({ productKey, batches, orders, now: NOW });
  apply(plan, batches, orders);
  return plan;
};

// ---------------------------------------------------------------- 2–4 partial fill

test("2–4. request 10 with 4 available, then +3, then +5", () => {
  const batches = [batch("b1", { quantity: 4 })];
  const orders = [order("o1", [[P, 10]])];

  let plan = run(batches, orders);
  let line = orders[0].data.items[0];
  assert.deepEqual([line.reservedQuantity, line.backorderedQuantity], [4, 6]);
  assert.equal(orders[0].data.allocationState, "partially_reserved", "not dispatchable");
  assert.equal(plan.leftAvailable, 0);

  batches.push(batch("b2", { quantity: 3 }));
  plan = run(batches, orders);
  line = orders[0].data.items[0];
  assert.deepEqual([line.reservedQuantity, line.backorderedQuantity], [7, 3]);
  assert.equal(orders[0].data.allocationState, "partially_reserved");
  assert.equal(plan.allocatedUnits, 3, "all 3 new units go to the waiting order");

  batches.push(batch("b3", { quantity: 5 }));
  plan = run(batches, orders);
  line = orders[0].data.items[0];
  assert.deepEqual([line.reservedQuantity, line.backorderedQuantity], [10, 0]);
  assert.equal(orders[0].data.allocationState, "fully_reserved");
  assert.equal(plan.allocatedUnits, 3, "only the remaining 3 are taken");
  assert.equal(plan.leftAvailable, 2, "2 left available");
  assert.deepEqual(orders[0].data.backorderedProductKeys, []);
});

test("1. zero stock: the order waits, nothing is reserved", () => {
  const orders = [order("o1", [[P, 5]])];
  const plan = run([], orders);
  assert.equal(plan.allocatedUnits, 0);
  assert.deepEqual(plan.orderUpdates, []);
  assert.equal(summarizeAllocation(orders[0].data.items).allocationState, "awaiting_stock");
});

// ---------------------------------------------------------------- 5–7 priority

test("5. an Urgent order outranks Standard orders", () => {
  const batches = [batch("b1", { quantity: 3 })];
  const orders = [
    order("standardEarly", [[P, 3]], { requestedDeliveryDate: "2026-10-06", allocationCreatedAtMillis: 1 }),
    order("urgentLate", [[P, 3]], { priority: "Urgent", requestedDeliveryDate: "2026-12-01", allocationCreatedAtMillis: 999 }),
  ];
  run(batches, orders);
  assert.equal(orders.find((o) => o.id === "urgentLate").data.allocationState, "fully_reserved");
  assert.equal(orders.find((o) => o.id === "standardEarly").data.items[0].reservedQuantity, 0);
});

test("6. same urgency: the earliest requested delivery date first; a missing date is last", () => {
  const batches = [batch("b1", { quantity: 4 })];
  const orders = [
    order("noDate", [[P, 2]], { requestedDeliveryDate: null, allocationCreatedAtMillis: 1 }),
    order("badDate", [[P, 2]], { requestedDeliveryDate: "2026-02-31", allocationCreatedAtMillis: 1 }),
    order("late", [[P, 2]], { requestedDeliveryDate: "2026-10-20" }),
    order("early", [[P, 2]], { requestedDeliveryDate: "2026-10-08" }),
  ];
  run(batches, orders);
  const reserved = (id) => orders.find((o) => o.id === id).data.items[0].reservedQuantity;
  assert.deepEqual([reserved("early"), reserved("late"), reserved("noDate"), reserved("badDate")], [2, 2, 0, 0]);
});

test("6b. on the same date, a scheduled time orders before none", () => {
  const a = priorityTuple({ requestedDeliveryDate: "2026-10-08", scheduledDeliveryTime: "09:00" }, "a");
  const b = priorityTuple({ requestedDeliveryDate: "2026-10-08" }, "b");
  assert.ok(compareAllocationPriority(a, b) < 0);
});

test("7. remaining ties: oldest createdAt, then document id", () => {
  const batches = [batch("b1", { quantity: 2 })];
  const orders = [
    order("zNewer", [[P, 1]], { allocationCreatedAtMillis: 2000 }),
    order("yOlder", [[P, 1]], { allocationCreatedAtMillis: 1000 }),
    order("bSameTime", [[P, 1]], { allocationCreatedAtMillis: 1500 }),
    order("aSameTime", [[P, 1]], { allocationCreatedAtMillis: 1500 }),
  ];
  run(batches, orders);
  const got = orders.filter((o) => o.data.items[0].reservedQuantity === 1).map((o) => o.id).sort();
  assert.deepEqual(got, ["aSameTime", "yOlder"]);
});

test("the sortable key orders exactly like the comparator", () => {
  const raw = [
    ["u1", { priority: "Urgent", requestedDeliveryDate: "2026-11-01", allocationCreatedAtMillis: 5 }],
    ["s1", { priority: "Standard", requestedDeliveryDate: "2026-10-01", allocationCreatedAtMillis: 5 }],
    ["s2", { priority: "Standard", requestedDeliveryDate: "2026-10-01", scheduledDeliveryTime: "08:30", allocationCreatedAtMillis: 9 }],
    ["s3", { priority: "Standard", requestedDeliveryDate: null, allocationCreatedAtMillis: 1 }],
    ["s4", { priority: "Standard", requestedDeliveryDate: "2026-10-01", allocationCreatedAtMillis: 4 }],
    ["s0", { priority: "Standard", requestedDeliveryDate: "2026-10-01", allocationCreatedAtMillis: 4 }],
    ["u2", { priority: "urgent", requestedDeliveryDate: "garbage", allocationCreatedAtMillis: 1 }],
  ];
  const byComparator = [...raw].sort((a, b) => compareAllocationPriority(priorityTuple(a[1], a[0]), priorityTuple(b[1], b[0]))).map((x) => x[0]);
  const byKey = [...raw].sort((a, b) => (allocationPriorityKey(a[1], a[0]) < allocationPriorityKey(b[1], b[0]) ? -1 : 1)).map((x) => x[0]);
  assert.deepEqual(byKey, byComparator);
  assert.deepEqual(byComparator, ["u1", "u2", "s2", "s0", "s4", "s1", "s3"]);
});

// ---------------------------------------------------------------- 8 FEFO

test("8. FEFO: the earliest valid expiry is used first; unusable stock never", () => {
  const batches = [
    batch("late", { quantity: 5, expiryDate: "2028-01-01" }),
    batch("soon", { quantity: 2, expiryDate: "2026-12-01" }),
    batch("expired", { quantity: 50, expiryDate: "2026-10-04" }),
    batch("critical", { quantity: 50, status: "Critical", expiryDate: "2026-10-20" }),
    batch("recalled", { quantity: 50, status: "Recalled" }),
    batch("returning", { quantity: 3, returnPendingQuantity: 3, expiryDate: "2026-11-01" }),
    batch("quarantined", { quantity: 4, quarantinedQuantity: 4, expiryDate: "2026-11-02" }),
    batch("corrupt", { quantity: "40" }),
    batch("otherProduct", { quantity: 50, vaccineId: Q, expiryDate: "2026-10-30" }),
  ];
  const orders = [order("o1", [[P, 4]])];
  const plan = run(batches, orders);
  assert.deepEqual(plan.orderUpdates[0].slices.map((s) => [s.inventoryId, s.quantity]), [["soon", 2], ["late", 2]]);
  for (const id of ["expired", "critical", "recalled", "returning", "quarantined", "corrupt", "otherProduct"]) {
    assert.equal(batches.find((b) => b.id === id).data.reservedQuantity, 0, id);
  }
});

test("15. return-pending, quarantined and written-off units are never available", () => {
  assert.equal(allocatableUnits({ status: "Stable", expiryDate: "2027-01-01", quantity: 10, reservedQuantity: 2, returnPendingQuantity: 3, quarantinedQuantity: 4 }, NOW), 1);
  assert.equal(allocatableUnits({ status: "Stable", expiryDate: "2027-01-01", quantity: 5, reservedQuantity: 5 }, NOW), 0);
  assert.equal(allocatableUnits({ status: "Stable", expiryDate: "2027-01-01", quantity: 5, reservedQuantity: 6 }, NOW), 0, "never negative");
});

// ---------------------------------------------------------------- 9–10 multi-line, products

test("9. a multi-line order stays blocked until EVERY line is fully reserved", () => {
  const batches = [batch("a1", { quantity: 10 }), batch("b1", { quantity: 1, vaccineId: Q })];
  const orders = [order("o1", [[P, 5], [Q, 3]])];
  run(batches, orders, P);
  assert.equal(orders[0].data.allocationState, "partially_reserved", "line A full, line B empty");
  assert.deepEqual(orders[0].data.backorderedProductKeys, [Q]);
  run(batches, orders, Q);
  assert.equal(orders[0].data.allocationState, "partially_reserved", "B has 1 of 3");
  batches.push(batch("b2", { quantity: 2, vaccineId: Q }));
  run(batches, orders, Q);
  assert.equal(orders[0].data.allocationState, "fully_reserved");
});

test("10. a shortage of one product never blocks allocating another", () => {
  const batches = [batch("bQ", { quantity: 4, vaccineId: Q })];
  const orders = [
    order("highNeedsP", [[P, 5]], { priority: "Urgent" }),
    order("lowNeedsQ", [[Q, 4]]),
  ];
  run(batches, orders, Q);
  assert.equal(orders.find((o) => o.id === "lowNeedsQ").data.allocationState, "fully_reserved");
  assert.equal(orders.find((o) => o.id === "highNeedsP").data.allocationState, undefined, "untouched");
});

test("a higher-priority order keeps its partial reservation while still short", () => {
  const batches = [batch("b1", { quantity: 3 })];
  const orders = [order("high", [[P, 5]], { priority: "Urgent" }), order("low", [[P, 2]])];
  run(batches, orders);
  assert.equal(orders[0].data.items[0].reservedQuantity, 3);
  assert.equal(orders[1].data.items[0].reservedQuantity, 0, "the lower order gets nothing while the higher still needs it");
  batches.push(batch("b2", { quantity: 3 }));
  run(batches, orders);
  assert.equal(orders[0].data.items[0].reservedQuantity, 5);
  assert.equal(orders[1].data.items[0].reservedQuantity, 1, "only the remainder flows down");
});

test("only open, version-2, pending_dispatch orders take part", () => {
  const batches = [batch("b1", { quantity: 10 })];
  const orders = [
    order("closed", [[P, 1]], { allocationOpen: false }),
    order("assigned", [[P, 1]], { status: "assigned" }),
    order("failed", [[P, 1]], { status: "delivery_failed" }),
    order("v1", [[P, 1]], { allocationVersion: 1 }),
    order("open", [[P, 1]]),
  ];
  const plan = run(batches, orders);
  assert.deepEqual(plan.orderUpdates.map((u) => u.orderId), ["open"]);
});

// ---------------------------------------------------------------- invariants

test("invariants: requested = reserved + backordered; reserved never exceeds stock", () => {
  const batches = [batch("b1", { quantity: 7 }), batch("b2", { quantity: 5, expiryDate: "2027-01-01" })];
  const orders = [order("o1", [[P, 4], [P, 6]]), order("o2", [[P, 9]], { requestedDeliveryDate: "2026-11-01" })];
  const plan = run(batches, orders);
  for (const o of orders) {
    for (const l of o.data.items) {
      const c = lineCounts(l);
      assert.equal(c.reserved + c.backordered, c.requested);
      assert.equal(l.reservedQuantity + l.backorderedQuantity, l.quantity);
    }
  }
  const reservedTotal = batches.reduce((s, b) => s + b.data.reservedQuantity, 0);
  assert.equal(reservedTotal, 12);
  assert.equal(plan.allocatedUnits, 12);
  for (const b of batches) assert.ok(b.data.reservedQuantity <= b.data.quantity, b.id);
});

test("slices merge per (line, batch) and total per batch", () => {
  const merged = mergeSlices(
    [{ lineIndex: 0, inventoryId: "b1", quantity: 2 }],
    [{ lineIndex: 0, inventoryId: "b1", quantity: 3 }, { lineIndex: 1, inventoryId: "b1", quantity: 1 }, { lineIndex: 0, inventoryId: "b2", quantity: 4 }]
  );
  assert.deepEqual(merged.map((s) => [s.lineIndex, s.inventoryId, s.quantity]), [[0, "b1", 5], [1, "b1", 1], [0, "b2", 4]]);
  assert.deepEqual([...unitsByBatch(merged)], [["b1", 6], ["b2", 4]]);
  assert.deepEqual([...unitsByBatch([{ inventoryId: "x", quantity: 0 }, { inventoryId: 5, quantity: 2 }, null])], []);
});

// ---------------------------------------------------------------- triggers

test("the inventory trigger allocates only when free stock grows", () => {
  const before = { vaccineId: P, status: "Stable", expiryDate: "2027-01-01", quantity: 10, reservedQuantity: 10 };
  assert.deepEqual(productKeysForInventoryWrite(null, { ...before, reservedQuantity: 0 }, NOW), [P], "new batch with stock");
  assert.deepEqual(productKeysForInventoryWrite(before, { ...before, reservedQuantity: 6 }, NOW), [P], "release");
  assert.deepEqual(productKeysForInventoryWrite(before, { ...before, quantity: 12 }, NOW), [P], "correction up");
  assert.deepEqual(productKeysForInventoryWrite({ ...before, reservedQuantity: 6 }, before, NOW), [], "allocation itself");
  assert.deepEqual(productKeysForInventoryWrite(before, { ...before, manufacturer: "x" }, NOW), [], "no change");
  assert.deepEqual(productKeysForInventoryWrite(before, null, NOW), [], "deleted");
  assert.deepEqual(productKeysForInventoryWrite(null, { ...before, vaccineId: undefined }, NOW), [], "no product");
});

test("the order trigger allocates only when an order newly joins the queue", () => {
  const open = order("o", [[P, 1]]).data;
  open.backorderedProductKeys = [P];
  assert.deepEqual(productKeysForOrderWrite(null, open), [P]);
  assert.deepEqual(productKeysForOrderWrite({ ...open, status: "delivery_failed", allocationOpen: false }, open), [P], "requeued");
  assert.deepEqual(productKeysForOrderWrite(open, { ...open, backorderedProductKeys: [] }), [], "allocation progress");
  assert.deepEqual(productKeysForOrderWrite(open, { ...open, allocationOpen: false }), []);
});

// ---------------------------------------------------------------- stock addition input

test("stock-addition input: server validation and expiry-derived status", () => {
  const ok = {
    vaccineId: "vac1",
    batchId: " bt-2026-099 ",
    manufacturingDate: "2026-09-01",
    arrivalDate: "2026-10-01",
    expiryDate: "2027-06-30",
    quantity: 5,
    sellingPriceCentavos: 125000,
  };
  const v = validateStockBatchPayload(ok, NOW);
  assert.equal(v.batchId, "BT-2026-099");
  assert.equal(v.status, "Stable");
  const code = (over) => {
    try {
      validateStockBatchPayload({ ...ok, ...over }, NOW);
      return null;
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code({ quantity: 0 }), "invalid-stock-batch");
  assert.equal(code({ quantity: 1.5 }), "invalid-stock-batch");
  assert.equal(code({ quantity: "5" }), "invalid-stock-batch");
  assert.equal(code({ sellingPriceCentavos: 0 }), "invalid-stock-batch");
  assert.equal(code({ expiryDate: "2026-10-05" }), "invalid-stock-batch", "expired");
  assert.equal(code({ manufacturingDate: "2026-10-06" }), "invalid-stock-batch", "future manufacture");
  assert.equal(code({ arrivalDate: "2026-12-31" }), "invalid-stock-batch", "arrival too far ahead");
  assert.equal(code({ reservedQuantity: 3 }), "unknown-field", "counters are never caller-supplied");
  assert.equal(code({ vaccineName: "Free" }), "unknown-field", "names come from the catalog");
  assert.equal(statusFromExpiry("2026-11-01", "2026-10-05"), "Critical");
  assert.equal(statusFromExpiry("2026-12-15", "2026-10-05"), "Warning");
  assert.equal(statusFromExpiry("2027-06-30", "2026-10-05"), "Stable");
});

// ---------------------------------------------------------------- paging (pure)

test("nextAllocationStep: every non-final step makes progress; the run ends only when nothing more is possible", () => {
  const { nextAllocationStep } = require("../src/allocation");
  const lastBatch = { expiryDate: "2027-01-01", id: "b99" };
  const base = { orderCount: 25, orderPageFull: true, batchPageFull: false, allocatedUnits: 0, leftAvailable: 0, lastBatch, lastOrderKey: "1|k25" };
  const start = { batchCursor: null, orderCursor: null };

  // No demand from the cursor on → done.
  assert.equal(nextAllocationStep({ ...base, orderCount: 0, leftAvailable: 9 }, start).done, true);
  // Stock left, and the order page was the last one → every order was served.
  assert.equal(nextAllocationStep({ ...base, orderPageFull: false, orderCount: 3, leftAvailable: 4, allocatedUnits: 2 }, start).done, true);
  // Stock left, full order page, NOTHING allocated → skip that page (not stop:
  // stopping here is exactly what used to strand stock for order #26+).
  const skip = nextAllocationStep({ ...base, leftAvailable: 5 }, start);
  assert.deepEqual(skip, { done: false, batchCursor: null, orderCursor: "1|k25" });
  // Stock left, full order page, units allocated → same page again (served orders leave the queue).
  assert.deepEqual(nextAllocationStep({ ...base, leftAvailable: 5, allocatedUnits: 3 }, start), { done: false, batchCursor: null, orderCursor: null });
  // No stock left on a full batch page → next batch page (not stop: there may be 100+ batches).
  assert.deepEqual(nextAllocationStep({ ...base, batchPageFull: true }, start), { done: false, batchCursor: lastBatch, orderCursor: null });
  // No stock left and that was the last batch page → done.
  assert.equal(nextAllocationStep({ ...base, batchPageFull: false }, start).done, true);
  // Cursors carry over untouched where the step does not move them.
  const mid = { batchCursor: lastBatch, orderCursor: "1|k10" };
  assert.deepEqual(nextAllocationStep({ ...base, leftAvailable: 5, allocatedUnits: 1 }, mid), { done: false, ...mid });
});

test("an on-hand figure above the Add Stock ceiling is unconfirmed: never allocated, never quoted", () => {
  const { evaluateBatch, MAX_STOCK_QUANTITY } = require("../src/policy");
  // Staging's BT-2026-011: usable status, valid expiry, linked product — but
  // 99,999,999,999,900 on hand, which nobody has confirmed.
  const typo = { vaccineId: "p", status: "Warning", expiryDate: "2027-11-07", quantity: 99999999999900, reservedQuantity: 70, sellingPriceCentavos: 100 };
  assert.equal(allocatableUnits(typo, NOW), 0);
  assert.throws(
    () => evaluateBatch({ inventoryId: "OCvs", data: typo, requested: 1, expectedUnitPriceCentavos: 100, now: NOW, allowBackorder: true }),
    (e) => e.code === "inventory-quantity-unconfirmed"
  );
  // At the ceiling it is ordinary stock again.
  const ok = { ...typo, quantity: MAX_STOCK_QUANTITY, reservedQuantity: 0 };
  assert.equal(allocatableUnits(ok, NOW), MAX_STOCK_QUANTITY);
  // Settling what is ALREADY reserved is unaffected: the 70 units held by an
  // existing order can still be consumed or released.
  const { settleBatch } = require("../src/policy");
  assert.equal(settleBatch({ inventoryId: "OCvs", data: typo, quantity: 70, mode: "consume" }).quantity, 99999999999830);
  assert.equal(settleBatch({ inventoryId: "OCvs", data: typo, quantity: 70, mode: "release" }).reservedQuantity, 0);
});
