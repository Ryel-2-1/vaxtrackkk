import test from "node:test";
import assert from "node:assert/strict";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

// Order document identity.
//
// Every order write in the app targets `orders/{id}`, and the Firestore rules
// match a rider's own orders on that same path, so the document id is the
// order's only identity. The readers used to spread document data AFTER `id`,
// which let a stored field named `id` silently replace it — a later
// assign/status/cargo write would then have been aimed at a different document.
//
// These execute the real service modules; they do not grep the source.

const loader = createServiceLoader();
const orderService = await loader.load("orderService.js");
const deliveryService = await loader.load("deliveryService.js");
const cargoLoadingService = await loader.load("cargoLoadingService.js");
const invoiceService = await loader.load("invoiceService.js");

const REAL_DOC_ID = "RealOrderDocId";
const FORGED_ID = "FORGED-DIFFERENT-DOC";

/** An order whose stored data carries a hostile `id` field. */
const forgedOrder = (overrides = {}) => ({
  id: FORGED_ID, // the attack: a stored field named `id`
  orderNumber: "VT-ORD-9999",
  clinicId: "CLN-0001",
  clinicDocId: "clinicDocAbc",
  assignedRiderId: "riderUid123",
  status: "pending_dispatch",
  createdByUid: "salesRepUid",
  ...overrides,
});

/** A legacy order with no `id` field at all. */
const legacyOrder = (overrides = {}) => ({
  orderNumber: "VT-ORD-1111",
  status: "delivered",
  createdByUid: "salesRepUid",
  ...overrides,
});

const seedWith = (data) =>
  createStore({ orders: { [REAL_DOC_ID]: data }, users: {} });

const once = (subscribe) =>
  new Promise((resolve) => {
    subscribe(resolve);
  });

// ---------------------------------------------------------------------------
// A forged stored `id` never wins
// ---------------------------------------------------------------------------

test("getOrderById returns the Firestore document id, not a stored `id`", async () => {
  installStore(seedWith(forgedOrder()));
  const order = await orderService.getOrderById(REAL_DOC_ID);

  assert.equal(order.id, REAL_DOC_ID, "document id must win");
  assert.notEqual(order.id, FORGED_ID);
  assert.equal(order.orderNumber, "VT-ORD-9999", "other fields still come through");
});

test("subscribeSalesRepOrders returns the document id, not a stored `id`", async () => {
  installStore(seedWith(forgedOrder({ createdByUid: "salesRepUid" })));
  const orders = await once((cb) =>
    orderService.subscribeSalesRepOrders("salesRepUid", cb)
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, REAL_DOC_ID);
  assert.notEqual(orders[0].id, FORGED_ID);
});

test("subscribePendingDispatchOrders returns the document id, not a stored `id`", async () => {
  installStore(seedWith(forgedOrder({ status: "pending_dispatch" })));
  const orders = await once((cb) => orderService.subscribePendingDispatchOrders(cb));

  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, REAL_DOC_ID);
  assert.notEqual(orders[0].id, FORGED_ID);
});

test("subscribeAssignedRiderOrders returns the document id, not a stored `id`", async () => {
  // Still exported and still covered, even though the web no longer calls it.
  installStore(seedWith(forgedOrder({ status: "assigned", assignedRiderId: "riderUid123" })));
  const orders = await once((cb) =>
    orderService.subscribeAssignedRiderOrders("riderUid123", cb)
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, REAL_DOC_ID);
  assert.notEqual(orders[0].id, FORGED_ID);
});

test("deliveryService.subscribeDeliveries returns the document id, not a stored `id`", async () => {
  installStore(seedWith(forgedOrder({ status: "in_transit" })));
  const orders = await once((cb) => deliveryService.subscribeDeliveries(cb));

  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, REAL_DOC_ID);
  assert.notEqual(orders[0].id, FORGED_ID);
  // The derived status fields must still be computed and must not be displaced.
  assert.equal(orders[0].statusKey, "in_transit");
  assert.equal(orders[0].statusLabel, "In Transit");
});

test("cargo loading groups carry the document id, not a stored `id`", async () => {
  // This id is handed to updateOrderLoadedState and finalizeRiderDispatch,
  // which write to orders/{id}, so it must be authoritative.
  const store = createStore({
    orders: {
      [REAL_DOC_ID]: forgedOrder({ status: "assigned", assignedRiderId: "riderUid123" }),
    },
    users: {
      riderUid123: { role: "rider", status: "approved", fullName: "QA Rider" },
    },
  });
  installStore(store);

  const groups = await once((cb) => cargoLoadingService.subscribeCargoLoadingGroups(cb));
  const orders = groups.flatMap((g) => g.orders ?? []);
  assert.ok(orders.length >= 1, "the assigned order should appear in a rider group");
  assert.equal(orders[0].id, REAL_DOC_ID);
  assert.notEqual(orders[0].id, FORGED_ID);
});

test("cargo loading rider uid is the users document id, not a stored `uid`", async () => {
  const store = createStore({
    orders: {
      [REAL_DOC_ID]: forgedOrder({ status: "assigned", assignedRiderId: "riderUid123" }),
    },
    users: {
      riderUid123: {
        uid: "FORGED-RIDER-UID", // hostile stored field
        role: "rider",
        status: "approved",
        fullName: "QA Rider",
      },
    },
  });
  installStore(store);

  const groups = await once((cb) => cargoLoadingService.subscribeCargoLoadingGroups(cb));
  const uids = groups.map((g) => g.riderId ?? g.rider?.uid).filter(Boolean);
  assert.ok(
    uids.every((u) => u !== "FORGED-RIDER-UID"),
    "a stored uid field must never become the rider identity"
  );
  assert.ok(uids.includes("riderUid123"), "the users document id is the rider identity");
});

test("the invoice queue's order id is the document id, not a stored `id`", async () => {
  // This id becomes the invoice document id (one invoice per order) and is
  // written back to orders/{id} by updateInvoicePriority.
  installStore(
    createStore({
      orders: { [REAL_DOC_ID]: forgedOrder({ status: "delivered" }) },
      invoices: {},
    })
  );

  const rows = await once((cb) => invoiceService.subscribeInvoiceQueue(cb));
  const row = rows.find((r) => r.orderId === REAL_DOC_ID || r.id === REAL_DOC_ID);
  assert.ok(row, "the delivered order should appear in the invoice queue");
  assert.ok(
    JSON.stringify(rows).indexOf(FORGED_ID) === -1,
    "the forged id must not survive anywhere in the queue rows"
  );
});

// ---------------------------------------------------------------------------
// Legacy documents are unaffected
// ---------------------------------------------------------------------------

test("legacy orders without an `id` field behave exactly as before", async () => {
  installStore(seedWith(legacyOrder()));

  const direct = await orderService.getOrderById(REAL_DOC_ID);
  assert.equal(direct.id, REAL_DOC_ID);
  assert.equal(direct.orderNumber, "VT-ORD-1111");
  assert.equal(direct.status, "delivered");

  const listed = await once((cb) => deliveryService.subscribeDeliveries(cb));
  assert.equal(listed[0].id, REAL_DOC_ID);
  assert.equal(listed[0].statusKey, "delivered");
  // No invented fields: the reader adds identity + derived status only.
  assert.equal(listed[0].assignedRiderId, undefined);
});

test("ordinary order data is untouched by the identity fix", async () => {
  const data = legacyOrder({
    clinicName: "OSM QA Test Clinic",
    quantity: 120,
    items: [{ name: "Comirnaty", sku: "BATCH-1", quantity: 120 }],
  });
  installStore(seedWith(data));

  const order = await orderService.getOrderById(REAL_DOC_ID);
  assert.equal(order.clinicName, "OSM QA Test Clinic");
  assert.equal(order.quantity, 120);
  assert.deepEqual(order.items, data.items);
});

test("business identifiers are never used as document identity", async () => {
  installStore(
    seedWith(
      forgedOrder({
        orderNumber: "VT-ORD-9999",
        clinicId: "CLN-0001",
        clinicDocId: "clinicDocAbc",
        assignedRiderId: "riderUid123",
        invoiceNumber: "INV-2026-000001",
      })
    )
  );
  const order = await orderService.getOrderById(REAL_DOC_ID);

  for (const businessId of [
    "VT-ORD-9999",
    "CLN-0001",
    "clinicDocAbc",
    "riderUid123",
    "INV-2026-000001",
    FORGED_ID,
  ]) {
    assert.notEqual(order.id, businessId, `${businessId} must not become the identity`);
  }
  assert.equal(order.id, REAL_DOC_ID);
});
