"use strict";

/**
 * Order Confirmation Receipts + Stock Allocation History against a REAL
 * Firestore (emulator), through the real callables' bodies.
 *
 * Receipt: created once, atomically with the order; a retried checkout never
 * adds a second; nothing later (stock, catalog, price, status) changes it.
 * Ledger: every stock event of an order is recorded exactly once — retries,
 * replays and concurrent allocation runs never duplicate an entry — and the
 * ledger always reconciles with the order's reserved figures.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-history" }, "history-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const allocation = require("../../src/allocation");
const { settleClientReportedFailure } = require("../../src/failureReturn");
const history = require("../../src/orderHistory");
const outbox = require("../../src/orderHistoryOutbox");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const NOW = new Date("2026-10-05T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const SR2 = "rep2";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const AREA = "area1";
const CLINIC = "clinic1";
const DOCTOR = "doctor1";
const P = "vacP";
const PRICE = 125000;

let seq = 0;
const rid = () => `hist${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
const get = async (col, id) => (await db.collection(col).doc(id).get()).data();
const order = (id) => get("orders", id);
const inv = (id) => get("inventory", id);

/** Every ledger entry of one order, in the order they happened. */
async function events(orderId) {
  const snap = await db.collection(history.ALLOCATION_EVENTS).where("orderId", "==", orderId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis() || a.ordinal - b.ordinal);
}
const receiptsFor = async (orderId) =>
  (await db.collection(history.RECEIPTS).where("orderId", "==", orderId).get()).docs;

async function wipe() {
  for (const c of [
    "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "allocationContinuations", history.RECEIPTS, history.ALLOCATION_EVENTS,
    history.OUTBOX,
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

async function seed(batches = {}, vaccine = {}) {
  await wipe();
  // Med Reps order only inside their assigned territory (this branch's rule).
  const territory = { assignedAreaIds: [AREA], assignedClinicIds: [CLINIC] };
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", name: "Rep One", email: "rep1@vaxtrack.test", ...territory });
  await db.collection("users").doc(SR2).set({ role: "salesrep", status: "approved", name: "Rep Two", ...territory });
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
  await db.collection("vaccines").doc(P).set({
    // Every product carries a VAT classification on this branch (VATable by default here).
    vaccineName: "Allocation Test Vaccine", vaccineType: "T", internalSku: "ATV-001", vatClassification: "vatable", ...vaccine,
  });
  for (const [id, over] of Object.entries(batches)) {
    await db.collection("inventory").doc(id).set({
      vaccineId: P, vaccineName: "Allocation Test Vaccine", batchId: id.toUpperCase(), status: "Stable",
      expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE,
      ...over,
    });
  }
}

const payloadFor = (items, over = {}) => ({
  requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
  items: items.map(([inventoryId, quantity]) => ({ inventoryId, quantity, expectedUnitPriceCentavos: PRICE })),
  ...over,
});
const createWith = (payload, uid = SR) =>
  ops.createOrderWithReservation({ db, FieldValue, uid, email: "rep1@vaxtrack.test", now: NOW, payload });
const create = (items, over = {}) => createWith(payloadFor(items, over));

const addStock = (over = {}) =>
  flow.addStockBatchWithAllocation({
    db, FieldValue, uid: ADMIN, now: NOW,
    payload: {
      vaccineId: P, batchId: `IN-${++seq}`, manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01",
      expiryDate: "2027-06-30", quantity: 1, sellingPriceCentavos: PRICE, ...over,
    },
  });

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

/**
 * The ledger must explain the order: within the current epoch, the units the
 * stock_allocated events record equal what the order holds reserved.
 */
async function assertLedgerReconciles(orderId) {
  const o = await order(orderId);
  const epoch = history.epochOf(o);
  const allocated = (await events(orderId))
    .filter((e) => e.eventType === "stock_allocated" && e.epoch === epoch)
    .reduce((s, e) => s + e.quantityChanged, 0);
  const reserved = o.items.reduce((s, l) => s + (l.reservedQuantity || 0), 0);
  assert.equal(allocated, reserved, `${orderId}: ledger ${allocated} vs order ${reserved}`);
}

// ---------------------------------------------------------------- receipt

test("1/8. a new order gets exactly one original receipt and an initial allocation history", async () => {
  await seed({ bt3131: { quantity: 1, batchId: "BT-3131-3131" } });
  const r = await create([["bt3131", 3]]);

  const docs = await receiptsFor(r.orderId);
  assert.equal(docs.length, 1, "exactly one receipt");
  assert.equal(docs[0].id, r.orderId, "receipt id = Firestore order document id");
  const rc = docs[0].data();
  const o = await order(r.orderId);
  assert.equal(rc.receiptType, "order_confirmation");
  assert.equal(rc.receiptKind, "original");
  assert.equal(rc.isReconstructed, false);
  assert.equal(rc.orderNumber, r.orderNumber);
  assert.equal(rc.medRepUid, SR);
  assert.equal(rc.medRepName, "Rep One");
  assert.equal(rc.medRepEmail, "rep1@vaxtrack.test");
  assert.equal(rc.doctorName, "Dr. Ana Reyes");
  assert.equal(rc.deliveryAddress, o.deliveryAddress);
  assert.equal(rc.clinicName, o.clinicName);
  assert.equal(rc.requestedDeliveryDate, DELIVERY_DATE);
  assert.equal(rc.requestedDeliveryTime, null);
  assert.equal(rc.priority, "Standard");
  assert.equal(rc.lines.length, 1);
  assert.deepEqual(
    [rc.lines[0].productKey, rc.lines[0].sku, rc.lines[0].name, rc.lines[0].quantityRequested, rc.lines[0].unitPriceCentavos, rc.lines[0].lineTotalCentavos],
    [P, "ATV-001", "Allocation Test Vaccine", 3, PRICE, 3 * PRICE]
  );
  assert.equal(rc.subtotalCentavos, 3 * PRICE);
  // From the line's own VAT snapshot, with the invoice's per-item routine.
  // VAT-inclusive: round(375000 × 12 / 112) = 40179 is inside the 375000 total.
  assert.deepEqual([rc.vatStatus, rc.vatAmountCentavos, rc.finalTotalCentavos, rc.discountCentavos], ["vatable", 40179, 375000, null]);
  assert.equal(rc.creationSource, "createOrderWithReservation");
  assert.equal(rc.generatedBy, "server");
  assert.ok(rc.createdAt.toMillis() > 0);
  assert.equal(rc.orderCreatedAt.toMillis(), o.createdAt.toMillis(), "same commit as the order");
  assert.deepEqual(rc.skus, ["ATV-001"]);
  assert.equal(o.items[0].sku, "ATV-001", "the line keeps the canonical SKU");

  // 8. The initial partial reservation, recorded as it happened.
  const ev = await events(r.orderId);
  assert.deepEqual(ev.map((e) => e.eventType), ["order_placed", "stock_allocated", "partially_reserved", "initial_allocation"]);
  const alloc = ev[1];
  assert.deepEqual([alloc.quantityChanged, alloc.batchId, alloc.inventoryId, alloc.sku], [1, "BT-3131-3131", "bt3131", "ATV-001"]);
  assert.deepEqual([alloc.requestedQuantity, alloc.reservedQuantityAfter, alloc.backorderedQuantityAfter], [3, 1, 2]);
  assert.equal(alloc.allocationStateAfter, "partially_reserved");
  assert.equal(alloc.sourceOperation, "createOrderWithReservation");
  assert.deepEqual([alloc.actorRole, alloc.triggeredByUid, alloc.triggeredByRole], ["system", SR, "salesrep"]);
  assert.equal(alloc.medRepUid, SR);
  assert.equal(alloc.orderNumber, r.orderNumber);
  assert.equal(alloc.idempotencyKey, alloc.id);
  assert.match(alloc.id, new RegExp(`^${r.orderId}__e0__alloc__${P}__r1$`));
  const initial = ev[3];
  assert.deepEqual([initial.requestedQuantity, initial.reservedQuantityAfter, initial.backorderedQuantityAfter], [3, 1, 2]);
  assert.deepEqual([initial.allocationStateAfter, initial.sourceOperation, initial.recovered], ["partially_reserved", "createOrderWithReservation", false]);
  assert.match(initial.summary, /1 vial reserved, 2 vials backordered/);
  // The outbox marker created with the order is closed by the placing call.
  const marker = await get(history.OUTBOX, r.orderId);
  assert.deepEqual([marker.status, marker.materializedBy], ["done", "createOrderWithReservation"]);
  assert.equal(ev[0].actorRole, "salesrep");
  assert.equal(ev[0].actorUid, SR);
  await assertLedgerReconciles(r.orderId);
});

test("1. classified products: VAT on the receipt uses the invoice's integer rounding", async () => {
  await seed({ q: { quantity: 5 } }, { vatClassification: "vatable" });
  const r = await create([["q", 3]]);
  const rc = (await receiptsFor(r.orderId))[0].data();
  // 3 × 125000 = 375000, VAT-inclusive: round(375000 × 12 / 112) = 40179 is
  // INSIDE it, and the total stays 375000 (never 420000).
  assert.deepEqual([rc.vatStatus, rc.vatRatePercent, rc.vatAmountCentavos, rc.finalTotalCentavos], ["vatable", 12, 40179, 375000]);
  assert.equal(rc.priceIsVatInclusive, true);
  assert.equal(rc.lines[0].unitPriceCentavos, PRICE, "the original VAT-inclusive unit price");
  assert.equal(rc.lines[0].vatClassification, "vatable");

  await seed({ q: { quantity: 5 } }, { vatClassification: "vat_exempt" });
  const x = await create([["q", 3]]);
  const rx = (await receiptsFor(x.orderId))[0].data();
  assert.deepEqual([rx.vatStatus, rx.vatRatePercent, rx.vatAmountCentavos, rx.finalTotalCentavos], ["vat_exempt", 0, 0, 375000]);
});

test("2. retrying order creation creates no second receipt and no second history", async () => {
  await seed({ s: { quantity: 2 } });
  const payload = payloadFor([["s", 3]]);
  const first = await createWith(payload);
  const before = (await receiptsFor(first.orderId))[0];
  const evBefore = await events(first.orderId);

  const replay = await createWith(payload);
  assert.equal(replay.replayed, true);
  assert.equal(replay.orderId, first.orderId);
  // Several simultaneous resubmits of the same checkout.
  const burst = await Promise.all([createWith(payload), createWith(payload), createWith(payload)]);
  assert.ok(burst.every((b) => b.orderId === first.orderId));

  assert.equal((await db.collection("orders").get()).size, 1, "one order");
  const after = await receiptsFor(first.orderId);
  assert.equal(after.length, 1, "one receipt");
  assert.ok(after[0].updateTime.isEqual(before.updateTime), "the receipt was never rewritten");
  assert.deepEqual((await events(first.orderId)).map((e) => e.id), evBefore.map((e) => e.id), "no new ledger entries");
  assert.equal((await db.collection(history.RECEIPTS).get()).size, 1);
});

// ---------------------------------------------------------------- initial history: failure injection

/**
 * The placing call "stops" right after its creation transaction commits: only
 * createOrderTransaction runs — no allocation pass, no materialization. This is
 * exactly the state a crash between the two transactions leaves behind.
 */
const interruptedCreate = (items, over = {}) =>
  ops.createOrderTransaction({ db, FieldValue, uid: SR, email: null, now: NOW, payload: payloadFor(items, over) });
const initialEvents = async (orderId) => (await events(orderId)).filter((e) => e.eventType === "initial_allocation");
const runTrigger = (orderId) =>
  outbox.materializeInitialHistory({ db, FieldValue, orderId, now: NOW, materializedBy: "materializeOrderHistory", allocate: true });

test("2/gap. interrupted after creation: the outbox records the initial outcome exactly once", async () => {
  await seed({ bt3131: { quantity: 1, batchId: "BT-3131-3131" } });
  const r = await interruptedCreate([["bt3131", 3]]);

  // What survived the "crash": order, receipt, first ledger entry, pending marker.
  assert.equal((await receiptsFor(r.orderId)).length, 1);
  assert.deepEqual(await (async () => (await events(r.orderId)).map((e) => e.eventType))(), ["order_placed"]);
  assert.equal((await get(history.OUTBOX, r.orderId)).status, "pending", "materialization is required");
  assert.deepEqual(await initialEvents(r.orderId), [], "not yet recorded — the UI shows it as pending");

  // Recovery: the trigger fires (and is redelivered, concurrently, and again).
  const results = await Promise.all([runTrigger(r.orderId), runTrigger(r.orderId), runTrigger(r.orderId)]);
  await runTrigger(r.orderId);
  assert.equal(results.filter((x) => x.materialized).length, 1, "exactly one materializer wrote");

  const initial = await initialEvents(r.orderId);
  assert.equal(initial.length, 1, "recorded exactly once");
  assert.deepEqual(
    [initial[0].requestedQuantity, initial[0].reservedQuantityAfter, initial[0].backorderedQuantityAfter, initial[0].allocationStateAfter],
    [3, 1, 2, "partially_reserved"],
    "the recovery ran the order's first allocation pass before recording it"
  );
  assert.deepEqual([initial[0].sourceOperation, initial[0].recovered], ["materializeOrderHistory", true]);
  const marker = await get(history.OUTBOX, r.orderId);
  assert.deepEqual([marker.status, marker.materializedBy], ["done", "materializeOrderHistory"]);

  // A later retry or a replayed checkout changes nothing.
  const frozen = (await db.collection(history.ALLOCATION_EVENTS).doc(initial[0].id).get()).updateTime;
  await runTrigger(r.orderId);
  assert.ok((await db.collection(history.ALLOCATION_EVENTS).doc(initial[0].id).get()).updateTime.isEqual(frozen));
  await assertLedgerReconciles(r.orderId);
});

test("2/gap. a replayed checkout completes a pending marker; the placing call and the trigger never both write", async () => {
  // Replay path.
  await seed({ s: { quantity: 0 } });
  const payload = payloadFor([["s", 2]]);
  const committed = await ops.createOrderTransaction({ db, FieldValue, uid: SR, email: null, now: NOW, payload });
  assert.equal((await get(history.OUTBOX, committed.orderId)).status, "pending");
  const replay = await createWith(payload);
  assert.equal(replay.replayed, true);
  let initial = await initialEvents(committed.orderId);
  assert.equal(initial.length, 1);
  assert.deepEqual([initial[0].backorderedQuantityAfter, initial[0].sourceOperation, initial[0].recovered],
    [2, "createOrderWithReservation:replay", true]);
  await createWith(payload);
  await runTrigger(committed.orderId);
  assert.equal((await initialEvents(committed.orderId)).length, 1);

  // Race: the placing call and the trigger at the same moment.
  await seed({ s: { quantity: 4 } });
  const raced = await interruptedCreate([["s", 2]]);
  await Promise.all([
    outbox.materializeInitialHistory({ db, FieldValue, orderId: raced.orderId, now: NOW, materializedBy: "createOrderWithReservation", allocate: true }),
    runTrigger(raced.orderId),
    runTrigger(raced.orderId),
  ]);
  initial = await initialEvents(raced.orderId);
  assert.equal(initial.length, 1, "one record, whoever won");
  assert.deepEqual([initial[0].reservedQuantityAfter, initial[0].backorderedQuantityAfter], [2, 0]);
  assert.equal((await get(history.OUTBOX, raced.orderId)).status, "done");
});

test("2/gap. a deleted order closes its marker without inventing history", async () => {
  await seed({ s: { quantity: 0 } });
  const r = await interruptedCreate([["s", 1]]);
  await db.collection("orders").doc(r.orderId).delete();
  const res = await outbox.materializeInitialHistory({ db, FieldValue, orderId: r.orderId, now: NOW, materializedBy: "materializeOrderHistory", allocate: false });
  assert.equal(res.reason, "order-missing");
  assert.deepEqual([(await get(history.OUTBOX, r.orderId)).status, (await initialEvents(r.orderId)).length], ["abandoned", 0]);
});

test("3. the receipt keeps the original quantities and prices after stock, catalog and status changes", async () => {
  await seed({ s: { quantity: 1 } });
  const r = await create([["s", 3]]);
  const snap0 = (await receiptsFor(r.orderId))[0];
  const original = snap0.data();

  // Catalog and batch change underneath it: price, SKU, name, VAT class.
  await db.collection("inventory").doc("s").update({ sellingPriceCentavos: 999900, batchId: "RENAMED" });
  await db.collection("vaccines").doc(P).update({ vaccineName: "Renamed Vaccine", internalSku: "NEW-SKU", vatClassification: "vatable" });
  // Clinic, doctor and address records change.
  await db.collection("clinics").doc(CLINIC).update({ name: "Renamed Clinic", location: "99 Other Street, Pasig" });
  await db.collection("doctors").doc(DOCTOR).update({ name: "Dr. Someone Else" });
  await db.collection("doctors").doc(DOCTOR).collection("deliveryAddresses").doc(CLINIC).update({ active: false });
  // The order itself changes (server-side writes, as a correction would make).
  await db.collection("orders").doc(r.orderId).update({
    priority: "Urgent", deliveryInstructions: "Changed", deliveryAddress: "Changed address", doctorName: "Changed",
    clinicName: "Changed", requestedDeliveryDate: "2026-12-01",
  });
  // New stock arrives and completes it; then it is delivered.
  await addStock({ quantity: 5, sellingPriceCentavos: 777700 });
  assert.equal((await order(r.orderId)).allocationState, "fully_reserved");
  await toInTransit(r.orderId);
  await recordEvidence(r.orderId);
  await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId });

  const now = (await receiptsFor(r.orderId))[0];
  assert.ok(now.updateTime.isEqual(snap0.updateTime), "never rewritten");
  assert.deepEqual(now.data(), original);
  assert.deepEqual([original.lines[0].quantityRequested, original.lines[0].unitPriceCentavos, original.lines[0].sku], [3, PRICE, "ATV-001"]);
  assert.deepEqual(
    [original.doctorName, original.priority, original.requestedDeliveryDate, original.vatStatus, original.deliveryAddress],
    ["Dr. Ana Reyes", "Standard", DELIVERY_DATE, "vatable", "10 Mabini Street, Manila"]
  );
});

// ---------------------------------------------------------------- ledger

test("9. a fully backordered order records waiting, and no batch", async () => {
  await seed({ quoteOnly: { quantity: 0, batchId: "BT-3131-3131" } });
  const r = await create([["quoteOnly", 2]]);
  const ev = await events(r.orderId);
  assert.deepEqual(ev.map((e) => e.eventType), ["order_placed", "initial_allocation"]);
  assert.deepEqual([ev[1].reservedQuantityAfter, ev[1].backorderedQuantityAfter, ev[1].allocationStateAfter], [0, 2, "awaiting_stock"]);
  assert.match(ev[1].summary, /2 vials backordered — awaiting stock/);
  for (const e of ev) {
    assert.deepEqual(e.batchIds, [], "no batch is claimed for a backordered order");
    assert.equal(e.batchId, null);
  }
  // The receipt still records the quoted batch for audit — never as a reservation.
  const rc = (await receiptsFor(r.orderId))[0].data();
  assert.equal(rc.lines[0].quotedBatchId, "BT-3131-3131");
});

test("10/11/12/18. staging scenario: the next vial goes to the Urgent order; history survives resolution", async () => {
  // Allocation Test Vaccine, batch BT-3131-3131 with one vial on hand.
  await seed({ bt3131: { quantity: 1, batchId: "BT-3131-3131" } });
  const a = await create([["bt3131", 3]]); // Standard Order A: 1 reserved, 2 backordered
  const b = await create([["bt3131", 1]], { priority: "Urgent" }); // Urgent Order B: 0 / 1
  assert.deepEqual((await order(a.orderId)).items.map((l) => [l.reservedQuantity, l.backorderedQuantity]), [[1, 2]]);
  assert.deepEqual((await order(b.orderId)).items.map((l) => [l.reservedQuantity, l.backorderedQuantity]), [[0, 1]]);
  const aBefore = await events(a.orderId);

  // 10/11. One incoming vial → one event, on B (Urgent), none on A.
  const incoming = await addStock({ quantity: 1, batchId: "BT-NEXT-0001" });
  const bEv = await events(b.orderId);
  const bAlloc = bEv.filter((e) => e.eventType === "stock_allocated");
  assert.equal(bAlloc.length, 1, "exactly one allocation event");
  assert.deepEqual([bAlloc[0].quantityChanged, bAlloc[0].batchId, bAlloc[0].inventoryId], [1, "BT-NEXT-0001", incoming.inventoryId]);
  assert.equal(bAlloc[0].sourceOperation, "addStockBatchWithAllocation");
  assert.equal(bAlloc[0].stockAddedInThisOperation, true);
  assert.deepEqual([bAlloc[0].triggeredByUid, bAlloc[0].triggeredByRole], [ADMIN, "admin"]);
  assert.ok(bEv.some((e) => e.eventType === "fully_reserved"));
  assert.deepEqual((await events(a.orderId)).map((e) => e.id), aBefore.map((e) => e.id), "A untouched");
  assert.equal((await order(a.orderId)).allocationState, "partially_reserved");

  // Backlog vs history: B left the queue, both keep receipt + history.
  const backlog = async () => (await db.collection("orders")
    .where("allocationOpen", "==", true)
    .where("allocationState", "in", ["awaiting_stock", "partially_reserved"])
    .orderBy("allocationPriorityKey").get()).docs.map((d) => d.id);
  assert.deepEqual(await backlog(), [a.orderId]);

  // 12. More stock completes A; its partial history stays.
  await addStock({ quantity: 2, batchId: "BT-NEXT-0002" });
  const aEv = await events(a.orderId);
  assert.deepEqual(aEv.map((e) => e.eventType),
    ["order_placed", "stock_allocated", "partially_reserved", "initial_allocation", "stock_allocated", "fully_reserved"]);
  assert.deepEqual(aEv[4].batchIds, ["BT-NEXT-0002"]);
  assert.deepEqual([aEv[4].reservedQuantityAfter, aEv[4].backorderedQuantityAfter], [3, 0]);

  // 18. Nothing waits now; history and receipts remain for both.
  assert.deepEqual(await backlog(), []);
  for (const id of [a.orderId, b.orderId]) {
    assert.equal((await receiptsFor(id)).length, 1);
    await assertLedgerReconciles(id);
  }
  assert.equal((await receiptsFor(a.orderId))[0].data().lines[0].quantityRequested, 3);
  assert.equal((await receiptsFor(b.orderId))[0].data().lines[0].quantityRequested, 1);
});

test("13. cancellation records the released quantity once", async () => {
  await seed({ s: { quantity: 1, batchId: "BT-1" } });
  const r = await create([["s", 3]]);
  const cancel = () => ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: r.orderId, reason: "Clinic cancelled", now: NOW });
  await cancel();
  const again = await cancel();
  assert.equal(again.replayed, true);
  const rel = (await events(r.orderId)).filter((e) => e.eventType === "reservation_released");
  assert.equal(rel.length, 1, "released once");
  assert.deepEqual([rel[0].releasedQuantity, rel[0].backorderWithdrawnQuantity, rel[0].batchId], [1, 2, "BT-1"]);
  assert.deepEqual([rel[0].reservedQuantityAfter, rel[0].backorderedQuantityAfter], [0, 0]);
  assert.deepEqual([rel[0].actorUid, rel[0].actorRole], [DISPATCHER, "dispatcher"]);
  assert.equal((await inv("s")).reservedQuantity, 0);

  // A fully backordered order's cancellation moves no stock and says so.
  await seed({ q: { quantity: 0 } });
  const w = await create([["q", 2]]);
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: w.orderId, reason: "Clinic cancelled", now: NOW });
  const bc = (await events(w.orderId)).filter((e) => e.eventType === "backorder_cancelled");
  assert.equal(bc.length, 1);
  assert.deepEqual([bc[0].quantityChanged, bc[0].backorderWithdrawnQuantity, bc[0].batchIds], [0, 2, []]);
});

test("14. delivery completion records consumption once", async () => {
  await seed({ s: { quantity: 2, batchId: "BT-2" } });
  const r = await create([["s", 2]]);
  await toInTransit(r.orderId);
  await recordEvidence(r.orderId);
  await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId });
  const again = await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: r.orderId });
  assert.equal(again.replayed, true);
  const consumed = (await events(r.orderId)).filter((e) => e.eventType === "reservation_consumed");
  assert.equal(consumed.length, 1);
  assert.deepEqual([consumed[0].consumedQuantity, consumed[0].batchId, consumed[0].actorRole], [2, "BT-2", "rider"]);
});

test("15/16/requeue. failure → Return Pending (not available) → usable → reallocated; each recorded once", async (t) => {
  await seed({ s: { quantity: 2, batchId: "BT-RET" } });
  const failed = await create([["s", 2]]);
  const waiting = await create([["s", 1]]); // nothing left for it yet
  await toInTransit(failed.orderId);

  await t.test("15. the failure moves the units to Return Pending, not to the waiting order", async () => {
    const rep = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: failed.orderId, reason: "Clinic closed" } });
    await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: failed.orderId, reason: "Clinic closed" } });
    const ret = (await events(failed.orderId)).filter((e) => e.eventType === "moved_to_return_pending");
    assert.equal(ret.length, 1, "recorded once");
    assert.deepEqual([ret[0].returnedQuantity, ret[0].returnId, ret[0].batchId, ret[0].epoch], [2, rep.returnId, "BT-RET", 0]);
    assert.deepEqual([ret[0].actorUid, ret[0].actorRole, ret[0].sourceOperation], [RIDER, "rider", "reportDeliveryFailure"]);
    const batch = await inv("s");
    assert.deepEqual([batch.reservedQuantity, batch.returnPendingQuantity], [0, 2]);
    assert.equal((await order(waiting.orderId)).allocationState, "awaiting_stock", "Return Pending is not available");
    assert.equal((await events(waiting.orderId)).filter((e) => e.eventType === "stock_allocated").length, 0);
  });

  await t.test("requeue: the failed order waits again, recorded once in a new epoch", async () => {
    await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: failed.orderId } });
    await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: failed.orderId } });
    const rq = (await events(failed.orderId)).filter((e) => e.eventType === "order_requeued");
    assert.equal(rq.length, 1);
    assert.deepEqual([rq[0].epoch, rq[0].backorderedQuantityAfter, rq[0].actorRole], [1, 2, "dispatcher"]);
  });

  await t.test("16. usable return: restored, then reallocated by priority — recorded once", async () => {
    const returnId = `${failed.orderId}_1`;
    await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId, disposition: "usable" } });
    const again = await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId, disposition: "usable" } });
    assert.equal(again.replayed, true);
    const restored = (await events(failed.orderId)).filter((e) => e.eventType === "return_restored");
    assert.equal(restored.length, 1);
    assert.deepEqual([restored[0].quantityChanged, restored[0].disposition, restored[0].actorRole], [2, "usable", "admin"]);
    // Both open orders are Standard with the same date: the older (failed) one first.
    const reEv = (await events(failed.orderId)).filter((e) => e.eventType === "stock_allocated" && e.epoch === 1);
    assert.equal(reEv.length, 1, "reallocation recorded in the new epoch");
    assert.equal(reEv[0].sourceOperation, "confirmReturnDisposition");
    assert.match(reEv[0].summary, /returned stock confirmed usable/);
    assert.match(reEv[0].id, /__e1__alloc__/);
    await assertLedgerReconciles(failed.orderId);
    await assertLedgerReconciles(waiting.orderId);
  });
});

test("16. damaged / temperature excursion / missing dispositions are recorded, never allocated", async () => {
  for (const [disposition, type] of [["damaged", "return_quarantined"], ["temperature_excursion", "return_quarantined"], ["missing", "return_written_off"]]) {
    await seed({ s: { quantity: 1, batchId: "BT-D" } });
    const f = await create([["s", 1]]);
    const w = await create([["s", 1]]);
    await toInTransit(f.orderId);
    const rep = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: f.orderId, reason: "Broken cold box" } });
    await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: rep.returnId, disposition } });
    const ev = (await events(f.orderId)).filter((e) => e.eventType === type);
    assert.equal(ev.length, 1, disposition);
    assert.equal(ev[0].disposition, disposition);
    assert.equal((await events(w.orderId)).filter((e) => e.eventType === "stock_allocated").length, 0, `${disposition} stock is never allocated`);
  }
});

test("17. retries and concurrent allocation runs never duplicate an event", async () => {
  await seed({ s: { quantity: 0 } });
  const orders = await Promise.all([create([["s", 2]]), create([["s", 2]]), create([["s", 2]], { priority: "Urgent" })]);
  // Stock appears by a direct (trigger-path) write, then the inventory trigger,
  // the order trigger and a continuation all race to allocate it, twice over.
  await db.collection("inventory").doc("s").update({ quantity: 5 });
  const run = (operation) => allocation.allocateProducts({ db, FieldValue, productKeys: [P], now: NOW, source: { operation } });
  await Promise.all([run("allocateOnInventoryWrite"), run("allocateOnOrderWrite"), run("allocateOnInventoryWrite"), run("continueAllocation")]);
  await run("allocateOnInventoryWrite");

  const ids = [];
  let ledgerUnits = 0;
  for (const o of orders) {
    const ev = await events(o.orderId);
    ids.push(...ev.map((e) => e.id));
    ledgerUnits += ev.filter((e) => e.eventType === "stock_allocated").reduce((s, e) => s + e.quantityChanged, 0);
    await assertLedgerReconciles(o.orderId);
    assert.equal(ev.filter((e) => e.eventType === "fully_reserved").length <= 1, true);
  }
  assert.equal(new Set(ids).size, ids.length, "every id distinct");
  assert.equal(ledgerUnits, 5, "the ledger records each reserved unit once");
  assert.equal((await inv("s")).reservedQuantity, 5);
  const urgent = await events(orders[2].orderId);
  assert.ok(urgent.some((e) => e.eventType === "fully_reserved"), "the Urgent order was served");

  // A redelivered compatibility-trigger event settles and records nothing twice.
  await seed({ s: { quantity: 1 } });
  const f = await create([["s", 1]]);
  await toInTransit(f.orderId);
  const before = await order(f.orderId);
  await db.collection("orders").doc(f.orderId).update({ status: "delivery_failed", deliveryFailedByUid: RIDER, deliveryFailureReason: "Closed" });
  const after = await order(f.orderId);
  await settleClientReportedFailure({ db, FieldValue, orderId: f.orderId, before, after });
  await settleClientReportedFailure({ db, FieldValue, orderId: f.orderId, before, after });
  const ret = (await events(f.orderId)).filter((e) => e.eventType === "moved_to_return_pending");
  assert.equal(ret.length, 1);
  assert.equal(ret[0].sourceOperation, "settleClientReportedFailure");
});

// ---------------------------------------------------------------- reconstruction (pure; never run against data)

test("legacy backfill builder: labelled reconstructed, never invents an initial reservation", async () => {
  await seed({ s: { quantity: 1 } });
  const r = await create([["s", 3]]);
  const o = await order(r.orderId);
  const rebuilt = history.buildReconstructedReceipt(r.orderId, o);
  assert.equal(rebuilt.receiptKind, "reconstructed");
  assert.equal(rebuilt.isReconstructed, true);
  assert.equal(rebuilt.medRepUid, SR);
  assert.equal(rebuilt.lines[0].quantityRequested, 3);
  assert.equal(rebuilt.vatStatus, "not_recorded");
  assert.ok(!("initialReservedQuantity" in rebuilt));
  assert.equal(history.buildReconstructedReceipt("x", { items: [{ quantity: 1 }] }), null, "no price snapshot → nothing to rebuild");
});

// ---------------------------------------------------------------- append-only ledger

const eventsCol = () => db.collection(history.ALLOCATION_EVENTS);
const sampleEvent = (over = {}) => ({
  ...history.buildEvent({
    orderId: "ordX",
    order: { orderNumber: "VT-ORD-X", createdByUid: SR, items: [{ productKey: P, quantity: 2, reservedQuantity: 1, backorderedQuantity: 1 }] },
    eventType: "stock_allocated",
    sourceOperation: "addStockBatchWithAllocation",
    lines: [{ lineIndex: 0, productKey: P, requestedQuantity: 2, reservedQuantityAfter: 1, backorderedQuantityAfter: 1 }],
    batches: [{ inventoryId: "b1", batchId: "BT-1", productKey: P, quantity: 1 }],
    quantityChanged: 1,
    allocationStateAfter: "partially_reserved",
    summary: "Reserved 1 vial from batch BT-1.",
  }),
  ...over,
});
/** One transaction through the production write path: prepare (read) → create. */
const append = (eventId, event) =>
  db.runTransaction(async (tx) => {
    const prepared = await history.prepareEvents(tx, { db, events: [{ eventId, event }] });
    history.createPreparedEvents(tx, { FieldValue, prepared });
    return prepared.length;
  });
const conflictCode = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code === "history-integrity-conflict" ? { code: e.code, fields: e.details.fields } : { code: e.code };
  }
};

test("L1. an identical retry creates nothing and changes nothing", async () => {
  await wipe();
  const id = "ordX__e0__alloc__vacP__r1";
  assert.equal(await append(id, sampleEvent()), 1);
  const first = await eventsCol().doc(id).get();
  assert.equal(await append(id, sampleEvent()), 0, "identical → no write");
  assert.equal(await append(id, sampleEvent({ summary: "Different wording only." })), 0, "wording is not identity");
  const again = await eventsCol().doc(id).get();
  assert.ok(again.updateTime.isEqual(first.updateTime), "never rewritten");
  assert.deepEqual(again.data(), first.data());
  assert.equal((await eventsCol().get()).size, 1);
});

test("L2. the same id with different content can never overwrite the original", async () => {
  await wipe();
  const id = "ordX__e0__alloc__vacP__r1";
  await append(id, sampleEvent({ returnId: null }));
  const original = await eventsCol().doc(id).get();
  const variants = {
    eventType: { eventType: "fully_reserved" },
    orderId: { orderId: "ordY" },
    reservationId: { reservationId: "ordY" },
    returnId: { returnId: "ordX_1" },
    productKey: { productKey: "vacQ" },
    batchIds: { batchIds: ["BT-OTHER"] },
    quantityChanged: { quantityChanged: 2 },
    reservedQuantityAfter: { reservedQuantityAfter: 2 },
    backorderedQuantityAfter: { backorderedQuantityAfter: 0 },
    epoch: { epoch: 1 },
    sourceOperation: { sourceOperation: "allocateOnInventoryWrite" },
  };
  for (const [field, change] of Object.entries(variants)) {
    const result = await conflictCode(append(id, sampleEvent({ returnId: null, ...change })));
    assert.equal(result?.code, "history-integrity-conflict", field);
    assert.ok(result.fields.includes(field), `${field} is named in the conflict`);
  }
  const after = await eventsCol().doc(id).get();
  assert.ok(after.updateTime.isEqual(original.updateTime), "the original is untouched");
  assert.deepEqual(after.data(), original.data());
});

test("L3. concurrent writers cannot alter an existing event", async () => {
  await wipe();
  const id = "ordX__e0__alloc__vacP__r1";
  const writers = [1, 2, 3, 4, 5, 6].map((q) => append(id, sampleEvent({ quantityChanged: q })));
  const settled = await Promise.allSettled(writers);
  const won = settled.filter((s) => s.status === "fulfilled" && s.value === 1);
  assert.equal(won.length, 1, "exactly one writer created it");
  for (const s of settled.filter((x) => x.status === "rejected")) {
    // The losers are refused — by the integrity check, or by create() itself.
    assert.ok(["history-integrity-conflict", 6].includes(s.reason.code), String(s.reason.code));
  }
  const stored = await eventsCol().doc(id).get();
  const winnerQty = settled.findIndex((s) => s.status === "fulfilled" && s.value === 1) + 1;
  assert.equal(stored.data().quantityChanged, winnerQty, "the stored event is the winner's, unaltered");
  // Later writers, identical or not, still change nothing.
  await append(id, sampleEvent({ quantityChanged: winnerQty }));
  assert.equal(await conflictCode(append(id, sampleEvent({ quantityChanged: 99 }))).then((r) => r?.code), "history-integrity-conflict");
  assert.ok((await eventsCol().doc(id).get()).updateTime.isEqual(stored.updateTime));
});

test("L4. a stock change cannot commit over a conflicting event: allocation aborts, nothing moves", async () => {
  await seed({ quote: { quantity: 0 } });
  const r = await create([["quote", 2]]);
  // Plant a DIFFERENT event at the id the next allocation would write.
  const id = `${r.orderId}__e0__alloc__${P}__r1`;
  await eventsCol().doc(id).set({ ...sampleEvent({ orderId: r.orderId, quantityChanged: 7 }), eventId: id });
  const planted = await eventsCol().doc(id).get();

  const err = await flow.addStockBatchWithAllocation({
    db, FieldValue, uid: ADMIN, now: NOW,
    payload: { vaccineId: P, batchId: "BT-CONFLICT", manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01", expiryDate: "2027-06-30", quantity: 1, sellingPriceCentavos: PRICE },
  }).then(() => null, (e) => e);
  assert.equal(err?.code, "history-integrity-conflict");
  assert.equal((await db.collection("inventory").where("batchId", "==", "BT-CONFLICT").get()).size, 0, "the stock addition rolled back with it");
  assert.equal((await order(r.orderId)).allocationState, "awaiting_stock", "no reservation without its history");
  const after = await eventsCol().doc(id).get();
  assert.ok(after.updateTime.isEqual(planted.updateTime), "the existing event is untouched");
  assert.equal(after.data().quantityChanged, 7);
});

// ---------------------------------------------------------------- receipt immutability

test("R1. a receipt is create-only: an identical server retry writes nothing, a different one is refused", async () => {
  await seed({ s: { quantity: 1 } });
  const r = await create([["s", 3]]);
  const ref = db.collection(history.RECEIPTS).doc(r.orderId);
  const original = await ref.get();
  const tryWrite = (receipt) =>
    db.runTransaction(async (tx) => {
      const prepared = await history.prepareReceipt(tx, { db, orderId: r.orderId, receipt });
      history.createPreparedReceipt(tx, prepared);
      return prepared ? 1 : 0;
    });
  // The same receipt again, with fresh server timestamps (as a retry would build it).
  const same = { ...original.data(), createdAt: FieldValue.serverTimestamp(), orderCreatedAt: FieldValue.serverTimestamp() };
  assert.equal(await tryWrite(same), 0);
  for (const change of [{ subtotalCentavos: 1 }, { priority: "Urgent" }, { receiptKind: "reconstructed", isReconstructed: true }]) {
    const res = await conflictCode(tryWrite({ ...same, ...change }));
    assert.equal(res?.code, "history-integrity-conflict", JSON.stringify(change));
  }
  const after = await ref.get();
  assert.ok(after.updateTime.isEqual(original.updateTime), "never overwritten");
  assert.deepEqual(after.data(), original.data());
});

// ---------------------------------------------------------------- backfill tool (emulator only; never run against data)

test("B1. backfill: refuses production and unsafe flags; dry run writes nothing; apply is create-only and labelled", async () => {
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");
  const tool = await import(pathToFileURL(path.join(__dirname, "..", "..", "scripts", "backfillOrderReceipts.mjs")).href);

  // Guards.
  const refusal = (argv, env) => { try { tool.parseOptions(argv, env); return null; } catch (e) { return e.message; } };
  assert.match(refusal([], { emulator: false }), /--project is required/);
  assert.match(refusal(["--project", "vaxtrack-bef1b"], { emulator: false }), /production/);
  assert.match(refusal(["--project", "vaxtrack-bef1b"], { emulator: true }), /production/, "production refused even on an emulator");
  assert.match(refusal(["--project", "some-other-project"], { emulator: false }), /only --project vaxtrack-staging/);
  assert.match(refusal(["--project", "vaxtrack-staging", "--apply"], { emulator: false }), /--apply requires --confirm/);
  assert.match(refusal(["--project", "vaxtrack-staging", "--apply", "--confirm", "x"], { emulator: false }), /--apply requires --confirm/);
  assert.deepEqual(tool.parseOptions(["--project", "vaxtrack-staging"], { emulator: false }),
    { project: "vaxtrack-staging", apply: false, confirm: null, orderIds: [] }, "no --apply → dry run");

  // World: one order WITH an original receipt, one legacy priced order without
  // (a copy made the way pre-receipt orders look), one unpriced legacy order.
  await seed({ s: { quantity: 1 } });
  const real = await create([["s", 1]]);
  const realReceipt = await db.collection(history.RECEIPTS).doc(real.orderId).get();
  const legacy = { ...(await order(real.orderId)), orderNumber: "VT-ORD-LEGACY-A" };
  await db.collection("orders").doc("legacyA").set(legacy);
  await db.collection("orders").doc("legacyOld").set({ orderNumber: "VT-ORD-OLD", status: "delivered", items: [{ quantity: 1 }], createdByUid: SR });
  const receiptsBefore = (await db.collection(history.RECEIPTS).get()).size;

  const lines = [];
  const log = (l) => lines.push(l);
  const dry = await tool.runBackfill({ db, FieldValue, options: { apply: false, confirm: null, orderIds: [] }, log });
  assert.deepEqual([dry.applied, dry.toCreate, dry.created], [false, 1, 0]);
  assert.ok(lines.some((l) => /^PROPOSED: 1 reconstructed receipt\(s\) to create; 2 skipped\.$/.test(l)), "exact counts printed");
  assert.equal((await db.collection(history.RECEIPTS).get()).size, receiptsBefore, "dry run wrote nothing");

  const wrong = await tool.runBackfill({ db, FieldValue, options: { apply: true, confirm: 2, orderIds: [] }, log: () => {} }).then(() => null, (e) => e.message);
  assert.match(wrong, /does not match the 1 receipt/);
  assert.equal((await db.collection(history.RECEIPTS).get()).size, receiptsBefore, "a mismatched confirm wrote nothing");

  lines.length = 0;
  const applied = await tool.runBackfill({ db, FieldValue, options: { apply: true, confirm: 1, orderIds: [] }, log });
  assert.deepEqual([applied.applied, applied.created], [true, 1]);
  assert.ok(lines.findIndex((l) => l.startsWith("PROPOSED:")) < lines.findIndex((l) => l.startsWith("Applied:")), "counts before applying");
  const rebuilt = (await db.collection(history.RECEIPTS).doc("legacyA").get()).data();
  assert.deepEqual([rebuilt.receiptKind, rebuilt.isReconstructed, rebuilt.creationSource], ["reconstructed", true, "backfillOrderReceipts"]);
  assert.ok(rebuilt.reconstructionNotes.length > 0);
  const realAfter = await db.collection(history.RECEIPTS).doc(real.orderId).get();
  assert.ok(realAfter.updateTime.isEqual(realReceipt.updateTime), "the real receipt was never touched");
  assert.equal((await db.collection(history.RECEIPTS).doc("legacyOld").get()).exists, false, "nothing to rebuild from → stays legacy");

  // A second apply finds nothing to do; a reconstructed receipt can't be swapped for an "original".
  const again = await tool.runBackfill({ db, FieldValue, options: { apply: true, confirm: 0, orderIds: [] }, log: () => {} });
  assert.equal(again.created, 0);
  const swap = await conflictCode(db.runTransaction(async (tx) => {
    const p = await history.prepareReceipt(tx, { db, orderId: "legacyA", receipt: { ...rebuilt, receiptKind: "original", isReconstructed: false } });
    history.createPreparedReceipt(tx, p);
  }));
  assert.equal(swap?.code, "history-integrity-conflict");
  assert.equal((await db.collection(history.RECEIPTS).doc("legacyA").get()).data().isReconstructed, true, "still marked reconstructed");
});

// ---------------------------------------------------------------- VAT-inclusive rule: history is not rewritten

test("V-H. an order and receipt recorded VAT-exclusive stay exactly as recorded through later events", async () => {
  await seed({ s: { quantity: 0 } });
  const r = await create([["s", 2]]);
  // Turn this order and its receipt into what the earlier code recorded:
  // VAT-exclusive convention, VAT on top. (Server-side seed of history.)
  await db.collection("orders").doc(r.orderId).update({ priceIsVatInclusive: false });
  const receiptRef = db.collection(history.RECEIPTS).doc(r.orderId);
  await receiptRef.update({ priceIsVatInclusive: false, vatStatus: "vatable", vatRatePercent: 12, vatAmountCentavos: 30000, finalTotalCentavos: 280000 });
  const receiptBefore = await receiptRef.get();

  // Later stock, allocation and cancellation do not touch either record's money.
  await addStock({ quantity: 2 });
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: r.orderId, reason: "Clinic cancelled", now: NOW });

  const receiptAfter = await receiptRef.get();
  assert.ok(receiptAfter.updateTime.isEqual(receiptBefore.updateTime), "the historical receipt is never rewritten");
  assert.deepEqual(receiptAfter.data(), receiptBefore.data());
  const o = await order(r.orderId);
  assert.equal(o.priceIsVatInclusive, false, "the order's recorded convention is untouched");
  assert.equal(o.subtotalCentavos, 2 * PRICE);
  assert.equal(o.items[0].unitPriceCentavos, PRICE);
});
