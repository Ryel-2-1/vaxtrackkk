"use strict";

/**
 * Stock and expiry alerts against a REAL Firestore (emulator): a vaccine's
 * batches and reorder configuration open, update and clear its alerts, and the
 * Admin's "Check stock now" sweeps the catalog. Run: npm run test:emulator.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-stock-alerts" }, "stock-alerts-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;
const ops = require("../../src/stockAlertsOps");
const S = require("../../src/stockAlerts");

const NOW = new Date("2026-11-03T02:00:00.000Z"); // 10:00 in Manila
const ref = (c, id) => db.collection(c).doc(id);
const alert = async (id) => {
  const s = await ref("alerts", id).get();
  return s.exists ? s.data() : null;
};

async function wipe() {
  for (const c of ["users", "vaccines", "inventory", "inventoryAnalyticsConfig", "alerts"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function world() {
  await wipe();
  await ref("users", "adm").set({ role: "admin", status: "approved" });
  await ref("users", "disp").set({ role: "dispatcher", status: "approved" });
  await ref("vaccines", "v1").set({ vaccineName: "Hep B" });
  await ref("inventory", "b1").set({ vaccineId: "v1", batchId: "HEP-001", quantity: 50, reservedQuantity: 10, expiryDate: "2027-06-30" });
  await ref("inventory", "b2").set({ vaccineId: "v1", batchId: "HEP-002", quantity: 8, reservedQuantity: 0, expiryDate: "2026-11-20" });
  await ref("inventoryAnalyticsConfig", "v1").set({ vaccineId: "v1", enabled: true, leadTimeDays: 7, safetyStockQuantity: 60 });
}

const review = () => ops.reviewProductStockAlerts({ db, FieldValue, vaccineId: "v1", now: NOW });

test("low stock and an expiring batch open as Admin alerts; a restock clears the low-stock one", async () => {
  await world();
  await review();
  const low = await alert(S.stockAlertId("v1"));
  assert.deepEqual([low.type, low.status, low.severity, low.availableQuantity, low.audience], ["stock_low", "active", "warning", 48, "admin"]);
  const soon = await alert(S.expiryAlertId("b2"));
  assert.deepEqual([soon.type, soon.conditionKey, soon.expiryDate], ["batch_expiry", "expiring", "2026-11-20"]);
  assert.equal(await alert(S.expiryAlertId("b1")), null);

  await ref("inventory", "b1").update({ quantity: 200 });
  await review();
  const cleared = await alert(S.stockAlertId("v1"));
  assert.deepEqual([cleared.status, cleared.resolvedBy, cleared.resolutionReason], ["resolved", "server", "cleared"]);
});

test("a repeat review writes nothing new; out of stock escalates the open alert as unread", async () => {
  await world();
  await review();
  await ref("alerts", S.stockAlertId("v1")).update({ read: true });
  assert.equal((await review()).written, 0);
  await ref("inventory", "b1").update({ reservedQuantity: 50 });
  await ref("inventory", "b2").update({ reservedQuantity: 8 });
  await review();
  const out = await alert(S.stockAlertId("v1"));
  assert.deepEqual([out.conditionKey, out.severity, out.read], ["out", "critical", false]);
});

test("an expired batch with vials on hand is critical; disposing of it clears the alert", async () => {
  await world();
  await ref("inventory", "b2").update({ expiryDate: "2026-11-01" });
  await review();
  assert.equal((await alert(S.expiryAlertId("b2"))).conditionKey, "expired");
  await ref("inventory", "b2").update({ quarantinedQuantity: 8 });
  await review();
  assert.equal((await alert(S.expiryAlertId("b2"))).status, "resolved");
});

test("an alert an Admin resolved stays resolved while nothing gets worse", async () => {
  await world();
  await review();
  await ref("alerts", S.stockAlertId("v1")).update({ status: "resolved" });
  await ref("inventory", "b1").update({ quantity: 49 }); // still low, a little lower
  await review();
  assert.equal((await alert(S.stockAlertId("v1"))).status, "resolved");
});

test("archiving a vaccine clears its alerts", async () => {
  await world();
  await review();
  await ref("vaccines", "v1").update({ archived: true });
  await review();
  assert.equal((await alert(S.stockAlertId("v1"))).status, "resolved");
  assert.equal((await alert(S.expiryAlertId("b2"))).status, "resolved");
});

test("Check stock now: Admins only, and it sweeps every vaccine", async () => {
  await world();
  await ref("vaccines", "v2").set({ vaccineName: "Rabies" });
  await ref("inventory", "r1").set({ vaccineId: "v2", batchId: "RAB-001", quantity: 3, reservedQuantity: 3, expiryDate: "2027-01-01" });
  await assert.rejects(ops.recheckStockAlerts({ db, FieldValue, uid: "disp", now: NOW }), { code: "wrong-role" });
  const r = await ops.recheckStockAlerts({ db, FieldValue, uid: "adm", now: NOW });
  assert.deepEqual([r.checked, r.failed], [2, 0]);
  assert.equal((await alert(S.stockAlertId("v2"))).conditionKey, "out");
  assert.ok(await alert(S.stockAlertId("v1")));
});
