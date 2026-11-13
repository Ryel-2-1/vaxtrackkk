"use strict";
/**
 * Client revisions of 2026-11-13, pure parts:
 *  - stock arriving after an order's delivery date is not reserved for it;
 *  - the invoice names the lots actually reserved/delivered;
 *  - Add Stock and batch edits accept Lot Number and Supplier (optional).
 * Synthetic data only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { arrivesBy } = require("../src/expiryGuard");
const { planAllocation } = require("../src/allocation");
const { readInvoiceLots, withInvoiceLots, lotsLabel, expiriesLabel } = require("../src/invoiceLots");
const { validateStockBatchPayload } = require("../src/inventoryWorkflow");
const { validateBatchMetadata } = require("../src/batchMetadata");

const NOW = new Date(Date.UTC(2026, 10, 13, 2, 0)); // Nov 13 10:00 Manila
const P = "v1";
const batch = (id, arrivalDate, expiryDate = "2027-06-01", quantity = 10) => ({
  id,
  data: { vaccineId: P, batchId: id.toUpperCase(), status: "Stable", arrivalDate, expiryDate, quantity, reservedQuantity: 0 },
});
const order = (id, requestedDeliveryDate, quantity) => ({
  id,
  data: {
    status: "pending_dispatch", allocationVersion: 2, allocationOpen: true, requestedDeliveryDate,
    createdAt: { toMillis: () => 1 },
    items: [{ productKey: P, quantity, reservedQuantity: 0, backorderedQuantity: quantity }],
  },
});

test("arrivesBy: on or before the date; no arrival date means on hand", () => {
  assert.equal(arrivesBy({ arrivalDate: "2026-11-15" }, "2026-11-15"), true);
  assert.equal(arrivesBy({ arrivalDate: "2026-11-16" }, "2026-11-15"), false);
  assert.equal(arrivesBy({}, "2026-11-15"), true);
  assert.equal(arrivesBy({ arrivalDate: "not a date" }, "2026-11-15"), true);
});

test("stock arriving after the delivery date is not reserved; the order keeps waiting", () => {
  // The reproduced case: due Nov 15, the only stock arrives Nov 25.
  const late = planAllocation({ productKey: P, batches: [batch("late01", "2026-11-25")], orders: [order("o1", "2026-11-15", 5)], now: NOW });
  assert.deepEqual(late.orderUpdates, [], "nothing reserved, so the order stays awaiting_stock and cannot dispatch");
  // The same stock serves an order due on or after its arrival (future orders keep working).
  const future = planAllocation({ productKey: P, batches: [batch("late01", "2026-11-25")], orders: [order("o2", "2026-11-25", 5)], now: NOW });
  assert.equal(future.orderUpdates[0].allocationState, "fully_reserved");
  // Stock already here still goes to the early order; the late batch is left for later ones.
  const mixed = planAllocation({
    productKey: P,
    batches: [batch("here", "2026-11-10", "2027-08-01", 3), batch("late01", "2026-11-25", "2027-06-01", 10)],
    orders: [order("o1", "2026-11-15", 5), order("o2", "2026-11-30", 5)],
    now: NOW,
  });
  const o1 = mixed.orderUpdates.find((u) => u.orderId === "o1");
  const o2 = mixed.orderUpdates.find((u) => u.orderId === "o2");
  assert.deepEqual(o1.slices.map((s) => [s.inventoryId, s.quantity]), [["here", 3]]);
  assert.equal(o1.allocationState, "partially_reserved");
  assert.deepEqual(o2.slices.map((s) => [s.inventoryId, s.quantity]), [["late01", 5]]);
});

test("reschedule refuses a date before reserved stock arrives", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/scheduleOperations.js"), "utf8");
  assert.match(src, /"reserved-batch-arrives-later"/);
  assert.match(src, /!arrivesBy\(\{ arrivalDate: arrival \}, needBy\)/);
  assert.match(require("node:fs").readFileSync(require.resolve("../index.js"), "utf8"), /"reserved-batch-arrives-later": "failed-precondition"/);
});

// ---- invoice lots ----

function fakeTx(docs) {
  return {
    get: async (ref) => {
      const data = docs[ref.path];
      return { exists: data !== undefined, data: () => data };
    },
  };
}
const fakeDb = { collection: (c) => ({ doc: (id) => ({ path: `${c}/${id}` }) }) };

test("the invoice names the lots actually reserved, not the quoted batch", async () => {
  const docs = {
    "inventoryReservations/o1": {
      status: "consumed",
      items: [
        { lineIndex: 0, inventoryId: "b2", batchId: "B2", quantity: 6 },
        { lineIndex: 0, inventoryId: "b3", batchId: "B3", quantity: 4 },
        { lineIndex: 1, inventoryId: "b9", batchId: "B9", quantity: 2 },
      ],
    },
    "inventory/b2": { batchId: "B2", lotNumber: "LOT-A12", expiryDate: "2027-03-01" },
    "inventory/b3": { batchId: "B3", lotNumber: "", expiryDate: "2027-05-01" },
    "inventory/b9": { batchId: "B9", expiryDate: "2027-09-01" },
  };
  // Line 0 was QUOTED from b1, but FEFO filled it from b2 and b3.
  const orderItems = [{ inventoryId: "b1", batchId: "B1" }, { inventoryId: "b9", batchId: "B9" }];
  const lots = await readInvoiceLots(fakeTx(docs), fakeDb, "o1", orderItems);
  const items = withInvoiceLots([{ batchId: "B1", quantity: 10 }, { batchId: "B9", quantity: 2 }], lots);
  assert.equal(items[0].lotNumber, "LOT-A12 (6), B3 (4)", "Lot Number, else the Batch ID");
  assert.equal(items[0].expiry, "2027-03-01, 2027-05-01");
  assert.equal(items[0].batchId, "B1", "the quoted batch stays for traceability");
  assert.equal(items[0].quantity, 10, "quantities and prices untouched");
  assert.equal(items[1].lotNumber, "B9");
  assert.equal(items[1].expiry, "2027-09-01");
});

test("no lots for a released, returned or missing reservation; slices without lineIndex match by batch", async () => {
  for (const status of ["released", "returned"]) {
    const lots = await readInvoiceLots(fakeTx({ "inventoryReservations/o": { status, items: [{ lineIndex: 0, inventoryId: "b", quantity: 1 }] } }), fakeDb, "o", [{}]);
    assert.equal(lots.size, 0, status);
  }
  assert.equal((await readInvoiceLots(fakeTx({}), fakeDb, "o", [{}])).size, 0);
  const legacy = await readInvoiceLots(
    fakeTx({ "inventoryReservations/o": { status: "reserved", items: [{ inventoryId: "b5", quantity: 3 }] }, "inventory/b5": { batchId: "B5" } }),
    fakeDb, "o", [{ inventoryId: "b4" }, { inventoryId: "b5" }]
  );
  assert.deepEqual([...legacy.keys()], [1]);
  assert.equal(lotsLabel([]), "");
  assert.equal(expiriesLabel([{ expiryDate: "2027-01-01" }, { expiryDate: "2027-01-01" }]), "2027-01-01");
});

// ---- Lot Number and Supplier ----

const stockPayload = (over = {}) => ({
  vaccineId: "vac1", batchId: "bt-1", manufacturingDate: "2026-10-01", arrivalDate: "2026-11-13",
  expiryDate: "2027-10-01", quantity: 10, sellingPriceCentavos: 12345, ...over,
});

test("Add Stock accepts optional Lot Number and Supplier", () => {
  const plain = validateStockBatchPayload(stockPayload(), NOW);
  assert.equal(plain.lotNumber, "");
  assert.equal(plain.supplier, "");
  const full = validateStockBatchPayload(stockPayload({ lotNumber: " LOT-77 ", supplier: " Angela ", manufacturer: "Johnson" }), NOW);
  assert.equal(full.lotNumber, "LOT-77");
  assert.equal(full.supplier, "Angela");
  assert.equal(full.manufacturer, "Johnson");
  assert.throws(() => validateStockBatchPayload(stockPayload({ supplier: "x".repeat(121) }), NOW), /up to 120/);
  assert.throws(() => validateStockBatchPayload(stockPayload({ lotNumber: 5 }), NOW), /must be text/);
});

test("batch edits may set Lot Number and Supplier; an older client that omits them leaves them unchanged", () => {
  const base = {
    inventoryId: "inv1", batchId: "BT-1", manufacturingDate: "2026-10-01", expiryDate: "2027-10-01",
    location: "Hub", manufacturer: "Johnson",
  };
  const expected = { batchId: "BT-1", manufacturingDate: "2026-10-01", expiryDate: "2027-10-01", location: "Hub", manufacturer: "Johnson" };
  const old = validateBatchMetadata({ ...base, expected }, NOW);
  assert.equal("supplier" in old.values, false);
  const now = validateBatchMetadata({ ...base, supplier: " Angela ", lotNumber: "", expected: { ...expected, supplier: "", lotNumber: "" } }, NOW);
  assert.equal(now.values.supplier, "Angela");
  assert.equal(now.values.lotNumber, "");
  assert.throws(() => validateBatchMetadata({ ...base, supplier: "Angela", expected }, NOW), /Reload the batch/);
});
