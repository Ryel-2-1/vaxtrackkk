"use strict";

// Real Firestore transactions. Run only through emulators:exec; NEVER a live project.
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
  throw new Error("Inventory visibility tests require a loopback Firestore emulator.");
}
const app = admin.initializeApp({ projectId: "demo-vaxtrack-visibility" }, "inventory-visibility");
const db = app.firestore();
const { FieldPath, Timestamp } = admin.firestore;
const ops = require("../../src/inventoryVisibilityOps");
const V = require("../../src/inventoryVisibility");
const at = (day) => new Date(`2031-01-${String(day).padStart(2, "0")}T02:00:00Z`);
const productRef = (id = "v1") => db.collection("vaccines").doc(id);
const batchRef = (id = "b1") => db.collection("inventory").doc(id);
const read = async (id = "v1") => (await productRef(id).get()).data();
const observe = (day, id = "v1", rest = {}) => ops.observeProductInventory({ db, vaccineId: id, now: at(day), ...rest });
const sweep = (day, rest = {}) => ops.reviewInventoryVisibilityRun({ db, FieldPath, now: at(day), ...rest });

async function reset() {
  for (const collection of ["vaccines", "inventory", ops.CURSOR_COLLECTION, "orders", "inventoryReservations", "inventoryAuditEvents"]) {
    await db.recursiveDelete(db.collection(collection));
  }
  await productRef().set({ vaccineName: "Example", archived: false, vatClassification: "vatable" });
  await batchRef().set({ vaccineId: "v1", quantity: 0, reservedQuantity: 0 });
}

test("VIS-E1 first observation starts a legacy clock now, not from ancient creation", async () => {
  await reset();
  await productRef().update({ createdAt: Timestamp.fromDate(new Date("2000-01-01")) });
  assert.equal((await observe(1)).state, "empty");
  assert.equal((await read()).inventoryEmptySince.toMillis(), at(1).getTime());
  assert.equal((await observe(2)).changed, false);
  assert.equal((await read()).inventoryEmptySince.toMillis(), at(1).getTime());
});

test("VIS-E2 a different batch's stock prevents hiding, including fully reserved doses", async () => {
  await reset();
  await observe(1);
  await batchRef("b2").set({ vaccineId: "v1", quantity: 10, reservedQuantity: 10 });
  await observe(2);
  assert.equal((await read()).inventoryStockState, "in_stock");
  assert.equal((await read()).inventoryEmptySince, null);
});

test("VIS-E3 restock then depletion starts a fresh interval; retries are idempotent", async () => {
  await reset();
  await observe(1);
  await batchRef().update({ quantity: 3 });
  await observe(2);
  await batchRef().update({ quantity: 0 });
  await observe(3);
  const ref = await productRef().get();
  assert.equal(ref.data().inventoryEmptySince.toMillis(), at(3).getTime());
  await Promise.all([observe(4), observe(4), observe(5)]);
  assert.ok((await productRef().get()).updateTime.isEqual(ref.updateTime));
});

test("VIS-E4 delayed/out-of-order positive snapshots cannot backdate or repeatedly reset the clock", async () => {
  await reset();
  await observe(1);
  const before = await batchRef().get();
  await batchRef().update({ quantity: 5 });
  const positive = await batchRef().get();
  await batchRef().update({ quantity: 0 });
  const zero = await batchRef().get();
  // Depletion event handled before restock event; current data, not payload, wins.
  await ops.observeInventoryWrite({ db, before: positive, after: zero, now: at(3) });
  assert.equal((await read()).inventoryEmptySince.toMillis(), at(3).getTime());
  const ref = await productRef().get();
  await ops.observeInventoryWrite({ db, before, after: positive, now: at(4) });
  await ops.observeInventoryWrite({ db, before: positive, after: zero, now: at(5) });
  assert.ok((await productRef().get()).updateTime.isEqual(ref.updateTime));
});

test("VIS-E5 invalid stock and held doses fail open, and recovery starts a new clock", async () => {
  await reset();
  await observe(1);
  for (const fields of [{ quantity: "0" }, { quantity: 0, reservedQuantity: 1 },
    { quantity: 0, reservedQuantity: 0, returnPendingQuantity: 2 }]) {
    await batchRef().update(fields);
    assert.equal((await observe(2)).state, "needs_review");
    assert.equal((await read()).inventoryEmptySince, null);
  }
  await batchRef().update({ quantity: 0, reservedQuantity: 0, returnPendingQuantity: 0 });
  await observe(3);
  assert.equal((await read()).inventoryEmptySince.toMillis(), at(3).getTime());
});

test("VIS-E6 manual archives are never undone; stock, orders, reservations and audit are untouched", async () => {
  await reset();
  await productRef().update({ archived: true, archiveReason: "Manual retirement" });
  await db.collection("orders").doc("o1").set({ status: "pending_dispatch", vaccineName: "Example" });
  await db.collection("inventoryReservations").doc("o1").set({ items: [] });
  const snapshot = async () => Promise.all(["inventory", "orders", "inventoryReservations", "inventoryAuditEvents"].map(async (c) =>
    (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }))));
  const before = await snapshot();
  await observe(1);
  await sweep(2);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await read()).archived, true);
  assert.equal((await read()).archiveReason, "Manual retirement");
});

test("VIS-E7 sweep advances a durable page cursor and eventually reaches the whole catalog", async () => {
  await reset();
  for (const id of ["v2", "v3", "v4", "v5"]) await productRef(id).set({ vaccineName: id });
  const r1 = await sweep(1, { pageSize: 2 });
  const r2 = await sweep(2, { pageSize: 2 });
  const r3 = await sweep(3, { pageSize: 2 });
  assert.deepEqual([r1.scanned, r2.scanned, r3.scanned], [2, 2, 1]);
  assert.deepEqual([r1.afterId, r2.afterId, r3.afterId], ["v2", "v4", null]);
  for (const id of ["v1", "v2", "v3", "v4", "v5"]) assert.equal((await read(id)).inventoryStockState, "empty");
});

test("VIS-E8 a failed product doesn't block others; the next catalog cycle retries it", async () => {
  await reset();
  await productRef("v2").set({ vaccineName: "Second" });
  const logs = [];
  const result = await sweep(1, {
    observe: async (args) => {
      if (args.vaccineId === "v1") throw new Error("injected");
      return ops.observeProductInventory(args);
    }, logFailure: (log) => logs.push(log),
  });
  assert.deepEqual([result.scanned, result.failed, result.changed], [2, 1, 1]);
  assert.deepEqual(logs, [{ vaccineId: "v1", errorType: "Error" }]);
  assert.equal((await read()).inventoryEmptySince, undefined);
  await sweep(2);
  assert.equal((await read()).inventoryEmptySince.toMillis(), at(2).getTime());
});

test("VIS-E9 products without batches are observed, missing products are not recreated", async () => {
  await reset();
  await productRef("v2").set({ vaccineName: "Not stocked yet" });
  await observe(1, "v2");
  assert.equal((await read("v2")).inventoryEmptySince.toMillis(), at(1).getTime());
  assert.deepEqual(await observe(1, "missing"), { skipped: "missing_product" });
  assert.equal((await productRef("missing").get()).exists, false);
});

test("VIS-E10 observation racing a stock write eventually converges to current stock", async () => {
  await reset();
  await Promise.all([observe(1), batchRef().update({ quantity: 10 })]);
  await observe(2); // real trigger/sweep backstop, no replay of old counters
  assert.equal((await read()).inventoryStockState, "in_stock");
  assert.equal((await read()).inventoryEmptySince, null);
  assert.equal((await batchRef().get()).data().quantity, 10);
});

test("VIS-E11 oversized batch query is incomplete and must never confirm empty", async () => {
  await reset();
  for (let offset = 0; offset < V.MAX_PRODUCT_BATCHES; offset += 400) {
    const write = db.batch();
    for (let i = offset; i < Math.min(offset + 400, V.MAX_PRODUCT_BATCHES); i++) {
      write.set(batchRef(`extra_${i}`), { vaccineId: "v1", quantity: 0 });
    }
    await write.commit();
  }
  assert.equal((await observe(1)).state, "needs_review");
  assert.equal((await read()).inventoryEmptySince, null);
});

test.after(async () => app.delete());
