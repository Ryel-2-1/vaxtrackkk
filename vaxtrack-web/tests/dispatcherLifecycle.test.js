import test from "node:test";
import assert from "node:assert/strict";
import {
  createServiceLoader,
  createStore,
  installStore,
  SERVER_TIMESTAMP,
} from "./serviceHarness.js";

// Dispatcher lifecycle services, executed against the in-memory Firestore
// stand-in: cargo loading, finalize dispatch, and cancellation.
//
// These run the REAL service modules — src/services is copied with only its
// two unresolvable import specifiers redirected — so what is asserted is the
// shipped logic, not a description of it. No emulator, no network, no staging.

const loader = createServiceLoader();
const cargo = await loader.load("cargoLoadingService.js");
const orders = await loader.load("orderService.js");
const { WorkflowError } = await loader.load("orderWorkflow.js");

const RIDER = "RiderUid1";
const OTHER_RIDER = "RiderUid2";
const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };

const order = (over = {}) => ({
  orderNumber: "VT-ORD-7001",
  status: "assigned",
  assignedRiderId: RIDER,
  assignedRiderName: "QA Rider",
  isLoaded: false,
  createdByUid: "salesRepUid",
  clinicDocId: "clinicAbc",
  clinicLat: 14.5995,
  clinicLocationVerified: true,
  ...over,
});

const seed = (docs) =>
  createStore({
    orders: docs,
    users: {
      [RIDER]: { role: "rider", status: "approved", fullName: "QA Rider" },
      [OTHER_RIDER]: { role: "rider", status: "approved", fullName: "Other Rider" },
    },
  });

const data = (store, id) => store.collections.orders[id].data;

async function expectRejection(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WorkflowError, `expected WorkflowError, got ${err?.name}`);
    assert.equal(err.code, code);
    assert.ok(err.message.length > 0, "must carry a displayable message");
    return true;
  });
}

// ---------------------------------------------------------------------------
// Cargo loading — the ONLY authority for assigned → loading
// ---------------------------------------------------------------------------

test("confirming an assigned order promotes it to loading", async () => {
  const store = installStore(seed({ o1: order() }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);
  const o = data(store, "o1");

  assert.equal(o.status, "loading");
  assert.equal(o.isLoaded, true);
  assert.equal(o.loadedAt, SERVER_TIMESTAMP);
  assert.equal(o.loadedByUid, DISPATCHER.uid);
  assert.equal(o.statusUpdatedAt, SERVER_TIMESTAMP);
  assert.equal(o.statusUpdatedByUid, DISPATCHER.uid);
});

test("confirming an order that is already loading writes metadata only", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: false }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);

  assert.equal(data(store, "o1").status, "loading", "status is unchanged");
  assert.equal(data(store, "o1").isLoaded, true);
});

test("unchecking never regresses loading back to assigned", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: true }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", false);
  const o = data(store, "o1");

  assert.equal(o.status, "loading", "loading means preparation began; it does not un-begin");
  assert.equal(o.isLoaded, false);
  assert.equal(o.loadedAt, null, "stale audit fields are cleared");
  assert.equal(o.loadedByUid, null);
});

test("loading metadata is refused outside assigned and loading", async () => {
  for (const status of ["pending_dispatch", "in_transit", "delayed", "delivered", "cancelled"]) {
    const store = installStore(seed({ o1: order({ status }) }), DISPATCHER);
    await expectRejection(cargo.updateOrderLoadedState("o1", true), "not-loadable");
    assert.equal(data(store, "o1").status, status, "untouched");
    assert.equal(store.writes.length, 0, "nothing was written");
  }
});

test("the caller's view of the status cannot drive the promotion", async () => {
  // The old signature took a `currentStatusKey` from the rendered list, so a
  // stale screen could promote an order that had already moved on. The service
  // now re-reads; the extra argument is simply ignored.
  const store = installStore(seed({ o1: order({ status: "in_transit" }) }), DISPATCHER);
  await expectRejection(cargo.updateOrderLoadedState("o1", true, DISPATCHER, "assigned"), "not-loadable");
  assert.equal(data(store, "o1").status, "in_transit");
});

test("cargo loading refuses a missing order and an unauthenticated caller", async () => {
  installStore(seed({}), DISPATCHER);
  await expectRejection(cargo.updateOrderLoadedState("nope", true), "order-not-found");

  installStore(seed({ o1: order() }), null);
  await expectRejection(cargo.updateOrderLoadedState("o1", true), "not-signed-in");
});

// ---------------------------------------------------------------------------
// Finalize dispatch — loading → in_transit, atomically
// ---------------------------------------------------------------------------

const loadedOrder = (over = {}) => order({ status: "loading", isLoaded: true, ...over });

test("a fully eligible group is dispatched together", async () => {
  const store = installStore(
    seed({ o1: loadedOrder(), o2: loadedOrder({ orderNumber: "VT-ORD-7002" }) }),
    DISPATCHER
  );
  await cargo.finalizeRiderDispatch(RIDER, ["o1", "o2"]);

  for (const id of ["o1", "o2"]) {
    const o = data(store, id);
    assert.equal(o.status, "in_transit");
    assert.equal(o.dispatchedAt, SERVER_TIMESTAMP);
    assert.equal(o.startedAt, SERVER_TIMESTAMP);
    assert.equal(o.loadingFinalizedAt, SERVER_TIMESTAMP);
    assert.equal(o.dispatchedByUid, DISPATCHER.uid);
    assert.equal(o.statusUpdatedByUid, DISPATCHER.uid);
  }
});

test("multiple orders per rider are preserved", async () => {
  const store = installStore(
    seed({ o1: loadedOrder(), o2: loadedOrder(), o3: loadedOrder() }),
    DISPATCHER
  );
  await cargo.finalizeRiderDispatch(RIDER, ["o1", "o2", "o3"]);
  assert.equal(
    ["o1", "o2", "o3"].filter((id) => data(store, id).status === "in_transit").length,
    3
  );
});

test("a mixed-status batch fails atomically — nothing is dispatched", async () => {
  const store = installStore(
    seed({ o1: loadedOrder(), o2: loadedOrder({ status: "assigned" }) }),
    DISPATCHER
  );
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1", "o2"]), "order-not-dispatchable");

  assert.equal(data(store, "o1").status, "loading", "the eligible order was NOT dispatched");
  assert.equal(data(store, "o2").status, "assigned");
  assert.equal(store.writes.length, 0, "no partial write escaped");
});

test("an unloaded order blocks the whole dispatch", async () => {
  const store = installStore(
    seed({ o1: loadedOrder(), o2: loadedOrder({ isLoaded: false }) }),
    DISPATCHER
  );
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1", "o2"]), "order-not-loaded");
  assert.equal(data(store, "o1").status, "loading");
  assert.equal(store.writes.length, 0);
});

test("an order belonging to another rider blocks the whole dispatch", async () => {
  const store = installStore(
    seed({ o1: loadedOrder(), o2: loadedOrder({ assignedRiderId: OTHER_RIDER }) }),
    DISPATCHER
  );
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1", "o2"]), "order-not-for-rider");
  assert.equal(store.writes.length, 0);
});

test("a stale batch naming a vanished order fails atomically", async () => {
  const store = installStore(seed({ o1: loadedOrder() }), DISPATCHER);
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1", "ghost"]), "order-not-found");
  assert.equal(data(store, "o1").status, "loading");
  assert.equal(store.writes.length, 0);
});

test("terminal orders can never be re-dispatched", async () => {
  for (const status of ["delivered", "cancelled"]) {
    const store = installStore(seed({ o1: loadedOrder({ status }) }), DISPATCHER);
    await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1"]), "order-not-dispatchable");
    assert.equal(data(store, "o1").status, status);
  }
});

test("finalize rejects an empty group, a missing rider and no session", async () => {
  installStore(seed({ o1: loadedOrder() }), DISPATCHER);
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, []), "no-orders");
  await expectRejection(cargo.finalizeRiderDispatch("", ["o1"]), "rider-required");

  installStore(seed({ o1: loadedOrder() }), null);
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1"]), "not-signed-in");
});

// ---------------------------------------------------------------------------
// Cancellation — the only status change Shipments still owns
// ---------------------------------------------------------------------------

test("a non-terminal order is cancelled with a reason", async () => {
  for (const status of ["pending_dispatch", "assigned", "loading", "in_transit", "delayed"]) {
    const store = installStore(seed({ o1: order({ status }) }), DISPATCHER);
    await orders.cancelOrderByDispatcher("o1", "  Clinic closed for the day  ");
    const o = data(store, "o1");

    assert.equal(o.status, "cancelled");
    assert.equal(o.cancelReason, "Clinic closed for the day", "stored trimmed");
    assert.equal(o.cancelledAt, SERVER_TIMESTAMP);
    assert.equal(o.statusUpdatedAt, SERVER_TIMESTAMP);
    assert.equal(o.statusUpdatedByUid, DISPATCHER.uid);
  }
});

test("cancellation requires a meaningful reason", async () => {
  for (const reason of ["", "   ", "\n\t ", null, undefined, 42]) {
    const store = installStore(seed({ o1: order() }), DISPATCHER);
    await expectRejection(orders.cancelOrderByDispatcher("o1", reason), "cancel-reason-required");
    assert.equal(data(store, "o1").status, "assigned", "untouched");
    assert.equal(store.writes.length, 0, "no write on an invalid reason");
  }
});

test("an oversized reason is rejected", async () => {
  const store = installStore(seed({ o1: order() }), DISPATCHER);
  const tooLong = "x".repeat(orders.MAX_CANCEL_REASON_LENGTH + 1);
  await expectRejection(orders.cancelOrderByDispatcher("o1", tooLong), "cancel-reason-too-long");
  assert.equal(store.writes.length, 0);
});

test("terminal orders cannot be cancelled again", async () => {
  for (const status of ["delivered", "cancelled"]) {
    const store = installStore(seed({ o1: order({ status }) }), DISPATCHER);
    await expectRejection(orders.cancelOrderByDispatcher("o1", "Changed my mind"), "terminal-status");
    assert.equal(data(store, "o1").status, status);
  }
});

test("cancellation leaves the clinic snapshot and rider identity untouched", async () => {
  const store = installStore(seed({ o1: order({ status: "in_transit" }) }), DISPATCHER);
  await orders.cancelOrderByDispatcher("o1", "Cold chain breach");
  const o = data(store, "o1");

  assert.equal(o.clinicDocId, "clinicAbc");
  assert.equal(o.clinicLat, 14.5995);
  assert.equal(o.clinicLocationVerified, true);
  assert.equal(o.assignedRiderId, RIDER);

  const written = store.writes.at(-1).data;
  const allowed = [
    "status", "cancelReason", "cancelledAt",
    "statusUpdatedAt", "statusUpdatedByUid", "statusUpdatedByEmail", "updatedAt",
  ];
  for (const key of Object.keys(written)) {
    assert.ok(allowed.includes(key), `unexpected field written: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// No generic escape hatch survives
// ---------------------------------------------------------------------------

test("the arbitrary-status writer is gone from the order service", async () => {
  // `updateOrderStatus(orderId, anyString)` used to let a dispatcher write
  // `delivered`, `delayed`, or a typo, from any status at all.
  assert.equal(orders.updateOrderStatus, undefined, "no generic status writer is exported");

  const exported = Object.keys(orders).filter((k) => typeof orders[k] === "function");
  for (const name of exported) {
    assert.ok(
      !/^updateOrderStatus$|^setOrderStatus$|^forceStatus$/.test(name),
      `${name} looks like a status escape hatch`
    );
  }
});

test("no dispatcher service can perform a rider transition", async () => {
  for (const status of ["in_transit", "delayed"]) {
    const store = installStore(seed({ o1: order({ status, isLoaded: true }) }), DISPATCHER);
    // The only status-changing dispatcher entry points are these three.
    await expectRejection(cargo.updateOrderLoadedState("o1", true), "not-loadable");
    await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1"]), "order-not-dispatchable");
    // Cancellation is allowed — it is a dispatcher transition, not a rider one.
    await orders.cancelOrderByDispatcher("o1", "Recalled by supervisor");
    assert.equal(data(store, "o1").status, "cancelled");
    assert.notEqual(data(store, "o1").status, "delivered");
  }
});
