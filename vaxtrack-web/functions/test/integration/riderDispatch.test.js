"use strict";

/**
 * Rider trips against a REAL Firestore (emulator): assignment, Finalize
 * Dispatch, settlement and return-to-hub (src/riderDispatchOps.js), with the
 * order-write trigger's reconcile step called directly after each simulated
 * order change, as the other integration suites do with their operations.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-dispatch" }, "dispatch-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const ops = require("../../src/riderDispatchOps");
const D = require("../../src/riderDispatch");

const NOW = new Date("2026-10-19T03:00:00Z");
const DISPATCHER = "disp1";
const ADMIN = "admin1";
const R1 = "rider1";
const R2 = "rider2";

async function wipe() {
  for (const c of ["orders", "users", D.RIDER_DISPATCH_STATES, D.RIDER_TRIPS]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await Promise.all([
    db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved", email: "d@x.test" }),
    db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" }),
    db.collection("users").doc(R1).set({ role: "rider", status: "approved", fullName: "Rider One", phone: "0917" }),
    db.collection("users").doc(R2).set({ role: "rider", status: "approved", fullName: "Rider Two" }),
    db.collection("users").doc("rep1").set({ role: "salesrep", status: "approved" }),
    db.collection("users").doc("disp-pending").set({ role: "dispatcher", status: "pending" }),
    db.collection("users").doc("rider-off").set({ role: "rider", status: "disabled" }),
  ]);
}

async function seedOrder(id, over = {}) {
  await db.collection("orders").doc(id).set({
    orderNumber: `VT-ORD-1-${id.toUpperCase()}`,
    status: "pending_dispatch",
    requestedDeliveryDate: "2026-10-18",
    allocationVersion: 2,
    allocationState: "fully_reserved",
    routePolyline: "abc",
    ...over,
  });
}
const get = async (c, id) => {
  const s = await db.collection(c).doc(id).get();
  return s.exists ? s.data() : null;
};
const state = (r) => get(D.RIDER_DISPATCH_STATES, r);
const order = (id) => get("orders", id);
const updateTime = async (c, id) => (await db.collection(c).doc(id).get()).updateTime;

const assign = (orderId, riderUid, uid = DISPATCHER) =>
  ops.assignRiderToOrder({ db, FieldValue, uid, email: "d@x.test", payload: { orderId, riderUid }, now: NOW });
const finalize = (riderUid, orderIds, tripId = undefined, uid = DISPATCHER) =>
  ops.finalizeRiderDispatch({ db, FieldValue, uid, email: "d@x.test", payload: { riderUid, orderIds, tripId }, now: NOW });
const confirmReturn = (riderUid, tripId, uid = DISPATCHER) =>
  ops.confirmRiderReturnToHub({ db, FieldValue, uid, payload: { riderUid, tripId } });

/** A Dispatcher ticking Cargo Loading (a client write the rules allow). */
async function load(id) {
  await db.collection("orders").doc(id).update({
    status: "loading",
    isLoaded: true,
    loadedAt: Timestamp.fromDate(NOW),
    loadedByUid: DISPATCHER,
  });
}

/** Any order change (a callable, a Rider write), then the trigger's reconcile — exactly as delivered. */
async function change(id, fields) {
  const before = await order(id);
  await db.collection("orders").doc(id).update(fields);
  const after = await order(id);
  return ops.reconcileRiderOnOrderWrite({ db, FieldValue, before, after });
}

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

// ------------------------------------------------------------------ assignment

test("assignment starts ONE server trip; later orders join it before departure", async () => {
  await wipe();
  await seedOrder("o1");
  await seedOrder("o2");
  const a = await assign("o1", R1);
  assert.equal(a.replayed, false);
  assert.match(a.tripId, /^[A-Za-z0-9]{20}$/, "a server-generated id");
  const o1 = await order("o1");
  assert.deepEqual([o1.status, o1.assignedRiderId, o1.dispatchTripId, o1.assignedByUid, o1.statusUpdatedByUid, o1.assignedRiderName], ["assigned", R1, a.tripId, DISPATCHER, DISPATCHER, "Rider One"]);
  assert.equal(o1.routePolyline, undefined, "an earlier rider's route is cleared");
  const b = await assign("o2", R1);
  assert.equal(b.tripId, a.tripId, "joined the same trip");
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId, s.orderIds], [D.STATE.FORMING, a.tripId, ["o1", "o2"]]);
  const trip = await get(D.RIDER_TRIPS, a.tripId);
  assert.deepEqual([trip.riderUid, trip.status, trip.orderIds, trip.source], [R1, "forming", ["o1", "o2"], "assignment"]);
});

test("simultaneous assignments to an available Rider form ONE trip", async () => {
  await wipe();
  for (const id of ["o1", "o2", "o3", "o4"]) await seedOrder(id);
  const results = await Promise.all(["o1", "o2", "o3", "o4"].map((id) => assign(id, R1)));
  const tripIds = new Set(results.map((r) => r.tripId));
  assert.equal(tripIds.size, 1, "no second trip was started by a racing call");
  const s = await state(R1);
  assert.deepEqual(s.orderIds, ["o1", "o2", "o3", "o4"]);
  assert.equal((await db.collection(D.RIDER_TRIPS).get()).size, 1);
});

test("one order raced to two Riders is assigned exactly once", async () => {
  await wipe();
  await seedOrder("o1");
  const out = await Promise.allSettled([assign("o1", R1), assign("o1", R2)]);
  const ok = out.filter((r) => r.status === "fulfilled");
  const bad = out.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason.code, /^order-(not-pending|already-assigned)$/);
  const winner = ok[0].value.riderUid;
  const loser = winner === R1 ? R2 : R1;
  assert.equal((await order("o1")).assignedRiderId, winner);
  const ls = await state(loser);
  assert.ok(ls === null || ls.state === D.STATE.AVAILABLE, "the losing Rider holds no trip");
});

test("a repeated assignment is a no-op success", async () => {
  await wipe();
  await seedOrder("o1");
  const first = await assign("o1", R1);
  const t = await updateTime("orders", "o1");
  const again = await assign("o1", R1);
  assert.deepEqual([again.replayed, again.tripId], [true, first.tripId]);
  assert.ok((await updateTime("orders", "o1")).isEqual(t), "not rewritten");
  await rejects(assign("o1", R2), "order-not-pending");
});

test("assignment checks the order, the Rider and the caller", async () => {
  await wipe();
  await seedOrder("future", { requestedDeliveryDate: "2026-10-25" });
  await seedOrder("short", { allocationState: "partially_reserved" });
  await seedOrder("ok");
  await rejects(assign("future", R1), "scheduled-date-not-reached");
  await rejects(assign("short", R1), "order-not-fully-reserved");
  await rejects(assign("ok", "rider-off"), "rider-not-approved");
  await rejects(assign("ok", "rep1"), "not-a-rider");
  await rejects(assign("missing", R1), "order-not-found");
  await rejects(assign("ok", R1, "rep1"), "wrong-role");
  await rejects(assign("ok", R1, R1), "wrong-role");
  await rejects(assign("ok", R1, "disp-pending"), "not-approved");
  // Admin may assign too.
  assert.equal((await assign("ok", R1, ADMIN)).replayed, false);
});

// ------------------------------------------------------------------ departure

test("Finalize sends the whole trip; then the Rider takes no new assignment", async () => {
  await wipe();
  for (const id of ["o1", "o2", "o3"]) await seedOrder(id);
  const { tripId } = await assign("o1", R1);
  await assign("o2", R1);
  await load("o1");
  await rejects(finalize(R1, ["o1", "o2"], tripId), "order-not-dispatchable");
  await db.collection("orders").doc("o2").update({ status: "loading", isLoaded: false });
  await rejects(finalize(R1, ["o1", "o2"], tripId), "order-not-loaded");
  await load("o2");
  await rejects(finalize(R1, ["o1"], tripId), "trip-changed", "a partial group is refused");
  await rejects(finalize(R1, ["o1", "o2"], "someOtherTrip"), "trip-changed");

  const f = await finalize(R1, ["o1", "o2"], tripId);
  assert.deepEqual([f.tripId, f.dispatchedOrderIds, f.replayed], [tripId, ["o1", "o2"], false]);
  for (const id of ["o1", "o2"]) {
    const o = await order(id);
    assert.equal(o.status, "in_transit");
    assert.equal(o.dispatchTripId, tripId);
    assert.ok(o.dispatchedAt instanceof Timestamp && o.startedAt instanceof Timestamp && o.loadingFinalizedAt instanceof Timestamp);
    assert.deepEqual([o.dispatchedByUid, o.statusUpdatedByUid], [DISPATCHER, DISPATCHER], "attribution for the status-event trigger");
  }
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId, s.orderIds, s.departedByUid], [D.STATE.ON_TRIP, tripId, ["o1", "o2"], DISPATCHER]);

  // Mid-trip: refused on the server, nothing written.
  const t3 = await updateTime("orders", "o3");
  await rejects(assign("o3", R1), "rider-on-trip");
  assert.ok((await updateTime("orders", "o3")).isEqual(t3));
  assert.equal((await order("o3")).status, "pending_dispatch");
  // Another Rider is unaffected.
  assert.equal((await assign("o3", R2)).replayed, false);
});

test("a repeated Finalize is a no-op success", async () => {
  await wipe();
  await seedOrder("o1");
  const { tripId } = await assign("o1", R1);
  await load("o1");
  await finalize(R1, ["o1"], tripId);
  const t = await updateTime("orders", "o1");
  const again = await finalize(R1, ["o1"], tripId);
  assert.deepEqual([again.replayed, again.tripId], [true, tripId]);
  assert.ok((await updateTime("orders", "o1")).isEqual(t), "dispatch fields not rewritten");
  // Also when the caller did not send the trip id.
  assert.equal((await finalize(R1, ["o1"])).replayed, true);
});

test("an assignment racing a Finalize never joins a departed trip", async () => {
  for (let round = 0; round < 3; round += 1) {
    await wipe();
    await seedOrder("o1");
    await seedOrder("late");
    const { tripId } = await assign("o1", R1);
    await load("o1");
    const [f, a] = await Promise.allSettled([finalize(R1, ["o1"], tripId), assign("late", R1)]);
    const late = await order("late");
    const s = await state(R1);
    if (f.status === "fulfilled") {
      // Departed first: the late order was refused and is untouched.
      assert.equal(a.status, "rejected");
      assert.equal(a.reason.code, "rider-on-trip");
      assert.equal(late.status, "pending_dispatch");
      assert.deepEqual([s.state, s.orderIds], [D.STATE.ON_TRIP, ["o1"]]);
    } else {
      // Joined first: the Finalize saw an unloaded member and sent nothing.
      assert.equal(a.status, "fulfilled");
      assert.match(f.reason.code, /^(trip-changed|order-not-dispatchable)$/);
      assert.deepEqual([s.state, s.orderIds], [D.STATE.FORMING, ["late", "o1"]]);
      assert.equal((await order("o1")).status, "loading");
    }
  }
});

// ------------------------------------------------------------------ settlement + return

test("the Rider returns only when every trip order is settled; return confirmation is idempotent", async () => {
  await wipe();
  for (const id of ["o1", "o2", "o3"]) await seedOrder(id);
  const { tripId } = await assign("o1", R1);
  await assign("o2", R1);
  await assign("o3", R1);
  for (const id of ["o1", "o2", "o3"]) await load(id);
  await finalize(R1, ["o1", "o2", "o3"], tripId);

  await change("o1", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP);
  await change("o2", { status: "delayed" });
  await change("o2", { status: "in_transit" });
  await change("o2", { status: "delivery_failed" });
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "one order still out");
  await rejects(confirmReturn(R1, tripId), "trip-not-settled");
  await change("o3", { status: "cancelled" });
  const s = await state(R1);
  assert.equal(s.state, D.STATE.RETURNING);
  assert.ok(s.settledAt instanceof Timestamp);
  assert.equal((await get(D.RIDER_TRIPS, tripId)).status, "settled");

  // Still not assignable until the physical return is confirmed.
  await seedOrder("next");
  await rejects(assign("next", R1), "rider-returning");
  await rejects(confirmReturn(R1, "wrongTrip"), "trip-changed");
  await rejects(confirmReturn(R1, tripId, "rep1"), "wrong-role");
  const c = await confirmReturn(R1, tripId);
  assert.deepEqual([c.state, c.replayed], [D.STATE.AVAILABLE, false]);
  const back = await state(R1);
  assert.deepEqual([back.state, back.tripId, back.orderIds, back.lastConfirmedTripId, back.returnConfirmedByUid], [D.STATE.AVAILABLE, null, [], tripId, DISPATCHER]);
  const t = await updateTime(D.RIDER_DISPATCH_STATES, R1);
  assert.equal((await confirmReturn(R1, tripId)).replayed, true, "a repeated confirmation is a no-op");
  assert.ok((await updateTime(D.RIDER_DISPATCH_STATES, R1)).isEqual(t));
  const trip = await get(D.RIDER_TRIPS, tripId);
  assert.deepEqual([trip.status, trip.returnConfirmedByUid], ["returned", DISPATCHER]);

  // A new trip, with a new id.
  const n = await assign("next", R1);
  assert.notEqual(n.tripId, tripId);
});

test("a requeued failed order settles the trip it left", async () => {
  await wipe();
  await seedOrder("o1");
  const { tripId } = await assign("o1", R1);
  await load("o1");
  await finalize(R1, ["o1"], tripId);
  await change("o1", { status: "delivery_failed" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  // requeueFailedOrder: back to the queue, unassigned (the trip stays settled).
  await change("o1", { status: "pending_dispatch", assignedRiderId: FieldValue.delete(), dispatchTripId: FieldValue.delete() });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  assert.equal((await confirmReturn(R1, tripId)).state, D.STATE.AVAILABLE);
});

test("cancelling before departure leaves the trip; cancelling all of it dissolves it", async () => {
  await wipe();
  await seedOrder("o1");
  await seedOrder("o2");
  const { tripId } = await assign("o1", R1);
  await assign("o2", R1);
  await change("o1", { status: "cancelled" });
  assert.deepEqual((await state(R1)).orderIds, ["o2"]);
  await load("o2");
  assert.equal((await finalize(R1, ["o2"], tripId)).replayed, false, "the remaining order departs alone");

  await wipe();
  await seedOrder("o1");
  const t2 = (await assign("o1", R1)).tripId;
  await change("o1", { status: "cancelled" });
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId, s.orderIds], [D.STATE.AVAILABLE, null, []]);
  assert.equal((await get(D.RIDER_TRIPS, t2)).status, "dissolved");
});

// ------------------------------------------------------------------ legacy data

test("legacy: a Rider already on the road is classified on_trip and never freed early", async () => {
  await wipe();
  // Before this release: no state document, no dispatchTripId.
  await seedOrder("out", { status: "in_transit", assignedRiderId: R1, dispatchedAt: Timestamp.fromDate(NOW) });
  await seedOrder("given-later", { status: "assigned", assignedRiderId: R1 });
  await seedOrder("new");
  await rejects(assign("new", R1), "rider-on-trip");
  // A refused call still records the truth: the Rider is classified from
  // their orders (on_trip), and the order it refused is untouched.
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "the refusal classified the Rider");
  assert.equal((await order("new")).status, "pending_dispatch");

  // The first order change classifies the Rider.
  await change("out", { status: "delayed" });
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds, s.heldOrderIds, s.classifiedFrom], [D.STATE.ON_TRIP, ["out"], ["given-later"], "orders"]);
  const tripId = s.tripId;
  assert.equal((await order("out")).dispatchTripId, tripId, "the departed order carries the trip id");
  await rejects(finalize(R1, ["given-later"]), "rider-on-trip", "held orders cannot leave mid-trip");

  await change("out", { status: "in_transit" });
  await change("out", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING, "the held order does not keep the trip open");
  const c = await confirmReturn(R1, tripId);
  assert.equal(c.state, D.STATE.FORMING, "the held order becomes the next trip");
  const next = await state(R1);
  assert.deepEqual([next.orderIds, next.heldOrderIds], [["given-later"], []]);
  assert.equal((await order("given-later")).dispatchTripId, next.tripId);
  await load("given-later");
  assert.equal((await finalize(R1, ["given-later"], next.tripId)).replayed, false);
});

test("legacy: only pre-departure orders are adopted into a forming trip", async () => {
  await wipe();
  await seedOrder("a", { status: "assigned", assignedRiderId: R1 });
  await seedOrder("b", { status: "loading", assignedRiderId: R1, isLoaded: true });
  await seedOrder("c");
  const r = await assign("c", R1);
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds], [D.STATE.FORMING, ["a", "b", "c"]]);
  for (const id of ["a", "b", "c"]) assert.equal((await order(id)).dispatchTripId, r.tripId);
});

test("legacy: a Rider with no orders is classified available", async () => {
  await wipe();
  await seedOrder("o1");
  const r = await assign("o1", R2);
  assert.equal(r.replayed, false);
  assert.equal((await state(R2)).state, D.STATE.FORMING);
});

test("rollout window: direct client writes are folded in, never free a Rider on the road", async () => {
  await wipe();
  await seedOrder("o1");
  const { tripId } = await assign("o1", R1);
  await load("o1");
  await finalize(R1, ["o1"], tripId);
  // An OLD Dispatcher page assigns directly while the Rider is out (only
  // possible before the new rules are deployed).
  await seedOrder("bypass");
  const res = await change("bypass", { status: "assigned", assignedRiderId: R1 });
  assert.deepEqual(res[0].anomalies, ["bypass"]);
  let s = await state(R1);
  assert.deepEqual([s.state, s.orderIds, s.heldOrderIds], [D.STATE.ON_TRIP, ["o1"], ["bypass"]]);
  // ...and an old Cargo Loading page then sends it out directly.
  await change("bypass", { status: "in_transit" });
  s = await state(R1);
  assert.deepEqual([s.state, s.orderIds, s.heldOrderIds], [D.STATE.ON_TRIP, ["bypass", "o1"], []]);
  await change("o1", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "the bypass order is still out");
  await change("bypass", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
});

test("the trigger ignores writes that do not touch a trip, and replays are no-ops", async () => {
  await wipe();
  await seedOrder("o1");
  await assign("o1", R1);
  assert.deepEqual(await change("o1", { lastLocation: { lat: 1, lng: 2 } }), [], "location fixes are skipped");
  const t = await updateTime(D.RIDER_DISPATCH_STATES, R1);
  const r = await ops.reconcileRider({ db, FieldValue, riderUid: R1 });
  assert.equal(r.changed, false);
  assert.ok((await updateTime(D.RIDER_DISPATCH_STATES, R1)).isEqual(t));
});

// ------------------------------------------------------------------ one-time classification script

test("classification script: guarded options, dry run writes nothing, apply never frees a Rider on the road", async () => {
  const script = await import("../../scripts/classifyRiderDispatchStates.mjs");
  assert.throws(() => script.parseOptions([]), /--project is required/);
  assert.throws(() => script.parseOptions(["--project", "vaxtrack-bef1b"], { emulator: true }), /Production is refused/);
  assert.throws(() => script.parseOptions(["--project", "some-other"]), /Only vaxtrack-staging/);
  assert.throws(() => script.parseOptions(["--project", "vaxtrack-staging", "--apply"]), /requires --confirm/);
  assert.deepEqual(script.parseOptions(["--project", "vaxtrack-staging"]), { project: "vaxtrack-staging", apply: false, confirm: null });

  await wipe();
  await seedOrder("out", { status: "in_transit", assignedRiderId: R1 });
  await seedOrder("later", { status: "assigned", assignedRiderId: R1 });
  await seedOrder("prep", { status: "loading", assignedRiderId: R2 });
  const plan = await script.planClassification(db);
  const byRider = Object.fromEntries(plan.map((p) => [p.riderUid, p]));
  assert.deepEqual([byRider[R1].state, byRider[R1].orderIds, byRider[R1].heldOrderIds], [D.STATE.ON_TRIP, ["out"], ["later"]]);
  assert.deepEqual([byRider[R2].state, byRider[R2].orderIds], [D.STATE.FORMING, ["prep"]]);
  assert.equal(byRider["rider-off"].state, D.STATE.AVAILABLE);
  assert.equal((await db.collection(D.RIDER_DISPATCH_STATES).get()).size, 0, "the dry run wrote nothing");

  await assert.rejects(script.applyClassification(db, FieldValue, plan, plan.length + 1), /does not match/);
  assert.equal((await db.collection(D.RIDER_DISPATCH_STATES).get()).size, 0);
  const results = await script.applyClassification(db, FieldValue, plan, plan.length);
  assert.equal(results.filter((r) => r.changed).length, plan.length);
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP);
  assert.equal((await state(R2)).state, D.STATE.FORMING);
  // A second run has nothing left to classify.
  assert.deepEqual(await script.planClassification(db), []);
});

// ------------------------------------------------------------------ what an assignment writes (moved from the client)

test("assignment writes exactly the assignment, from the rider document and the verified caller", async () => {
  await wipe();
  // Unassigned means absent, null or "" — a whitespace id is an assignment.
  await seedOrder("absent");
  await seedOrder("nullish", { assignedRiderId: null });
  await seedOrder("blank", { assignedRiderId: "" });
  await seedOrder("space", { assignedRiderId: " " });
  for (const id of ["absent", "nullish", "blank"]) assert.equal((await assign(id, R1)).replayed, false, id);
  await rejects(assign("space", R1), "order-already-assigned");

  // Exact role and status — no case or whitespace leniency; an employee id is not a uid.
  await wipe();
  await db.collection("users").doc("caps").set({ role: "Rider", status: "approved" });
  await db.collection("users").doc("pad").set({ role: "rider", status: " approved" });
  await db.collection("users").doc("adm").set({ role: "admin", status: "approved" });
  await db.collection("users").doc("emp-uid").set({ role: "rider", status: "approved", employeeId: "EMP-1" });
  await seedOrder("o1");
  await rejects(assign("o1", "caps"), "not-a-rider");
  await rejects(assign("o1", "pad"), "rider-not-approved");
  await rejects(assign("o1", "adm"), "not-a-rider");
  await rejects(assign("o1", "EMP-1"), "rider-not-found");

  // Display fields from the rider document only, with the documented fallbacks; nothing invented.
  await db.collection("users").doc("noname").set({ role: "rider", status: "approved", displayName: "Display Only", contactNumber: "0918" });
  await db.collection("users").doc("bare").set({ role: "rider", status: "approved" });
  await seedOrder("o2");
  await seedOrder("o3", { notes: "keep me", priority: "Urgent" });
  await assign("o2", "noname");
  let o = await order("o2");
  assert.deepEqual([o.assignedRiderName, o.assignedRiderPhone], ["Display Only", "0918"]);
  const before = await order("o3");
  await ops.assignRiderToOrder({ db, FieldValue, uid: DISPATCHER, email: null, payload: { orderId: "o3", riderUid: "bare" }, now: NOW });
  o = await order("o3");
  assert.equal(o.assignedRiderName, undefined, "no placeholder name");
  assert.equal(o.assignedRiderPhone, undefined, "no invented phone");
  assert.equal(o.statusUpdatedByEmail, undefined, "a caller without an email leaves none (not a stale one)");
  assert.equal(o.routePolyline, undefined, "the earlier rider's route is cleared");
  // Only assignment, attribution and trip fields changed.
  const changed = [...new Set([...Object.keys(o), ...Object.keys(before)])].filter((k) => JSON.stringify(o[k]) !== JSON.stringify(before[k])).sort();
  assert.deepEqual(changed, [
    "assignedAt", "assignedByUid", "assignedRiderId", "dispatchTripId", "routePolyline",
    "status", "statusUpdatedAt", "statusUpdatedByUid", "updatedAt",
  ]);
  assert.deepEqual([o.notes, o.priority], ["keep me", "Urgent"]);
  // An order with no route gains no route keys.
  await seedOrder("o4");
  await db.collection("orders").doc("o4").update({ routePolyline: FieldValue.delete() });
  await assign("o4", R1);
  assert.ok(!Object.keys(await order("o4")).some((k) => /^route|^trip|^stop/.test(k)));
});

// ------------------------------------------------------------------ what Finalize checks and writes (moved from the client)

test("Finalize refuses the whole trip for any ineligible order, and nothing moves", async () => {
  // Undated, not yet due, not fully reserved (the stored order, not the UI's view).
  for (const [over, code] of [
    [{ requestedDeliveryDate: FieldValue.delete() }, "scheduled-date-missing"],
    [{ requestedDeliveryDate: "2026-10-18 " }, "scheduled-date-invalid"],
    [{ requestedDeliveryDate: "2026-10-25" }, "scheduled-date-not-reached"],
    [{ allocationState: "partially_reserved" }, "order-not-fully-reserved"],
  ]) {
    await wipe();
    await seedOrder("ok");
    await seedOrder("late");
    const { tripId } = await assign("ok", R1);
    await assign("late", R1);
    await load("ok");
    await load("late");
    await db.collection("orders").doc("late").update(over);
    await rejects(finalize(R1, ["late", "ok"], tripId), code);
    assert.deepEqual([(await order("ok")).status, (await order("late")).status], ["loading", "loading"], code);
    assert.equal((await state(R1)).state, D.STATE.FORMING);
  }
  // Another Rider's order, a vanished order, or a terminal one: the group is not the trip.
  await wipe();
  await seedOrder("mine");
  await seedOrder("theirs");
  const { tripId } = await assign("mine", R1);
  await assign("theirs", R2);
  await load("mine");
  await load("theirs");
  await rejects(finalize(R1, ["mine", "theirs"], tripId), "trip-changed");
  await rejects(finalize(R1, ["mine", "ghost"], tripId), "trip-changed");
  await change("mine", { status: "cancelled" });
  await rejects(finalize(R1, ["mine"], tripId), "trip-not-forming");
  assert.equal((await order("theirs")).status, "loading");
});

test("Finalize stamps a legacy order's missing custody audit, never rewrites one, and keeps routes", async () => {
  await wipe();
  const earlier = Timestamp.fromDate(new Date("2026-10-18T22:00:00Z"));
  await seedOrder("legacy", { tripPolyline: "trip-line", stopSequence: 1, routeGeneratedAt: earlier });
  await seedOrder("kept");
  const { tripId } = await assign("legacy", R1);
  await assign("kept", R1);
  // Routes are generated after assignment (the assignment cleared any earlier rider's).
  await db.collection("orders").doc("legacy").update({ routePolyline: "route-line", tripPolyline: "trip-line", stopSequence: 1 });
  // A legacy order ticked before the audit existed; and one with an audit.
  await db.collection("orders").doc("legacy").update({ status: "loading", isLoaded: true });
  await db.collection("orders").doc("kept").update({ status: "loading", isLoaded: true, loadedAt: earlier, loadedByUid: "EarlierDispatcher" });
  await finalize(R1, ["kept", "legacy"], tripId);
  const legacy = await order("legacy");
  assert.ok(legacy.loadedAt instanceof Timestamp);
  assert.equal(legacy.loadedByUid, DISPATCHER);
  assert.deepEqual([legacy.routePolyline, legacy.tripPolyline, legacy.stopSequence], ["route-line", "trip-line", 1], "routes kept");
  const kept = await order("kept");
  assert.ok(kept.loadedAt.isEqual(earlier));
  assert.equal(kept.loadedByUid, "EarlierDispatcher");
});

test("a failed, cancelled or delivered order is never assigned (recovery is requeue → pending)", async () => {
  await wipe();
  for (const status of ["delivery_failed", "cancelled", "delivered", "in_transit"]) {
    await seedOrder(status, { status, assignedRiderId: R2 });
    const t = await updateTime("orders", status);
    await rejects(assign(status, R1), "order-not-pending");
    assert.ok((await updateTime("orders", status)).isEqual(t), `${status} untouched`);
  }
});
