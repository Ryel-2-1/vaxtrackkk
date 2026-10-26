"use strict";

/**
 * Admin Rider recovery against a REAL Firestore (emulator): preview, confirm
 * returned to hub, and the staging-only QA trip reset — with the real Rider
 * Part B callables (assign, Finalize, return) and the order-write trigger's
 * reconcile step called directly after each simulated order change.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-rider-recovery" }, "rider-recovery-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const trips = require("../../src/riderDispatchOps");
const ops = require("../../src/riderRecoveryOps");
const orderOps = require("../../src/operations");
const D = require("../../src/riderDispatch");
const { qaResetConfig } = require("../../src/riderRecovery");

const NOW = new Date("2026-10-19T03:00:00Z");
const PLACED = new Date("2026-10-15T03:00:00Z");
const ADMIN = "admin1";
const DISPATCHER = "disp1";
const R1 = "rider1";
const R2 = "rider2";
const REASON = "QA run finished; resetting the test rider";
const ON = qaResetConfig({ projectId: "demo-vaxtrack-rider-recovery", flag: "true" });

async function wipe() {
  for (const c of [
    "orders", "users", D.RIDER_DISPATCH_STATES, D.RIDER_TRIPS, ops.RECOVERY_AUDITS, "riderNavigationSessions",
    "inventoryReturns", "inventory", "inventoryReservations", "vaccines", "areas", "clinics", "doctors",
    "orderRequestKeys", "orderReceipts", "inventoryAllocationEvents", "orderHistoryOutbox", "allocationContinuations",
  ]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map(async (d) => {
      for (const sub of await d.ref.listCollections()) {
        const s = await sub.get();
        await Promise.all(s.docs.map((x) => x.ref.delete()));
      }
      await d.ref.delete();
    }));
  }
  await Promise.all([
    db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved", email: "a@x.test" }),
    db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved", email: "d@x.test" }),
    db.collection("users").doc(R1).set({ role: "rider", status: "approved", fullName: "Rider One" }),
    db.collection("users").doc(R2).set({ role: "rider", status: "approved", fullName: "Rider Two" }),
    db.collection("users").doc("rep1").set({ role: "salesrep", status: "approved", assignedAreaIds: ["area1"], assignedClinicIds: ["clinic1"] }),
    db.collection("users").doc("admin-pending").set({ role: "admin", status: "pending" }),
    db.collection("users").doc("admin-disabled").set({ role: "admin", status: "disabled" }),
  ]);
}

async function seedOrder(id, over = {}) {
  await db.collection("orders").doc(id).set({
    orderNumber: `VT-ORD-${id.toUpperCase()}`,
    status: "pending_dispatch",
    requestedDeliveryDate: "2026-10-18",
    allocationVersion: 2,
    allocationState: "fully_reserved",
    ...over,
  });
}
const get = async (c, id) => {
  const s = await db.collection(c).doc(id).get();
  return s.exists ? s.data() : null;
};
const state = (r = R1) => get(D.RIDER_DISPATCH_STATES, r);
const order = (id) => get("orders", id);
const audits = async () => (await db.collection(ops.RECOVERY_AUDITS).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};

const assign = (orderId, riderUid = R1) =>
  trips.assignRiderToOrder({ db, FieldValue, uid: DISPATCHER, email: "d@x.test", payload: { orderId, riderUid }, now: NOW });
const finalize = (orderIds, tripId, riderUid = R1) =>
  trips.finalizeRiderDispatch({ db, FieldValue, uid: DISPATCHER, email: "d@x.test", payload: { riderUid, orderIds, tripId }, now: NOW });
const recheck = (riderUids, uid = ADMIN) => trips.recheckRiderTripStates({ db, FieldValue, uid, payload: { riderUids } });
const preview = (riderUid = R1, { uid = ADMIN, config = ON } = {}) =>
  ops.previewRiderRecovery({ db, uid, payload: { riderUid }, config });
const apply = (action, version, { riderUid = R1, uid = ADMIN, config = ON, reason = REASON } = {}) =>
  ops.applyRiderRecovery({ db, FieldValue, uid, email: "a@x.test", payload: { riderUid, action, version, reason }, config });

/** A Dispatcher ticking Cargo Loading, with its audit (a client write the rules allow). */
const load = (id) =>
  db.collection("orders").doc(id).update({ status: "loading", isLoaded: true, loadedAt: Timestamp.fromDate(NOW), loadedByUid: DISPATCHER });
/** Any order change, then the trigger's reconcile — exactly as deployed. */
async function change(id, fields) {
  const before = await order(id);
  await db.collection("orders").doc(id).update(fields);
  const after = await order(id);
  return trips.reconcileRiderOnOrderWrite({ db, FieldValue, before, after });
}
const blockerCodes = (p) => p.actions.qaReset.blockers.map((b) => b.code).sort();

/** o1 + o2 assigned to R1 on one forming trip, never loaded. */
async function formingTrip() {
  await wipe();
  await seedOrder("o1");
  await seedOrder("o2");
  const { tripId } = await assign("o1");
  await assign("o2");
  return tripId;
}
/** o1 + o2 loaded and dispatched (on_trip). */
async function departedTrip() {
  const tripId = await formingTrip();
  await load("o1");
  await load("o2");
  await finalize(["o1", "o2"], tripId);
  return tripId;
}

// ------------------------------------------------------------------ 1–4

test("1. an available Rider: nothing to recover, and a reset is a no-op", async () => {
  await wipe();
  await trips.reconcileRider({ db, FieldValue, riderUid: R1 });
  const p = await preview();
  assert.deepEqual([p.derived.state, p.actions.recheck.needed, p.actions.confirmReturn.available], [D.STATE.AVAILABLE, false, false]);
  assert.match(p.actions.confirmReturn.message, /already at the hub/);
  assert.deepEqual([p.actions.qaReset.enabled, p.actions.qaReset.available, p.actions.qaReset.noop], [true, false, true]);
  const r = await apply("qa_reset", p.version);
  assert.deepEqual([r.changed, r.state], [false, D.STATE.AVAILABLE]);
  assert.equal((await audits()).length, 0, "a no-op records nothing");
});

test("2. a stale stored state: the preview says so and Re-check repairs it", async () => {
  await wipe();
  await seedOrder("o1", { status: "delivered", assignedRiderId: R1 });
  // Left on_trip by a missed trigger event, although its only order is delivered.
  const t = db.collection(D.RIDER_TRIPS).doc("trip-stale");
  await t.set({ riderUid: R1, status: "departed", orderIds: ["o1"] });
  await db.collection(D.RIDER_DISPATCH_STATES).doc(R1).set({ riderUid: R1, state: D.STATE.ON_TRIP, tripId: "trip-stale", orderIds: ["o1"], heldOrderIds: [], departedAt: Timestamp.fromDate(NOW) });
  const p = await preview();
  assert.deepEqual([p.stored.state, p.derived.state, p.actions.recheck.needed], [D.STATE.ON_TRIP, D.STATE.RETURNING, true]);
  const [res] = (await recheck([R1])).results;
  assert.deepEqual([res.changed, res.state, res.previousState], [true, D.STATE.RETURNING, D.STATE.ON_TRIP]);
  assert.equal((await preview()).actions.recheck.needed, false);
  assert.equal((await state()).state, D.STATE.RETURNING, "never available without a confirmed return");
});

test("3–4. a returning Rider: the Admin confirms the return with a reason; a repeat replays harmlessly", async () => {
  const tripId = await departedTrip();
  await change("o1", { status: "delivered" });
  await change("o2", { status: "cancelled" });
  assert.equal((await state()).state, D.STATE.RETURNING);

  const p = await preview();
  assert.equal(p.actions.confirmReturn.available, true);
  assert.equal(p.actions.qaReset.available, false, "a trip that left is never reset");
  assert.ok(blockerCodes(p).includes("trip-departed"));
  assert.equal(await codeOf(apply("confirm_return", p.version, { reason: "  " })), "reason-required");

  const r = await apply("confirm_return", p.version);
  assert.deepEqual([r.state, r.replayed], [D.STATE.AVAILABLE, false]);
  assert.deepEqual(r.affectedOrderNumbers.sort(), ["VT-ORD-O1", "VT-ORD-O2"]);
  const s = await state();
  assert.deepEqual([s.state, s.lastConfirmedTripId, s.returnConfirmedByUid], [D.STATE.AVAILABLE, tripId, ADMIN]);
  assert.equal((await get(D.RIDER_TRIPS, tripId)).status, "returned");
  const [a] = await audits();
  assert.deepEqual([a.action, a.riderUid, a.actorUid, a.reason, a.before.state, a.after.state, a.tripId],
    ["confirm_return", R1, ADMIN, REASON, D.STATE.RETURNING, D.STATE.AVAILABLE, tripId]);

  // 4. The same confirmation again (or twice at once) replays; nothing moves.
  const before = await state();
  const again = await Promise.all([apply("confirm_return", p.version), apply("confirm_return", p.version)]);
  assert.ok(again.every((x) => x.replayed));
  assert.deepEqual(await state(), before);
  assert.equal((await audits()).length, 1);
  // A fresh preview no longer offers it.
  assert.equal((await preview()).actions.confirmReturn.available, false);
});

// ------------------------------------------------------------------ 5–6, 21

test("5 + 21. a forming trip of never-loaded orders is reset atomically, with one complete audit record", async () => {
  const tripId = await formingTrip();
  const p = await preview();
  assert.deepEqual([p.derived.state, p.actions.qaReset.available], [D.STATE.FORMING, true]);
  assert.deepEqual(p.actions.qaReset.requeueOrderNumbers, ["VT-ORD-O1", "VT-ORD-O2"]);
  assert.deepEqual(p.orders.map((o) => [o.orderNumber, o.statusLabel, o.custody]), [["VT-ORD-O1", "Assigned", "not-loaded"], ["VT-ORD-O2", "Assigned", "not-loaded"]]);

  const r = await apply("qa_reset", p.version);
  assert.deepEqual([r.changed, r.state], [true, D.STATE.AVAILABLE]);
  for (const id of ["o1", "o2"]) {
    const o = await order(id);
    assert.deepEqual([o.status, o.assignedRiderId, o.dispatchTripId, o.previousAssignedRiderId, o.statusUpdatedByUid],
      ["pending_dispatch", null, undefined, R1, ADMIN], id);
  }
  const s = await state();
  assert.deepEqual([s.state, s.tripId, s.orderIds, s.heldOrderIds], [D.STATE.AVAILABLE, null, [], []]);
  const t = await get(D.RIDER_TRIPS, tripId);
  assert.deepEqual([t.status, t.orderIds, t.dissolvedBy], ["dissolved", [], "qa-reset"]);

  const [a] = await audits();
  assert.deepEqual(
    [a.action, a.riderUid, a.riderName, a.actorUid, a.actorRole, a.actorEmail, a.reason, a.projectId],
    ["qa_reset", R1, "Rider One", ADMIN, "admin", "a@x.test", REASON, "demo-vaxtrack-rider-recovery"],
  );
  assert.deepEqual([a.before.state, a.before.tripId, a.after.state, a.after.tripId], [D.STATE.FORMING, tripId, D.STATE.AVAILABLE, null]);
  assert.deepEqual(a.affectedOrders.map((x) => [x.orderNumber, x.fromStatus, x.toStatus, x.previousTripId]),
    [["VT-ORD-O1", "assigned", "pending_dispatch", tripId], ["VT-ORD-O2", "assigned", "pending_dispatch", tripId]]);
  assert.deepEqual(a.dissolvedTripIds, [tripId]);
  assert.ok(a.createdAt);

  // The order-write trigger agrees: nothing left to reconcile.
  for (const id of ["o1", "o2"]) await change(id, { updatedAt: FieldValue.serverTimestamp() });
  assert.equal((await state()).state, D.STATE.AVAILABLE);
  // The orders can be assigned again, to anyone.
  assert.equal((await assign("o1", R2)).replayed, false);
});

test("6. all or none: one loaded order blocks the whole reset and nothing changes", async () => {
  await formingTrip();
  // Ticked while still Assigned (allowed by the rules): handled vials.
  await db.collection("orders").doc("o2").update({ isLoaded: true, loadedAt: Timestamp.fromDate(NOW), loadedByUid: DISPATCHER });
  const p = await preview();
  assert.equal(p.actions.qaReset.available, false);
  assert.deepEqual(p.actions.qaReset.blockers.map((b) => [b.code, b.orderNumber]), [["order-loaded", "VT-ORD-O2"]]);
  assert.equal(p.orders.find((o) => o.orderNumber === "VT-ORD-O2").blocker.code, "order-loaded");
  assert.equal(await codeOf(apply("qa_reset", p.version)), "recovery-blocked");
  assert.equal((await order("o1")).status, "assigned", "o1 untouched too");
  assert.equal((await state()).state, D.STATE.FORMING);
  assert.equal((await audits()).length, 0);
});

// ------------------------------------------------------------------ 7–14 refusals

async function refused(code, setup) {
  await setup();
  const p = await preview();
  assert.equal(p.actions.qaReset.available, false, code);
  assert.ok(blockerCodes(p).includes(code), `${code} in ${blockerCodes(p)}`);
  const before = { s: await state(), o1: await order("o1"), o2: await order("o2") };
  assert.equal(await codeOf(apply("qa_reset", p.version)), "recovery-blocked", code);
  assert.deepEqual({ s: await state(), o1: await order("o1"), o2: await order("o2") }, before, `${code}: nothing changed`);
  return p;
}

test("7. Loading with no loading record: the lifecycle has no way back from Loading — refused", async () => {
  const p = await refused("loading-not-requeueable", async () => {
    await formingTrip();
    // A legacy/direct Loading write with no flag and no audit.
    await db.collection("orders").doc("o1").update({ status: "loading" });
  });
  assert.match(p.actions.qaReset.blockers[0].message, /can't be moved back from Loading/);
});

test("8. Loading with the box ticked: refused", async () => {
  await refused("order-loaded", async () => {
    await formingTrip();
    await load("o1");
  });
});

test("9. Loading, unticked, but the immutable loading audit remains: refused", async () => {
  await refused("order-loaded", async () => {
    await formingTrip();
    await load("o1");
    await db.collection("orders").doc("o1").update({ isLoaded: false });
  });
});

test("10. In Transit: refused", async () => {
  await refused("order-on-the-road", departedTrip);
});

test("11. Delayed: refused", async () => {
  await refused("order-on-the-road", async () => {
    await departedTrip();
    await change("o1", { status: "delayed" });
  });
});

test("12. a failed delivery, or vials pending return inspection: refused", async () => {
  await refused("order-failed", async () => {
    await departedTrip();
    await change("o1", { status: "delivery_failed" });
  });
  await refused("return-pending", async () => {
    await formingTrip();
    await db.collection("inventoryReturns").doc("o1_1").set({ orderId: "o1", status: "pending", items: [], source: "delivery_failed" });
  });
});

test("13. an active navigation session: refused", async () => {
  await refused("navigation-active", async () => {
    await formingTrip();
    await db.collection("riderNavigationSessions").doc(R1).set({ riderUid: R1, sessionId: "s1", orderId: "o1", state: "navigating", endedAt: null });
  });
});

test("14. an order recorded on another Rider's trip: refused, never forced", async () => {
  await refused("membership-inconsistent", async () => {
    await formingTrip();
    await seedOrder("x2");
    const { tripId: other } = await assign("x2", R2);
    // o2 names R2's trip while assigned to R1: ambiguous custody.
    await db.collection("orders").doc("o2").update({ dispatchTripId: other });
  });
});

// ------------------------------------------------------------------ 15–17 concurrency

test("15. reset racing an assignment: one consistent outcome", async () => {
  for (let round = 0; round < 3; round += 1) {
    await wipe();
    await seedOrder("o1");
    await seedOrder("o2");
    await assign("o1");
    const p = await preview();
    const [a, r] = await Promise.allSettled([assign("o2"), apply("qa_reset", p.version)]);
    assert.equal(a.status, "fulfilled", `round ${round}: the assignment always succeeds`);
    await trips.reconcileRider({ db, FieldValue, riderUid: R1 });
    const s = await state();
    const o1 = await order("o1");
    const o2 = await order("o2");
    if (r.status === "fulfilled") {
      // Reset first: o1 back in the queue; o2 started a fresh trip.
      assert.equal(o1.status, "pending_dispatch");
      assert.deepEqual([s.state, s.orderIds], [D.STATE.FORMING, ["o2"]]);
      assert.equal(o2.dispatchTripId, s.tripId);
    } else {
      assert.equal(r.reason.code, "recovery-stale", `round ${round}`);
      assert.deepEqual([s.state, s.orderIds], [D.STATE.FORMING, ["o1", "o2"]]);
      assert.equal(o1.dispatchTripId, s.tripId);
    }
  }
});

test("16. reset racing Finalize Dispatch: a departed trip is never reset", async () => {
  // A preview taken before loading cannot be applied after the trip leaves.
  const tripId = await formingTrip();
  const stale = await preview();
  assert.equal(stale.actions.qaReset.available, true);
  await load("o1");
  await load("o2");
  await finalize(["o1", "o2"], tripId);
  assert.equal(await codeOf(apply("qa_reset", stale.version)), "recovery-stale");
  assert.equal((await state()).state, D.STATE.ON_TRIP);

  // Loaded and racing: Finalize wins or the reset is refused — never both.
  for (let round = 0; round < 3; round += 1) {
    const t = await formingTrip();
    await load("o1");
    await load("o2");
    const p = await preview();
    const [f, r] = await Promise.allSettled([finalize(["o1", "o2"], t), apply("qa_reset", p.version)]);
    assert.equal(f.status, "fulfilled");
    assert.equal(r.status, "rejected");
    assert.match(r.reason.code, /^recovery-(blocked|stale)$/);
    assert.deepEqual([(await order("o1")).status, (await state()).state], ["in_transit", D.STATE.ON_TRIP]);
  }
});

test("17. a repeated QA reset is idempotent, sequentially and at once", async () => {
  await formingTrip();
  const p = await preview();
  const both = await Promise.all([apply("qa_reset", p.version), apply("qa_reset", p.version)]);
  assert.deepEqual(both.map((x) => x.replayed).sort(), [false, true]);
  const third = await apply("qa_reset", p.version);
  assert.equal(third.replayed, true);
  assert.deepEqual(third.affectedOrderNumbers, ["VT-ORD-O1", "VT-ORD-O2"]);
  assert.equal((await audits()).length, 1);
  assert.equal((await state()).state, D.STATE.AVAILABLE);
});

// ------------------------------------------------------------------ 18, 20

test("18. only an approved Admin may preview or apply", async () => {
  await formingTrip();
  const p = await preview();
  for (const [uid, code] of [
    [DISPATCHER, "wrong-role"], ["rep1", "wrong-role"], [R1, "wrong-role"],
    ["admin-pending", "not-approved"], ["admin-disabled", "not-approved"], ["nobody", "profile-missing"],
  ]) {
    assert.equal(await codeOf(preview(R1, { uid })), code, `preview ${uid}`);
    assert.equal(await codeOf(apply("qa_reset", p.version, { uid })), code, `apply ${uid}`);
  }
  assert.equal(await codeOf(preview(DISPATCHER)), "not-a-rider", "only Riders are recovered");
  assert.equal((await state()).state, D.STATE.FORMING);
});

test("20. production, an unlisted project, or the switch off: QA reset fails closed", async () => {
  await formingTrip();
  const configs = [
    qaResetConfig({ projectId: "vaxtrack-bef1b", flag: "true" }),
    qaResetConfig({ projectId: "some-other-project", flag: "true" }),
    qaResetConfig({ projectId: "vaxtrack-staging", flag: undefined }),
    qaResetConfig({ projectId: "vaxtrack-staging", flag: "TRUE" }),
    qaResetConfig({ projectId: null, flag: "true" }),
  ];
  for (const config of configs) {
    assert.equal(config.enabled, false, JSON.stringify(config));
    const p = await preview(R1, { config });
    assert.deepEqual([p.actions.qaReset.enabled, p.actions.qaReset.available], [false, false]);
    assert.deepEqual(blockerCodes(p), ["qa-reset-disabled"]);
    assert.equal(await codeOf(apply("qa_reset", p.version, { config })), "qa-reset-disabled");
  }
  assert.equal(qaResetConfig({ projectId: "vaxtrack-staging", flag: "true" }).enabled, true);
  // Production still offers the safe recoveries.
  const prod = await preview(R1, { config: configs[0] });
  assert.equal(prod.actions.recheck.available, true);
  assert.equal((await state()).state, D.STATE.FORMING);
});

test("a preview goes stale when anything it read changes", async () => {
  await formingTrip();
  const p = await preview();
  await db.collection("orders").doc("o1").update({ deliveryInstructions: "Gate B" });
  assert.equal(await codeOf(apply("qa_reset", p.version)), "recovery-stale");
  assert.equal(await codeOf(apply("qa_reset", "not-a-version")), "invalid-request");
  assert.equal((await state()).state, D.STATE.FORMING);
});

// ------------------------------------------------------------------ 22

test("22. a pre-departure reset leaves every reservation and stock figure exactly as it was", async () => {
  await wipe();
  await Promise.all([
    db.collection("areas").doc("area1").set({ name: "Manila", active: true }),
    db.collection("clinics").doc("clinic1").set({
      clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: "area1", area: "Manila",
      status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
    }),
    db.collection("doctors").doc("doctor1").set({ name: "Dr. Ana Reyes", areaId: "area1", area: "Manila", active: true }),
    db.collection("vaccines").doc("vacP").set({ vaccineName: "Vaccine P", vaccineType: "T", vatClassification: "vatable" }),
    db.collection("inventory").doc("b1").set({
      vaccineId: "vacP", vaccineName: "Vaccine P", batchId: "B1", status: "Stable", expiryDate: "2027-06-30",
      quantity: 20, reservedQuantity: 0, sellingPriceCentavos: 125000, priceIsVatInclusive: true,
    }),
  ]);
  await db.collection("doctors").doc("doctor1").collection("deliveryAddresses").doc("clinic1").set({ active: true });
  const ids = [];
  for (const [n, qty] of [[1, 6], [2, 9]]) {
    const r = await orderOps.createOrderWithReservation({
      db, FieldValue, uid: "rep1", now: PLACED,
      payload: {
        requestId: `rreq${n}${"x".repeat(24)}`, doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: "2026-10-18",
        items: [{ inventoryId: "b1", quantity: qty, expectedUnitPriceCentavos: 125000 }],
      },
    });
    ids.push(r.orderId);
    await assign(r.orderId);
  }
  const batch = await get("inventory", "b1");
  const reservations = await Promise.all(ids.map((id) => get("inventoryReservations", id)));
  const items = await Promise.all(ids.map(async (id) => (await order(id)).items));
  assert.equal(batch.reservedQuantity, 15);

  await apply("qa_reset", (await preview()).version);

  assert.deepEqual(await get("inventory", "b1"), batch, "stock figures untouched");
  assert.deepEqual(await Promise.all(ids.map((id) => get("inventoryReservations", id))), reservations, "reservations untouched");
  for (const [i, id] of ids.entries()) {
    const o = await order(id);
    assert.deepEqual([o.status, o.allocationState, o.items], ["pending_dispatch", "fully_reserved", items[i]]);
  }
});
