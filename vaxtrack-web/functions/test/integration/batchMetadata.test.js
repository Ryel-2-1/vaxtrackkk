"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { updateBatchMetadata } = require("../../src/batchMetadata");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8181";
const app = admin.initializeApp({ projectId: "demo-vaxtrack-batch-metadata" }, "batch-metadata-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;
const now = new Date("2026-10-29T04:00:00Z");
const base = { batchId: "LOT-1", manufacturingDate: "2026-01-01", expiryDate: "2027-01-01", location: "Shelf 1", manufacturer: "Maker" };

test("an earlier expiry is refused while an open order holds the batch for a later delivery", async () => {
  await db.doc("users/admin").set({ role: "admin", status: "approved" });
  const lot = { ...base, batchId: "LOT-3" };
  await db.doc("inventory/three").set({ ...lot, quantity: 10, reservedQuantity: 2, usageTracked: true });
  await db.doc("orders/held").set({ orderNumber: "VT-HELD", status: "assigned", requestedDeliveryDate: "2026-12-15" });
  await db.doc("inventoryReservations/held").set({
    orderId: "held", status: "reserved", items: [{ lineIndex: 0, inventoryId: "three", quantity: 2 }], inventoryIds: ["three"],
  });
  const edit = (expected, expiryDate) => updateBatchMetadata({
    db, FieldValue, uid: "admin", email: "admin@test.invalid", now,
    payload: { inventoryId: "three", expected, ...expected, expiryDate },
  });
  try {
    await assert.rejects(edit(lot, "2026-12-01"), (e) => e.code === "batch-expiry-before-reservation" && /VT-HELD/.test(e.message) && /2026-12-15/.test(e.message));
    assert.equal((await db.doc("inventory/three").get()).data().expiryDate, "2027-01-01", "nothing changed");
    assert.equal((await edit(lot, "2026-12-15")).changed, true, "the delivery day itself is still covered");
    // A delivered order no longer holds stock for the future.
    await db.doc("orders/held").update({ status: "delivered" });
    assert.equal((await edit({ ...lot, expiryDate: "2026-12-15" }, "2026-11-15")).changed, true);
  } finally {
    const audits = await db.collection("inventoryAuditEvents").where("inventoryId", "==", "three").get();
    await Promise.all(audits.docs.map((doc) => doc.ref.delete()));
    await Promise.all(["inventory/three", "orders/held", "inventoryReservations/held"].map((path) => db.doc(path).delete()));
  }
});

test("Admin metadata edit is atomic and audited; stock and used identity are protected", async () => {
  await db.doc("users/admin").set({ role: "admin", status: "approved" });
  await db.doc("users/rep").set({ role: "sales_rep", status: "approved" });
  await db.doc("inventory/one").set({ ...base, quantity: 12, reservedQuantity: 3, usageTracked: true });
  await db.doc("inventory/two").set({ ...base, batchId: "TAKEN", quantity: 1, usageTracked: true });
  const call = (uid, expected, changes) => updateBatchMetadata({
    db, FieldValue, uid, email: "admin@test.invalid", now,
    payload: { inventoryId: "one", expected, ...changes },
  });
  try {
    await assert.rejects(call("rep", base, { ...base, location: "Shelf 2" }), { code: "wrong-role" });
    await assert.rejects(call("admin", base, { ...base, batchId: "TAKEN" }), { code: "batch-id-exists" });
    const result = await call("admin", base, { ...base, location: "Shelf 2", expiryDate: "2028-01-01" });
    assert.equal(result.changed, true);
    const current = (await db.doc("inventory/one").get()).data();
    assert.equal(current.location, "Shelf 2");
    assert.equal(current.quantity, 12);
    assert.equal(current.reservedQuantity, 3);
    const audits = await db.collection("inventoryAuditEvents").where("inventoryId", "==", "one").get();
    assert.equal(audits.size, 1);
    assert.equal(audits.docs[0].data().before.location, "Shelf 1");
    assert.equal(audits.docs[0].data().after.location, "Shelf 2");
    await assert.rejects(call("admin", base, { ...base, location: "Shelf 3" }), { code: "batch-changed" });
    await db.doc("inventory/one").update({ firstUsedAt: FieldValue.serverTimestamp() });
    const fresh = { ...base, location: "Shelf 2", expiryDate: "2028-01-01" };
    await assert.rejects(call("admin", fresh, { ...fresh, batchId: "NEW-ID" }), { code: "batch-id-locked" });
  } finally {
    const audits = await db.collection("inventoryAuditEvents").where("inventoryId", "==", "one").get();
    await Promise.all(audits.docs.map((doc) => doc.ref.delete()));
    await Promise.all(["users/admin", "users/rep", "inventory/one", "inventory/two"].map((path) => db.doc(path).delete()));
    await app.delete();
  }
});
