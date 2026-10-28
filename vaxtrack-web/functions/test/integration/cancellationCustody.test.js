"use strict";

/**
 * Cancellation custody, end to end against a REAL Firestore (emulator), with
 * the real Rider Part B callables (assign, Finalize Dispatch, confirm return)
 * and the order-write trigger's reconcile step called directly after each
 * order change, as riderDispatch.test.js does.
 *
 * cancelAfterDispatch.test.js covers the per-status custody decision, the
 * Cargo Loading audit, replays and Admin dispositions. This suite covers what
 * that one does not: multi-product provenance, version-1 and legacy records,
 * the real Finalize callable, return confirmation and failure-return reuse
 * under a racing cancel, unauthorized callers, and trip settlement.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-cancel-custody" }, "cancel-custody-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const tripOps = require("../../src/riderDispatchOps");
const D = require("../../src/riderDispatch");

// Orders are placed before their delivery date and dispatched on it.
const PLACED = new Date("2026-10-05T02:00:00.000Z");
const DISPATCHED = new Date("2026-10-10T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const PRICE = 125000;
const REASON = "Clinic closed for the day";

let seq = 0;
const rid = () => `ccus${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const get = async (col, id) => {
  const s = await db.collection(col).doc(id).get();
  return s.exists ? s.data() : null;
};
const order = (id) => get("orders", id);
const reservation = (id) => get("inventoryReservations", id);
const ret = (id) => get("inventoryReturns", id);
const riderState = () => get(D.RIDER_DISPATCH_STATES, RIDER);
const countReturns = async () => (await db.collection("inventoryReturns").get()).size;

async function wipe() {
  for (const c of [
    "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "orderReceipts", "inventoryAllocationEvents", "orderHistoryOutbox",
    "allocationContinuations", "riderLocations", D.RIDER_DISPATCH_STATES, D.RIDER_TRIPS,
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
}

/** [batches]: inventoryId → { product, ...overrides }. */
async function seed(batches) {
  await wipe();
  await Promise.all([
    db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", assignedAreaIds: ["area1"], assignedClinicIds: ["clinic1"] }),
    db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved", email: "d@x.test" }),
    db.collection("users").doc(RIDER).set({ role: "rider", status: "approved", fullName: "Rider One" }),
    db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" }),
    db.collection("users").doc("disp-pending").set({ role: "dispatcher", status: "pending" }),
    db.collection("users").doc("disp-disabled").set({ role: "dispatcher", status: "disabled" }),
    db.collection("areas").doc("area1").set({ name: "Manila", active: true }),
    db.collection("clinics").doc("clinic1").set({
      clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: "area1", area: "Manila",
      status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
    }),
    db.collection("doctors").doc("doctor1").set({ name: "Dr. Ana Reyes", areaId: "area1", area: "Manila", active: true }),
  ]);
  await db.collection("doctors").doc("doctor1").collection("deliveryAddresses").doc("clinic1").set({ active: true });
  const products = new Set(Object.values(batches).map((b) => b.product));
  for (const p of products) {
    await db.collection("vaccines").doc(p).set({ vaccineName: `Vaccine ${p}`, vaccineType: "T", vatClassification: "vatable" });
  }
  for (const [id, { product, ...over }] of Object.entries(batches)) {
    await db.collection("inventory").doc(id).set({
      vaccineId: product, vaccineName: `Vaccine ${product}`, batchId: id.toUpperCase(), status: "Stable",
      expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE, priceIsVatInclusive: true,
      ...over,
    });
  }
}

/** [lines]: [[inventoryId, quantity], ...]. */
const create = (lines, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: PLACED,
    payload: {
      requestId: rid(), doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: DELIVERY_DATE,
      items: lines.map(([inventoryId, quantity]) => ({ inventoryId, quantity, expectedUnitPriceCentavos: PRICE })),
      ...over,
    },
  }).then((r) => r.orderId);

const cancel = (orderId, uid = DISPATCHER) =>
  ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid, orderId, reason: REASON, now: DISPATCHED });
const decide = (returnId, payload) =>
  flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: DISPATCHED, payload: { returnId, ...payload } });
const reportFailure = (orderId) =>
  flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId, reason: "Clinic closed" } });

// Rider Part B, through the real callables.
const assign = (orderId) =>
  tripOps.assignRiderToOrder({ db, FieldValue, uid: DISPATCHER, email: "d@x.test", payload: { orderId, riderUid: RIDER }, now: DISPATCHED });
const finalize = (orderIds, tripId) =>
  tripOps.finalizeRiderDispatch({ db, FieldValue, uid: DISPATCHER, email: "d@x.test", payload: { riderUid: RIDER, orderIds, tripId }, now: DISPATCHED });
const confirmReturn = (tripId) =>
  tripOps.confirmRiderReturnToHub({ db, FieldValue, uid: DISPATCHER, payload: { riderUid: RIDER, tripId } });
/** A Dispatcher ticking Cargo Loading (a client write the rules allow), with its audit. */
const load = (orderId) =>
  db.collection("orders").doc(orderId).update({
    status: "loading", isLoaded: true, loadedAt: Timestamp.fromDate(DISPATCHED), loadedByUid: DISPATCHER,
  });
/** The order-write trigger, as deployed: reconcile from the before/after pair. */
async function reconcileAfter(orderId, action) {
  const before = await order(orderId);
  const result = await action();
  const after = await order(orderId);
  await tripOps.reconcileRiderOnOrderWrite({ db, FieldValue, before, after });
  return result;
}
/** Direct status write, for records the app no longer produces (legacy/v1). */
const setFields = (orderId, fields) => db.collection("orders").doc(orderId).update(fields);

/** on hand / reserved / return-pending / quarantined / available */
async function stock(id) {
  const b = await get("inventory", id);
  const n = (v) => (Number.isInteger(v) ? v : 0);
  return {
    onHand: n(b.quantity), reserved: n(b.reservedQuantity), returnPending: n(b.returnPendingQuantity),
    quarantined: n(b.quarantinedQuantity),
    available: n(b.quantity) - n(b.reservedQuantity) - n(b.returnPendingQuantity) - n(b.quarantinedQuantity),
  };
}
const lineOf = async (orderId, i = 0) => {
  const l = (await order(orderId)).items[i];
  return [l.reservedQuantity, l.backorderedQuantity];
};

// ------------------------------------------------- provenance across products

test("a two-product in-transit order returns each batch's exact quantity, with full provenance", async () => {
  await seed({ a1: { product: "pA", quantity: 6 }, b1: { product: "pB", quantity: 9 } });
  const x = await create([["a1", 4], ["b1", 7]]);
  await setFields(x, { status: "in_transit", assignedRiderId: RIDER });
  const res = await cancel(x);
  assert.equal(res.replayed, false);

  const rt = await ret(`${x}_cancel`);
  assert.deepEqual(
    rt.items.map((i) => [i.inventoryId, i.batchId, i.productKey, i.quantity]),
    [["a1", "A1", "pA", 4], ["b1", "B1", "pB", 7]],
  );
  assert.deepEqual([rt.status, rt.source, rt.cancelledFromStatus, rt.cancelReason, rt.reportedByUid, rt.totalQuantity, rt.orderId],
    ["pending", "cancelled_after_dispatch", "in_transit", REASON, DISPATCHER, 11, x]);
  assert.ok(rt.reportedAt, "creation time recorded");
  assert.deepEqual(rt.productKeys, ["pA", "pB"]);

  const r = await reservation(x);
  assert.deepEqual([r.status, r.returnId, r.settlementType, r.settledByUid], ["returned", `${x}_cancel`, "cancelled_after_dispatch", DISPATCHER]);
  assert.deepEqual(await stock("a1"), { onHand: 6, reserved: 0, returnPending: 4, quarantined: 0, available: 2 });
  assert.deepEqual(await stock("b1"), { onHand: 9, reserved: 0, returnPending: 7, quarantined: 0, available: 2 });
  const o = await order(x);
  assert.deepEqual([o.status, o.allocationStatus, o.pendingReturnId, o.cancelReason], ["cancelled", "returned", `${x}_cancel`, REASON]);
});

test("only genuinely released hub stock reaches a waiting order; return-pending stock never does", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const hub = await create([["b1", 2]]); // never left the hub
  const away = await create([["b1", 8]]); // with the rider
  const waiting = await create([["b1", 5]]); // 0 reserved, 5 backordered
  await setFields(away, { status: "in_transit", assignedRiderId: RIDER });
  assert.deepEqual(await lineOf(waiting), [0, 5]);

  await cancel(away);
  assert.deepEqual(await lineOf(waiting), [0, 5], "nothing from the vehicle");
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, available: 0 });

  const released = await cancel(hub);
  assert.deepEqual(released.reallocated.map((a) => [a.orderId, a.units]), [[waiting, 2]], "exactly the hub's 2");
  assert.deepEqual(await lineOf(waiting), [2, 3]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, available: 0 });
});

// ------------------------------------------------------ legacy and version 1

test("a version-1 in-transit order with no loading audit still goes to return-pending", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 8]]);
  const waiting = await create([["b1", 4]]);
  // Pre-backorder record: version 1, dispatched before the loading audit existed.
  await setFields(x, { status: "in_transit", assignedRiderId: RIDER, allocationVersion: 1, isLoaded: FieldValue.delete() });
  await cancel(x);
  assert.equal((await ret(`${x}_cancel`)).status, "pending");
  assert.equal((await reservation(x)).status, "returned");
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, available: 0 });
  assert.deepEqual(await lineOf(waiting), [2, 2], "the waiting order gets nothing from the vehicle");
});

test("a version-1 failed delivery still holding its reservation is returned for inspection, not released", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 8]]);
  const waiting = await create([["b1", 4]]);
  // Failed under the old design, which kept a failure's stock reserved.
  await setFields(x, { status: "delivery_failed", assignedRiderId: RIDER, allocationVersion: 1, deliveryFailureReason: "Clinic closed", deliveryFailedByUid: RIDER });
  assert.equal((await reservation(x)).status, "reserved");

  const res = await cancel(x);
  assert.deepEqual(res.reallocated, [], "nothing reallocated");
  const r = await reservation(x);
  assert.deepEqual([r.status, r.settlementType], ["returned", "delivery_failed"]);
  const rt = await ret(r.returnId);
  assert.deepEqual([rt.status, rt.source, rt.totalQuantity], ["pending", "delivery_failed", 8]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, available: 0 });
  assert.deepEqual(await lineOf(waiting), [2, 2]);
  assert.equal((await order(x)).status, "cancelled");
  // A retry is a replay: nothing moves twice, no second return.
  assert.equal((await cancel(x)).replayed, true);
  assert.equal(await countReturns(), 1);
});

test("a v2 in-transit order whose reservation is missing is refused, never treated as hub stock", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 8]]);
  await setFields(x, { status: "in_transit", assignedRiderId: RIDER });
  await db.collection("inventoryReservations").doc(x).delete();
  assert.equal(await codeOf(cancel(x)), "reservation-not-found");
  assert.equal((await order(x)).status, "in_transit", "nothing changed");
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 8, returnPending: 0, quarantined: 0, available: 2 });
});

// ------------------------------------------------- failed-delivery return reuse

test("cancelling a failed delivery reuses its return; no cancellation return is created", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 8]]);
  await setFields(x, { status: "in_transit", assignedRiderId: RIDER });
  await reportFailure(x);
  const failed = await order(x);
  assert.equal(failed.pendingReturnId, `${x}_1`);

  await cancel(x);
  assert.equal(await countReturns(), 1);
  assert.equal(await ret(`${x}_cancel`), null, "no duplicate return");
  assert.equal((await ret(`${x}_1`)).status, "pending");
  const o = await order(x);
  assert.deepEqual([o.status, o.pendingReturnId, o.deliveryFailureReason], ["cancelled", `${x}_1`, "Clinic closed"]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 0, returnPending: 8, quarantined: 0, available: 2 });
});

test("cancellation racing the Admin's return confirmation stays consistent either way", async () => {
  for (let round = 0; round < 3; round += 1) {
    await seed({ b1: { product: "pA", quantity: 10 } });
    const x = await create([["b1", 8]]);
    await setFields(x, { status: "in_transit", assignedRiderId: RIDER });
    await reportFailure(x);
    const outcomes = await Promise.allSettled([cancel(x), decide(`${x}_1`, { disposition: "usable" })]);
    assert.ok(outcomes.every((o) => o.status === "fulfilled"), `round ${round}: both succeed`);
    assert.equal(await countReturns(), 1);
    const rt = await ret(`${x}_1`);
    assert.deepEqual([rt.status, rt.disposition], ["resolved", "usable"]);
    assert.equal((await order(x)).status, "cancelled");
    // The 8 vials came back exactly once: available, nothing pending, nothing reserved.
    assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 0, returnPending: 0, quarantined: 0, available: 10 }, `round ${round}`);
  }
});

// -------------------------------------------------------------- authorization

test("only Dispatcher can cancel after departure; other roles are refused and nothing moves", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 8]]);
  await setFields(x, { status: "in_transit", assignedRiderId: RIDER });
  for (const [uid, code] of [
    [RIDER, "wrong-role"], [SR, "cancellation-not-eligible"], [ADMIN, "cancellation-not-eligible"],
    ["disp-pending", "not-approved"], ["disp-disabled", "not-approved"], ["nobody", "profile-missing"],
  ]) {
    assert.equal(await codeOf(cancel(x, uid)), code, uid);
  }
  assert.equal((await order(x)).status, "in_transit");
  assert.equal((await reservation(x)).status, "reserved");
  assert.equal(await countReturns(), 0);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 8, returnPending: 0, quarantined: 0, available: 2 });
});

test("delivered and already-cancelled orders keep their outcome", async () => {
  await seed({ b1: { product: "pA", quantity: 10 } });
  const x = await create([["b1", 2]]);
  await setFields(x, { status: "delivered" });
  assert.equal(await codeOf(cancel(x)), "invalid-status-transition");
  assert.equal((await reservation(x)).status, "reserved", "untouched by the refused cancel");
});

// --------------------------------------------- Rider Part B: Finalize and trips

/** Two fully reserved orders on one forming trip, both loaded. */
async function loadedTrip() {
  await seed({ b1: { product: "pA", quantity: 20 } });
  const o1 = await create([["b1", 8]]);
  const o2 = await create([["b1", 5]]);
  const waiting = await create([["b1", 10]]); // 7 reserved, 3 backordered
  const { tripId } = await assign(o1);
  await assign(o2);
  await load(o1);
  await load(o2);
  return { o1, o2, waiting, tripId };
}

test("cancellation racing the real Finalize Dispatch: one outcome, the loaded vials returned once", async () => {
  for (let round = 0; round < 3; round += 1) {
    const { o1, o2, waiting, tripId } = await loadedTrip();
    const outcomes = await Promise.allSettled([cancel(o1), finalize([o1, o2], tripId)]);
    assert.equal(outcomes[0].status, "fulfilled", `round ${round}: the cancel always settles`);
    await tripOps.reconcileRider({ db, FieldValue, riderUid: RIDER });

    const o = await order(o1);
    assert.equal(o.status, "cancelled");
    // Loaded either way: the 8 vials were handled, so they are inspected.
    assert.equal((await ret(`${o1}_cancel`)).status, "pending");
    assert.equal(await countReturns(), 1);
    assert.deepEqual(await stock("b1"), { onHand: 20, reserved: 12, returnPending: 8, quarantined: 0, available: 0 }, `round ${round}`);
    assert.deepEqual(await lineOf(waiting), [7, 3], "the waiting order gets nothing from the loaded order");

    const s = await riderState();
    if (outcomes[1].status === "fulfilled") {
      assert.equal((await order(o2)).status, "in_transit");
      assert.equal(s.state, D.STATE.ON_TRIP, "o2 is still out: the trip is not settled");
    } else {
      // Finalize saw the cancelled order and refused the whole trip.
      assert.equal((await order(o2)).status, "loading");
      assert.equal(s.state, D.STATE.FORMING);
    }
  }
});

test("trip settlement: a cancelled order is terminal, but the Rider returns only when every order is", async () => {
  const { o1, o2, tripId } = await loadedTrip();
  await finalize([o1, o2], tripId);
  assert.equal((await riderState()).state, D.STATE.ON_TRIP);

  await reconcileAfter(o1, () => cancel(o1));
  assert.equal((await riderState()).state, D.STATE.ON_TRIP, "o2 is still with the Rider");
  // A repeated cancel changes nothing: no second return, no second settlement.
  const before = await riderState();
  await reconcileAfter(o1, () => cancel(o1));
  assert.deepEqual(await riderState(), before);
  assert.equal(await countReturns(), 1);

  await reconcileAfter(o2, () => cancel(o2));
  const settled = await riderState();
  assert.equal(settled.state, D.STATE.RETURNING, "every order terminal: returning to the hub");
  assert.notEqual(settled.state, D.STATE.AVAILABLE, "never available automatically");
  assert.equal(await countReturns(), 2);
  assert.deepEqual(await stock("b1"), { onHand: 20, reserved: 7, returnPending: 13, quarantined: 0, available: 0 });

  // Only the Dispatcher's confirmation of the physical return frees the Rider.
  await confirmReturn(tripId);
  assert.equal((await riderState()).state, D.STATE.AVAILABLE);
});
