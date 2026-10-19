"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/riderDispatch");

const R = "rider1";
const M = (entries) => new Map(entries);

test("settled for the trip: delivered, cancelled, failed, or no longer this Rider's", () => {
  const T = "trip1";
  assert.equal(D.settledForTrip({ status: "delivered", assignedRiderId: R, dispatchTripId: T }, R, T), true);
  assert.equal(D.settledForTrip({ status: "cancelled", assignedRiderId: R, dispatchTripId: T }, R, T), true);
  assert.equal(D.settledForTrip({ status: "delivery_failed", assignedRiderId: R, dispatchTripId: T }, R, T), true);
  assert.equal(D.settledForTrip({ status: "pending_dispatch" }, R, T), true, "requeued: unassigned");
  assert.equal(D.settledForTrip({ status: "in_transit", assignedRiderId: "other", dispatchTripId: T }, R, T), true);
  assert.equal(D.settledForTrip(null, R, T), true, "deleted");
  assert.equal(D.settledForTrip({ status: "in_transit", assignedRiderId: R, dispatchTripId: T }, R, T), false);
  assert.equal(D.settledForTrip({ status: "delayed", assignedRiderId: R, dispatchTripId: T }, R, T), false);
  assert.equal(D.settledForTrip({ status: "in_transit", assignedRiderId: R }, R, T), false, "a legacy order without a trip id is still out");
});

test("the schedule instant matches the rules: 00:00 Manila on a real date", () => {
  const o = { requestedDeliveryDate: "2026-10-19" };
  assert.equal(D.scheduleReached(o, new Date("2026-10-18T15:59:59Z")), false);
  assert.equal(D.scheduleReached(o, new Date("2026-10-18T16:00:00Z")), true);
  for (const bad of ["2026-02-31", "2026-10-19 ", "19/10/2026", "", null, undefined]) {
    assert.equal(D.scheduleReached({ requestedDeliveryDate: bad }, new Date("2030-01-01")), false, String(bad));
  }
  assert.equal(D.fullyReserved({ allocationVersion: 2, allocationState: "fully_reserved" }), true);
  assert.equal(D.fullyReserved({ allocationVersion: 2, allocationState: "partially_reserved" }), false);
  assert.equal(D.fullyReserved({ allocationVersion: 1 }), true, "pre-allocation orders are reserved at creation");
});

test("legacy classification never frees a Rider who is on the road", () => {
  assert.deepEqual(D.classifyFromOrders([]), { state: D.STATE.AVAILABLE, orderIds: [], heldOrderIds: [] });
  assert.deepEqual(
    D.classifyFromOrders([{ id: "b", data: { status: "loading" } }, { id: "a", data: { status: "assigned" } }]),
    { state: D.STATE.FORMING, orderIds: ["a", "b"], heldOrderIds: [] }
  );
  assert.deepEqual(
    D.classifyFromOrders([
      { id: "x", data: { status: "delayed" } },
      { id: "y", data: { status: "assigned" } },
      { id: "z", data: { status: "delivered" } },
    ]),
    { state: D.STATE.ON_TRIP, orderIds: ["x"], heldOrderIds: ["y"] }
  );
});

test("assignment is allowed only before departure", () => {
  assert.equal(D.assignmentAllowed(D.STATE.AVAILABLE).ok, true);
  assert.equal(D.assignmentAllowed(D.STATE.FORMING).ok, true);
  assert.equal(D.assignmentAllowed(D.STATE.ON_TRIP).code, "rider-on-trip");
  assert.equal(D.assignmentAllowed(D.STATE.RETURNING).code, "rider-returning");
  assert.equal(D.assignmentAllowed("bogus").code, "rider-state-unknown");
});

test("reconcile: settlement moves on_trip to returning; nothing else does", () => {
  const current = { state: D.STATE.ON_TRIP, tripId: "T", orderIds: ["a", "b"], heldOrderIds: [] };
  const out = (a, b) => D.reconcile({
    riderUid: R,
    current,
    memberOrders: M([["a", { status: a, assignedRiderId: R, dispatchTripId: "T" }], ["b", { status: b, assignedRiderId: R, dispatchTripId: "T" }]]),
    riderOrders: [],
  });
  assert.deepEqual(out("delivered", "in_transit"), { unchanged: true });
  const r = out("delivered", "cancelled");
  assert.deepEqual([r.state, r.settled], [D.STATE.RETURNING, true]);
  // Already returning: stays returning, no-op.
  assert.deepEqual(
    D.reconcile({ riderUid: R, current: { ...current, state: D.STATE.RETURNING }, memberOrders: M([["a", null], ["b", null]]), riderOrders: [] }),
    { unchanged: true }
  );
});

test("reconcile: a forming trip loses cancelled members and dissolves when empty", () => {
  const current = { state: D.STATE.FORMING, tripId: "T", orderIds: ["a", "b"] };
  const r = D.reconcile({
    riderUid: R,
    current,
    memberOrders: M([["a", { status: "cancelled", assignedRiderId: R, dispatchTripId: "T" }], ["b", { status: "loading", assignedRiderId: R, dispatchTripId: "T" }]]),
    riderOrders: [{ id: "b", data: { status: "loading", assignedRiderId: R, dispatchTripId: "T" } }],
  });
  assert.deepEqual([r.state, r.orderIds], [D.STATE.FORMING, ["b"]]);
  const gone = D.reconcile({ riderUid: R, current, memberOrders: M([["a", null], ["b", { status: "cancelled", assignedRiderId: R }]]), riderOrders: [] });
  assert.deepEqual([gone.state, gone.dissolved], [D.STATE.AVAILABLE, true]);
});

test("reconcile: writes made without the server are folded in, never dropped", () => {
  // A stray assignment while out → held, reported.
  const onTrip = { state: D.STATE.ON_TRIP, tripId: "T", orderIds: ["a"], heldOrderIds: [] };
  const a = { status: "in_transit", assignedRiderId: R, dispatchTripId: "T" };
  const held = D.reconcile({ riderUid: R, current: onTrip, memberOrders: M([["a", a]]), riderOrders: [{ id: "a", data: a }, { id: "s", data: { status: "assigned", assignedRiderId: R } }] });
  assert.deepEqual([held.state, held.heldOrderIds, held.anomalies], [D.STATE.ON_TRIP, ["s"], ["s"]]);
  // A stray already on the road joins the trip and keeps a returning Rider out.
  const returning = { state: D.STATE.RETURNING, tripId: "T", orderIds: ["a"], heldOrderIds: [] };
  const back = D.reconcile({
    riderUid: R,
    current: returning,
    memberOrders: M([["a", { status: "delivered", assignedRiderId: R, dispatchTripId: "T" }]]),
    riderOrders: [{ id: "s", data: { status: "in_transit", assignedRiderId: R } }],
  });
  assert.deepEqual([back.state, back.orderIds, back.adoptOrderIds], [D.STATE.ON_TRIP, ["a", "s"], ["s"]]);
  // A legacy client Finalize of a forming trip → on_trip.
  const forming = { state: D.STATE.FORMING, tripId: "T", orderIds: ["a", "b"] };
  const gone = D.reconcile({
    riderUid: R,
    current: forming,
    memberOrders: M([["a", { status: "in_transit", assignedRiderId: R, dispatchTripId: "T" }], ["b", { status: "assigned", assignedRiderId: R, dispatchTripId: "T" }]]),
    riderOrders: [],
  });
  assert.deepEqual([gone.state, gone.orderIds, gone.heldOrderIds, gone.departedByLegacyWrite], [D.STATE.ON_TRIP, ["a"], ["b"], true]);
});

// ------------------------------------------------------------------ transaction retry (riderDispatchOps)

const ops = require("../src/riderDispatchOps");
const { PolicyError } = require("../src/policy");

/** What the Admin SDK throws: a numeric gRPC code, a "N CODE: text" message, the text as details. */
const grpcError = (code, name, text) => Object.assign(new Error(`${code} ${name}: ${text}`), { code, details: text });

test("only the named transient transaction failures are retried", () => {
  const retried = [
    grpcError(10, "ABORTED", "Transaction lock timeout."),
    grpcError(10, "ABORTED", "Too much contention on these documents. Please try again."),
    grpcError(3, "INVALID_ARGUMENT", "Transaction is invalid or closed."),
    grpcError(3, "INVALID_ARGUMENT", "The referenced transaction has expired or is no longer valid."),
  ];
  for (const e of retried) assert.equal(ops.isTransientTransactionError(e), true, e.message);

  const notRetried = [
    // Every other INVALID_ARGUMENT is a real request error.
    grpcError(3, "INVALID_ARGUMENT", 'Value for argument "documentPath" is not a valid resource path.'),
    grpcError(3, "INVALID_ARGUMENT", "Cannot use \"undefined\" as a Firestore value."),
    grpcError(3, "INVALID_ARGUMENT", "The token has expired."),
    grpcError(3, "INVALID_ARGUMENT", "transaction"),
    // Other codes, including ones that only look transient.
    grpcError(9, "FAILED_PRECONDITION", "Transaction is invalid or closed."),
    grpcError(4, "DEADLINE_EXCEEDED", "Deadline exceeded."),
    grpcError(14, "UNAVAILABLE", "Connection dropped."),
    grpcError(7, "PERMISSION_DENIED", "Missing or insufficient permissions."),
    // Client-SDK string codes are never what the Admin SDK throws.
    Object.assign(new Error("aborted"), { code: "aborted" }),
    Object.assign(new Error("Transaction is invalid or closed."), { code: "invalid-argument" }),
    // Domain refusals, even if the code field were numeric.
    Object.assign(new PolicyError("rider-on-trip", "This rider has already left on a trip."), { code: 10 }),
    new PolicyError("trip-changed", "This rider's trip changed."),
    new TypeError("x is undefined"),
    null,
    undefined,
  ];
  for (const e of notRetried) assert.equal(ops.isTransientTransactionError(e), false, String(e?.message ?? e));
});

test("the retry is bounded and stops at the first non-transient failure", async () => {
  const fakeDb = (failures) => {
    const db = { calls: 0 };
    db.runTransaction = async (fn) => {
      db.calls += 1;
      const f = failures[db.calls - 1];
      if (f) throw f;
      return fn("tx");
    };
    return db;
  };
  const aborted = () => grpcError(10, "ABORTED", "Transaction lock timeout.");
  const closed = () => grpcError(3, "INVALID_ARGUMENT", "Transaction is invalid or closed.");

  // Two transient failures, then success: three attempts, the value returned.
  let db = fakeDb([aborted(), closed()]);
  assert.equal(await ops.runTripTransaction(db, async (tx) => `ran with ${tx}`), "ran with tx");
  assert.equal(db.calls, 3);

  // Always transient: gives up after TRANSIENT_ATTEMPTS with that error.
  db = fakeDb([aborted(), aborted(), aborted(), aborted()]);
  await assert.rejects(ops.runTripTransaction(db, async () => "never"), (e) => e.code === 10);
  assert.equal(db.calls, ops.TRANSIENT_ATTEMPTS);
  assert.equal(ops.TRANSIENT_ATTEMPTS, 3);

  // A real INVALID_ARGUMENT, a domain refusal, a programming error: one attempt only.
  for (const failure of [
    grpcError(3, "INVALID_ARGUMENT", "Cannot use \"undefined\" as a Firestore value."),
    new PolicyError("rider-on-trip", "This rider has already left on a trip."),
    new TypeError("boom"),
  ]) {
    db = fakeDb([failure, undefined]);
    await assert.rejects(ops.runTripTransaction(db, async () => "never"), (e) => e === failure);
    assert.equal(db.calls, 1, String(failure.message));
  }
});
