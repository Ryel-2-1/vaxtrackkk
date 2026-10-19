import test from "node:test";
import assert from "node:assert/strict";
import {
  callableError,
  createServiceLoader,
  createStore,
  installCallables,
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
  // A valid, already-reached delivery date; undated orders fail closed.
  requestedDeliveryDate: "2026-01-01",
  ...over,
});

/** The same order as it exists from before the date became required. */
const undated = (over = {}) => {
  const o = order(over);
  delete o.requestedDeliveryDate;
  return o;
};

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

test("an undated, invalid-dated or future order is not promoted to loading", async () => {
  for (const [o, code] of [
    [undated(), "scheduled-date-missing"],
    [order({ requestedDeliveryDate: "" }), "scheduled-date-invalid"],
    [order({ requestedDeliveryDate: "2999-01-01" }), "scheduled-date-not-reached"],
  ]) {
    const store = installStore(seed({ o1: o }), DISPATCHER);
    await expectRejection(cargo.updateOrderLoadedState("o1", true), code);
    assert.equal(data(store, "o1").status, "assigned", "nothing was written");
    assert.equal(data(store, "o1").isLoaded, false);
  }
});

// Finalize's schedule check (undated / not yet due refuses the whole trip) is
// the finalizeRiderDispatch callable's now: functions/test/integration/riderDispatch.test.js.

test("confirming an order that is already loading writes metadata only", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: false }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);

  assert.equal(data(store, "o1").status, "loading", "status is unchanged");
  assert.equal(data(store, "o1").isLoaded, true);
});

// A stored loading audit: an earlier confirmation by another dispatcher.
const EARLIER = { toMillis: () => Date.parse("2026-01-01T00:30:00Z") };
const audited = (over = {}) => ({
  loadedAt: EARLIER,
  loadedByUid: "EarlierDispatcher",
  loadedByEmail: "earlier@vaxtrack.com",
  ...over,
});
const auditKeys = (write) => Object.keys(write.data).filter((k) => k.startsWith("loadedBy") || k === "loadedAt");

test("unchecking never regresses loading back to assigned, and keeps the loading audit", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: true, ...audited() }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", false);
  const o = data(store, "o1");

  assert.equal(o.status, "loading", "loading means preparation began; it does not un-begin");
  assert.equal(o.isLoaded, false);
  assert.equal(o.loadedAt, EARLIER, "the audit survives the untick");
  assert.equal(o.loadedByUid, "EarlierDispatcher");
  assert.equal(o.loadedByEmail, "earlier@vaxtrack.com");
  assert.deepEqual(auditKeys(store.writes[0]), [], "the untick writes no audit field at all");
});

test("re-ticking an order that has an audit changes only the flag", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: false, ...audited() }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);
  const o = data(store, "o1");
  assert.equal(o.isLoaded, true);
  assert.equal(o.loadedAt, EARLIER, "the first confirmation stays the record");
  assert.equal(o.loadedByUid, "EarlierDispatcher");
  assert.deepEqual(auditKeys(store.writes[0]), []);
});

test("an assigned order with an earlier audit is promoted without rewriting it", async () => {
  const store = installStore(seed({ o1: order({ ...audited() }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);
  const o = data(store, "o1");
  assert.equal(o.status, "loading");
  assert.equal(o.loadedAt, EARLIER);
  assert.equal(o.loadedByUid, "EarlierDispatcher");
});

test("a legacy loaded order without an audit is stamped when unticked, so custody is not lost", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: true }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", false);
  const o = data(store, "o1");
  assert.equal(o.isLoaded, false);
  assert.equal(o.loadedAt, SERVER_TIMESTAMP);
  assert.equal(o.loadedByUid, DISPATCHER.uid);
  assert.equal(o.loadedByEmail, DISPATCHER.email);
});

test("unticking an order that was never confirmed writes no audit", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: false }) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", false);
  assert.deepEqual(auditKeys(store.writes[0]), []);
  assert.equal("loadedAt" in data(store, "o1"), false);
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

// ---------------------------------------------------------------------------
// Finalize Dispatch — the finalizeRiderDispatch callable (Rider trips)
//
// The whole trip leaves on the server, or nothing does: every order re-read,
// in Loading, confirmed loaded, fully reserved, on or after its date, and the
// group exactly the Rider's trip (another Rider's, a vanished or a terminal
// order is refused); a legacy order's missing custody audit is stamped and an
// existing one never rewritten; route fields are kept. All of that is tested
// against a real Firestore in functions/test/integration/riderDispatch.test.js.
// Here: the service sends exactly the trip, writes nothing itself, and passes
// the server's answer through.
// ---------------------------------------------------------------------------

test("finalize is one callable request for the rider's whole group, with the trip the page saw", async () => {
  const store = installStore(seed({ o1: order({ status: "loading", isLoaded: true }) }), DISPATCHER);
  const reply = { riderUid: RIDER, tripId: "Trip1", dispatchedOrderIds: ["o1", "o2"], replayed: false };
  const calls = installCallables({ finalizeRiderDispatch: () => reply });
  assert.deepEqual(await cargo.finalizeRiderDispatch(RIDER, ["o1", "o2", "o1"], "Trip1"), reply);
  assert.deepEqual(calls, [{ name: "finalizeRiderDispatch", data: { riderUid: RIDER, orderIds: ["o1", "o2"], tripId: "Trip1" } }]);
  // A Rider the server has not classified yet: no trip id is sent.
  await cargo.finalizeRiderDispatch(RIDER, ["o1"]);
  assert.deepEqual(calls[1].data, { riderUid: RIDER, orderIds: ["o1"] });
  assert.equal(store.writes.length, 0, "the client writes nothing — no in_transit write exists here");
});

test("finalize refusals come back with the server's code and sentence", async () => {
  installStore(seed({}), DISPATCHER);
  for (const code of ["order-not-loaded", "order-not-dispatchable", "trip-changed", "rider-on-trip", "scheduled-date-not-reached"]) {
    installCallables({ finalizeRiderDispatch: () => { throw callableError(code, `Refused: ${code}.`); } });
    await assert.rejects(cargo.finalizeRiderDispatch(RIDER, ["o1"]), (err) => {
      assert.deepEqual([err.code, err.message], [code, `Refused: ${code}.`]);
      return true;
    });
  }
});

test("finalize rejects an empty group, a missing rider and no session", async () => {
  installStore(seed({ o1: order({ status: "loading", isLoaded: true }) }), DISPATCHER);
  const calls = installCallables({ finalizeRiderDispatch: () => ({}) });
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, []), "no-orders");
  await expectRejection(cargo.finalizeRiderDispatch("", ["o1"]), "rider-required");

  installStore(seed({ o1: order({ status: "loading", isLoaded: true }) }), null);
  await expectRejection(cargo.finalizeRiderDispatch(RIDER, ["o1"]), "not-signed-in");
  assert.equal(calls.length, 0, "nothing reached the server");
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
    // The status-changing dispatcher entry points: loading (client), Finalize
    // (the server refuses anything not in Loading) and cancellation.
    await expectRejection(cargo.updateOrderLoadedState("o1", true), "not-loadable");
    installCallables({
      finalizeRiderDispatch: () => { throw callableError("order-not-dispatchable", "No longer ready for dispatch."); },
    });
    await assert.rejects(cargo.finalizeRiderDispatch(RIDER, ["o1"]), (e) => e.code === "order-not-dispatchable");
    assert.equal(data(store, "o1").status, status);
    // Cancellation is allowed — it is a dispatcher transition, not a rider one.
    await orders.cancelOrderByDispatcher("o1", "Recalled by supervisor");
    assert.equal(data(store, "o1").status, "cancelled");
    assert.notEqual(data(store, "o1").status, "delivered");
  }
});

test("loading and dispatch keep a valid route: only a change of rider or destination clears it", async () => {
  const route = {
    routePolyline: "_p~iF~ps|U_ulLnnqC", routeGeneratedAt: "after-assignment", routeDestinationRevision: 0,
    tripId: "trip-1", tripPolyline: "_p~iF~ps|U", stopSequence: 1, tripGeneratedAt: "after-assignment",
  };
  const store = installStore(seed({ o1: order(route) }), DISPATCHER);
  await cargo.updateOrderLoadedState("o1", true);
  const o = data(store, "o1");
  assert.equal(o.status, "loading");
  for (const [k, v] of Object.entries(route)) assert.equal(o[k], v, `${k} kept`);
  // Dispatch keeps them too — the server's Finalize writes no route field
  // (functions/test/integration/riderDispatch.test.js).
});
