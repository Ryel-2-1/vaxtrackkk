"use strict";

/**
 * Pre-deployment hardening of allocation, against a REAL Firestore (emulator).
 *
 *   PAGING     more than 25 waiting orders, more than 100 batches, a first
 *              order page that cannot use the stock, leftover stock, repeated
 *              and concurrent runs, bounded continuation, no trigger loop, no
 *              duplicated slices, deterministic priority across pages.
 *   INVARIANTS the counter effect of every inventory event, with `available`
 *              asserted explicitly, including retries.
 *   COMPAT     the temporary settleClientReportedFailure trigger for Rider
 *              builds that still write `delivery_failed` directly, and its
 *              races with requeue and cancel.
 *
 * Run:  npm run test:emulator   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-alloc-hardening" }, "alloc-hardening-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const allocation = require("../../src/allocation");
const { settleClientReportedFailure } = require("../../src/failureReturn");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const {
  allocateProduct,
  allocationPriorityKey,
  compareAllocationPriority,
  priorityTuple,
  runContinuation,
  requestContinuation,
  CONTINUATIONS,
  MAX_CONTINUATIONS,
} = allocation;

const NOW = new Date("2026-10-05T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const AREA = "area1";
const CLINIC = "clinic1";
const DOCTOR = "doctor1";
const P = "vacP";
const PRICE = 125000;

let seq = 0;
const rid = () => `hard${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
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
const n = (v) => (Number.isInteger(v) ? v : 0);
/** available = on hand − reserved − return-pending − quarantined */
const availableOf = (b) => n(b.quantity) - n(b.reservedQuantity) - n(b.returnPendingQuantity) - n(b.quarantinedQuantity);

async function wipe() {
  for (const c of ["users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations", "inventoryReturns", "orderRequestKeys", CONTINUATIONS]) {
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

/** Users, catalog and a doctor/clinic, for the callables. */
async function world() {
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
}

async function batch(id, over = {}) {
  await db.collection("inventory").doc(id).set({
    vaccineId: P, vaccineName: "Vaccine P", batchId: id.toUpperCase(), status: "Stable",
    expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE,
    ...over,
  });
}

/** A version-2 future order waiting for [qty] of P (seeded directly). */
async function waiting(id, { qty = 1, urgent = false, date = DELIVERY_DATE, created = 1000, status = "pending_dispatch" } = {}) {
  const data = {
    orderNumber: `VT-${id}`,
    status,
    priority: urgent ? "Urgent" : "Standard",
    requestedDeliveryDate: date,
    allocationVersion: 2,
    allocationStatus: "reserved",
    allocationOpen: true,
    allocationCreatedAtMillis: created,
    allocationState: "awaiting_stock",
    backorderedProductKeys: [P],
    items: [{ productKey: P, inventoryId: "quote", quantity: qty, reservedQuantity: 0, backorderedQuantity: qty }],
  };
  data.allocationPriorityKey = allocationPriorityKey(data, id);
  await db.collection("orders").doc(id).set(data);
  return data;
}

const run = (over = {}) => allocateProduct({ db, FieldValue, productKey: P, now: NOW, ...over });

/**
 * Every invariant that must hold after any allocation activity:
 *   - batch reserved == Σ active slices on it; reserved+returnPending+quarantined ≤ on hand
 *   - each order line's reservedQuantity == Σ its slices; requested = reserved + backordered
 *   - no duplicated slice (one per line × batch)
 */
async function assertReconciled() {
  const reservations = (await db.collection("inventoryReservations").get()).docs;
  const slicesByBatch = new Map();
  for (const r of reservations) {
    const items = r.data().items ?? [];
    const seen = new Set();
    for (const s of items) {
      const key = `${s.lineIndex}|${s.inventoryId}`;
      assert.ok(!seen.has(key), `duplicate slice ${key} in ${r.id}`);
      seen.add(key);
    }
    if (r.data().status !== "reserved") continue;
    for (const s of items) slicesByBatch.set(s.inventoryId, (slicesByBatch.get(s.inventoryId) ?? 0) + s.quantity);
    const o = (await db.collection("orders").doc(r.id).get()).data();
    if (o?.allocationVersion === 2) {
      (o.items ?? []).forEach((line, i) => {
        const sum = items.filter((s) => s.lineIndex === i).reduce((a, s) => a + s.quantity, 0);
        assert.equal(n(line.reservedQuantity), sum, `${r.id} line ${i} reserved == its slices`);
        if (o.allocationOpen) assert.equal(n(line.reservedQuantity) + n(line.backorderedQuantity), line.quantity, `${r.id} line ${i}`);
      });
    }
  }
  for (const d of (await db.collection("inventory").get()).docs) {
    const b = d.data();
    assert.equal(n(b.reservedQuantity), slicesByBatch.get(d.id) ?? 0, `${d.id}: reserved == Σ active slices`);
    assert.ok(availableOf(b) >= 0, `${d.id}: never over-held`);
  }
}

async function fullyReservedIds() {
  const snap = await db.collection("orders").where("allocationState", "==", "fully_reserved").get();
  return snap.docs.map((d) => d.id).sort();
}

// =============================================================== PAGING

test("P1. more than 25 waiting orders are all served when stock suffices", async () => {
  await world();
  await batch("big", { quantity: 30 });
  for (let i = 0; i < 30; i += 1) await waiting(`o${String(i).padStart(2, "0")}`, { created: 1000 + i });
  const r = await run();
  assert.equal(r.allocatedUnits, 30);
  assert.equal(r.done, true);
  assert.ok(r.rounds >= 2, "needed more than one order page");
  assert.equal((await fullyReservedIds()).length, 30, "order #26..#30 are not stranded");
  assert.equal((await inv("big")).reservedQuantity, 30);
  await assertReconciled();
});

test("P2. a first page that cannot use the stock does not strand it for later orders", async () => {
  await world();
  await batch("two", { quantity: 2 });
  // 25 higher-priority entries that are in the queue index but not allocatable
  // (inconsistent data: no longer pending_dispatch). They fill page 1.
  for (let i = 0; i < 25; i += 1) await waiting(`stale${String(i).padStart(2, "0")}`, { urgent: true, status: "assigned", created: i });
  await waiting("eligibleA", { created: 5000 });
  await waiting("eligibleB", { created: 5001 });
  const r = await run();
  assert.equal(r.allocatedUnits, 2);
  assert.equal(r.done, true);
  assert.equal(r.rounds, 2, "round 1 found nothing usable on page 1 and skipped it; round 2 served page 2");
  assert.deepEqual(await fullyReservedIds(), ["eligibleA", "eligibleB"]);
  assert.equal((await order("stale00")).items[0].reservedQuantity, 0, "the stale entries are untouched");
  await assertReconciled();
});

test("P3. more than 100 batches: stock past the first batch page is reached, FEFO across pages", async () => {
  await world();
  // 101 batches, one unit each, distinct expiries; one order for all 101.
  for (let i = 0; i < 101; i += 1) {
    const d = new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10);
    await batch(`b${String(i).padStart(3, "0")}`, { quantity: 1, expiryDate: d });
  }
  await waiting("needs101", { qty: 101 });
  const r = await run();
  assert.equal(r.allocatedUnits, 101);
  assert.equal(r.rounds, 2, "page 1 (100 batches) exhausted, then page 2");
  assert.equal((await order("needs101")).allocationState, "fully_reserved");
  const used = (await reservation("needs101")).items.map((s) => s.inventoryId).sort();
  assert.equal(used.length, 101);
  await assertReconciled();
});

test("P4. 100 unusable earliest-expiry batches do not hide the usable ones behind them", async () => {
  await world();
  for (let i = 0; i < 100; i += 1) {
    const d = new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10);
    await batch(`dead${String(i).padStart(3, "0")}`, { quantity: 5, status: "Disabled", expiryDate: d });
  }
  await batch("liveLate", { quantity: 2, expiryDate: "2028-03-01" });
  await batch("liveEarly", { quantity: 2, expiryDate: "2028-01-01" });
  await waiting("w1", { qty: 3 });
  const r = await run();
  assert.equal(r.allocatedUnits, 3);
  assert.equal(r.rounds, 2, "page 1 held only unusable batches; the cursor moved past it");
  const slices = (await reservation("w1")).items.map((s) => [s.inventoryId, s.quantity]);
  assert.deepEqual(slices, [["liveEarly", 2], ["liveLate", 1]], "FEFO among the usable batches");
  assert.equal((await inv("dead000")).reservedQuantity, 0, "unusable stock is never allocated");
  await assertReconciled();
});

test("P5. stock left after one round is reported and stays available", async () => {
  await world();
  await batch("ten", { quantity: 10 });
  await waiting("a", { qty: 2 });
  await waiting("b", { qty: 1 });
  const r = await run();
  assert.deepEqual([r.allocatedUnits, r.leftAvailable, r.done, r.rounds], [3, 7, true, 1]);
  assert.equal(availableOf(await inv("ten")), 7);
  await assertReconciled();
});

test("P6. repeated runs (trigger redelivery) change nothing once settled", async () => {
  await world();
  await batch("big", { quantity: 28 });
  for (let i = 0; i < 30; i += 1) await waiting(`o${String(i).padStart(2, "0")}`, { created: 1000 + i });
  await run();
  const before = await inv("big");
  const resBefore = (await db.collection("inventoryReservations").get()).docs.map((d) => [d.id, d.data().items]);
  for (let k = 0; k < 3; k += 1) {
    const again = await run();
    assert.equal(again.allocatedUnits, 0, `run ${k + 2} allocates nothing`);
    assert.equal(again.done, true);
  }
  assert.deepEqual(await inv("big"), before);
  assert.deepEqual((await db.collection("inventoryReservations").get()).docs.map((d) => [d.id, d.data().items]), resBefore);
  await assertReconciled();
});

test("P7. concurrent trigger runs and a stock-adding callable never over-reserve or duplicate", async () => {
  await world();
  await batch("base", { quantity: 20 });
  const tuples = [];
  for (let i = 0; i < 40; i += 1) {
    const o = await waiting(`c${String(i).padStart(2, "0")}`, { urgent: i % 7 === 0, created: 2000 + ((i * 17) % 40) });
    tuples.push(priorityTuple(o, `c${String(i).padStart(2, "0")}`));
  }
  await Promise.all([
    run(),
    run(),
    run(),
    flow.addStockBatchWithAllocation({
      db, FieldValue, uid: ADMIN, now: NOW,
      payload: { vaccineId: P, batchId: "CONC-1", manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01", expiryDate: "2027-06-30", quantity: 10, sellingPriceCentavos: PRICE },
    }),
  ]);
  await run(); // drain, as the inventory trigger would
  const batches = (await db.collection("inventory").get()).docs.map((d) => d.data());
  assert.equal(batches.reduce((s, b) => s + b.reservedQuantity, 0), 30, "30 of 40 requested, all stock");
  const expected = tuples.sort(compareAllocationPriority).slice(0, 30).map((t) => t.id).sort();
  assert.deepEqual(await fullyReservedIds(), expected, "exactly the 30 highest-priority orders");
  await assertReconciled();
});

test("P8. allocation's own writes do not re-trigger allocation (no trigger loop)", async () => {
  await world();
  await batch("five", { quantity: 5 });
  await waiting("x", { qty: 3 });
  const orderBefore = await order("x");
  const invBefore = await inv("five");
  await run();
  const orderAfter = await order("x");
  const invAfter = await inv("five");
  assert.deepEqual(flow.productKeysForOrderWrite(orderBefore, orderAfter), [], "order trigger: no-op");
  assert.deepEqual(flow.productKeysForInventoryWrite(invBefore, invAfter, NOW), [], "inventory trigger: no-op");
  // A brand-new future order, by contrast, does start a run.
  assert.deepEqual(flow.productKeysForOrderWrite(null, orderBefore), [P]);
});

test("P9. a run that outgrows its rounds continues through a bounded chain that terminates", async () => {
  await world();
  await batch("big", { quantity: 60 });
  for (let i = 0; i < 60; i += 1) await waiting(`q${String(i).padStart(2, "0")}`, { created: 1000 + i });
  const first = await run({ maxRounds: 1 });
  assert.equal(first.allocatedUnits, 25);
  assert.equal(first.done, false);
  assert.equal(first.continued, true, "progress was made, so a continuation is recorded");
  let links = 0;
  for (;;) {
    const doc = await get(CONTINUATIONS, P);
    if (!doc || doc.status !== "pending") break;
    links += 1;
    assert.ok(links <= 10, "the chain must end");
    // As the continueAllocation trigger would, one round per link.
    await runContinuation({ db, FieldValue, productKey: P, data: doc, now: NOW, maxRounds: 1 });
  }
  assert.equal((await get(CONTINUATIONS, P)).status, "done");
  assert.equal((await fullyReservedIds()).length, 60);
  // The "done" write re-triggers the handler: it is a no-op.
  assert.equal(await runContinuation({ db, FieldValue, productKey: P, data: await get(CONTINUATIONS, P), now: NOW }), null);
  await assertReconciled();
});

test("P10. no progress → no continuation; and a chain is hard-capped", async () => {
  await world();
  for (let i = 0; i < 30; i += 1) await waiting(`z${i}`, { created: i });
  const r = await run({ maxRounds: 1 }); // no stock at all
  assert.equal(r.done, true);
  assert.equal(r.continued, false);
  assert.equal(await get(CONTINUATIONS, P), undefined);
  const capped = await requestContinuation({ db, FieldValue, productKey: P, cursors: {}, generation: MAX_CONTINUATIONS + 1 });
  assert.equal(capped, false);
  assert.equal(await get(CONTINUATIONS, P), undefined);
});

test("P11. priority is deterministic across page boundaries, whatever the insertion order", async () => {
  const spec = Array.from({ length: 30 }, (_, i) => ({
    id: `d${String(i).padStart(2, "0")}`,
    urgent: i % 9 === 0,
    date: ["2026-10-08", "2026-10-10", "2026-10-12", null][i % 4],
    created: 3000 + ((i * 13) % 30),
  }));
  const results = [];
  for (const order_ of [spec, [...spec].reverse()]) {
    await world();
    await batch("stock", { quantity: 27 });
    for (const s of order_) await waiting(s.id, { urgent: s.urgent, date: s.date, created: s.created });
    await run();
    results.push(await fullyReservedIds());
  }
  assert.deepEqual(results[0], results[1], "same 27 orders regardless of insertion order");
  const expected = spec
    .map((s) => priorityTuple({ priority: s.urgent ? "Urgent" : "Standard", requestedDeliveryDate: s.date, allocationCreatedAtMillis: s.created }, s.id))
    .sort(compareAllocationPriority)
    .slice(0, 27)
    .map((t) => t.id)
    .sort();
  assert.deepEqual(results[0], expected, "and they are the 27 highest by the comparator");
});

// =============================================================== INVARIANTS

const create = (inventoryId, quantity, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
      items: [{ inventoryId, quantity, expectedUnitPriceCentavos: PRICE }],
      ...over,
    },
  });
const toInTransit = (id) => db.collection("orders").doc(id).update({ status: "in_transit", assignedRiderId: RIDER });
const fail = (id) => flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: id, reason: "Clinic closed" } });
const dispose = (returnId, disposition) =>
  flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId, disposition } });
const counters = async (id) => {
  const b = await inv(id);
  return { onHand: n(b.quantity), reserved: n(b.reservedQuantity), returnPending: n(b.returnPendingQuantity), quarantined: n(b.quarantinedQuantity), available: availableOf(b) };
};

test("I1. failed order: reservation → 0, units → return-pending, available unchanged", async () => {
  await world();
  await batch("s", { quantity: 10 });
  const o = await create("s", 4);
  const before = await counters("s");
  assert.deepEqual(before, { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, available: 6 });
  await toInTransit(o.orderId);
  await fail(o.orderId);
  assert.deepEqual(await counters("s"), { onHand: 10, reserved: 0, returnPending: 4, quarantined: 0, available: 6 });
  assert.equal((await reservation(o.orderId)).status, "returned");
  assert.equal((await order(o.orderId)).items[0].reservedQuantity, 0);
  await assertReconciled();
});

test("I2. returned and usable: return-pending ↓, units eligible, allocation runs at once", async () => {
  await world();
  await batch("s", { quantity: 4 });
  const failed = await create("s", 4, { priority: "Urgent" });
  const waitingOrder = await create("s", 3);
  await toInTransit(failed.orderId);
  const rep = await fail(failed.orderId);
  const r = await dispose(rep.returnId, "usable");
  assert.deepEqual(r.reallocated.map((x) => [x.orderId, x.units]), [[waitingOrder.orderId, 3]]);
  assert.deepEqual(await counters("s"), { onHand: 4, reserved: 3, returnPending: 0, quarantined: 0, available: 1 });
  await assertReconciled();
});

test("I3. damaged / temperature excursion / missing: those units never become available", async () => {
  for (const disposition of ["damaged", "temperature_excursion", "missing"]) {
    await world();
    await batch("s", { quantity: 5 });
    const failed = await create("s", 3, { priority: "Urgent" });
    const waitingOrder = await create("s", 4);
    await toInTransit(failed.orderId);
    const before = await counters("s"); // 5 on hand: 3 failed + 2 to waiting
    const rep = await fail(failed.orderId);
    await dispose(rep.returnId, disposition);
    await run(); // as the inventory trigger would
    const after = await counters("s");
    assert.equal(after.available, before.available, `${disposition}: available did not increase`);
    assert.equal(after.returnPending, 0);
    assert.equal(after.reserved, 2, `${disposition}: the waiting order keeps only what it had`);
    assert.deepEqual([(await order(waitingOrder.orderId)).items[0].reservedQuantity], [2]);
    if (disposition === "missing") assert.equal(after.onHand, 2, "written off the on-hand figure");
    else assert.equal(after.quarantined, 3);
    await assertReconciled();
  }
});

test("I4. delivered: reserved and on hand each drop exactly once", async () => {
  await world();
  await batch("s", { quantity: 10 });
  const o = await create("s", 4);
  await toInTransit(o.orderId);
  await db.collection("orders").doc(o.orderId).update({
    proofOfDeliveryUrl: `https://storage/${o.orderId}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(o.orderId),
    proofRecipientName: "Maria", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
    invoiceUrl: `https://storage/${o.orderId}/invoice.jpg`, invoicePath: canonicalInvoicePath(o.orderId),
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
  });
  await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: o.orderId });
  const once = await counters("s");
  assert.deepEqual(once, { onHand: 6, reserved: 0, returnPending: 0, quarantined: 0, available: 6 });
  const replay = await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: o.orderId });
  assert.equal(replay.replayed, true);
  assert.deepEqual(await counters("s"), once, "a retried delivery moves nothing");
});

test("I5. cancelled before dispatch: released and reallocated", async () => {
  await world();
  await batch("s", { quantity: 5 });
  const first = await create("s", 5, { priority: "Urgent" });
  const second = await create("s", 2);
  const r = await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: first.orderId, reason: "Clinic cancelled", now: NOW });
  assert.deepEqual(r.reallocated.map((x) => [x.orderId, x.units]), [[second.orderId, 2]]);
  assert.deepEqual(await counters("s"), { onHand: 5, reserved: 2, returnPending: 0, quarantined: 0, available: 3 });
  await assertReconciled();
});

test("I6. every retried call leaves the counters exactly as the first call did", async () => {
  await world();
  await batch("s", { quantity: 6 });
  const a = await create("s", 3, { priority: "Urgent" });
  const b = await create("s", 2);
  await toInTransit(a.orderId);
  const rep = await fail(a.orderId);
  let snap = await counters("s");
  assert.equal((await fail(a.orderId)).replayed, true);
  assert.deepEqual(await counters("s"), snap, "failure replay");
  await dispose(rep.returnId, "usable");
  snap = await counters("s");
  assert.equal((await dispose(rep.returnId, "usable")).replayed, true);
  assert.deepEqual(await counters("s"), snap, "disposition replay");
  await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: a.orderId } });
  snap = await counters("s");
  assert.equal((await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: a.orderId } })).replayed, true);
  assert.deepEqual(await counters("s"), snap, "requeue replay");
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: b.orderId, reason: "No longer needed", now: NOW });
  snap = await counters("s");
  assert.equal((await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: b.orderId, reason: "No longer needed", now: NOW })).replayed, true);
  assert.deepEqual(await counters("s"), snap, "cancel replay");
  await assertReconciled();
});

// =============================================================== COMPAT

/** What an older Rider build writes: status + reason, nothing about stock. */
async function clientFailure(orderId) {
  const before = await order(orderId);
  await db.collection("orders").doc(orderId).update({
    status: "delivery_failed",
    deliveryFailureReason: "Clinic closed (old app)",
    deliveryFailedAt: FieldValue.serverTimestamp(),
    deliveryFailedByUid: RIDER,
    statusUpdatedByUid: RIDER,
    statusUpdatedAt: FieldValue.serverTimestamp(),
  });
  return { before, after: await order(orderId) };
}
const trigger = (orderId, event) => settleClientReportedFailure({ db, FieldValue, orderId, ...event });

test("C1. the compatibility trigger settles an old client's failure exactly like the callable", async () => {
  await world();
  await batch("s", { quantity: 10 });
  const o = await create("s", 4);
  await toInTransit(o.orderId);
  const event = await clientFailure(o.orderId);
  assert.deepEqual(await counters("s"), { onHand: 10, reserved: 4, returnPending: 0, quarantined: 0, available: 6 }, "until settled, still reserved — never available");
  const r = await trigger(o.orderId, event);
  assert.equal(r.settled, true);
  assert.deepEqual(await counters("s"), { onHand: 10, reserved: 0, returnPending: 4, quarantined: 0, available: 6 });
  const after = await order(o.orderId);
  assert.equal(after.failureCount, 1);
  assert.equal(after.pendingReturnId, r.returnId);
  assert.equal(after.allocationOpen, false);
  assert.equal((await get("inventoryReturns", r.returnId)).status, "pending");
  // C2. a redelivered event moves nothing and does not count twice.
  const again = await trigger(o.orderId, event);
  assert.equal(again.settled, false);
  assert.equal((await order(o.orderId)).failureCount, 1);
  assert.deepEqual((await counters("s")).returnPending, 4);
  await assertReconciled();
});

test("C3. a callable-reported failure is ignored by the compatibility trigger", async () => {
  await world();
  await batch("s", { quantity: 5 });
  const o = await create("s", 2);
  await toInTransit(o.orderId);
  const before = await order(o.orderId);
  await fail(o.orderId);
  const snap = await counters("s");
  assert.equal(await trigger(o.orderId, { before, after: await order(o.orderId) }), null);
  assert.deepEqual(await counters("s"), snap);
});

test("C4. requeue before the trigger runs settles first — no reserved units are orphaned", async () => {
  await world();
  await batch("s", { quantity: 5 });
  const o = await create("s", 3);
  await toInTransit(o.orderId);
  const event = await clientFailure(o.orderId);
  await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: o.orderId } });
  const c = await counters("s");
  assert.equal(c.returnPending, 3, "the old reservation went to return-pending, not lost");
  assert.equal((await order(o.orderId)).pendingReturnId, `${o.orderId}_1`);
  assert.equal((await trigger(o.orderId, event)).reason, "no-longer-failed");
  assert.deepEqual(await counters("s"), c);
  await assertReconciled();
});

test("C5. cancel before the trigger runs returns the units, never releases them unchecked", async () => {
  await world();
  await batch("s", { quantity: 5 });
  const o = await create("s", 3);
  await toInTransit(o.orderId);
  const event = await clientFailure(o.orderId);
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: o.orderId, reason: "Clinic closed", now: NOW });
  assert.deepEqual(await counters("s"), { onHand: 5, reserved: 0, returnPending: 3, quarantined: 0, available: 2 });
  assert.equal((await trigger(o.orderId, event)).reason, "no-longer-failed");
  const replay = await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: o.orderId, reason: "Clinic closed", now: NOW });
  assert.equal(replay.replayed, true, "a retried cancel of a returned order replays");
  await assertReconciled();
});

test("C6. an order that was already failed before the window is never rewritten by the trigger", async () => {
  await world();
  await batch("s", { quantity: 5, reservedQuantity: 2 });
  await db.collection("orders").doc("legacyFailed").set({ orderNumber: "VT-LEG", status: "delivery_failed", allocationVersion: 1 });
  await db.collection("inventoryReservations").doc("legacyFailed").set({ status: "reserved", allocationVersion: 1, items: [{ inventoryId: "s", quantity: 2 }] });
  const doc_ = await order("legacyFailed");
  await db.collection("orders").doc("legacyFailed").update({ note: "touched" });
  assert.equal(await trigger("legacyFailed", { before: doc_, after: await order("legacyFailed") }), null);
  assert.equal((await reservation("legacyFailed")).status, "reserved");
  assert.equal((await inv("s")).reservedQuantity, 2);
});

test("C7. a version-1 order whose stock was returned cannot be requeued", async () => {
  await world();
  await batch("s", { quantity: 5, reservedQuantity: 2 });
  await db.collection("orders").doc("v1").set({ orderNumber: "VT-V1", status: "in_transit", allocationVersion: 1, assignedRiderId: RIDER });
  await db.collection("inventoryReservations").doc("v1").set({ status: "reserved", allocationVersion: 1, items: [{ inventoryId: "s", batchId: "S", quantity: 2 }] });
  await fail("v1");
  assert.equal((await reservation("v1")).status, "returned");
  assert.equal(await codeOf(flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId: "v1" } })), "legacy-order-not-requeueable");
  assert.equal((await order("v1")).status, "delivery_failed", "unchanged");
});

test.after(async () => {
  await wipe();
  await app.delete();
});

// =============================================================== STAGING REMEDIATION (emulator copy)

test("R1. the staging ARV remediation: dry run writes nothing; apply converts once; reruns skip", async () => {
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");
  const script = await import(pathToFileURL(path.join(__dirname, "..", "..", "scripts", "remediateStagingArvReturns.mjs")).href);
  await world();
  // A copy of the staging documents as exported read-only on 2026-10-06.
  await db.collection("inventory").doc(script.BATCH_ID).set({
    vaccineId: script.PRODUCT_ID, vaccineName: "ARV", batchId: "BT_2026-013", status: "Warning",
    expiryDate: "2026-11-07", quantity: 338, reservedQuantity: 2, sellingPriceCentavos: PRICE,
  });
  for (const t of script.TARGETS) {
    await db.collection("orders").doc(t.orderId).set({
      orderNumber: t.orderNumber, status: "delivery_failed", allocationVersion: 1,
      deliveryFailureReason: "Clinic was closed", deliveryFailedByUid: RIDER,
    });
    await db.collection("inventoryReservations").doc(t.orderId).set({
      status: "reserved", allocationVersion: 1,
      items: [{ inventoryId: script.BATCH_ID, batchId: "BT_2026-013", quantity: 1 }],
    });
  }
  const before = await counters(script.BATCH_ID);
  assert.deepEqual(before, { onHand: 338, reserved: 2, returnPending: 0, quarantined: 0, available: 336 });

  for (const target of script.TARGETS) {
    const r = await script.remediateOne({ db, FieldValue, target, apply: false });
    assert.equal(r.action, "would-convert");
  }
  assert.deepEqual(await counters(script.BATCH_ID), before, "dry run writes nothing");

  for (const target of script.TARGETS) {
    assert.equal((await script.remediateOne({ db, FieldValue, target, apply: true })).action, "converted");
  }
  assert.deepEqual(await counters(script.BATCH_ID), { onHand: 338, reserved: 0, returnPending: 2, quarantined: 0, available: 336 },
    "reserved −2, return-pending +2, available unchanged");
  for (const t of script.TARGETS) {
    assert.equal((await reservation(t.orderId)).status, "returned");
    assert.equal((await get("inventoryReturns", `${t.orderId}_1`)).status, "pending");
    assert.equal((await order(t.orderId)).status, "delivery_failed", "the order itself is not moved");
  }
  for (const target of script.TARGETS) {
    const again = await script.remediateOne({ db, FieldValue, target, apply: true });
    assert.equal(again.action, "skip");
    assert.match(again.why, /already returned/);
  }
  assert.equal((await counters(script.BATCH_ID)).returnPending, 2, "idempotent");
  // Then the Admin's "Returned and usable" makes them available (nothing is waiting for ARV).
  for (const t of script.TARGETS) await dispose(`${t.orderId}_1`, "usable");
  assert.deepEqual(await counters(script.BATCH_ID), { onHand: 338, reserved: 0, returnPending: 0, quarantined: 0, available: 338 });
  await assertReconciled();
});

test("R2. the remediation refuses anything not exactly as exported", async () => {
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");
  const script = await import(pathToFileURL(path.join(__dirname, "..", "..", "scripts", "remediateStagingArvReturns.mjs")).href);
  const t = script.TARGETS[0];
  const res = { status: "reserved", items: [{ inventoryId: script.BATCH_ID, quantity: 1 }] };
  const ord = { orderNumber: t.orderNumber, status: "delivery_failed", allocationVersion: 1 };
  assert.equal(script.preconditionFailure(t, ord, res), null);
  assert.match(script.preconditionFailure(t, { ...ord, status: "pending_dispatch" }, res), /status is/);
  assert.match(script.preconditionFailure(t, { ...ord, orderNumber: "X" }, res), /order number/);
  assert.match(script.preconditionFailure(t, { ...ord, allocationVersion: 2 }, res), /allocationVersion/);
  assert.match(script.preconditionFailure(t, ord, { ...res, items: [{ inventoryId: script.BATCH_ID, quantity: 2 }] }), /reservation items/);
  assert.match(script.preconditionFailure(t, ord, null), /reservation not found/);
});
