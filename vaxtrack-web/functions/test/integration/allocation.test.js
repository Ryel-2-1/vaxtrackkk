"use strict";

/**
 * Inventory allocation against a REAL Firestore (emulator): future orders,
 * partial fill from stock additions, priority, concurrency, cancellation
 * reallocation, failure → return-pending → disposition, requeue, delivery
 * consumption, price/VAT immutability and counter reconciliation.
 *
 * Run:  npm run test:emulator   (in functions/)
 * Own project id, so other integration files never see this data.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-allocation" }, "allocation-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const NOW = new Date("2026-10-05T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const AREA = "area1";
const CLINIC = "clinic1";
const DOCTOR = "doctor1";
const P = "vacP"; // the product most cases order
const Q = "vacQ";
const PRICE = 125000;

let seq = 0;
const rid = () => `alloc${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const get = async (col, id) => (await db.collection(col).doc(id).get()).data();
const inv = (id) => get("inventory", id);
const order = (id) => get("orders", id);
const reservation = (id) => get("inventoryReservations", id);

async function wipe() {
  for (const c of ["users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations", "inventoryReturns", "orderRequestKeys"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map(async (d) => {
      const subs = await d.ref.listCollections();
      for (const sub of subs) {
        const s = await sub.get();
        await Promise.all(s.docs.map((x) => x.ref.delete()));
      }
      await d.ref.delete();
    }));
  }
}

/** A world with one doctor/clinic, one rep, and the given batches. */
async function seed(batches = {}) {
  await wipe();
  const territory = { assignedAreaIds: [AREA], assignedClinicIds: [CLINIC] };
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", ...territory });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
  await db.collection("areas").doc(AREA).set({ name: "Manila", active: true });
  await db.collection("clinics").doc(CLINIC).set({
    clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: AREA, area: "Manila",
    status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
  });
  const doctorRef = db.collection("doctors").doc(DOCTOR);
  await doctorRef.set({ name: "Dr. Ana Reyes", areaId: AREA, area: "Manila", active: true });
  await doctorRef.collection("deliveryAddresses").doc(CLINIC).set({ active: true });
  await db.collection("vaccines").doc(P).set({ vaccineName: "Vaccine P", vaccineType: "T", vatClassification: "vatable" });
  await db.collection("vaccines").doc(Q).set({ vaccineName: "Vaccine Q", vaccineType: "T", vatClassification: "vat_exempt" });
  for (const [id, over] of Object.entries(batches)) {
    await db.collection("inventory").doc(id).set({
      vaccineId: P, vaccineName: "Vaccine P", batchId: id.toUpperCase(), status: "Stable",
      expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE,
      ...over,
    });
  }
}

const create = (items, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC,
      requestedDeliveryDate: DELIVERY_DATE,
      items: items.map(([inventoryId, quantity]) => ({ inventoryId, quantity, expectedUnitPriceCentavos: PRICE })),
      ...over,
    },
  });

const addStock = (over = {}) =>
  flow.addStockBatchWithAllocation({
    db, FieldValue, uid: ADMIN, now: NOW,
    payload: {
      vaccineId: P, batchId: `IN-${++seq}`, manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01",
      expiryDate: "2027-06-30", quantity: 1, sellingPriceCentavos: PRICE, ...over,
    },
  });

const lineOf = async (orderId, i = 0) => {
  const l = (await order(orderId)).items[i];
  return [l.reservedQuantity, l.backorderedQuantity];
};

async function sumReservedSlices(inventoryId) {
  const snap = await db.collection("inventoryReservations").where("status", "==", "reserved").get();
  return snap.docs.reduce((s, d) => s + (d.data().items ?? []).filter((x) => x.inventoryId === inventoryId).reduce((a, x) => a + x.quantity, 0), 0);
}

async function toInTransit(orderId) {
  await db.collection("orders").doc(orderId).update({ status: "in_transit", assignedRiderId: RIDER });
}
async function recordEvidence(orderId) {
  await db.collection("orders").doc(orderId).update({
    proofOfDeliveryUrl: `https://storage/${orderId}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(orderId),
    proofRecipientName: "Maria", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
    invoiceUrl: `https://storage/${orderId}/invoice.jpg`, invoicePath: canonicalInvoicePath(orderId),
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
  });
}

// ---------------------------------------------------------------- 1–4

test("1. zero available stock: a future order is accepted, priced, and waits", async () => {
  await seed({ quoteOnly: { quantity: 0 } });
  const r = await create([["quoteOnly", 5]]);
  const o = await order(r.orderId);
  assert.equal(o.status, "pending_dispatch");
  assert.equal(o.allocationState, "awaiting_stock");
  assert.deepEqual(await lineOf(r.orderId), [0, 5]);
  assert.equal(o.subtotalCentavos, 5 * PRICE, "priced from the quoted batch");
  assert.equal(o.items[0].vatClassification, "vatable", "VAT snapshot unchanged");
  assert.equal(r.allocation.allocationState, "awaiting_stock");
});

test("2–4. request 10 with 4 available, +3 then +5 through Add Stock", async () => {
  await seed({ b4: { quantity: 4 } });
  const r = await create([["b4", 10]]);
  assert.deepEqual(await lineOf(r.orderId), [4, 6]);
  assert.equal((await order(r.orderId)).allocationState, "partially_reserved");

  const add3 = await addStock({ quantity: 3 });
  assert.deepEqual([add3.added, add3.allocatedToOrders, add3.leftAvailable], [3, 3, 0]);
  assert.deepEqual(await lineOf(r.orderId), [7, 3]);
  assert.equal(add3.allocations[0].orderId, r.orderId);

  const add5 = await addStock({ quantity: 5 });
  assert.deepEqual([add5.added, add5.allocatedToOrders, add5.leftAvailable], [5, 3, 2]);
  assert.deepEqual(await lineOf(r.orderId), [10, 0]);
  const o = await order(r.orderId);
  assert.equal(o.allocationState, "fully_reserved");
  assert.deepEqual(o.backorderedProductKeys, []);
  assert.equal((await inv(add5.inventoryId)).reservedQuantity, 3);
});

// ---------------------------------------------------------------- 5–7

test("5–7. stock goes to Urgent first, then earliest date, then oldest", async () => {
  await seed({ quote: { quantity: 0 } });
  const standardEarly = await create([["quote", 2]], { requestedDeliveryDate: "2026-10-06" });
  const standardLate = await create([["quote", 2]], { requestedDeliveryDate: "2026-10-20" });
  const urgent = await create([["quote", 2]], { priority: "Urgent", requestedDeliveryDate: "2026-11-30" });
  await addStock({ quantity: 4 });
  assert.deepEqual(await lineOf(urgent.orderId), [2, 0], "urgent first, despite the latest date");
  assert.deepEqual(await lineOf(standardEarly.orderId), [2, 0], "then the earliest date");
  assert.deepEqual(await lineOf(standardLate.orderId), [0, 2]);
});

// ---------------------------------------------------------------- 9–10

test("9–10. multi-line blocked until every line is full; other products still allocate", async () => {
  await seed({ pStock: { quantity: 10 }, qQuote: { vaccineId: Q, quantity: 0 } });
  const multi = await create([["pStock", 3], ["qQuote", 2]], { priority: "Urgent" });
  let o = await order(multi.orderId);
  assert.equal(o.allocationState, "partially_reserved");
  assert.deepEqual(o.backorderedProductKeys, [Q]);
  // A lower-priority order for P still gets P's remaining stock.
  const low = await create([["pStock", 4]]);
  assert.equal((await order(low.orderId)).allocationState, "fully_reserved");
  await addStock({ vaccineId: Q, quantity: 2 });
  o = await order(multi.orderId);
  assert.equal(o.allocationState, "fully_reserved");
});

// ---------------------------------------------------------------- 11

test("11. concurrent orders and stock additions never over-reserve", async () => {
  await seed({ base: { quantity: 10 } });
  const creates = Array.from({ length: 6 }, () => create([["base", 3]]));
  const adds = [addStock({ quantity: 2 }), addStock({ quantity: 3 })];
  const created = await Promise.all(creates);
  await Promise.all(adds);
  // Every round re-reads the counters in its transaction; drain any leftover.
  await flow.addStockBatchWithAllocation({ db, FieldValue, uid: ADMIN, now: NOW, payload: { vaccineId: P, batchId: "DRAIN-0", manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01", expiryDate: "2027-06-30", quantity: 1, sellingPriceCentavos: PRICE } });

  const batches = (await db.collection("inventory").where("vaccineId", "==", P).get()).docs;
  const onHand = batches.reduce((s, d) => s + d.data().quantity, 0);
  const reserved = batches.reduce((s, d) => s + d.data().reservedQuantity, 0);
  assert.ok(reserved <= onHand, `${reserved} reserved of ${onHand}`);
  for (const d of batches) {
    assert.ok(d.data().reservedQuantity <= d.data().quantity, d.id);
    assert.equal(d.data().reservedQuantity, await sumReservedSlices(d.id), `${d.id} reconciles with its slices`);
  }
  let orderReserved = 0;
  for (const c of created) {
    const [res, back] = await lineOf(c.orderId);
    assert.equal(res + back, 3, "requested = reserved + backordered");
    orderReserved += res;
  }
  assert.equal(orderReserved, reserved);
  assert.equal(onHand, 16);
  assert.equal(reserved, 16, "all 16 units are reserved — 18 were requested");
});

// ---------------------------------------------------------------- 12

test("12. cancelling releases and reallocates exactly once", async () => {
  await seed({ ten: { quantity: 10 } });
  const a = await create([["ten", 10]], { priority: "Urgent" });
  const b = await create([["ten", 4]]);
  assert.deepEqual(await lineOf(b.orderId), [0, 4]);
  const first = await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: a.orderId, reason: "Clinic cancelled", now: NOW });
  assert.deepEqual(first.reallocated.map((x) => [x.orderId, x.units]), [[b.orderId, 4]]);
  assert.deepEqual(await lineOf(b.orderId), [4, 0]);
  assert.equal((await inv("ten")).reservedQuantity, 4);
  const again = await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: a.orderId, reason: "Clinic cancelled", now: NOW });
  assert.equal(again.replayed, true);
  assert.equal((await inv("ten")).reservedQuantity, 4, "released once");
  assert.equal((await reservation(a.orderId)).status, "released");
  assert.equal((await order(a.orderId)).allocationOpen, false);
});

// ---------------------------------------------------------------- 13–15, requeue

test("13–15. failure → return-pending; dispositions; requeue", async (t) => {
  await seed({ s: { quantity: 6 } });
  const failed = await create([["s", 4]], { priority: "Urgent" });
  const waiting = await create([["s", 4]]);
  assert.deepEqual(await lineOf(waiting.orderId), [2, 2]);
  await toInTransit(failed.orderId);

  await t.test("13. the rider's failure moves the units to return-pending, not available", async () => {
    const r = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: failed.orderId, reason: "Clinic closed" } });
    assert.equal(r.status, "delivery_failed");
    const b = await inv("s");
    assert.deepEqual([b.quantity, b.reservedQuantity, b.returnPendingQuantity], [6, 2, 4]);
    assert.deepEqual(await lineOf(waiting.orderId), [2, 2], "returned units are NOT reallocated yet");
    const o = await order(failed.orderId);
    assert.equal(o.allocationOpen, false);
    assert.deepEqual(o.backorderedProductKeys, []);
    assert.equal((await reservation(failed.orderId)).status, "returned", "18. no active reservation");
    const ret = await get("inventoryReturns", r.returnId);
    assert.equal(ret.status, "pending");
    assert.deepEqual(ret.items, [{ inventoryId: "s", batchId: "S", productKey: P, quantity: 4 }]);
    assert.equal(ret.reportedByUid, RIDER);
    assert.equal(ret.failureReason, "Clinic closed");
    // 17. replay
    const again = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: failed.orderId, reason: "Clinic closed" } });
    assert.equal(again.replayed, true);
    assert.equal((await inv("s")).returnPendingQuantity, 4);
  });

  await t.test("14. usable return restores the units and the allocator runs", async () => {
    const r = await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: `${failed.orderId}_1`, disposition: "usable", notes: "Seals intact" } });
    assert.deepEqual(r.reallocated.map((x) => [x.orderId, x.units]), [[waiting.orderId, 2]]);
    assert.deepEqual(await lineOf(waiting.orderId), [4, 0]);
    const b = await inv("s");
    assert.deepEqual([b.reservedQuantity, b.returnPendingQuantity], [4, 0]);
    const again = await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: `${failed.orderId}_1`, disposition: "usable" } });
    assert.equal(again.replayed, true);
    assert.equal(await codeOf(flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: `${failed.orderId}_1`, disposition: "damaged" } })), "return-already-resolved");
  });

  await t.test("requeue: the failed order rejoins the queue and is filled when stock exists", async () => {
    const r = await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: failed.orderId } });
    assert.equal(r.status, "pending_dispatch");
    const o = await order(failed.orderId);
    assert.equal(o.assignedRiderId, null);
    assert.equal(o.deliveryFailureReason, "Clinic closed", "the failure record stays");
    assert.equal(o.allocationOpen, true);
    assert.deepEqual(await lineOf(failed.orderId), [2, 2], "the 2 free units go to it");
  });
});

test("15. damaged, temperature-excursion and missing returns are never allocated", async () => {
  for (const [disposition, expect] of [
    ["damaged", { quarantinedQuantity: 3, quantity: 3 }],
    ["temperature_excursion", { quarantinedQuantity: 3, quantity: 3 }],
    ["missing", { quarantinedQuantity: 0, quantity: 0, writtenOffQuantity: 3 }],
  ]) {
    await seed({ s: { quantity: 3 } });
    const f = await create([["s", 3]], { priority: "Urgent" });
    const waiting = await create([["s", 3]]);
    await toInTransit(f.orderId);
    const rep = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: f.orderId, reason: "Broken cold box" } });
    const r = await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: rep.returnId, disposition } });
    assert.deepEqual(r.reallocated, [], disposition);
    const b = await inv("s");
    assert.equal(b.returnPendingQuantity, 0, disposition);
    assert.equal(b.quarantinedQuantity ?? 0, expect.quarantinedQuantity, disposition);
    assert.equal(b.quantity, expect.quantity, disposition);
    if (expect.writtenOffQuantity) assert.equal(b.writtenOffQuantity, expect.writtenOffQuantity);
    assert.deepEqual(await lineOf(waiting.orderId), [0, 3], `${disposition}: nothing allocated`);
    // A later stock trigger/round still cannot reach it.
    await addStock({ quantity: 1 });
    assert.deepEqual(await lineOf(waiting.orderId), [1, 2], `${disposition}: only the new unit`);
  }
});

// ---------------------------------------------------------------- 16–18, 20

test("16–18, 20. delivery consumes exactly the reserved slices once; price and VAT unchanged", async () => {
  await seed({ early: { quantity: 2, expiryDate: "2027-01-31" }, later: { quantity: 5, expiryDate: "2027-09-30" } });
  const r = await create([["later", 4]]);
  const created = await order(r.orderId);
  const res = await reservation(r.orderId);
  assert.deepEqual(res.items.map((s) => [s.inventoryId, s.quantity]), [["early", 2], ["later", 2]], "FEFO split");
  await toInTransit(r.orderId);
  await recordEvidence(r.orderId);
  await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId });
  let early = await inv("early");
  let later = await inv("later");
  assert.deepEqual([early.quantity, early.reservedQuantity, later.quantity, later.reservedQuantity], [0, 0, 3, 0]);
  const again = await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId });
  assert.equal(again.replayed, true);
  early = await inv("early");
  later = await inv("later");
  assert.deepEqual([early.quantity, later.quantity], [0, 3], "consumed once");
  const o = await order(r.orderId);
  assert.equal((await reservation(r.orderId)).status, "consumed", "no active reservation");
  assert.equal(o.allocationOpen, false);
  for (const k of ["subtotalCentavos", "pricingVersion", "priceIsVatInclusive"]) assert.deepEqual(o[k], created[k], k);
  for (const k of ["unitPriceCentavos", "lineTotalCentavos", "vatClassification", "inventoryId"]) assert.deepEqual(o.items[0][k], created.items[0][k], k);
});

test("an order that is not fully reserved cannot be delivered", async () => {
  await seed({ b: { quantity: 1 } });
  const r = await create([["b", 3]]);
  await toInTransit(r.orderId);
  await recordEvidence(r.orderId);
  assert.equal(await codeOf(ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId })), "order-not-fully-reserved");
  assert.equal((await inv("b")).quantity, 1, "nothing consumed");
});

// ---------------------------------------------------------------- 21, 19

test("21. a batch's figures reconcile with the records that explain them", async () => {
  await seed({ s: { quantity: 5 } });
  const a = await create([["s", 2]]);
  const b = await create([["s", 1]], { priority: "Urgent" });
  await toInTransit(b.orderId);
  await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: b.orderId, reason: "Address not found" } });
  const p = await flow.getReservationProvenance({ db, uid: ADMIN, now: NOW, payload: { inventoryId: "s" } });
  assert.equal(p.reconciled, true);
  assert.deepEqual([p.onHand, p.reservedQuantity, p.returnPendingQuantity, p.available], [5, 2, 1, 2]);
  assert.deepEqual(p.reservations.map((r) => [r.orderId, r.reservedQuantity]), [[a.orderId, 2]]);
  assert.deepEqual(p.returns.map((r) => [r.orderId, r.quantity]), [[b.orderId, 1]]);
});

test("19. only the right role reaches each inventory operation", async () => {
  await seed({ s: { quantity: 5, batchId: "SEEDED-1" } });
  const r = await create([["s", 1]]);
  assert.equal(await codeOf(flow.addStockBatchWithAllocation({ db, FieldValue, uid: SR, now: NOW, payload: {} })), "wrong-role");
  assert.equal(await codeOf(flow.addStockBatchWithAllocation({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: {} })), "wrong-role");
  assert.equal(await codeOf(flow.reportDeliveryFailure({ db, FieldValue, uid: DISPATCHER, payload: { orderId: r.orderId, reason: "x x" } })), "wrong-role");
  assert.equal(await codeOf(flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: r.orderId, reason: "Not mine" } })), "not-assigned-rider");
  assert.equal(await codeOf(flow.confirmReturnDisposition({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { returnId: "x", disposition: "usable" } })), "wrong-role");
  assert.equal(await codeOf(flow.requeueFailedOrder({ db, FieldValue, uid: SR, now: NOW, payload: { orderId: r.orderId } })), "wrong-role");
  assert.equal(await codeOf(flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: r.orderId } })), "order-not-failed");
  assert.equal(await codeOf(flow.getReservationProvenance({ db, uid: DISPATCHER, now: NOW, payload: { inventoryId: "s" } })), "wrong-role");
  // Batch ids are normalized (trimmed, upper-cased) before the uniqueness check.
  assert.equal(await codeOf(addStock({ batchId: " seeded-1 " })), "batch-id-exists");
  assert.equal(await codeOf(addStock({ vaccineId: "noSuchVaccine" })), "vaccine-not-found");
});

test.after(async () => {
  await wipe();
  await app.delete();
});
