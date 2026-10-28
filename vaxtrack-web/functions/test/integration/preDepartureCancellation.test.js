"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
  throw new Error("Cancellation tests require an isolated loopback Firestore emulator.");
}
const app = admin.initializeApp({ projectId: "demo-vaxtrack-pre-cancel" }, "pre-cancel");
const db = app.firestore();
const { FieldValue } = admin.firestore;
const ops = require("../../src/operations");
const trips = require("../../src/riderDispatchOps");
const D = require("../../src/riderDispatch");
const custody = require("../../src/preDepartureCancellation.json");
const DAY = "2030-01-02";
const NOW = new Date(`${DAY}T02:00:00Z`);
const ref = (collection, id) => db.collection(collection).doc(id);
const get = async (collection, id) => (await ref(collection, id).get()).data();
const codeOf = async (promise) => { try { await promise; return null; } catch (e) { return e.code; } };
let sequence = 0;

async function seed(stock = 6) {
  for (const c of ["users", "vaccines", "inventory", "doctors", "clinics", "areas", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "orderReceipts", "orderHistoryOutbox", "inventoryAllocationEvents",
    "allocationContinuations", D.RIDER_TRIPS, D.RIDER_DISPATCH_STATES]) await db.recursiveDelete(db.collection(c));
  for (const [uid, role, status = "approved"] of [
    ["admin", "admin"], ["rep", "salesrep"], ["other", "salesrep"], ["disp", "dispatcher"], ["rider", "rider"],
    ["pending", "salesrep", "pending"], ["disabled", "admin", "disabled"], ["pending-admin", "admin", "pending"],
    ["disabled-rep", "salesrep", "disabled"],
  ]) await ref("users", uid).set({ role, status, assignedAreaIds: ["area"], assignedClinicIds: ["clinic"] });
  await ref("areas", "area").set({ name: "Manila", active: true });
  await ref("clinics", "clinic").set({ name: "Clinic", location: "Manila", areaId: "area", area: "Manila",
    status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98 });
  await ref("doctors", "doctor").set({ name: "Dr. Test", active: true, areaId: "area" });
  await ref("doctors", "doctor").collection("deliveryAddresses").doc("clinic").set({ active: true });
  for (const [id, quantity] of [["a", stock], ["b", 0]]) {
    await ref("vaccines", id).set({ vaccineName: `Vaccine ${id}`, vaccineType: "T", vatClassification: "vatable" });
    await ref("inventory", id).set({ vaccineId: id, vaccineName: `Vaccine ${id}`, batchId: id.toUpperCase(), quantity,
      reservedQuantity: 0, expiryDate: "2031-06-30", status: "Stable", sellingPriceCentavos: 125000, priceIsVatInclusive: true });
  }
}
const create = async (lines = [["a", 4]], extra = {}) => (await ops.createOrderWithReservation({
  db, FieldValue, uid: "rep", now: NOW, payload: {
    requestId: `cancel${++sequence}${"x".repeat(24)}`, doctorId: "doctor", doctorAddressId: "clinic",
    requestedDeliveryDate: DAY, items: lines.map(([inventoryId, quantity]) => ({ inventoryId, quantity, expectedUnitPriceCentavos: 125000 })), ...extra,
  },
})).orderId;
const cancel = (orderId, uid = "admin", reason = "Doctor agreed to receive available items first") =>
  ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid, email: `${uid}@example.test`, orderId, reason, now: NOW });
const assign = (orderId) => trips.assignRiderToOrder({ db, FieldValue, uid: "disp", payload: { orderId, riderUid: "rider" }, now: NOW });
const reconcile = () => trips.reconcileRider({ db, FieldValue, riderUid: "rider" });
const finalize = (orderIds, tripId) => trips.finalizeRiderDispatch({ db, FieldValue, uid: "disp", payload: { riderUid: "rider", orderIds, tripId }, now: NOW });
// Same transaction boundary/audit as Cargo Loading: cancelled cannot be loaded.
const load = (orderId) => db.runTransaction(async (tx) => {
  const orderRef = ref("orders", orderId);
  const order = (await tx.get(orderRef)).data();
  if (!["assigned", "loading"].includes(order.status)) throw Object.assign(new Error("Order moved"), { code: "invalid-status-transition" });
  tx.update(orderRef, { status: "loading", isLoaded: true, loadedAt: FieldValue.serverTimestamp(), loadedByUid: "disp" });
});
const history = async (id) => (await db.collection("inventoryAllocationEvents").where("orderId", "==", id).get()).docs.map((d) => d.data());

test("Admin and owning Med Rep cancel partial/backordered orders with exact provenance and caller attribution", async () => {
  for (const uid of ["admin", "rep"]) {
    await seed();
    const id = await create([["a", 4], ["b", 3]]);
    const original = await get("orders", id);
    const reservation = await get("inventoryReservations", id);
    const receipt = await get("orderReceipts", id);
    assert.equal(original.createdByUid, "rep");
    assert.equal(original.allocationState, "partially_reserved");
    assert.equal(await codeOf(assign(id)), "order-not-fully-reserved", "the original order cannot partially dispatch");
    const result = await cancel(id, uid);
    assert.equal(result.replayed, false);
    const order = await get("orders", id);
    assert.equal(order.status, "cancelled");
    assert.equal(order.cancelledByUid, uid);
    assert.equal(order.cancelledByRole, uid === "rep" ? "salesrep" : "admin");
    assert.equal(order.statusUpdatedByEmail, `${uid}@example.test`);
    assert.equal(order.allocationOpen, false);
    assert.equal((await get("inventory", "a")).reservedQuantity, 0);
    assert.equal((await get("inventory", "a")).quantity, 6);
    const settled = await get("inventoryReservations", id);
    assert.equal(settled.status, "released");
    assert.deepEqual(settled.items, reservation.items);
    assert.deepEqual(await get("orderReceipts", id), receipt);
    for (const key of ["finalTotalCentavos", "vatSummary", "requestedArrival", "requestedDeliveryDate", "allocationPriorityKey"])
      assert.deepEqual(order[key], original[key], key);
    // Use the existing history collection contract, not a new ledger.
    const release = (await history(id)).find((e) => e.sourceOperation === "cancelOrderWithInventoryRelease");
    assert.ok(release, "release history exists");
    assert.equal(release.actorUid, uid);
    assert.equal(release.actorRole, uid === "rep" ? "salesrep" : "admin");
    assert.equal(release.releasedQuantity, 4);
    assert.equal(release.backorderWithdrawnQuantity, 3);
    assert.equal((await db.collection("inventoryReturns").get()).size, 0);
  }
});

test("authorization is checked before settlement and replay; reason is required and bounded", async () => {
  await seed();
  const id = await create();
  for (const [uid, code] of [["other", "not-order-owner"], ["rider", "wrong-role"], ["pending", "not-approved"],
    ["disabled", "not-approved"], ["pending-admin", "not-approved"], ["disabled-rep", "not-approved"],
    ["ghost", "profile-missing"], [null, "unauthenticated"]]) assert.equal(await codeOf(cancel(id, uid)), code, String(uid));
  for (const [reason, code] of [["  ", "reason-required"], ["x".repeat(501), "reason-too-long"]])
    assert.equal(await codeOf(cancel(id, "admin", reason)), code);
  assert.equal((await get("inventory", "a")).reservedQuantity, 4);
  await cancel(id, "rep");
  assert.equal(await codeOf(cancel(id, "other")), "not-order-owner");
  await ref("users", "rep").update({ status: "disabled" });
  assert.equal(await codeOf(cancel(id, "rep")), "not-approved");
  assert.equal((await cancel(id, "admin")).replayed, true);
});

test("assigned and explicitly unloaded Loading orders cancel; ambiguous or departed trips do not", async () => {
  for (const status of ["assigned", "loading"]) {
    await seed();
    const id = await create();
    await assign(id);
    if (status === "loading") await ref("orders", id).update({ status, isLoaded: false });
    assert.equal((await cancel(id, "rep")).status, "cancelled");
    await reconcile();
    assert.equal((await get(D.RIDER_DISPATCH_STATES, "rider")).state, D.STATE.AVAILABLE);
  }
  for (const broken of ["missing", "departed", "unknown"]) {
    await seed(); const id = await create(); const { tripId } = await assign(id);
    if (broken === "missing") await ref(D.RIDER_TRIPS, tripId).delete();
    else await ref(D.RIDER_TRIPS, tripId).update({ status: broken === "departed" ? "on_trip" : "unknown" });
    assert.equal(await codeOf(cancel(id)), "cancellation-not-eligible");
    assert.equal((await get("inventory", "a")).reservedQuantity, 4);
  }
});

test("new permissions fail closed on custody, malformed/legacy data and all later lifecycle states", async () => {
  await seed(1000);
  const cases = [
    ...["in_transit", "delayed", "delivered", "delivery_failed", "unknown"].map((status) => ({ status })),
    { allocationVersion: FieldValue.delete() }, { allocationVersion: 99 }, { allocationStatus: "returned" },
    { status: "loading" }, { isLoaded: true }, { isLoaded: null }, { isLoaded: "false" }, { failureCount: 1 },
    ...custody.custodyFields.map((key) => ({ [key]: key.endsWith("At") ? NOW : "recorded" })),
  ];
  for (const patch of cases) {
    const id = await create(); await ref("orders", id).update(patch);
    for (const uid of ["admin", "rep"]) assert.equal(await codeOf(cancel(id, uid)), "cancellation-not-eligible", JSON.stringify(patch));
    assert.equal((await get("inventoryReservations", id)).status, "reserved");
  }
  const id = await create();
  await assign(id); await load(id);
  await ref("orders", id).update({ isLoaded: false });
  assert.equal(await codeOf(cancel(id)), "cancellation-not-eligible", "untick retains audit");
});

test("simultaneous Admin/Med Rep cancels release and record history exactly once", async () => {
  await seed(); const id = await create();
  const results = await Promise.all([cancel(id), cancel(id, "rep"), cancel(id)]);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal((await get("inventory", "a")).reservedQuantity, 0);
  const entries = await history(id);
  assert.equal(entries.filter((e) => e.sourceOperation === "cancelOrderWithInventoryRelease").length, 1);
});

test("released stock follows existing priority, never a replacement-order reservation", async () => {
  await seed(5); const original = await create([["a", 5]]);
  const standard = await create([["a", 3]]);
  const urgent = await create([["a", 4]], { priority: "Urgent" });
  await cancel(original, "rep");
  assert.equal((await get("orders", urgent)).items[0].reservedQuantity, 4);
  assert.equal((await get("orders", standard)).items[0].reservedQuantity, 1);
  assert.equal((await get("inventory", "a")).reservedQuantity, 5);
  assert.equal((await db.collection("orders").get()).size, 3);
  const events = await history(urgent);
  const allocated = events.find((e) => e.sourceOperation === "cancelOrderWithInventoryRelease");
  assert.equal(allocated.triggeredByUid, "rep");
  assert.equal(allocated.triggeredByRole, "salesrep");
});

test("cancellation racing loading confirmation never releases handled stock", async () => {
  for (let round = 0; round < 3; round++) {
    await seed(); const id = await create(); await assign(id);
    const results = await Promise.allSettled([cancel(id, "rep"), load(id)]);
    const order = await get("orders", id);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    if (order.status === "cancelled") {
      assert.equal(order.loadedAt, undefined); assert.equal((await get("inventory", "a")).reservedQuantity, 0);
    } else {
      assert.equal(order.isLoaded, true); assert.equal((await get("inventory", "a")).reservedQuantity, 4);
    }
  }
});

test("loaded cancellation racing real Finalize refuses new permissions; Dispatcher keeps return custody", async () => {
  await seed(); const id = await create(); const { tripId } = await assign(id); await load(id);
  const [c, f] = await Promise.allSettled([cancel(id), finalize([id], tripId)]);
  assert.equal(c.status, "rejected"); assert.equal(c.reason.code, "cancellation-not-eligible");
  assert.equal(f.status, "fulfilled");
  assert.equal((await get("inventory", "a")).reservedQuantity, 4);
  await cancel(id, "disp"); await reconcile();
  assert.equal((await get("inventory", "a")).returnPendingQuantity, 4);
  assert.equal((await get("inventory", "a")).reservedQuantity, 0);
  assert.equal((await get(D.RIDER_DISPATCH_STATES, "rider")).state, D.STATE.RETURNING);
});

test("cancelling one forming-trip member retains the other; active Rider is never freed by cancellation", async () => {
  await seed(10); const one = await create(); const two = await create();
  const { tripId } = await assign(one); await assign(two);
  await cancel(one); await reconcile();
  const state = await get(D.RIDER_DISPATCH_STATES, "rider");
  assert.equal(state.state, D.STATE.FORMING); assert.deepEqual(state.orderIds, [two]);
  await load(two); await finalize([two], tripId);
  assert.equal(await codeOf(cancel(two)), "cancellation-not-eligible");
  assert.equal((await get(D.RIDER_DISPATCH_STATES, "rider")).state, D.STATE.ON_TRIP);
});

test.after(async () => app.delete());
