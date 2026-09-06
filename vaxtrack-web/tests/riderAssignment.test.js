import test from "node:test";
import assert from "node:assert/strict";
import {
  createServiceLoader,
  createStore,
  injectCompetingWrite,
  installStore,
  SERVER_TIMESTAMP,
} from "./serviceHarness.js";

// Transactional rider assignment.
//
// The previous version took a caller-supplied rider object and wrote it with
// `updateDoc`, trusting an order id that arrived through localStorage. Two
// dispatchers acting on the same queue entry both succeeded and the later write
// silently replaced the earlier rider.
//
// These tests execute the real `assignRiderToOrder` against an in-memory store
// that models Firestore's optimistic concurrency: a transaction records the
// versions it read and is retried if any changed before commit. No emulator,
// no network, no staging write.

const loader = createServiceLoader();
const { assignRiderToOrder, AssignmentError } = await loader.load("orderService.js");

const ORDER_ID = "OrderDocAbc";
const RIDER_UID = "RiderDocUid123";
const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };

const pendingOrder = (overrides = {}) => ({
  orderNumber: "VT-ORD-5001",
  status: "pending_dispatch",
  assignedRiderId: null,
  assignedRiderName: null,
  createdByUid: "salesRepUid",
  ...overrides,
});

const approvedRider = (overrides = {}) => ({
  role: "rider",
  status: "approved",
  fullName: "QA Rider Two",
  phone: "09179876543",
  employeeId: "EMP-4432",
  vehiclePlate: "ABC-1234",
  ...overrides,
});

const seed = ({ order = pendingOrder(), rider = approvedRider(), extraUsers = {} } = {}) =>
  createStore({
    orders: order ? { [ORDER_ID]: order } : {},
    users: { ...(rider ? { [RIDER_UID]: rider } : {}), ...extraUsers },
  });

const orderIn = (store) => store.collections.orders[ORDER_ID].data;

async function expectRejection(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AssignmentError, `expected AssignmentError, got ${err?.name}`);
    assert.equal(err.code, code);
    assert.ok(err.message.length > 0, "the error must carry a displayable message");
    return true;
  });
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("an approved rider is assigned to a pending order", async () => {
  const store = installStore(seed(), DISPATCHER);
  const result = await assignRiderToOrder(ORDER_ID, RIDER_UID);

  const order = orderIn(store);
  assert.equal(order.status, "assigned");
  assert.equal(order.assignedRiderId, RIDER_UID);
  assert.equal(result.riderUid, RIDER_UID);
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(result.assignedRiderName, "QA Rider Two");
});

test("assignment timestamps and audit identity are server-stamped and authentic", async () => {
  const store = installStore(seed(), DISPATCHER);
  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  const order = orderIn(store);

  assert.equal(order.assignedAt, SERVER_TIMESTAMP, "assignedAt must be server-stamped");
  assert.equal(order.updatedAt, SERVER_TIMESTAMP);
  // The dispatcher identity comes from the session, not from a caller argument.
  assert.equal(order.assignedByUid, DISPATCHER.uid);
  assert.equal(order.assignedByEmail, DISPATCHER.email);
});

test("display fields are copied from the rider document", async () => {
  const store = installStore(seed(), DISPATCHER);
  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  const order = orderIn(store);

  assert.equal(order.assignedRiderName, "QA Rider Two");
  assert.equal(order.assignedRiderPhone, "09179876543");
  // Employee id and vehicle are display-only elsewhere and are not assignment data.
  assert.equal(order.assignedRiderEmployeeId, undefined);
  assert.equal(order.assignedRiderVehicle, undefined);
});

test("a rider with no phone on record gets no invented phone", async () => {
  const store = installStore(
    seed({ rider: approvedRider({ phone: undefined, contactNumber: undefined }) }),
    DISPATCHER
  );
  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  const order = orderIn(store);

  assert.ok(!("assignedRiderPhone" in order), "absent rather than fabricated");
  assert.equal(order.assignedRiderName, "QA Rider Two");
});

test("a rider with no name falls back through the document, never to a placeholder", async () => {
  const store = installStore(
    seed({
      rider: approvedRider({ fullName: undefined, name: undefined, displayName: undefined, email: "rider@vaxtrack.com" }),
    }),
    DISPATCHER
  );
  const result = await assignRiderToOrder(ORDER_ID, RIDER_UID);
  assert.equal(orderIn(store).assignedRiderName, "rider@vaxtrack.com");
  assert.equal(result.assignedRiderName, "rider@vaxtrack.com");
});

// ---------------------------------------------------------------------------
// Order-side rejections
// ---------------------------------------------------------------------------

test("a missing order is rejected", async () => {
  installStore(seed({ order: null }), DISPATCHER);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-not-found");
});

test("an order that is not pending_dispatch is rejected", async () => {
  for (const status of ["assigned", "loading", "in_transit", "delayed", "delivered", "cancelled"]) {
    const store = installStore(seed({ order: pendingOrder({ status }) }), DISPATCHER);
    await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-not-pending");
    assert.equal(orderIn(store).status, status, "the order must be left untouched");
  }
});

test("an already-assigned order is rejected even if its status looks pending", async () => {
  // Defence in depth: status and assignment are checked independently.
  const store = installStore(
    seed({ order: pendingOrder({ assignedRiderId: "SomeOtherRiderUid" }) }),
    DISPATCHER
  );
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-already-assigned");
  assert.equal(orderIn(store).assignedRiderId, "SomeOtherRiderUid", "no overwrite");
});

test("a whitespace-only assignedRiderId still counts as assigned", async () => {
  // Deliberately matched to firestore.rules, which can only test `size() == 0`
  // and therefore treats "   " as a present value. If the service trimmed
  // instead, it would accept a write the rules then refuse.
  const store = installStore(seed({ order: pendingOrder({ assignedRiderId: "   " }) }), DISPATCHER);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-already-assigned");
  assert.equal(orderIn(store).assignedRiderId, "   ");
});

test("absent, null and empty-string all mean unassigned", async () => {
  for (const order of [
    pendingOrder({ assignedRiderId: null }),
    pendingOrder({ assignedRiderId: "" }),
    (() => { const o = pendingOrder(); delete o.assignedRiderId; return o; })(),
  ]) {
    const store = installStore(seed({ order }), DISPATCHER);
    await assignRiderToOrder(ORDER_ID, RIDER_UID);
    assert.equal(orderIn(store).assignedRiderId, RIDER_UID);
  }
});

// ---------------------------------------------------------------------------
// Rider-side rejections
// ---------------------------------------------------------------------------

test("a missing user is rejected", async () => {
  installStore(seed({ rider: null }), DISPATCHER);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "rider-not-found");
});

test("admin, dispatcher and sales rep accounts are rejected", async () => {
  for (const role of ["admin", "dispatcher", "salesrep"]) {
    const store = installStore(seed({ rider: approvedRider({ role }) }), DISPATCHER);
    await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "not-a-rider");
    assert.equal(orderIn(store).status, "pending_dispatch");
  }
});

test("pending, disabled and rejected riders are rejected", async () => {
  for (const status of ["pending", "pending_approval", "disabled", "rejected"]) {
    const store = installStore(seed({ rider: approvedRider({ status }) }), DISPATCHER);
    await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "rider-not-approved");
    assert.equal(orderIn(store).assignedRiderId, null);
  }
});

test("role and status must match exactly — no case or whitespace leniency", async () => {
  for (const rider of [approvedRider({ role: "Rider" }), approvedRider({ role: " rider " })]) {
    installStore(seed({ rider }), DISPATCHER);
    await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "not-a-rider");
  }
  installStore(seed({ rider: approvedRider({ status: "Approved" }) }), DISPATCHER);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "rider-not-approved");
});

// ---------------------------------------------------------------------------
// Identity cannot be substituted or forged
// ---------------------------------------------------------------------------

test("an employee id cannot substitute for the rider UID", async () => {
  installStore(seed(), DISPATCHER);
  // EMP-4432 is the rider's employeeId, not their document id.
  await expectRejection(assignRiderToOrder(ORDER_ID, "EMP-4432"), "rider-not-found");
});

test("caller-supplied name and phone cannot forge assignment data", async () => {
  // The signature takes identities only, so there is nowhere to inject these.
  assert.equal(assignRiderToOrder.length, 2, "orderId and riderUid only");

  const store = installStore(seed(), DISPATCHER);
  await assignRiderToOrder(ORDER_ID, RIDER_UID, {
    name: "Fake Rider",
    phone: "0000000000",
    employeeId: "EMP-FORGED",
  });
  const order = orderIn(store);
  assert.equal(order.assignedRiderName, "QA Rider Two", "authoritative name wins");
  assert.equal(order.assignedRiderPhone, "09179876543");
  assert.ok(!JSON.stringify(order).includes("EMP-FORGED"));
  assert.ok(!JSON.stringify(order).includes("Fake Rider"));
});

test("an empty or non-string identity is rejected before any read", async () => {
  installStore(seed(), DISPATCHER);
  await expectRejection(assignRiderToOrder("", RIDER_UID), "order-id-required");
  await expectRejection(assignRiderToOrder(ORDER_ID, ""), "rider-uid-required");
  await expectRejection(assignRiderToOrder(ORDER_ID, null), "rider-uid-required");
});

test("an unauthenticated caller is rejected", async () => {
  installStore(seed(), null);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "not-signed-in");
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("a repeated submission does not produce a second assignment", async () => {
  const store = installStore(seed(), DISPATCHER);
  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  const writesAfterFirst = store.writes.length;

  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-not-pending");
  assert.equal(store.writes.length, writesAfterFirst, "no second write occurred");
});

test("two dispatchers racing the same order cannot overwrite one another", async () => {
  const store = installStore(seed({ extraUsers: { RiderTwoUid: approvedRider({ fullName: "Second Rider" }) } }), DISPATCHER);

  // A competing dispatcher commits between this attempt's reads and its commit.
  // The store bumps the document version, so the transaction is retried and the
  // retry sees an order that is already assigned.
  injectCompetingWrite(async () => {
    const rec = store.collections.orders[ORDER_ID];
    rec.data = {
      ...rec.data,
      status: "assigned",
      assignedRiderId: "RiderTwoUid",
      assignedRiderName: "Second Rider",
    };
    rec.version += 1;
  });

  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "order-not-pending");

  const order = orderIn(store);
  assert.equal(order.assignedRiderId, "RiderTwoUid", "the winner's assignment survives");
  assert.equal(order.assignedRiderName, "Second Rider");
  assert.ok(store.transactionAttempts >= 2, "the losing transaction retried rather than clobbering");
});

test("the same rider may still be assigned to a different order", async () => {
  // No one-active-order-per-rider limit, by decision.
  const SECOND_ORDER = "OrderDocDef";
  const store = createStore({
    orders: { [ORDER_ID]: pendingOrder(), [SECOND_ORDER]: pendingOrder({ orderNumber: "VT-ORD-5002" }) },
    users: { [RIDER_UID]: approvedRider() },
  });
  installStore(store, DISPATCHER);

  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  await assignRiderToOrder(SECOND_ORDER, RIDER_UID);

  assert.equal(store.collections.orders[ORDER_ID].data.assignedRiderId, RIDER_UID);
  assert.equal(store.collections.orders[SECOND_ORDER].data.assignedRiderId, RIDER_UID);
});

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

test("a rejected assignment writes nothing at all", async () => {
  const store = installStore(seed({ rider: approvedRider({ status: "disabled" }) }), DISPATCHER);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "rider-not-approved");
  assert.equal(store.writes.length, 0, "no partial write may escape a rejected transaction");
});

test("assignment touches only assignment fields", async () => {
  const store = installStore(
    seed({
      order: pendingOrder({
        clinicDocId: "clinicDocAbc",
        clinicLocationVerified: true,
        clinicLat: 14.5995,
        quantity: 120,
      }),
    }),
    DISPATCHER
  );
  await assignRiderToOrder(ORDER_ID, RIDER_UID);
  const order = orderIn(store);

  // Phase 02A snapshot and order payload are untouched.
  assert.equal(order.clinicDocId, "clinicDocAbc");
  assert.equal(order.clinicLocationVerified, true);
  assert.equal(order.clinicLat, 14.5995);
  assert.equal(order.quantity, 120);
  assert.equal(order.createdByUid, "salesRepUid");

  const written = store.writes.at(-1).data;
  const allowed = [
    "status", "assignedRiderId", "assignedRiderName", "assignedRiderPhone",
    "assignedAt", "assignedByUid", "assignedByEmail", "updatedAt",
  ];
  for (const key of Object.keys(written)) {
    assert.ok(allowed.includes(key), `unexpected field written: ${key}`);
  }
});
