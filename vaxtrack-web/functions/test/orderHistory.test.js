"use strict";

/**
 * Order receipts + allocation history: the pure builders (no Firestore).
 * The emulator suite (test/integration/orderHistory.test.js) covers the
 * transactions; this pins the identities and figures they write.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../src/orderHistory");

const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
const line = (over = {}) => ({
  inventoryId: "inv1", batchId: "BT-1", name: "Vaccine P", sku: "ATV-001", productKey: "vacP",
  quantity: 3, reservedQuantity: 0, backorderedQuantity: 3, unitPriceCentavos: 123457, lineTotalCentavos: 370371,
  ...over,
});
const order = (over = {}) => ({
  orderNumber: "VT-ORD-1-ABCD", createdByUid: "rep1", allocationVersion: 2, allocationState: "awaiting_stock",
  items: [line()], ...over,
});

test("event ids are deterministic and derived from the state change", () => {
  const before = order();
  const update = {
    items: [line({ reservedQuantity: 1, backorderedQuantity: 2 })],
    allocationState: "partially_reserved",
    slices: [{ lineIndex: 0, productKey: "vacP", inventoryId: "inv9", batchId: "BT-9", quantity: 1 }],
  };
  const a = h.allocationEvents({ orderId: "o1", before, update, productKey: "vacP", source: { operation: "addStockBatchWithAllocation" } });
  const b = h.allocationEvents({ orderId: "o1", before, update, productKey: "vacP", source: { operation: "allocateOnInventoryWrite" } });
  assert.deepEqual(a.map((e) => e.eventId), ["o1__e0__alloc__vacP__r1", "o1__e0__state__partially_reserved"]);
  assert.deepEqual(b.map((e) => e.eventId), a.map((e) => e.eventId), "the same change has the same id, whoever runs it");
  // A later reservation of the same product has a new id; a new epoch too.
  const more = h.allocationEvents({
    orderId: "o1", before: { ...before, allocationState: "partially_reserved" },
    update: { ...update, items: [line({ reservedQuantity: 3, backorderedQuantity: 0 })], allocationState: "fully_reserved" },
    productKey: "vacP",
  });
  assert.deepEqual(more.map((e) => e.eventId), ["o1__e0__alloc__vacP__r3", "o1__e0__state__fully_reserved"]);
  const afterFailure = h.allocationEvents({ orderId: "o1", before: { ...before, failureCount: 1 }, update, productKey: "vacP" });
  assert.equal(afterFailure[0].eventId, "o1__e1__alloc__vacP__r1");
  assert.throws(() => h.eventIdOf("a/b"), /unsafe/);
});

test("an allocation event carries the fields the UI and the audit need", () => {
  const [e] = h.allocationEvents({
    orderId: "o1",
    before: order(),
    update: {
      items: [line({ reservedQuantity: 1, backorderedQuantity: 2 })],
      allocationState: "partially_reserved",
      slices: [{ lineIndex: 0, productKey: "vacP", inventoryId: "inv9", batchId: "BT-9", quantity: 1 }],
    },
    productKey: "vacP",
    source: { operation: "addStockBatchWithAllocation", triggeredBy: { uid: "admin1", role: "admin" } },
    newInventoryIds: new Set(["inv9"]),
  });
  const ev = e.event;
  assert.deepEqual(
    [ev.eventType, ev.orderId, ev.orderNumber, ev.medRepUid, ev.productKey, ev.sku, ev.itemName, ev.inventoryId, ev.batchId],
    ["stock_allocated", "o1", "VT-ORD-1-ABCD", "rep1", "vacP", "ATV-001", "Vaccine P", "inv9", "BT-9"]
  );
  assert.deepEqual([ev.quantityChanged, ev.requestedQuantity, ev.reservedQuantityAfter, ev.backorderedQuantityAfter], [1, 3, 1, 2]);
  assert.deepEqual([ev.allocationStateAfter, ev.reservationId, ev.sourceOperation], ["partially_reserved", "o1", "addStockBatchWithAllocation"]);
  assert.deepEqual([ev.actorRole, ev.actorUid, ev.triggeredByUid, ev.triggeredByRole], ["system", null, "admin1", "admin"]);
  assert.deepEqual(ev.batchIds, ["BT-9"]);
  assert.equal(ev.stockAddedInThisOperation, true);
  assert.match(ev.summary, /Reserved 1 vial from batch BT-9 \(newly added stock\)\./);
});

test("version-1 reservation slices without lineIndex map to their line by batch", () => {
  const grouped = h.slicesByLine(
    [{ inventoryId: "a", quantity: 2 }, { inventoryId: "b", quantity: 1 }, { inventoryId: "a", quantity: 1 }],
    [{ inventoryId: "a" }, { inventoryId: "b" }]
  );
  assert.deepEqual(grouped.map((g) => [g.lineIndex, g.batches.map((x) => [x.inventoryId, x.quantity])]), [[0, [["a", 3]]], [1, [["b", 1]]]]);
});

test("cancellation: released units and withdrawn backorder, one id per order", () => {
  const o = order({ allocationState: "partially_reserved", items: [line({ reservedQuantity: 1, backorderedQuantity: 2 })] });
  const c = h.cancellationEvent({ orderId: "o1", order: o, reservationItems: [{ lineIndex: 0, inventoryId: "inv1", batchId: "BT-1", quantity: 1 }], uid: "disp1" });
  assert.equal(c.eventId, "o1__cancel");
  assert.deepEqual([c.event.eventType, c.event.releasedQuantity, c.event.backorderWithdrawnQuantity], ["reservation_released", 1, 2]);
  assert.deepEqual([c.event.reservedQuantityAfter, c.event.backorderedQuantityAfter], [0, 0]);
  const none = h.cancellationEvent({ orderId: "o2", order: order(), reservationItems: [], uid: "disp1" });
  assert.equal(none.event.eventType, "backorder_cancelled");
});

test("the receipt computes VAT from each line's own snapshot, and never invents one", () => {
  const fields = {
    subtotalCentavos: 370371, priority: "Urgent", pricingVersion: 1, priceCurrency: "PHP", priceIsVatInclusive: true,
    doctorName: "Dr. A", clinicName: "Dr. A — Clinic", deliveryAddress: "1 St", requestedDeliveryDate: "2026-10-10",
  };
  const receiptFor = (lines, over = {}) => h.buildOrderReceipt({
    orderId: "o1", orderNumber: "VT-ORD-1-ABCD", requestId: "r", uid: "rep1", user: { name: "Rep" }, email: null,
    orderFields: { ...fields, ...over }, items: lines, FieldValue,
  });
  const vatable = receiptFor([{ ...line(), chain: "T", vatClassification: "vatable" }]);
  // VAT-inclusive: round(370371 × 12 / 112) = 39683 is INSIDE the subtotal; the
  // total stays 370371 (never 414816 — VAT is not added on top).
  assert.deepEqual([vatable.vatStatus, vatable.vatAmountCentavos, vatable.finalTotalCentavos], ["vatable", 39683, 370371]);
  assert.equal(vatable.priceIsVatInclusive, true);
  assert.equal(vatable.lines[0].unitPriceCentavos, 123457, "the original VAT-inclusive unit price is kept");
  const exempt = receiptFor([{ ...line(), chain: "T", vatClassification: "vat_exempt" }]);
  assert.deepEqual([exempt.vatStatus, exempt.vatAmountCentavos, exempt.finalTotalCentavos], ["vat_exempt", 0, 370371]);
  // Mixed orders are allowed on this branch: VAT on the VATable line only.
  const mixed = receiptFor([
    { ...line(), quantity: 1, unitPriceCentavos: 100000, lineTotalCentavos: 100000, vatClassification: "vatable" },
    { ...line(), quantity: 1, unitPriceCentavos: 50000, lineTotalCentavos: 50000, vatClassification: "vat_exempt" },
  ], { subtotalCentavos: 150000 });
  assert.deepEqual([mixed.vatStatus, mixed.vatRatePercent, mixed.vatAmountCentavos, mixed.finalTotalCentavos], ["mixed", 12, 10714, 150000]);
  const none = receiptFor([{ ...line(), chain: "T" }]);
  assert.deepEqual([none.vatStatus, none.vatAmountCentavos, none.finalTotalCentavos], ["not_classified", null, null]);
  assert.deepEqual([none.receiptKind, none.isReconstructed, none.medRepUid, none.medRepName], ["original", false, "rep1", "Rep"]);
  assert.equal(none.lines[0].quotedBatchId, "BT-1");
  assert.equal(none.discountCentavos, null, "there is no order-time discount");
});

test("integrity comparison covers the identity fields and ignores wording and key order", () => {
  for (const f of ["eventType", "orderId", "reservationId", "returnId", "productKey", "batchIds", "quantityChanged",
    "reservedQuantityAfter", "backorderedQuantityAfter", "epoch", "sourceOperation"]) {
    assert.ok(h.IMMUTABLE_EVENT_FIELDS.includes(f), f);
  }
  assert.ok(!h.IMMUTABLE_EVENT_FIELDS.includes("summary") && !h.IMMUTABLE_EVENT_FIELDS.includes("createdAt"));
  assert.equal(h.canonical({ b: 1, a: [1, { d: 2, c: null }] }), h.canonical({ a: [1, { c: undefined, d: 2 }], b: 1 }));
  assert.deepEqual(h.immutableDiff({ eventType: "a", epoch: 0 }, { eventType: "a", epoch: 1 }, ["eventType", "epoch"]), ["epoch"]);
  assert.deepEqual(h.immutableDiff({ returnId: undefined }, { returnId: null }, ["returnId"]), [], "absent ≡ null");
  assert.deepEqual(h.RECEIPT_VOLATILE_FIELDS, ["createdAt", "orderCreatedAt", "reconstructedAt"], "only server timestamps are excluded");
});

test("the ledger code path has no overwrite primitive", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  // Every history write goes through prepare → tx.create; no tx.set on these collections.
  const history = src("orderHistory.js");
  assert.match(history, /tx\.create\(ref, \{ \.\.\.event, eventId, idempotencyKey: eventId, createdAt: FieldValue\.serverTimestamp\(\) \}\)/);
  assert.match(history, /if \(prepared\) tx\.create\(prepared\.ref, prepared\.receipt\)/);
  assert.doesNotMatch(history, /tx\.set\(/);
  for (const f of ["allocation.js", "operations.js", "inventoryWorkflow.js", "failureReturn.js", "orderHistoryOutbox.js"]) {
    const s = src(f);
    assert.doesNotMatch(s, /writeEvent|ALLOCATION_EVENTS\)\.doc\([^)]*\)\.set|RECEIPTS\)\.doc\([^)]*\)\.set/, f);
  }
});

test("initial allocation: one deterministic id; a recovery is labelled", () => {
  const o = order({ allocationState: "partially_reserved", items: [line({ reservedQuantity: 1, backorderedQuantity: 2 })] });
  const normal = h.initialAllocationEvent({ orderId: "o1", order: o, materializedBy: "createOrderWithReservation" });
  const recovered = h.initialAllocationEvent({ orderId: "o1", order: o, materializedBy: "materializeOrderHistory" });
  assert.equal(normal.eventId, "o1__confirmed");
  assert.equal(recovered.eventId, "o1__confirmed");
  assert.deepEqual([normal.event.requestedQuantity, normal.event.reservedQuantityAfter, normal.event.backorderedQuantityAfter, normal.event.allocationStateAfter],
    [3, 1, 2, "partially_reserved"]);
  assert.deepEqual([normal.event.recovered, recovered.event.recovered], [false, true]);
  const marker = h.initialHistoryMarker({ orderId: "o1", orderNumber: "VT-1", medRepUid: "rep1", productKeys: ["vacP"], FieldValue });
  assert.deepEqual([marker.status, marker.task, marker.productKeys], ["pending", "initial_allocation", ["vacP"]]);
});

test("backfill planner: dry-run plans create-only, labelled reconstructed, never over an existing receipt", async () => {
  const { planFor } = await import("../scripts/backfillOrderReceipts.mjs");
  const priced = order({ pricingVersion: 1, subtotalCentavos: 370371 });
  assert.equal(planFor("o1", priced, true).action, "skip");
  const plan = planFor("o1", priced, false);
  assert.equal(plan.action, "create");
  assert.equal(plan.receipt.receiptKind, "reconstructed");
  assert.equal(plan.receipt.isReconstructed, true);
  assert.match(planFor("o2", { items: [{ quantity: 1 }] }, false).why, /no server price snapshot/);
});
