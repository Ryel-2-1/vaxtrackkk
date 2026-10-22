"use strict";

/**
 * Rider trips with a STALE stored state, against a real Firestore (emulator).
 *
 * `riderDispatchStates/{rider}` is maintained by an order-write trigger that can
 * miss, fail or reorder events. Every decision must therefore re-derive the
 * Rider's state from their orders (riderDispatch.reconcile) and never let the
 * stored document alone authorize an assignment, a departure or a release.
 * Each test seeds the stale document directly, exactly as a missed
 * reconciliation would leave it.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-dispatch-stale" }, "dispatch-stale-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const ops = require("../../src/riderDispatchOps");
const D = require("../../src/riderDispatch");

const NOW = new Date("2026-10-19T03:00:00Z");
const DISPATCHER = "disp1";
const ADMIN = "admin1";
const R1 = "rider1";
const R2 = "rider2";
const AT = Timestamp.fromDate(NOW);

async function wipe() {
  for (const c of ["orders", "users", D.RIDER_DISPATCH_STATES, D.RIDER_TRIPS]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await Promise.all([
    db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" }),
    db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" }),
    db.collection("users").doc(R1).set({ role: "rider", status: "approved", fullName: "Rider One" }),
    db.collection("users").doc(R2).set({ role: "rider", status: "approved", fullName: "Rider Two" }),
    db.collection("users").doc("rep1").set({ role: "salesrep", status: "approved" }),
  ]);
}

const seedOrder = (id, over = {}) =>
  db.collection("orders").doc(id).set({
    orderNumber: `VT-${id}`,
    status: "pending_dispatch",
    requestedDeliveryDate: "2026-10-18",
    allocationVersion: 2,
    allocationState: "fully_reserved",
    ...over,
  });
const onRoad = (id, rider, tripId, over = {}) =>
  seedOrder(id, { status: "in_transit", assignedRiderId: rider, ...(tripId ? { dispatchTripId: tripId } : {}), dispatchedAt: AT, ...over });
const loaded = { isLoaded: true, loadedAt: AT, loadedByUid: DISPATCHER };
const setState = (rider, data) => db.collection(D.RIDER_DISPATCH_STATES).doc(rider).set({ riderUid: rider, heldOrderIds: [], ...data });
const setTrip = (id, data) => db.collection(D.RIDER_TRIPS).doc(id).set(data);
const get = async (c, id) => {
  const s = await db.collection(c).doc(id).get();
  return s.exists ? s.data() : null;
};
const state = (r) => get(D.RIDER_DISPATCH_STATES, r);
const order = (id) => get("orders", id);

const assign = (orderId, riderUid, uid = DISPATCHER) =>
  ops.assignRiderToOrder({ db, FieldValue, uid, payload: { orderId, riderUid }, now: NOW });
const finalize = (riderUid, orderIds, tripId = undefined, uid = DISPATCHER) =>
  ops.finalizeRiderDispatch({ db, FieldValue, uid, payload: { riderUid, orderIds, tripId }, now: NOW });
const confirmReturn = (riderUid, tripId, uid = DISPATCHER) =>
  ops.confirmRiderReturnToHub({ db, FieldValue, uid, payload: { riderUid, tripId } });
const recheck = (riderUids, uid = DISPATCHER) => ops.recheckRiderTripStates({ db, FieldValue, uid, payload: { riderUids } });

/** An order change whose trigger event is DELIVERED (reconcile runs). */
async function change(id, fields) {
  const before = await order(id);
  await db.collection("orders").doc(id).update(fields);
  const after = await order(id);
  return ops.reconcileRiderOnOrderWrite({ db, FieldValue, before, after });
}
/** An order change whose trigger event is MISSED (no reconcile). */
const missed = (id, fields) => db.collection("orders").doc(id).update(fields);

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

/** A real Part B trip for R1 with [ids], finalized; returns its trip id. */
async function departedTrip(ids) {
  for (const id of ids) await seedOrder(id);
  let tripId;
  for (const id of ids) tripId = (await assign(id, R1)).tripId;
  for (const id of ids) await db.collection("orders").doc(id).update({ status: "loading", ...loaded });
  await finalize(R1, ids, tripId);
  return tripId;
}

// ------------------------------------------------------------------ reproduced stale states

test("S1. stored available while an order is on the road: assignment refused, state corrected", async () => {
  await wipe();
  await setTrip("T1", { riderUid: R1, status: "departed", orderIds: ["X"] });
  await onRoad("X", R1, "T1");
  await seedOrder("Y");
  await setState(R1, { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] });
  await rejects(assign("Y", R1), "rider-on-trip");
  const s = await state(R1);
  assert.equal(s.state, D.STATE.ON_TRIP, "the refusal committed the correction");
  assert.deepEqual(s.orderIds, ["X"]);
  assert.equal((await order("X")).dispatchTripId, s.tripId, "the order carries the server trip it is on");
  assert.equal((await order("Y")).status, "pending_dispatch", "the refused order is untouched");
  // The trigger agrees from now on (idempotent).
  const r = await ops.reconcileRider({ db, FieldValue, riderUid: R1 });
  assert.equal(r.changed, false);
});

test("S1b. stored available with a LEGACY in-transit order (no trip id): refused, held, never freed", async () => {
  await wipe();
  await onRoad("X", R1, null);
  await seedOrder("given", { status: "assigned", assignedRiderId: R1 });
  await seedOrder("Y");
  await setState(R1, { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] });
  await rejects(assign("Y", R1), "rider-on-trip");
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds, s.heldOrderIds], [D.STATE.ON_TRIP, ["X"], ["given"]]);
  await rejects(finalize(R1, ["given"]), "rider-on-trip");
});

test("S2. stored on_trip after every trip order finished: returning (never available) until a confirmed return", async () => {
  await wipe();
  await setTrip("T2", { riderUid: R1, status: "departed", orderIds: ["X"] });
  await seedOrder("X", { status: "delivered", assignedRiderId: R1, dispatchTripId: "T2", dispatchedAt: AT });
  await seedOrder("Y");
  await setState(R1, { state: D.STATE.ON_TRIP, tripId: "T2", orderIds: ["X"] });
  await rejects(assign("Y", R1), "rider-returning");
  assert.equal((await state(R1)).state, D.STATE.RETURNING, "corrected to returning, not available");
  await rejects(finalize(R1, ["Y"]), "rider-on-trip");
  const c = await confirmReturn(R1, "T2");
  assert.deepEqual([c.state, c.replayed], [D.STATE.AVAILABLE, false]);
  const again = await confirmReturn(R1, "T2");
  assert.equal(again.replayed, true, "a repeated confirmation is a no-op");
  assert.equal((await assign("Y", R1)).replayed, false, "only now can the Rider be given an order");
});

test("S3. stored forming while another order is on the road: Finalize refused; the Rider is never freed", async () => {
  await wipe();
  await setTrip("T0", { riderUid: R1, status: "departed", orderIds: ["X"] });
  await setTrip("T3", { riderUid: R1, status: "forming", orderIds: ["B"] });
  await onRoad("X", R1, "T0");
  await seedOrder("B", { status: "loading", assignedRiderId: R1, dispatchTripId: "T3", ...loaded });
  await setState(R1, { state: D.STATE.FORMING, tripId: "T3", orderIds: ["B"] });
  await rejects(finalize(R1, ["B"], "T3"), "rider-on-trip");
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds, s.heldOrderIds], [D.STATE.ON_TRIP, ["X"], ["B"]]);
  assert.equal((await order("B")).status, "loading", "nothing departed");
  await rejects(confirmReturn(R1, s.tripId), "trip-not-settled");
  // Once X is really finished: returning, then a confirmed return makes B the next trip.
  await change("X", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  const c = await confirmReturn(R1, s.tripId);
  assert.equal(c.state, D.STATE.FORMING);
  assert.deepEqual((await state(R1)).orderIds, ["B"]);
});

test("S4. stored returning while an order is still on the road: return confirmation refused", async () => {
  await wipe();
  await setTrip("T4", { riderUid: R1, status: "settled", orderIds: ["X"] });
  await seedOrder("X", { status: "delivered", assignedRiderId: R1, dispatchTripId: "T4", dispatchedAt: AT });
  await onRoad("Z", R1, "T9");
  await setState(R1, { state: D.STATE.RETURNING, tripId: "T4", orderIds: ["X"] });
  await rejects(confirmReturn(R1, "T4"), "trip-not-settled");
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds], [D.STATE.ON_TRIP, ["X", "Z"]], "Z joins the trip; the Rider stays out");
  assert.equal((await order("Z")).dispatchTripId, "T4");
});

test("S5. a forming trip whose orders in fact travelled becomes returning, never available", async () => {
  await wipe();
  await setTrip("T5", { riderUid: R1, status: "forming", orderIds: ["A"] });
  await seedOrder("A", { status: "delivered", assignedRiderId: R1, dispatchTripId: "T5", dispatchedAt: AT });
  await setState(R1, { state: D.STATE.FORMING, tripId: "T5", orderIds: ["A"] });
  await seedOrder("Y");
  await rejects(assign("Y", R1), "rider-returning");
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
});

test("S6. a forming trip whose orders were all cancelled before departure dissolves (the Rider never left)", async () => {
  await wipe();
  await setTrip("T6", { riderUid: R1, status: "forming", orderIds: ["A"] });
  await seedOrder("A", { status: "cancelled", assignedRiderId: R1, dispatchTripId: "T6" });
  await setState(R1, { state: D.STATE.FORMING, tripId: "T6", orderIds: ["A"] });
  await seedOrder("Y");
  const a = await assign("Y", R1);
  assert.notEqual(a.tripId, "T6", "a new trip, not the dissolved one");
  assert.equal((await get(D.RIDER_TRIPS, "T6")).status, "dissolved");
});

// ------------------------------------------------------------------ server trip membership

test("an unproven trip (missing, or another Rider's) is never trusted: on the road → on_trip, else returning", async () => {
  await wipe();
  // Stored forming, trip document missing, only pre-departure orders.
  await seedOrder("A", { status: "assigned", assignedRiderId: R1, dispatchTripId: "GHOST" });
  await setState(R1, { state: D.STATE.FORMING, tripId: "GHOST", orderIds: ["A"] });
  await seedOrder("Y");
  await rejects(assign("Y", R1), "rider-returning");
  const s = await state(R1);
  assert.equal(s.state, D.STATE.RETURNING, "a person must confirm the Rider is at the hub");
  assert.notEqual(s.tripId, "GHOST");
  assert.equal((await get(D.RIDER_TRIPS, s.tripId)).source, "recovery");
  const c = await confirmReturn(R1, s.tripId);
  assert.equal(c.state, D.STATE.FORMING, "the held order forms the next trip after the return");

  // Stored on_trip naming R2's trip, while R1 carries an order.
  await wipe();
  await setTrip("R2TRIP", { riderUid: R2, status: "departed", orderIds: ["Q"] });
  await onRoad("X", R1, "R2TRIP");
  await setState(R1, { state: D.STATE.ON_TRIP, tripId: "R2TRIP", orderIds: ["X"] });
  const r = await ops.reconcileRider({ db, FieldValue, riderUid: R1 });
  assert.deepEqual([r.changed, r.state, r.recovered], [true, D.STATE.ON_TRIP, true]);
  const s2 = await state(R1);
  assert.notEqual(s2.tripId, "R2TRIP");
  assert.deepEqual((await get(D.RIDER_TRIPS, "R2TRIP")).orderIds, ["Q"], "the other Rider's trip is untouched");
});

test("fail closed: an assigned order with an unplaceable status stops every decision and every write", async () => {
  await wipe();
  await seedOrder("W", { status: "in_tarnsit", assignedRiderId: R1 });
  await seedOrder("Y");
  await setState(R1, { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] });
  const before = await state(R1);
  await rejects(assign("Y", R1), "rider-state-unknown");
  await rejects(finalize(R1, ["W"]), "rider-state-unknown");
  await rejects(confirmReturn(R1, "any"), "rider-state-unknown");
  const r = await ops.reconcileRider({ db, FieldValue, riderUid: R1 });
  assert.deepEqual([r.changed, r.unknown, r.orderIds], [false, true, ["W"]]);
  const rc = await recheck([R1]);
  assert.deepEqual([rc.results[0].error, rc.results[0].orderIds], ["rider-state-unknown", ["W"]]);
  assert.deepEqual(await state(R1), before, "nothing was written");
  assert.equal((await order("Y")).status, "pending_dispatch");
});

// ------------------------------------------------------------------ missed / reordered trigger events

test("missed settlement events: the repair re-checks named Riders to returning (never available)", async () => {
  await wipe();
  const tripId = await departedTrip(["a", "b"]);
  await missed("a", { status: "delivered" });
  await missed("b", { status: "delivery_failed" });
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "stale: the trigger never ran");
  const r = await recheck([R1, R2, "rep1", "nobody"]);
  const byId = Object.fromEntries(r.results.map((x) => [x.riderUid, x]));
  assert.deepEqual([byId[R1].changed, byId[R1].previousState, byId[R1].state], [true, D.STATE.ON_TRIP, D.STATE.RETURNING]);
  assert.equal(byId.rep1.error, "not-a-rider");
  assert.equal(byId.nobody.error, "not-a-rider");
  assert.equal(await state("rep1"), null, "nothing is written for an account that is not a Rider");
  assert.equal((await recheck([R1])).results[0].changed, false, "idempotent");
  assert.equal((await confirmReturn(R1, tripId)).state, D.STATE.AVAILABLE);
});

test("missed departure-side event: a direct in_transit write is caught by the next decision", async () => {
  await wipe();
  await seedOrder("a");
  const { tripId } = await assign("a", R1);
  await missed("a", { status: "in_transit", dispatchedAt: AT }); // a write the trigger never saw
  await seedOrder("Y");
  await rejects(assign("Y", R1), "rider-on-trip");
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId, s.orderIds], [D.STATE.ON_TRIP, tripId, ["a"]]);
});

test("out-of-order and repeated trigger events never regress the state", async () => {
  await wipe();
  const tripId = await departedTrip(["a"]);
  const before = await order("a");
  await db.collection("orders").doc("a").update({ status: "delivered" });
  const delivered = await order("a");
  // The newer event first, then the older one (in_transit → in_transit noise), then a repeat.
  await ops.reconcileRiderOnOrderWrite({ db, FieldValue, before, after: delivered });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  await ops.reconcileRiderOnOrderWrite({ db, FieldValue, before: { ...before, status: "loading" }, after: before });
  await ops.reconcileRiderOnOrderWrite({ db, FieldValue, before, after: delivered });
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId], [D.STATE.RETURNING, tripId], "re-derived from the current order, not the event");
});

// ------------------------------------------------------------------ concurrency, multi-order trips, repeats

test("multi-order trip: joins before departure, refused after, settles only when the last order does", async () => {
  await wipe();
  for (const id of ["a", "b", "c", "late"]) await seedOrder(id);
  const results = await Promise.all(["a", "b", "c"].map((id) => assign(id, R1)));
  const tripId = results[0].tripId;
  assert.equal(new Set(results.map((r) => r.tripId)).size, 1, "one trip");
  for (const id of ["a", "b", "c"]) await db.collection("orders").doc(id).update({ status: "loading", ...loaded });
  await finalize(R1, ["a", "b", "c"], tripId);
  await rejects(assign("late", R1), "rider-on-trip");
  await change("a", { status: "delivered" });
  await change("b", { status: "delivery_failed" });
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "c is still out");
  await rejects(confirmReturn(R1, tripId), "trip-not-settled");
  await change("c", { status: "delivered" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  assert.equal((await confirmReturn(R1, tripId)).state, D.STATE.AVAILABLE);
});

test("concurrent assignments to a stale-available Rider who is on the road: all refused", async () => {
  await wipe();
  await setTrip("T1", { riderUid: R1, status: "departed", orderIds: ["X"] });
  await onRoad("X", R1, "T1");
  for (const id of ["y1", "y2", "y3"]) await seedOrder(id);
  await setState(R1, { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] });
  const out = await Promise.allSettled(["y1", "y2", "y3"].map((id) => assign(id, R1)));
  for (const r of out) {
    assert.equal(r.status, "rejected");
    assert.ok(["rider-on-trip"].includes(r.reason.code) || ops.isTransientTransactionError(r.reason), String(r.reason?.code));
  }
  for (const id of ["y1", "y2", "y3"]) assert.equal((await order(id)).status, "pending_dispatch");
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP);
});

test("Finalize repeated and raced: one departure, the repeat replays; an assignment racing it joins or is refused", async () => {
  for (let round = 0; round < 4; round += 1) {
    await wipe();
    await seedOrder("a");
    await seedOrder("late");
    const { tripId } = await assign("a", R1);
    await db.collection("orders").doc("a").update({ status: "loading", ...loaded });
    const [f1, f2, late] = await Promise.allSettled([finalize(R1, ["a"], tripId), finalize(R1, ["a"], tripId), assign("late", R1)]);
    const done = [f1, f2].filter((r) => r.status === "fulfilled");
    assert.ok(done.filter((r) => r.value.replayed === false).length <= 1, `round ${round}: never two departures`);
    const a = await order("a");
    const lateOrder = await order("late");
    if (a.status === "in_transit") {
      // The assignment lost the race: it was refused after departure.
      assert.equal(done.length >= 1, true, `round ${round}`);
      assert.equal(late.status, "rejected", `round ${round}: nothing joins after departure`);
      assert.ok(["rider-on-trip"].includes(late.reason.code) || ops.isTransientTransactionError(late.reason), `round ${round}: ${late.reason.code}`);
      assert.equal(lateOrder.status, "pending_dispatch");
    } else {
      // The assignment won: `late` joined before departure, so both Finalize
      // calls (naming only "a") were refused and nothing left the hub.
      assert.equal(late.status, "fulfilled", `round ${round}`);
      assert.equal(lateOrder.dispatchTripId, tripId, `round ${round}: joined the same trip`);
      for (const f of [f1, f2]) {
        assert.equal(f.status, "rejected", `round ${round}`);
        assert.ok(["trip-changed"].includes(f.reason.code) || ops.isTransientTransactionError(f.reason), `round ${round}: ${f.reason.code}`);
      }
      assert.equal(a.status, "loading");
    }
    const s = await state(R1);
    assert.ok(!(s.state === D.STATE.AVAILABLE && a.status === "in_transit"), `round ${round}: never available while on the road`);
  }
});

test("the repair races an assignment safely and is restricted to Dispatchers and Admins", async () => {
  await wipe();
  await setTrip("T1", { riderUid: R1, status: "departed", orderIds: ["X"] });
  await onRoad("X", R1, "T1");
  await seedOrder("Y");
  await setState(R1, { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] });
  const [rc, a] = await Promise.allSettled([recheck([R1]), assign("Y", R1)]);
  assert.equal(rc.status, "fulfilled");
  assert.equal(a.status, "rejected");
  assert.equal((await order("Y")).status, "pending_dispatch");
  for (const uid of ["rep1", R1, "nobody"]) {
    await assert.rejects(recheck([R1], uid), (e) => ["wrong-role", "profile-missing"].includes(e.code));
  }
  await rejects(recheck([], DISPATCHER), "invalid-request");
  await rejects(recheck(Array.from({ length: 26 }, (_, i) => `r${i}`), ADMIN), "invalid-request");
  assert.equal((await recheck([R1], ADMIN)).results[0].changed, false, "Admin may run it; already repaired");
});

// ------------------------------------------------------------------ legacy and deletions

test("legacy active orders never free an in-transit Rider, through any path", async () => {
  await wipe();
  await onRoad("old", R1, null); // before Part B: no state, no trip id
  await seedOrder("held", { status: "assigned", assignedRiderId: R1 });
  const r = await recheck([R1]);
  assert.equal(r.results[0].state, D.STATE.ON_TRIP);
  const s = await state(R1);
  assert.deepEqual([s.orderIds, s.heldOrderIds], [["old"], ["held"]]);
  await rejects(confirmReturn(R1, s.tripId), "trip-not-settled");
  await rejects(finalize(R1, ["held"]), "rider-on-trip");
});

test("an in-transit order deleted out from under a trip leaves the Rider returning, not available", async () => {
  await wipe();
  const tripId = await departedTrip(["a"]);
  const before = await order("a");
  await db.collection("orders").doc("a").delete();
  await ops.reconcileRiderOnOrderWrite({ db, FieldValue, before, after: null });
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId], [D.STATE.RETURNING, tripId]);
});

// ------------------------------------------------------------------ after a confirmed return

test("after a confirmed return, terminal orders and old trip records never pull the Rider back", async () => {
  await wipe();
  // A real trip with every kind of terminal outcome, plus a legacy delivered
  // order without a server trip id — all still assigned to the Rider.
  const tripId = await departedTrip(["a", "b", "c"]);
  await seedOrder("legacy", { status: "delivered", assignedRiderId: R1, dispatchedAt: AT });
  await change("a", { status: "delivered" });
  await change("b", { status: "delivery_failed" });
  await change("c", { status: "cancelled" });
  assert.equal((await state(R1)).state, D.STATE.RETURNING);
  const c = await confirmReturn(R1, tripId);
  assert.equal(c.state, D.STATE.AVAILABLE);
  assert.equal((await get(D.RIDER_TRIPS, tripId)).status, "returned", "the old trip record stays");

  // Re-check, repeatedly (and the trigger on an unrelated later write): still available.
  for (let i = 0; i < 3; i += 1) {
    const r = await recheck([R1]);
    assert.deepEqual([r.results[0].changed, r.results[0].state], [false, D.STATE.AVAILABLE], `re-check ${i}`);
  }
  await change("a", { proofNote: "late upload" }); // not trip-relevant
  await change("legacy", { status: "delivered", updatedAt: AT });
  const s = await state(R1);
  assert.deepEqual([s.state, s.tripId, s.orderIds, s.lastConfirmedTripId], [D.STATE.AVAILABLE, null, [], tripId]);

  // A repeated confirmation is a replay, not a second release.
  const again = await confirmReturn(R1, tripId);
  assert.deepEqual([again.replayed, again.state], [true, D.STATE.AVAILABLE]);

  // The Rider forms a NEW trip; the old orders never join it.
  await seedOrder("next1");
  await seedOrder("next2");
  const n1 = await assign("next1", R1);
  const n2 = await assign("next2", R1);
  assert.notEqual(n1.tripId, tripId);
  assert.equal(n2.tripId, n1.tripId, "joins the new trip before departure");
  const formed = await state(R1);
  assert.deepEqual([formed.state, formed.orderIds], [D.STATE.FORMING, ["next1", "next2"]]);
  assert.equal((await recheck([R1])).results[0].changed, false, "re-check agrees with the new trip");
  // ...and a cancelled new trip dissolves back to available, not returning:
  // its orders never left, and the old trip's travelled orders are not members.
  await change("next1", { status: "cancelled" });
  await change("next2", { status: "cancelled" });
  assert.equal((await state(R1)).state, D.STATE.AVAILABLE);
});

test("after a confirmed return, an order that is really still on the road keeps the Rider out", async () => {
  await wipe();
  const tripId = await departedTrip(["a"]);
  await change("a", { status: "delivered" });
  await confirmReturn(R1, tripId);
  assert.equal((await state(R1)).state, D.STATE.AVAILABLE);
  // An order on the road whose update the trigger never saw (a legacy write).
  await onRoad("stray", R1, null);
  await seedOrder("Y");
  const r = await recheck([R1]);
  assert.deepEqual([r.results[0].changed, r.results[0].state], [true, D.STATE.ON_TRIP]);
  await rejects(assign("Y", R1), "rider-on-trip");
  const s = await state(R1);
  assert.deepEqual([s.state, s.orderIds], [D.STATE.ON_TRIP, ["stray"]]);
  assert.notEqual(s.tripId, tripId, "a new trip, not the confirmed one");
  // Repeated re-checks change nothing more; the confirmed trip cannot be re-confirmed into availability.
  assert.equal((await recheck([R1])).results[0].changed, false);
  const replay = await confirmReturn(R1, tripId);
  assert.equal(replay.replayed, true, "the old confirmation replays");
  assert.equal((await state(R1)).state, D.STATE.ON_TRIP, "...and does not free the Rider");
  await rejects(confirmReturn(R1, s.tripId), "trip-not-settled");
});
