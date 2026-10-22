"use strict";

/**
 * Cancelling an order whose vials are with the Rider (In Transit / Delayed),
 * against a REAL Firestore (emulator), through the server operations.
 *
 * Before this fix the units were released straight to available stock and
 * re-allocated to the next waiting order while still on the vehicle (audit
 * claim 3, reproduced 2026-10-17). Now they go to return-pending under one
 * return that an Admin resolves — as a whole or per batch — and only the usable
 * quantity becomes available.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-cancel-return" }, "cancel-return-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const { placeRiderAtDestination } = require("../helpers/riderAtDestination");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const { hasLoadingAudit } = require("../../src/policy");

const NOW = new Date("2026-10-05T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const P = "vacP";
const PRICE = 125000;
const REASON = "Clinic closed for the day";

let seq = 0;
const rid = () => `cret${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const get = async (col, id) => (await db.collection(col).doc(id).get()).data();
const order = (id) => get("orders", id);
const reservation = (id) => get("inventoryReservations", id);
const ret = (id) => get("inventoryReturns", id);

async function wipe() {
  for (const c of [
    "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "orderReceipts", "inventoryAllocationEvents", "orderHistoryOutbox",
    "allocationContinuations", "riderLocations",
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

async function seed(batches) {
  await wipe();
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", assignedAreaIds: ["area1"], assignedClinicIds: ["clinic1"] });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
  await db.collection("areas").doc("area1").set({ name: "Manila", active: true });
  await db.collection("clinics").doc("clinic1").set({
    clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: "area1", area: "Manila",
    status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
  });
  await db.collection("doctors").doc("doctor1").set({ name: "Dr. Ana Reyes", areaId: "area1", area: "Manila", active: true });
  await db.collection("doctors").doc("doctor1").collection("deliveryAddresses").doc("clinic1").set({ active: true });
  await db.collection("vaccines").doc(P).set({ vaccineName: "Vaccine P", vaccineType: "T", vatClassification: "vatable" });
  for (const [id, over] of Object.entries(batches)) {
    await db.collection("inventory").doc(id).set({
      vaccineId: P, vaccineName: "Vaccine P", batchId: id.toUpperCase(), status: "Stable",
      expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE, priceIsVatInclusive: true,
      ...over,
    });
  }
}

const create = (inventoryId, quantity, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId: rid(), doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: DELIVERY_DATE,
      items: [{ inventoryId, quantity, expectedUnitPriceCentavos: PRICE }],
      ...over,
    },
  });
// Assignment and dispatch are client writes in the app; their exact shape is
// covered by the rules suite. Here only the resulting status matters.
const setStatus = (orderId, status) =>
  db.collection("orders").doc(orderId).update({ status, assignedRiderId: RIDER });
/**
 * Loading, with the Cargo Loading confirmation as stored: true / false, or
 * "missing" (the field never written — how a created order starts). A true
 * confirmation carries its loading audit, as the client stamps it; "legacy" is
 * a flag set before the audit existed (true, no audit).
 */
const setLoading = (orderId, loaded, extra = {}) =>
  db.collection("orders").doc(orderId).update({
    status: "loading",
    assignedRiderId: RIDER,
    isLoaded: loaded === "missing" ? FieldValue.delete() : loaded === "legacy" ? true : loaded,
    ...(loaded === true ? { loadedAt: FieldValue.serverTimestamp(), loadedByUid: DISPATCHER } : {}),
    ...extra,
  });
/** The audit stamp the client writes on a first confirmation. */
const stamp = () => ({ loadedAt: FieldValue.serverTimestamp(), loadedByUid: DISPATCHER });
/**
 * A Cargo Loading tick or untick, as src/services/cargoLoadingService.js
 * updateOrderLoadedState writes it: only the flag, plus the audit when the
 * order has none yet and is (or was) loaded. An existing audit is never touched
 * (firestore.rules refuses that; the rules suite proves it).
 */
const setLoadedFlag = (orderId, loaded) =>
  db.runTransaction(async (tx) => {
    const ref = db.collection("orders").doc(orderId);
    const o = (await tx.get(ref)).data();
    const needsAudit = !hasLoadingAudit(o) && (loaded || o.isLoaded === true);
    tx.update(ref, { isLoaded: loaded, ...(needsAudit ? stamp() : {}), updatedAt: FieldValue.serverTimestamp() });
  });
/**
 * Finalize Dispatch, as Cargo Loading writes it (src/services/
 * cargoLoadingService.js finalizeRiderDispatch): in one transaction, refuse
 * unless the order is still loading AND confirmed as loaded, then → in_transit
 * (stamping the audit only on a legacy order that has none).
 */
const finalizeDispatch = (orderId) =>
  db.runTransaction(async (tx) => {
    const ref = db.collection("orders").doc(orderId);
    const o = (await tx.get(ref)).data();
    if (o.status !== "loading") throw Object.assign(new Error("not dispatchable"), { code: "order-not-dispatchable" });
    if (o.isLoaded !== true) throw Object.assign(new Error("not loaded"), { code: "order-not-loaded" });
    tx.update(ref, {
      ...(hasLoadingAudit(o) ? {} : stamp()),
      status: "in_transit", dispatchedAt: FieldValue.serverTimestamp(), loadingFinalizedAt: FieldValue.serverTimestamp(),
      startedAt: FieldValue.serverTimestamp(), statusUpdatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      dispatchedByUid: DISPATCHER, statusUpdatedByUid: DISPATCHER,
    });
  });
const cancel = (orderId, uid = DISPATCHER) =>
  ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid, orderId, reason: REASON, now: NOW });
const decide = (returnId, payload) =>
  flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId, ...payload } });

/** on hand / reserved / return-pending / quarantined / written off / available */
async function stock(id) {
  const b = await get("inventory", id);
  const n = (v) => (Number.isInteger(v) ? v : 0);
  return {
    onHand: n(b.quantity), reserved: n(b.reservedQuantity), returnPending: n(b.returnPendingQuantity),
    quarantined: n(b.quarantinedQuantity), writtenOff: n(b.writtenOffQuantity),
    available: n(b.quantity) - n(b.reservedQuantity) - n(b.returnPendingQuantity) - n(b.quarantinedQuantity),
  };
}
const lineOf = async (orderId) => {
  const l = (await order(orderId)).items[0];
  return [l.reservedQuantity, l.backorderedQuantity];
};
const countReturns = async () => (await db.collection("inventoryReturns").get()).size;
const eventsOf = async (orderId) =>
  (await db.collection("inventoryAllocationEvents").where("orderId", "==", orderId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function recordEvidence(orderId) {
  await db.collection("orders").doc(orderId).update({
    proofOfDeliveryUrl: `https://storage/${orderId}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(orderId),
    proofRecipientName: "Maria", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
    invoiceUrl: `https://storage/${orderId}/invoice.jpg`, invoicePath: canonicalInvoicePath(orderId),
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
  });
  await placeRiderAtDestination(db, Timestamp, { uid: RIDER, orderId });
}

/** 10 vials; order X (8, Urgent) dispatched; waiting order Y (4): 2 reserved, 2 backordered. */
async function vehicleScenario(status) {
  await seed({ b1: { quantity: 10 } });
  const x = await create("b1", 8, { priority: "Urgent" });
  const y = await create("b1", 4);
  await setStatus(x.orderId, status);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 10, returnPending: 0, quarantined: 0, writtenOff: 0, available: 0 });
  assert.deepEqual(await lineOf(y.orderId), [2, 2]);
  return { x: x.orderId, y: y.orderId };
}

// ---------------------------------------------------------------- 1. vehicle-held stock

for (const status of ["in_transit", "delayed"]) {
  test(`cancelled while ${status}: the 8 vials go to return-pending — nothing available, nothing reallocated`, async () => {
    const { x, y } = await vehicleScenario(status);
    const result = await cancel(x);
    const returnId = `${x}_cancel`;
    assert.deepEqual(
      [result.status, result.released, result.returnedForCheck, result.returnId, result.reallocated],
      ["cancelled", false, true, returnId, []]
    );

    // Inventory: the 8 are neither available nor reserved; Y keeps exactly what it had.
    assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
    assert.deepEqual(await lineOf(y), [2, 2], "the waiting order received none of the vehicle-held vials");

    // Order: cancelled, out of the queue, nothing reserved or awaited, pointing at its return.
    const o = await order(x);
    assert.equal(o.status, "cancelled");
    assert.equal(o.cancelReason, REASON);
    assert.deepEqual([o.allocationStatus, o.pendingReturnId, o.allocationOpen], ["returned", returnId, false]);
    assert.deepEqual(o.items.map((l) => [l.reservedQuantity, l.backorderedQuantity]), [[0, 0]]);
    assert.equal("failureCount" in o, false, "a cancellation is not counted as a failed delivery");

    // Reservation: settled as returned by the cancellation.
    const r = await reservation(x);
    assert.deepEqual([r.status, r.settlementType, r.returnId, r.settledByUid], ["returned", "cancelled_after_dispatch", returnId, DISPATCHER]);

    // Return: pending, labelled as a cancellation, with the batch and reason.
    const rt = await ret(returnId);
    assert.equal(rt.status, "pending");
    assert.equal(rt.source, "cancelled_after_dispatch");
    assert.equal(rt.cancelReason, REASON);
    assert.equal(rt.failureReason, null);
    assert.equal(rt.reportedByUid, DISPATCHER);
    assert.equal(rt.totalQuantity, 8);
    assert.deepEqual(rt.items, [{ inventoryId: "b1", batchId: "B1", productKey: P, quantity: 8 }]);
    assert.equal(await countReturns(), 1);

    // History: one Return Pending event, by the dispatcher, worded as a cancellation.
    const pending = (await eventsOf(x)).filter((e) => e.eventType === "moved_to_return_pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].actorRole, "dispatcher");
    assert.match(pending[0].summary, /^Cancelled after dispatch: /);
    assert.equal((await eventsOf(x)).some((e) => e.eventType === "reservation_released"), false, "nothing was released");
  });
}

// ---------------------------------------------------------------- 2. pre-dispatch stays a release

for (const status of ["pending_dispatch", "assigned"]) {
  test(`cancelled while ${status}: units never left — released and reallocated as before`, async () => {
    await seed({ b1: { quantity: 10 } });
    const x = await create("b1", 8, { priority: "Urgent" });
    const y = await create("b1", 4);
    if (status !== "pending_dispatch") await setStatus(x.orderId, status);
    const result = await cancel(x.orderId);
    assert.deepEqual([result.released, result.returnedForCheck, result.returnId], [true, false, null]);
    assert.deepEqual(result.reallocated.map((a) => [a.orderId, a.units]), [[y.orderId, 2]]);
    assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 });
    assert.equal((await reservation(x.orderId)).status, "released");
    assert.equal(await countReturns(), 0);
  });
}

// ---------------------------------------------------------------- 2b. Loading: the Cargo Loading confirmation is the custody boundary

/** 10 vials; order X (8, Urgent) loading with [loaded]; waiting order Y (4): 2 reserved, 2 backordered. */
async function loadingScenario(loaded, extra = {}) {
  await seed({ b1: { quantity: 10 } });
  const x = (await create("b1", 8, { priority: "Urgent" })).orderId;
  const y = (await create("b1", 4)).orderId;
  await setLoading(x, loaded, extra);
  const stored = await order(x);
  if (loaded === "missing") assert.equal("isLoaded" in stored, false, "precondition: no flag stored");
  else assert.equal(stored.isLoaded, loaded === "legacy" ? true : loaded, "precondition");
  return { x, y };
}
const HELD = { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 };
const RELEASED = { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 };
/** Cancelled as handled stock: one loading return, nothing reallocated, Y untouched. */
async function assertHeldAsReturn(x, y, result) {
  assert.deepEqual([result.released, result.returnedForCheck, result.returnId, result.reallocated], [false, true, `${x}_cancel`, []]);
  assert.deepEqual(await stock("b1"), HELD);
  assert.deepEqual(await lineOf(y), [2, 2], "the waiting order received none of the handled vials");
  assert.equal((await reservation(x)).status, "returned");
  assert.equal(await countReturns(), 1);
}
/** Cancelled as never handled: released and reallocated to Y, no return. */
async function assertReleased(x, y, result) {
  assert.deepEqual([result.released, result.returnedForCheck, result.returnId], [true, false, null]);
  assert.deepEqual(result.reallocated.map((a) => [a.orderId, a.units]), [[y, 2]]);
  assert.deepEqual(await stock("b1"), RELEASED);
  assert.equal((await reservation(x)).status, "released");
  assert.equal(await countReturns(), 0);
}

for (const loaded of [false, "missing"]) {
  test(`cancelled while loading with isLoaded ${loaded}: nothing was handled — released and reallocated`, async () => {
    const { x, y } = await loadingScenario(loaded);
    const result = await cancel(x);
    assert.deepEqual([result.released, result.returnedForCheck, result.returnId], [true, false, null]);
    assert.deepEqual(result.reallocated.map((a) => [a.orderId, a.units]), [[y, 2]]);
    assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 });
    assert.deepEqual(await lineOf(y), [4, 0]);
    assert.equal((await reservation(x)).status, "released");
    assert.equal(await countReturns(), 0);
  });
}

test("cancelled while loading with isLoaded true: one cancellation return, nothing available, nothing reallocated", async () => {
  const { x, y } = await loadingScenario(true);
  const result = await cancel(x);
  const returnId = `${x}_cancel`;
  assert.deepEqual(
    [result.released, result.returnedForCheck, result.returnId, result.reallocated],
    [false, true, returnId, []]
  );
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
  assert.deepEqual(await lineOf(y), [2, 2], "the waiting order received none of the loaded vials");
  const o = await order(x);
  assert.deepEqual([o.status, o.allocationStatus, o.pendingReturnId, o.allocationOpen], ["cancelled", "returned", returnId, false]);
  const r = await reservation(x);
  assert.deepEqual([r.status, r.settlementType, r.returnId], ["returned", "cancelled_after_dispatch", returnId]);
  const rt = await ret(returnId);
  assert.deepEqual(
    [rt.status, rt.source, rt.cancelledFromStatus, rt.cancelReason, rt.totalQuantity],
    ["pending", "cancelled_after_dispatch", "loading", REASON, 8]
  );
  assert.equal(await countReturns(), 1);
  const pending = (await eventsOf(x)).filter((e) => e.eventType === "moved_to_return_pending");
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /^Cancelled after loading: /);
  assert.equal(pending[0].cancelledFromStatus, "loading");
});

test("a loaded order's return: usable vials only become available — and reach the waiting order — after the Admin decides", async () => {
  const { x, y } = await loadingScenario(true);
  await cancel(x);
  assert.deepEqual(await lineOf(y), [2, 2]);
  const d = await decide(`${x}_cancel`, { disposition: "usable" });
  assert.deepEqual(d.reallocated.map((a) => [a.orderId, a.units]), [[y, 2]]);
  assert.deepEqual(await lineOf(y), [4, 0]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 });
});

test("a loaded order's damaged, temperature-excursion and missing vials never become available", async () => {
  for (const [disposition, expected] of [
    ["damaged", { onHand: 10, reserved: 2, returnPending: 0, quarantined: 8, writtenOff: 0, available: 0 }],
    ["temperature_excursion", { onHand: 10, reserved: 2, returnPending: 0, quarantined: 8, writtenOff: 0, available: 0 }],
    ["missing", { onHand: 2, reserved: 2, returnPending: 0, quarantined: 0, writtenOff: 8, available: 0 }],
  ]) {
    const { x, y } = await loadingScenario(true);
    await cancel(x);
    const r = await decide(`${x}_cancel`, { disposition });
    assert.deepEqual(r.reallocated, [], disposition);
    assert.deepEqual(await stock("b1"), expected, disposition);
    assert.deepEqual(await lineOf(y), [2, 2], `${disposition}: Y still waits`);
  }
  // Mixed, in one decision: 5 usable, 1 damaged, 1 temperature excursion, 1 missing.
  const { x, y } = await loadingScenario(true);
  await cancel(x);
  const r = await decide(`${x}_cancel`, { lines: [{ inventoryId: "b1", usable: 5, damaged: 1, temperature_excursion: 1, missing: 1 }] });
  assert.deepEqual(r.reallocated.map((a) => [a.orderId, a.units]), [[y, 2]]);
  assert.deepEqual(await stock("b1"), { onHand: 9, reserved: 4, returnPending: 0, quarantined: 2, writtenOff: 1, available: 3 });
});

test("a loaded order cancelled twice, or twice at once, has exactly one return", async () => {
  const a = await loadingScenario(true);
  await cancel(a.x);
  const after = await stock("b1");
  assert.equal((await cancel(a.x)).replayed, true);
  assert.deepEqual(await stock("b1"), after);
  assert.equal(await countReturns(), 1);

  const b = await loadingScenario(true);
  const outcomes = await Promise.allSettled([cancel(b.x), cancel(b.x)]);
  assert.ok(outcomes.every((o) => o.status === "fulfilled"));
  assert.equal(outcomes.filter((o) => o.value.replayed !== true).length, 1);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
  assert.equal(await countReturns(), 1);
});

test("cancellation racing Finalize Dispatch settles the reservation exactly once", async () => {
  const { x, y } = await loadingScenario(true);
  const [c, f] = await Promise.allSettled([cancel(x), finalizeDispatch(x)]);
  assert.equal(c.status, "fulfilled", "the cancel always lands: from loading (loaded) or, if Finalize won, from in transit");
  const o = await order(x);
  assert.equal(o.status, "cancelled");
  // Either order of commits ends the same way: loaded or dispatched, the
  // vials were handled — one return, nothing available, Y untouched.
  assert.equal((await reservation(x)).status, "returned");
  assert.equal(await countReturns(), 1);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
  assert.deepEqual(await lineOf(y), [2, 2]);
  const rt = await ret(`${x}_cancel`);
  if (f.status === "fulfilled") assert.equal(rt.cancelledFromStatus, "in_transit", "Finalize committed first");
  else assert.equal(rt.cancelledFromStatus, "loading", "the cancel committed first; Finalize then refused");
  // A retry of either changes nothing.
  await codeOf(finalizeDispatch(x));
  await cancel(x);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
  assert.equal(await countReturns(), 1);
});

test("the caller cannot choose the outcome: a loaded value in the request is ignored", async () => {
  // Unloaded order, caller claims it is loaded → still released.
  const a = await loadingScenario(false);
  const ra = await ops.cancelOrderWithInventoryRelease({
    db, FieldValue, uid: DISPATCHER, orderId: a.x, reason: REASON, now: NOW,
    isLoaded: true, loaded: true, payload: { isLoaded: true }, data: { isLoaded: true },
  });
  assert.deepEqual([ra.released, ra.returnedForCheck], [true, false]);
  assert.equal(await countReturns(), 0);
  // Loaded order, caller claims it is not → still held for inspection.
  const b = await loadingScenario(true);
  const rb = await ops.cancelOrderWithInventoryRelease({
    db, FieldValue, uid: DISPATCHER, orderId: b.x, reason: REASON, now: NOW,
    isLoaded: false, loaded: false, payload: { isLoaded: false }, data: { isLoaded: false },
  });
  assert.deepEqual([rb.released, rb.returnedForCheck], [false, true]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
});

test("Assigned stays a release even if a loaded flag was stored (only Loading, In Transit and Delayed hold custody)", async () => {
  // The rules let a dispatcher's loading-metadata write set the flag on an
  // assigned order without the promotion; the policy for Assigned is release.
  await seed({ b1: { quantity: 10 } });
  const x = (await create("b1", 8)).orderId;
  await db.collection("orders").doc(x).update({ status: "assigned", assignedRiderId: RIDER, isLoaded: true });
  const r = await cancel(x);
  assert.deepEqual([r.released, r.returnedForCheck], [true, false]);
  assert.equal(await countReturns(), 0);
});

// ---------------------------------------------------------------- 2c. Loading custody history (the audit survives an untick)

test("ticked, unticked, then cancelled: one cancellation return, nothing reallocated, the audit kept", async () => {
  const { x, y } = await loadingScenario(false);
  await setLoadedFlag(x, true);
  const first = await order(x);
  assert.ok(hasLoadingAudit(first), "the first confirmation stamped the audit");
  await setLoadedFlag(x, false);
  const unticked = await order(x);
  assert.equal(unticked.isLoaded, false);
  assert.equal(unticked.loadedAt.toMillis(), first.loadedAt.toMillis(), "the untick kept the audit");
  assert.equal(unticked.loadedByUid, DISPATCHER);

  await assertHeldAsReturn(x, y, await cancel(x));
  const rt = await ret(`${x}_cancel`);
  assert.deepEqual([rt.source, rt.cancelledFromStatus, rt.totalQuantity], ["cancelled_after_dispatch", "loading", 8]);
  const o = await order(x);
  assert.equal(o.loadedAt.toMillis(), first.loadedAt.toMillis(), "the cancellation leaves the custody record");
});

test("isLoaded missing but a complete audit survives: handled", async () => {
  const { x, y } = await loadingScenario("missing", stamp());
  await assertHeldAsReturn(x, y, await cancel(x));
});

test("legacy isLoaded true without an audit: handled", async () => {
  const { x, y } = await loadingScenario("legacy");
  assert.equal(hasLoadingAudit(await order(x)), false, "precondition: no audit");
  await assertHeldAsReturn(x, y, await cancel(x));
});

test("a legacy order unticked before cancelling is stamped, so it is still handled", async () => {
  const { x, y } = await loadingScenario("legacy");
  await setLoadedFlag(x, false);
  const o = await order(x);
  assert.deepEqual([o.isLoaded, hasLoadingAudit(o)], [false, true]);
  await assertHeldAsReturn(x, y, await cancel(x));
});

test("no flag and no complete audit: not handled — released and reallocated", async () => {
  const at = Timestamp.fromDate(new Date("2026-10-04T23:00:00Z"));
  for (const [label, loaded, extra] of [
    ["isLoaded false, nothing else", false, {}],
    ["no flag, nothing else", "missing", {}],
    ["loadedAt without loadedByUid", false, { loadedAt: at }],
    ["loadedByUid without loadedAt", false, { loadedByUid: DISPATCHER }],
    ["a cleared audit (old untick)", false, { loadedAt: null, loadedByUid: null, loadedByEmail: null }],
    ["loadedAt not a timestamp", false, { loadedAt: "2026-10-04", loadedByUid: DISPATCHER }],
    ["blank loadedByUid", "missing", { loadedAt: at, loadedByUid: "" }],
  ]) {
    const { x, y } = await loadingScenario(loaded, extra);
    try {
      await assertReleased(x, y, await cancel(x));
    } catch (e) {
      e.message = `${label}: ${e.message}`;
      throw e;
    }
  }
});

test("custody fields in the request have no effect: the stored order decides", async () => {
  const deny = {
    isLoaded: false, loaded: false, loadedAt: null, loadedByUid: null, handled: false,
    payload: { isLoaded: false, loadedAt: null, loadedByUid: null }, data: { isLoaded: false, loadedAt: null },
  };
  // Ever loaded (unticked, audit kept) — the caller says it never was.
  const a = await loadingScenario(false);
  await setLoadedFlag(a.x, true);
  await setLoadedFlag(a.x, false);
  await assertHeldAsReturn(a.x, a.y, await ops.cancelOrderWithInventoryRelease({
    db, FieldValue, uid: DISPATCHER, orderId: a.x, reason: REASON, now: NOW, ...deny,
  }));
  // Never loaded — the caller claims an audit.
  const b = await loadingScenario(false);
  const claim = {
    isLoaded: true, loaded: true, loadedAt: Timestamp.now(), loadedByUid: DISPATCHER, handled: true,
    payload: { isLoaded: true, loadedAt: Timestamp.now(), loadedByUid: DISPATCHER },
    data: { isLoaded: true, loadedByUid: DISPATCHER },
  };
  await assertReleased(b.x, b.y, await ops.cancelOrderWithInventoryRelease({
    db, FieldValue, uid: DISPATCHER, orderId: b.x, reason: REASON, now: NOW, ...claim,
  }));
  const o = await order(b.x);
  assert.equal("loadedAt" in o || "loadedByUid" in o, false, "nothing from the request was stored");
});

test("an unticked, ever-loaded order cancelled twice, or several times at once, has exactly one return", async () => {
  const a = await loadingScenario(false);
  await setLoadedFlag(a.x, true);
  await setLoadedFlag(a.x, false);
  await cancel(a.x);
  assert.equal((await cancel(a.x)).replayed, true);
  assert.deepEqual(await stock("b1"), HELD);
  assert.equal(await countReturns(), 1);

  const b = await loadingScenario(false);
  await setLoadedFlag(b.x, true);
  await setLoadedFlag(b.x, false);
  const outcomes = await Promise.allSettled([cancel(b.x), cancel(b.x), cancel(b.x)]);
  assert.ok(outcomes.every((o) => o.status === "fulfilled"));
  assert.equal(outcomes.filter((o) => o.value.replayed !== true).length, 1);
  assert.deepEqual(await stock("b1"), HELD);
  assert.equal(await countReturns(), 1);
});

test("cancellation racing an untick: always one return — the custody record outlives the flag", async () => {
  const { x, y } = await loadingScenario(false);
  await setLoadedFlag(x, true);
  const [c] = await Promise.allSettled([cancel(x), setLoadedFlag(x, false)]);
  assert.equal(c.status, "fulfilled");
  assert.equal((await order(x)).status, "cancelled");
  assert.deepEqual(await stock("b1"), HELD);
  assert.deepEqual(await lineOf(y), [2, 2]);
  assert.equal(await countReturns(), 1);
});

test("a re-ticked order (tick, untick, tick) finalizes with its original audit; a racing cancel settles once", async () => {
  const a = await loadingScenario(false);
  await setLoadedFlag(a.x, true);
  const firstAt = (await order(a.x)).loadedAt.toMillis();
  await setLoadedFlag(a.x, false);
  assert.equal(await codeOf(finalizeDispatch(a.x)), "order-not-loaded", "unticked: not dispatchable");
  await setLoadedFlag(a.x, true);
  await finalizeDispatch(a.x);
  const dispatched = await order(a.x);
  assert.deepEqual([dispatched.status, dispatched.loadedAt.toMillis(), dispatched.loadedByUid], ["in_transit", firstAt, DISPATCHER]);

  const b = await loadingScenario(false);
  await setLoadedFlag(b.x, true);
  await setLoadedFlag(b.x, false);
  await setLoadedFlag(b.x, true);
  const [c, f] = await Promise.allSettled([cancel(b.x), finalizeDispatch(b.x)]);
  assert.equal(c.status, "fulfilled");
  assert.equal((await order(b.x)).status, "cancelled");
  assert.equal((await reservation(b.x)).status, "returned");
  assert.deepEqual(await stock("b1"), HELD);
  assert.equal(await countReturns(), 1);
  const rt = await ret(`${b.x}_cancel`);
  assert.equal(rt.cancelledFromStatus, f.status === "fulfilled" ? "in_transit" : "loading");
});

test("a legacy loaded order is stamped as Finalize dispatches it", async () => {
  const { x } = await loadingScenario("legacy");
  await finalizeDispatch(x);
  const o = await order(x);
  assert.deepEqual([o.status, o.isLoaded, hasLoadingAudit(o), o.loadedByUid], ["in_transit", true, true, DISPATCHER]);
});

test("requeueing a failed order starts a new custody epoch: the old audit is cleared", async () => {
  const { x } = await loadingScenario(false);
  await setLoadedFlag(x, true);
  await finalizeDispatch(x);
  const failed = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: x, reason: "Clinic closed" } });
  await decide(failed.returnId, { disposition: "usable" });
  await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: x } });
  const o = await order(x);
  assert.equal(o.status, "pending_dispatch");
  assert.deepEqual([o.isLoaded, "loadedAt" in o, "loadedByUid" in o, "loadedByEmail" in o], [false, false, false, false]);
  // Reassigned and back in Loading with no new confirmation: cancelling releases.
  await setLoading(x, false);
  const before = await countReturns();
  const r = await cancel(x);
  assert.deepEqual([r.released, r.returnedForCheck], [true, false]);
  assert.equal(await countReturns(), before, "no new return");
});

// ---------------------------------------------------------------- 3. duplicates

test("a repeated cancellation is a replay: one return, stock moved once", async () => {
  const { x } = await vehicleScenario("in_transit");
  await cancel(x);
  const after = await stock("b1");
  const again = await cancel(x);
  assert.equal(again.replayed, true);
  assert.deepEqual(await stock("b1"), after);
  assert.equal(await countReturns(), 1);
});

test("two cancellations at the same moment: exactly one settles; one return", async () => {
  const { x } = await vehicleScenario("delayed");
  const outcomes = await Promise.allSettled([cancel(x), cancel(x)]);
  assert.ok(outcomes.every((o) => o.status === "fulfilled"), "the loser replays");
  assert.equal(outcomes.filter((o) => o.value.replayed !== true).length, 1);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
  assert.equal(await countReturns(), 1);
});

// ---------------------------------------------------------------- 4. races with the rider

test("cancellation racing completion: exactly one wins and stock is settled exactly once", async () => {
  const { x } = await vehicleScenario("in_transit");
  await recordEvidence(x);
  const [c, d] = await Promise.allSettled([
    cancel(x),
    ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: x }),
  ]);
  assert.equal([c, d].filter((o) => o.status === "fulfilled").length, 1, "one wins, one is refused");
  const o = await order(x);
  const r = await reservation(x);
  if (o.status === "delivered") {
    assert.equal(c.status, "rejected");
    assert.equal(r.status, "consumed");
    assert.deepEqual(await stock("b1"), { onHand: 2, reserved: 2, returnPending: 0, quarantined: 0, writtenOff: 0, available: 0 });
    assert.equal(await countReturns(), 0);
  } else {
    assert.equal(o.status, "cancelled");
    assert.equal(d.status, "rejected");
    assert.equal(r.status, "returned");
    assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
    assert.equal(await countReturns(), 1);
  }
  // Whichever lost, its retry changes nothing.
  const before = await stock("b1");
  await codeOf(cancel(x));
  await codeOf(ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: x }));
  assert.deepEqual(await stock("b1"), before);
});

test("completion after a cancellation is refused; cancellation after a completion is refused", async () => {
  const a = await vehicleScenario("in_transit");
  await recordEvidence(a.x);
  await cancel(a.x);
  assert.notEqual(await codeOf(ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: a.x })), null);
  assert.equal((await reservation(a.x)).status, "returned");

  const b = await vehicleScenario("in_transit");
  await recordEvidence(b.x);
  await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: b.x });
  assert.equal(await codeOf(cancel(b.x)), "invalid-status-transition");
  assert.equal(await countReturns(), 0);
});

test("cancellation racing the rider's failure report: one return, never two", async () => {
  const { x } = await vehicleScenario("in_transit");
  await Promise.allSettled([
    cancel(x),
    flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: x, reason: "Clinic closed" } }),
  ]);
  // Failure first → the later cancel moves no stock; cancel first → the report is refused.
  assert.equal(await countReturns(), 1);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 2, returnPending: 8, quarantined: 0, writtenOff: 0, available: 0 });
});

// ---------------------------------------------------------------- 5. Admin finishes the return

test("Admin finishes a cancelled order's return: usable vials become available and only then reach the waiting order", async () => {
  const { x, y } = await vehicleScenario("in_transit");
  await cancel(x);
  const returnId = `${x}_cancel`;
  const pendingList = await db.collection("inventoryReturns").where("status", "==", "pending").orderBy("reportedAt", "asc").get();
  assert.deepEqual(pendingList.docs.map((d) => d.id), [returnId], "listed for the Admin like any return");

  const decided = await decide(returnId, { disposition: "usable", notes: "Cooler sealed, logger in range" });
  assert.equal(decided.disposition, "usable");
  assert.deepEqual(decided.reallocated.map((a) => [a.orderId, a.units]), [[y, 2]], "only now does Y get stock");
  assert.deepEqual(await lineOf(y), [4, 0]);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 });

  const rt = await ret(returnId);
  assert.deepEqual([rt.status, rt.disposition, rt.resolvedByUid], ["resolved", "usable", ADMIN]);
  assert.deepEqual(rt.dispositionLines.map((l) => [l.inventoryId, l.usable, l.damaged, l.temperature_excursion, l.missing]), [["b1", 8, 0, 0, 0]]);
  const o = await order(x);
  assert.deepEqual([o.status, o.returnDisposition], ["cancelled", "usable"], "the order stays cancelled");
  // Repeating the same decision replays; a different one is refused.
  assert.equal((await decide(returnId, { disposition: "usable" })).replayed, true);
  assert.equal(await codeOf(decide(returnId, { disposition: "damaged" })), "return-already-resolved");
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, writtenOff: 0, available: 6 });
});

test("damaged or missing vials never become available or reach a waiting order", async () => {
  for (const [disposition, expected] of [
    ["damaged", { onHand: 10, reserved: 2, returnPending: 0, quarantined: 8, writtenOff: 0, available: 0 }],
    ["temperature_excursion", { onHand: 10, reserved: 2, returnPending: 0, quarantined: 8, writtenOff: 0, available: 0 }],
    ["missing", { onHand: 2, reserved: 2, returnPending: 0, quarantined: 0, writtenOff: 8, available: 0 }],
  ]) {
    const { x, y } = await vehicleScenario("delayed");
    await cancel(x);
    const r = await decide(`${x}_cancel`, { disposition });
    assert.deepEqual(r.reallocated, [], disposition);
    assert.deepEqual(await stock("b1"), expected, disposition);
    assert.deepEqual(await lineOf(y), [2, 2], `${disposition}: Y still waits`);
  }
});

// ---------------------------------------------------------------- 6. partial (per-batch) disposition

test("a split decision across two batches: only the usable quantity becomes available and is reallocated", async () => {
  // FEFO: an order of 8 takes 5 from the earlier batch and 3 from the later one.
  await seed({ early: { quantity: 5, expiryDate: "2027-01-31" }, later: { quantity: 6, expiryDate: "2027-09-30" } });
  const x = (await create("later", 8, { priority: "Urgent" })).orderId;
  const z = (await create("later", 5)).orderId; // waits: 3 reserved, 2 backordered
  assert.deepEqual((await reservation(x)).items.map((s) => [s.inventoryId, s.quantity]), [["early", 5], ["later", 3]]);
  assert.deepEqual(await lineOf(z), [3, 2]);
  await setStatus(x, "in_transit");
  await cancel(x);
  const returnId = `${x}_cancel`;
  assert.deepEqual((await ret(returnId)).items.map((i) => [i.inventoryId, i.quantity]), [["early", 5], ["later", 3]]);
  assert.deepEqual(await lineOf(z), [3, 2], "nothing reallocated at cancellation");

  const lines = [
    { inventoryId: "early", usable: 3, damaged: 2 },
    { inventoryId: "later", temperature_excursion: 1, missing: 2 },
  ];
  const decided = await decide(returnId, { lines, notes: "Two vials cracked; one over temperature; two not returned" });
  assert.equal(decided.disposition, "split");
  // early: 5 on hand; 3 usable back, 2 quarantined. later: 2 written off, 1 quarantined.
  assert.deepEqual(await stock("early"), { onHand: 5, reserved: 2, returnPending: 0, quarantined: 2, writtenOff: 0, available: 1 });
  assert.deepEqual(await stock("later"), { onHand: 4, reserved: 3, returnPending: 0, quarantined: 1, writtenOff: 2, available: 0 });
  assert.deepEqual(decided.reallocated.map((a) => [a.orderId, a.units]), [[z, 2]], "Z gets 2 of the 3 usable vials");
  assert.deepEqual(await lineOf(z), [5, 0]);

  const rt = await ret(returnId);
  assert.deepEqual([rt.status, rt.disposition], ["resolved", "split"]);
  assert.deepEqual(
    rt.dispositionLines.map((l) => [l.inventoryId, l.usable, l.damaged, l.temperature_excursion, l.missing]),
    [["early", 3, 2, 0, 0], ["later", 0, 0, 1, 2]]
  );
  // One history event per outcome, each with only its own quantities.
  const outcomeEvents = (await eventsOf(x)).filter((e) => e.sourceOperation === "confirmReturnDisposition");
  assert.deepEqual(
    outcomeEvents.map((e) => [e.eventType, e.quantityChanged]).sort(),
    [["return_quarantined", 2], ["return_quarantined", 1], ["return_restored", 3], ["return_written_off", 2]].sort()
  );

  // The same split again (order of keys or lines aside) replays; a different split is refused.
  const replay = await decide(returnId, { lines: [{ missing: 2, temperature_excursion: 1, inventoryId: "later" }, { damaged: 2, usable: 3, inventoryId: "early" }] });
  assert.equal(replay.replayed, true);
  assert.equal(await codeOf(decide(returnId, { lines: [{ inventoryId: "early", usable: 5 }, { inventoryId: "later", usable: 3 }] })), "return-already-resolved");
  assert.deepEqual(await stock("early"), { onHand: 5, reserved: 2, returnPending: 0, quarantined: 2, writtenOff: 0, available: 1 });
});

test("two identical Admin decisions at the same moment apply once", async () => {
  const { x } = await vehicleScenario("in_transit");
  await cancel(x);
  const lines = [{ inventoryId: "b1", usable: 6, damaged: 2 }];
  // Each call is timed and a rejection keeps its error, so a failure names the
  // call that was refused and why (a full emulator run once failed here with
  // only "falsy value").
  const timed = async (call) => {
    const started = Date.now();
    try {
      return { call, status: "fulfilled", value: await decide(`${x}_cancel`, { lines }), ms: Date.now() - started };
    } catch (e) {
      return { call, status: "rejected", reason: e, ms: Date.now() - started };
    }
  };
  const outcomes = await Promise.all([timed(1), timed(2)]);
  const rejected = outcomes
    .filter((o) => o.status === "rejected")
    .map((o) => ({ call: o.call, ms: o.ms, error: o.reason?.constructor?.name, code: o.reason?.code, message: o.reason?.message }));
  assert.deepEqual(rejected, [], `every concurrent decision succeeds (one applies, one replays); calls took ${outcomes.map((o) => `#${o.call} ${o.ms} ms`).join(", ")}`);
  assert.equal(outcomes.filter((o) => o.value.replayed !== true).length, 1);
  assert.deepEqual(await stock("b1"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 2, writtenOff: 0, available: 4 });
});

test("an invalid split changes nothing", async () => {
  const { x } = await vehicleScenario("in_transit");
  await cancel(x);
  const id = `${x}_cancel`;
  const before = await stock("b1");
  for (const payload of [
    { lines: [{ inventoryId: "b1", usable: 5 }] },                              // does not add up to 8
    { lines: [{ inventoryId: "b1", usable: 9, missing: -1 }] },                 // negative
    { lines: [{ inventoryId: "b1", usable: 7.5, damaged: 0.5 }] },              // not whole vials
    { lines: [{ inventoryId: "other", usable: 8 }] },                           // not this return's batch
    { lines: [{ inventoryId: "b1", usable: 8 }, { inventoryId: "b1", usable: 0 }] }, // batch twice
    { lines: [{ inventoryId: "b1", usable: 4, sold: 4 }] },                     // unknown outcome
  ]) {
    assert.equal(await codeOf(decide(id, payload)), "invalid-disposition-lines", JSON.stringify(payload));
  }
  assert.equal(await codeOf(decide(id, { disposition: "usable", lines: [{ inventoryId: "b1", usable: 8 }] })), "invalid-disposition");
  assert.deepEqual(await stock("b1"), before);
  assert.equal((await ret(id)).status, "pending");
});

test("only an Admin decides a return; a failed delivery's return still works as before", async () => {
  const { x } = await vehicleScenario("in_transit");
  await cancel(x);
  assert.equal(await codeOf(flow.confirmReturnDisposition({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { returnId: `${x}_cancel`, disposition: "usable" } })), "wrong-role");

  // Unchanged failure path: same machinery, its own id and source.
  const f = await vehicleScenario("in_transit");
  const r = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: f.x, reason: "Clinic closed" } });
  const fr = await ret(r.returnId);
  assert.deepEqual([r.returnId, fr.source, fr.failureReason, "cancelReason" in fr], [`${f.x}_1`, "delivery_failed", "Clinic closed", false]);
  assert.equal((await order(f.x)).failureCount, 1);
  const d = await decide(r.returnId, { disposition: "usable" });
  assert.deepEqual(d.reallocated.map((a) => [a.orderId, a.units]), [[f.y, 2]]);
});
