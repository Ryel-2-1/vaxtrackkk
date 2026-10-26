"use strict";

/**
 * Admin inventory removal controls against a REAL Firestore (emulator):
 *
 *   ARCHIVE   archive / restore; new orders and new stock refused while
 *             archived; existing orders, reservations and allocation intact.
 *   VOID      only a tracked batch with no downstream use; kept as a record;
 *             never quoted or allocated; legacy and used batches refused.
 *   REMOVE    quarantine free units / dispose quarantined units; reserved and
 *             returned units protected; availability via allocatableUnits.
 *   RETRIES   idempotent replays (one change, one audit entry).
 *   RACES     reservations vs. quarantine, order quote vs. void.
 *
 * Run:  npm run test:emulator   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-inventory-removal" }, "inventory-removal-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const removal = require("../../src/inventoryRemoval");
const { allocateProduct, allocatableUnits, CONTINUATIONS } = require("../../src/allocation");
const { isTransientTransactionError } = require("../../src/riderDispatchOps");

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
const Q = "vacQ";
const PRICE = 125000;

let seq = 0;
const rid = () => `rem${String(++seq).padStart(5, "0")}${"y".repeat(20)}`;
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
const n = (v) => (Number.isInteger(v) ? v : 0);
const availableOf = (b) => n(b.quantity) - n(b.reservedQuantity) - n(b.returnPendingQuantity) - n(b.quarantinedQuantity);
const auditFor = async (inventoryId) =>
  (await db.collection(removal.AUDIT).where("inventoryId", "==", inventoryId).get()).docs.map((d) => d.data());

async function wipe() {
  for (const c of [
    "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "inventoryAllocationEvents", "orderReceipts", "orderHistoryOutbox",
    removal.AUDIT, CONTINUATIONS,
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

async function world() {
  await wipe();
  const territory = { assignedAreaIds: [AREA], assignedClinicIds: [CLINIC] };
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", ...territory });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved", email: "admin@vaxtrack.test" });
  await db.collection("areas").doc(AREA).set({ name: "Manila", active: true });
  await db.collection("clinics").doc(CLINIC).set({
    clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: AREA, area: "Manila",
    status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
  });
  const doctorRef = db.collection("doctors").doc(DOCTOR);
  await doctorRef.set({ name: "Dr. Ana Reyes", areaId: AREA, area: "Manila", active: true });
  await doctorRef.collection("deliveryAddresses").doc(CLINIC).set({ active: true });
  await db.collection("vaccines").doc(P).set({ vaccineName: "Vaccine P", vaccineType: "T", internalSku: "VXT-P", vatClassification: "vatable" });
  await db.collection("vaccines").doc(Q).set({ vaccineName: "Vaccine Q", vaccineType: "T", internalSku: "VXT-Q", vatClassification: "vatable" });
}

/** A batch seeded directly — i.e. one that predates usage tracking. */
async function legacyBatch(id, over = {}) {
  await db.collection("inventory").doc(id).set({
    vaccineId: P, vaccineName: "Vaccine P", batchId: id.toUpperCase(), status: "Stable",
    expiryDate: "2027-06-30", quantity: 0, reservedQuantity: 0, sellingPriceCentavos: PRICE, priceIsVatInclusive: true,
    ...over,
  });
}

/** A batch added the real way (Add Stock): usage-tracked from its first moment. */
async function addStock(vaccineId, batchId, quantity, over = {}) {
  const r = await flow.addStockBatchWithAllocation({
    db, FieldValue, uid: ADMIN, now: NOW,
    payload: {
      vaccineId, batchId, manufacturingDate: "2026-09-01", arrivalDate: "2026-10-01",
      expiryDate: "2027-06-30", quantity, sellingPriceCentavos: PRICE, ...over,
    },
  });
  return r.inventoryId;
}

const create = (inventoryId, quantity, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
      items: [{ inventoryId, quantity, expectedUnitPriceCentavos: PRICE }],
      ...over,
    },
  });
const archive = (vaccineId, archived, reason = "Discontinued by the manufacturer", uid = ADMIN) =>
  removal.setVaccineArchived({ db, FieldValue, uid, email: "admin@vaxtrack.test", payload: { vaccineId, archived, ...(reason ? { reason } : {}) } });
const voidBatch = (inventoryId, uid = ADMIN) =>
  removal.voidInventoryBatch({ db, FieldValue, uid, email: "admin@vaxtrack.test", payload: { inventoryId, reason: "Entered twice by mistake" } });
const remove = (inventoryId, action, quantity, reason = "damaged", requestId = rid(), uid = ADMIN) =>
  removal.removeUnusableStock({ db, FieldValue, uid, email: "admin@vaxtrack.test", now: NOW, payload: { requestId, inventoryId, action, quantity, reason } });
const ordersCount = async () => (await db.collection("orders").get()).size;

// =============================================================== ARCHIVE

test("A1. archive refuses new orders on the server; restore allows them again", async () => {
  await world();
  const b = await addStock(P, "LOT-A1", 10);
  const r = await archive(P, true);
  assert.deepEqual([r.archived, r.replayed], [true, false]);
  const v = await get("vaccines", P);
  assert.equal(v.archived, true);
  assert.equal(v.archivedByUid, ADMIN);
  assert.equal(v.archiveReason, "Discontinued by the manufacturer");
  assert.ok(v.archivedAt, "server time recorded");

  assert.equal(await codeOf(create(b, 2)), "vaccine-archived");
  assert.equal(await ordersCount(), 0, "nothing written: no order");
  assert.equal((await db.collection("orderRequestKeys").get()).size, 0, "no request key either");
  assert.equal((await inv(b)).reservedQuantity, 0);

  await archive(P, false, null);
  const restored = await get("vaccines", P);
  assert.equal(restored.archived, false);
  assert.ok(restored.restoredAt);
  const o = await create(b, 2);
  assert.ok(o.orderId, "ordering works again after restore");
});

test("A2. archiving leaves existing orders, reservations, batches and allocation intact", async () => {
  await world();
  const b = await addStock(P, "LOT-A2", 5);
  const first = await create(b, 5, { priority: "Urgent" });
  const waiting = await create(b, 2); // backordered
  const before = { order: await get("orders", first.orderId), res: await get("inventoryReservations", first.orderId), batch: await inv(b) };
  await archive(P, true);
  assert.deepEqual(await get("orders", first.orderId), before.order, "the order is untouched");
  assert.deepEqual(await get("inventoryReservations", first.orderId), before.res, "its reservation is untouched");
  assert.deepEqual(await inv(b), before.batch, "the batch is untouched");
  // Existing demand still receives stock that frees up: cancel the first order.
  const c = await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: first.orderId, reason: "Clinic cancelled", now: NOW });
  assert.deepEqual(c.reallocated.map((x) => [x.orderId, x.units]), [[waiting.orderId, 2]], "allocation continues for an archived product's existing orders");
});

test("A3. archived products take no new stock; archive/restore replays are single-audited; only Admin", async () => {
  await world();
  await archive(P, true);
  assert.equal(await codeOf(addStock(P, "LOT-A3", 5)), "vaccine-archived");
  assert.equal((await db.collection("inventory").get()).size, 0, "no batch created");
  const again = await archive(P, true);
  assert.equal(again.replayed, true);
  const audits = (await db.collection(removal.AUDIT).where("vaccineId", "==", P).get()).docs.map((d) => d.data().action);
  assert.deepEqual(audits, ["vaccine_archived"], "a retried archive writes no second entry");
  for (const uid of [SR, DISPATCHER, RIDER, "nobody"]) {
    assert.ok(["wrong-role", "profile-missing"].includes(await codeOf(archive(Q, true, "Discontinued", uid))), uid);
  }
  assert.equal(await codeOf(archive("missing", true)), "vaccine-not-found");
  await db.collection("users").doc(ADMIN).update({ status: "disabled" });
  assert.equal(await codeOf(archive(Q, true)), "not-approved");
  assert.equal((await get("vaccines", Q)).archived, undefined, "nothing changed");
});

// =============================================================== VOID

test("V1. an unused tracked batch is voided, kept, never quoted or allocated", async () => {
  await world();
  const mistake = await addStock(P, "LOT-V1", 40);
  assert.equal((await inv(mistake)).usageTracked, true, "Add Stock tracks usage from creation");
  const r = await voidBatch(mistake);
  assert.deepEqual([r.voided, r.replayed], [true, false]);
  const b = await inv(mistake);
  assert.equal(b.voided, true);
  assert.equal(b.quantity, 40, "the recorded figure is kept as entered — no hard delete, no rewrite");
  assert.equal(b.voidedByUid, ADMIN);
  assert.ok(b.voidedAt);
  assert.equal(allocatableUnits(b, NOW), 0);
  const audit = await auditFor(mistake);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].quantityAtVoid, audit[0].actorUid, audit[0].reason], ["batch_voided", 40, ADMIN, "Entered twice by mistake"]);

  assert.equal(await codeOf(create(mistake, 1)), "batch-voided", "never quoted");
  // A real batch of the same product and a waiting order: allocation skips the voided one.
  const real = await addStock(P, "LOT-V1-REAL", 3);
  const o = await create(real, 5);
  const res = await get("inventoryReservations", o.orderId);
  assert.deepEqual(res.items.map((s) => [s.inventoryId, s.quantity]), [[real, 3]]);
  await allocateProduct({ db, FieldValue, productKey: P, now: NOW });
  assert.equal((await inv(mistake)).reservedQuantity, 0, "never allocated");

  const replay = await voidBatch(mistake);
  assert.equal(replay.replayed, true);
  assert.equal((await auditFor(mistake)).length, 1, "a retried void writes no second entry");
});

test("V2. a batch that predates usage tracking cannot be proven unused, so it is refused", async () => {
  await world();
  await legacyBatch("old", { quantity: 12 });
  assert.equal(await codeOf(voidBatch("old")), "batch-usage-unproven");
  assert.equal((await inv("old")).voided, undefined);
  assert.equal((await auditFor("old")).length, 0);
});

test("V3. any downstream use refuses the void — quote, reservation (even released), return, history", async () => {
  await world();
  // Quoted by an order (backordered: no stock reserved from it), then cancelled.
  const quoted = await addStock(Q, "LOT-Q", 1);
  await db.collection("inventory").doc(quoted).update({ quantity: 0 }); // nothing free; the quote alone is use
  const o = await create(quoted, 1);
  assert.equal((await inv(quoted)).firstUsedBy, "order_quote");
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: o.orderId, reason: "Clinic cancelled", now: NOW });
  assert.equal(await codeOf(voidBatch(quoted)), "batch-in-use");

  // Reserved by allocation, then released — counters back to zero, but used.
  const reserved = await addStock(P, "LOT-R", 4);
  const other = await addStock(P, "LOT-R-QUOTE", 1);
  const o2 = await create(other, 5); // takes 1 from LOT-R-QUOTE and 4 from LOT-R (FEFO tie → id)
  assert.ok((await inv(reserved)).reservedQuantity > 0 || (await inv(other)).reservedQuantity > 0);
  await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: o2.orderId, reason: "Clinic cancelled", now: NOW });
  const after = await inv(reserved);
  assert.equal(after.reservedQuantity, 0);
  assert.equal(after.firstUsedBy, "allocation");
  assert.equal(await codeOf(voidBatch(reserved)), "batch-in-use");

  // Belt and braces: a reservation, return or history entry naming the batch
  // refuses the void even if the marker were missing.
  for (const col of ["inventoryReservations", "inventoryReturns", "inventoryAllocationEvents"]) {
    const id = await addStock(P, `LOT-${col.length}-${col.slice(9, 13).toUpperCase()}`, 2);
    await db.collection(col).doc(`ref-${id}`).set({ inventoryIds: [id], status: "released" });
    assert.equal(await codeOf(voidBatch(id)), "batch-in-use", col);
    assert.equal((await inv(id)).voided, undefined);
  }
});

// =============================================================== REMOVE

test("R1. quarantine then dispose: counters, availability, written-off and audit", async () => {
  await world();
  const b = await addStock(P, "LOT-R1", 10);
  const o = await create(b, 4); // reserved 4, available 6
  const q = await remove(b, "quarantine", 3, "damaged");
  assert.equal(q.replayed, false);
  let s = await inv(b);
  assert.deepEqual([s.quantity, s.reservedQuantity, s.quarantinedQuantity, availableOf(s)], [10, 4, 3, 3]);
  assert.equal(allocatableUnits(s, NOW), 3, "the authoritative availability already excludes quarantine");
  const d = await remove(b, "dispose", 2, "damaged");
  assert.equal(d.replayed, false);
  s = await inv(b);
  assert.deepEqual([s.quantity, s.reservedQuantity, s.quarantinedQuantity, s.writtenOffQuantity, availableOf(s)], [8, 4, 1, 2, 3]);
  assert.equal((await get("orders", o.orderId)).items[0].reservedQuantity, 4, "the order's reservation is untouched");
  const audit = (await auditFor(b)).sort((x, y) => x.action.localeCompare(y.action));
  assert.deepEqual(audit.map((a) => [a.action, a.quantity, a.reason, a.actorUid]), [
    ["stock_disposed", 2, "damaged", ADMIN],
    ["stock_quarantined", 3, "damaged", ADMIN],
  ]);
  assert.ok(audit.every((a) => a.at), "server time on every entry");
  assert.deepEqual([audit[0].before.quarantined, audit[0].after.quarantined, audit[0].after.onHand], [3, 1, 8]);
});

test("R2. reserved units of active orders and returned units are never removable", async () => {
  await world();
  const b = await addStock(P, "LOT-R2", 6);
  const active = await create(b, 4);
  await db.collection("orders").doc(active.orderId).update({ status: "in_transit", assignedRiderId: RIDER });
  const failing = await create(b, 2);
  await db.collection("orders").doc(failing.orderId).update({ status: "in_transit", assignedRiderId: RIDER });
  await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: failing.orderId, reason: "Clinic closed" } });
  const s = await inv(b);
  assert.deepEqual([s.reservedQuantity, s.returnPendingQuantity, availableOf(s)], [4, 2, 0]);
  assert.equal(await codeOf(remove(b, "quarantine", 1, "recalled")), "insufficient-free-stock", "nothing free: all reserved or returned");
  assert.equal(await codeOf(remove(b, "dispose", 1, "recalled")), "insufficient-quarantined-stock", "returned units cannot be disposed of here");
  assert.deepEqual(await inv(b), s, "nothing changed");
  // The return is still decided through its own workflow.
  const ret = (await db.collection("inventoryReturns").where("orderId", "==", failing.orderId).get()).docs[0];
  await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: ret.id, disposition: "damaged" } });
  const after = await inv(b);
  assert.deepEqual([after.returnPendingQuantity, after.quarantinedQuantity, availableOf(after)], [0, 2, 0]);
  // Those quarantined units can now be disposed of.
  await remove(b, "dispose", 2, "damaged");
  assert.deepEqual([(await inv(b)).quantity, (await inv(b)).writtenOffQuantity], [4, 2]);
});

test("R3. 'expired' only on an expired batch; a voided batch has nothing to remove", async () => {
  await world();
  const live = await addStock(P, "LOT-R3", 5);
  assert.equal(await codeOf(remove(live, "quarantine", 1, "expired")), "removal-reason-not-applicable");
  await legacyBatch("lapsed", { quantity: 7, expiryDate: "2026-09-30", status: "Critical" });
  await remove("lapsed", "quarantine", 7, "expired");
  assert.equal((await inv("lapsed")).quarantinedQuantity, 7);
  const mistake = await addStock(P, "LOT-R3-X", 5);
  await voidBatch(mistake);
  assert.equal(await codeOf(remove(mistake, "quarantine", 1, "damaged")), "batch-voided");
});

// =============================================================== RETRIES

test("T1. a retried removal replays: one change, one audit entry; a reused id with other content is refused", async () => {
  await world();
  const b = await addStock(P, "LOT-T1", 10);
  const requestId = rid();
  const first = await remove(b, "quarantine", 4, "recalled", requestId);
  const second = await remove(b, "quarantine", 4, "recalled", requestId);
  assert.deepEqual([first.replayed, second.replayed], [false, true]);
  assert.deepEqual(second.after, first.after);
  assert.equal((await inv(b)).quarantinedQuantity, 4, "removed once");
  assert.equal((await auditFor(b)).length, 1);
  assert.equal(await codeOf(remove(b, "quarantine", 5, "recalled", requestId)), "idempotency-conflict");
  assert.equal(await codeOf(remove(b, "dispose", 4, "recalled", requestId)), "idempotency-conflict");
  assert.equal((await inv(b)).quarantinedQuantity, 4, "a conflicting reuse changes nothing");
  // Concurrent duplicates of one request (a double-click, a client retry):
  // each either applies or replays. The server retries transient transaction
  // failures a bounded number of times; should contention outlast that, the
  // failure is transient and the client retries with the SAME id. Never twice.
  const dup = rid();
  const results = await Promise.allSettled([1, 2, 3].map(() => remove(b, "quarantine", 2, "damaged", dup)));
  for (const r of results) {
    if (r.status === "rejected") {
      assert.ok(
        isTransientTransactionError(r.reason),
        `only a transient transaction failure may fail a duplicate: ${r.reason?.code} ${String(r.reason?.message).slice(0, 120)}`
      );
    }
  }
  const applied = results.filter((r) => r.status === "fulfilled" && r.value.replayed === false).length;
  assert.ok(applied <= 1, "at most one duplicate applied");
  const retry = await remove(b, "quarantine", 2, "damaged", dup);
  assert.equal(applied + (retry.replayed ? 0 : 1), 1, "exactly one application in total");
  assert.equal((await inv(b)).quarantinedQuantity, 6);
  assert.equal((await auditFor(b)).length, 2);
});

// =============================================================== RACES

test("C1. concurrent reservations vs quarantine never over-commit a batch", async () => {
  for (let round = 0; round < 6; round += 1) {
    await world();
    const b = await addStock(P, `LOT-C1-${round}`, 10);
    const results = await Promise.allSettled([
      remove(b, "quarantine", 6, "damaged"),
      create(b, 6),
      create(b, 3),
    ]);
    const s = await inv(b);
    assert.ok(availableOf(s) >= 0, `round ${round}: never over-held`);
    assert.ok(s.reservedQuantity + s.quarantinedQuantity <= 10, `round ${round}: reserved + quarantined ≤ on hand`);
    const quarantined = results[0].status === "fulfilled";
    assert.equal(s.quarantinedQuantity, quarantined ? 6 : 0, `round ${round}: quarantine applied iff it succeeded`);
    if (!quarantined) assert.equal(results[0].reason.code, "insufficient-free-stock", `round ${round}`);
    // Each order is placed (backordered as needed); reservations sum to the counter.
    const res = (await db.collection("inventoryReservations").get()).docs.map((d) => d.data());
    const slices = res.flatMap((r) => r.items ?? []).filter((x) => x.inventoryId === b).reduce((a, x) => a + x.quantity, 0);
    assert.equal(s.reservedQuantity, slices, `round ${round}: reserved == Σ slices`);
  }
});

test("C2. a void racing an order quote: exactly one wins, never both", async () => {
  for (let round = 0; round < 6; round += 1) {
    await world();
    const b = await addStock(P, `LOT-C2-${round}`, 5);
    const [v, o] = await Promise.allSettled([voidBatch(b), create(b, 1)]);
    const s = await inv(b);
    if (v.status === "fulfilled") {
      assert.equal(o.status, "rejected", `round ${round}: a voided batch cannot also be ordered`);
      assert.equal(o.reason.code, "batch-voided");
      assert.equal(s.voided, true);
      assert.equal(await ordersCount(), 0);
    } else {
      assert.equal(v.reason.code, "batch-in-use", `round ${round}`);
      assert.equal(o.status, "fulfilled");
      assert.equal(s.voided, undefined);
      assert.ok(s.firstUsedAt);
    }
  }
});

// =============================================================== CORRECT STOCK

const correct = (inventoryId, expectedQuantity, newQuantity, over = {}, uid = ADMIN) =>
  removal.correctStockQuantity({
    db, FieldValue, uid, email: "admin@vaxtrack.test", now: NOW,
    payload: {
      requestId: over.requestId ?? rid(), inventoryId, expectedQuantity, newQuantity,
      reasonCode: over.reasonCode ?? "count_discrepancy", reason: over.reason ?? "Physical recount on 5 Oct confirms the figure",
    },
  });

test("K1. a permitted correction: categorised, explained, permanently audited before/after", async () => {
  await world();
  const b = await addStock(P, "LOT-K1", 10);
  const o = await create(b, 4);
  const r = await correct(b, 10, 7, { reasonCode: "entry_error", reason: "Add Stock entered 10; the delivery note says 7" });
  assert.equal(r.replayed, false);
  const s = await inv(b);
  assert.deepEqual([s.quantity, s.previousQuantity, s.reservedQuantity, availableOf(s)], [7, 10, 4, 3]);
  assert.deepEqual([s.quantityCorrectionCode, s.quantityCorrectedByUid, s.quantityCorrectedByEmail], ["entry_error", ADMIN, "admin@vaxtrack.test"]);
  assert.ok(s.quantityCorrectedAt, "server time");
  const [audit] = await auditFor(b);
  assert.deepEqual(
    [audit.action, audit.reasonCode, audit.previousQuantity, audit.quantity, audit.before.onHand, audit.after.onHand, audit.after.reserved, audit.actorUid],
    ["stock_corrected", "entry_error", 10, -3, 10, 7, 4, ADMIN]
  );
  assert.ok(audit.at);
  assert.equal((await get("orders", o.orderId)).items[0].reservedQuantity, 4, "reservations are untouched");
  // A second correction keeps the first entry: the history is permanent.
  await correct(b, 7, 8);
  assert.equal((await auditFor(b)).length, 2);
});

test("K2. bypass attempts through the callable are refused and change nothing", async () => {
  await world();
  const b = await addStock(P, "LOT-K2", 10);
  await create(b, 4);
  await remove(b, "quarantine", 2, "damaged"); // held: 4 reserved + 2 quarantined
  const before = await inv(b);
  assert.equal(await codeOf(correct(b, 10, 5)), "correction-below-held", "never below reserved + returned + quarantined");
  assert.equal(await codeOf(correct(b, 9, 12)), "stock-changed", "a stale figure never overwrites");
  assert.equal(await codeOf(correct(b, 10, 12, { reason: "recount" })), "reason-required");
  assert.equal(await codeOf(correct(b, 10, 12, { reasonCode: "damaged" })), "invalid-correction-reason");
  assert.equal(await codeOf(correct(b, 10, 10)), "correction-unchanged");
  for (const uid of [SR, DISPATCHER, RIDER]) assert.equal(await codeOf(correct(b, 10, 12, {}, uid)), "wrong-role");
  await legacyBatch("lapsed", { quantity: 8, expiryDate: "2026-09-30", status: "Critical" });
  assert.equal(await codeOf(correct("lapsed", 8, 3)), "correction-expired-decrease", "expired doses go through quarantine → disposal");
  const mistake = await addStock(P, "LOT-K2-X", 5);
  await voidBatch(mistake);
  assert.equal(await codeOf(correct(mistake, 5, 6)), "batch-voided");
  assert.deepEqual(await inv(b), before, "nothing changed");
  assert.equal((await auditFor(b)).filter((a) => a.action === "stock_corrected").length, 0);
  // The legitimate route for the expired doses still works.
  await remove("lapsed", "quarantine", 8, "expired");
  await remove("lapsed", "dispose", 8, "expired");
  assert.deepEqual([(await inv("lapsed")).quantity, (await inv("lapsed")).writtenOffQuantity], [0, 8]);
});

test("K3. retries replay once; an upward correction feeds waiting orders", async () => {
  await world();
  const b = await addStock(P, "LOT-K3", 2);
  const waiting = await create(b, 5); // 2 reserved, 3 backordered
  const requestId = rid();
  const first = await correct(b, 2, 6, { requestId, reasonCode: "count_discrepancy", reason: "Recount found 4 vials not recorded at intake" });
  assert.deepEqual(first.reallocated.map((x) => [x.orderId, x.units]), [[waiting.orderId, 3]]);
  const again = await correct(b, 2, 6, { requestId, reasonCode: "count_discrepancy" });
  assert.equal(again.replayed, true);
  assert.equal((await inv(b)).quantity, 6);
  assert.equal((await auditFor(b)).length, 1, "one correction, one entry");
  assert.equal(await codeOf(correct(b, 2, 9, { requestId })), "idempotency-conflict");
  assert.equal((await get("orders", waiting.orderId)).allocationState, "fully_reserved");
});

test("K4. a correction racing reservations never leaves a batch over-held", async () => {
  for (let round = 0; round < 5; round += 1) {
    await world();
    const b = await addStock(P, `LOT-K4-${round}`, 10);
    const results = await Promise.allSettled([correct(b, 10, 4), create(b, 6), create(b, 3)]);
    const s = await inv(b);
    assert.ok(availableOf(s) >= 0, `round ${round}: never over-held`);
    if (results[0].status === "fulfilled") assert.equal(s.quantity, 4, `round ${round}`);
    else {
      assert.ok(
        ["correction-below-held", "stock-changed"].includes(results[0].reason.code) || isTransientTransactionError(results[0].reason),
        `round ${round}: ${results[0].reason.code}`
      );
      assert.equal(s.quantity, 10);
    }
  }
});

// =============================================================== ARCHIVE RACES

// Commit order is read from the documents' own commit metadata (createTime /
// updateTime). Server-timestamp FIELDS are not evidence of it: the emulator
// resolves them when a commit request arrives, before it waits for a lock.
const commitMillis = (snap, which) => snap[which].toMillis();
const archiveCommit = async () => commitMillis(await db.collection("vaccines").doc(P).get(), "updateTime");

test("A4. Archive racing order creation: the order commits before Archive, or is refused after it", async () => {
  for (let round = 0; round < 8; round += 1) {
    await world();
    const b = await addStock(P, `LOT-A4-${round}`, 10);
    const [a, o] = await Promise.allSettled([archive(P, true), create(b, 2)]);
    assert.equal(a.status, "fulfilled", `round ${round}: archive always commits`);
    const archivedAt = await archiveCommit();
    if (o.status === "fulfilled") {
      const orderSnap = await db.collection("orders").doc(o.value.orderId).get();
      assert.ok(commitMillis(orderSnap, "createTime") <= archivedAt, `round ${round}: a placed order committed before Archive`);
    } else {
      assert.equal(o.reason.code, "vaccine-archived", `round ${round}: ${o.reason.code}`);
      assert.equal(await ordersCount(), 0, `round ${round}: nothing written`);
      assert.equal((await db.collection("orderRequestKeys").get()).size, 0);
    }
  }
});

test("A5. Archive racing Add Stock: the batch commits before Archive, or is refused after it", async () => {
  for (let round = 0; round < 8; round += 1) {
    await world();
    const [a, s] = await Promise.allSettled([archive(P, true), addStock(P, `LOT-A5-${round}`, 10)]);
    assert.equal(a.status, "fulfilled", `round ${round}`);
    const archivedAt = await archiveCommit();
    const batches = (await db.collection("inventory").get()).docs;
    if (s.status === "fulfilled") {
      assert.equal(batches.length, 1);
      assert.ok(commitMillis(batches[0], "createTime") <= archivedAt, `round ${round}: the batch committed before Archive`);
    } else {
      assert.equal(s.reason.code, "vaccine-archived", `round ${round}: ${s.reason.code}`);
      assert.equal(batches.length, 0, `round ${round}: no batch`);
    }
  }
});

// =============================================================== USAGE vs VOID RACES

test("U1. allocation racing Void: a batch is either voided unused, or used and never voidable", async () => {
  for (let round = 0; round < 6; round += 1) {
    await world();
    // A quote batch with nothing free, so the order's demand is served from B.
    const quoteBatch = await addStock(P, `LOT-U1-Q-${round}`, 1);
    await db.collection("inventory").doc(quoteBatch).update({ quantity: 0 });
    const b = await addStock(P, `LOT-U1-B-${round}`, 5);
    const [v, o] = await Promise.allSettled([voidBatch(b), create(quoteBatch, 3)]);
    assert.equal(o.status, "fulfilled", `round ${round}: the order is placed either way`);
    const s = await inv(b);
    if (v.status === "fulfilled") {
      assert.equal(s.voided, true);
      assert.equal(n(s.reservedQuantity), 0, `round ${round}: a voided batch was never reserved`);
      assert.equal(s.firstUsedAt, undefined, `round ${round}: and never marked used`);
    } else {
      assert.equal(v.reason.code, "batch-in-use", `round ${round}: ${v.reason.code}`);
      assert.ok(s.firstUsedAt, `round ${round}: the reservation marked it`);
      assert.equal(s.voided, undefined);
    }
    // Whatever happened: no batch that was ever used is (or can become) voided.
    for (const d of (await db.collection("inventory").get()).docs) {
      const x = d.data();
      assert.ok(!(x.voided && (x.firstUsedAt || n(x.reservedQuantity) > 0)), `round ${round}: ${d.id} voided after use`);
      if (x.firstUsedAt && !x.voided) assert.equal(await codeOf(voidBatch(d.id)), "batch-in-use", `round ${round}: ${d.id}`);
    }
  }
});

test("U2. every quote and reservation marks the batch in the transaction that relies on it", async () => {
  await world();
  const quoted = await addStock(P, "LOT-U2-Q", 3);
  const spare = await addStock(P, "LOT-U2-S", 4);
  assert.equal((await inv(quoted)).firstUsedAt, undefined);
  await create(quoted, 5); // quotes LOT-U2-Q; reserves 5 across both batches
  const q = await inv(quoted);
  const sp = await inv(spare);
  assert.equal(q.firstUsedBy, "order_quote", "the quote's own transaction marked it");
  assert.ok(sp.firstUsedAt, "the reserving transaction marked the other batch");
  assert.equal(sp.firstUsedBy, "allocation");
  assert.equal(q.reservedQuantity + sp.reservedQuantity, 5);
  // A batch reserved at its own creation (Add Stock feeding a waiting order).
  await create(quoted, 4); // nothing free: backordered
  const fresh = await addStock(P, "LOT-U2-F", 10);
  const f = await inv(fresh);
  assert.ok(f.reservedQuantity > 0);
  assert.equal(f.firstUsedBy, "allocation", "marked in Add Stock's own transaction");
  for (const id of [quoted, spare, fresh]) assert.equal(await codeOf(voidBatch(id)), "batch-in-use");
});
