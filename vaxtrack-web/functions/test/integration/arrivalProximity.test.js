"use strict";

/**
 * Arrival proximity against a REAL Firestore (emulator), through the trigger
 * handlers in src/arrivalProximityOps.js (called directly, as the other
 * integration suites do). Run: npm run test:emulator (in functions/).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-proximity" }, "proximity-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;
const ops = require("../../src/arrivalProximityOps");
const P = require("../../src/arrivalProximity");

const RIDER = "riderP";
const ORDER = "orderP";
const CLINIC = { lat: 14.5995, lng: 120.9842 };
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const T0 = Date.parse("2026-11-01T08:00:00Z");
const MIN = 60 * 1000;

const orderDoc = (over = {}) => ({
  orderNumber: "VT-ORD-1-PROX",
  status: "in_transit",
  assignedRiderId: RIDER,
  assignedRiderName: "Rider Prox",
  clinicName: "Prox Clinic",
  destinationLat: CLINIC.lat,
  destinationLng: CLINIC.lng,
  destinationGeofenceRadiusM: 300,
  destinationLocationVerified: true,
  ...over,
});
const fix = (at, m = 40) => ({
  riderUid: RIDER,
  trackingState: "active",
  latitude: CLINIC.lat + m / M_PER_DEG_LAT,
  longitude: CLINIC.lng,
  accuracyMeters: 8,
  capturedAt: admin.firestore.Timestamp.fromMillis(at),
  updatedAt: admin.firestore.Timestamp.fromMillis(at + 1000),
});
const run = (at, m) => ops.processLocationProximity({ db, FieldValue, riderUid: RIDER, location: fix(at, m), nowMs: at + 2000 });
const prox = async () => (await db.collection(P.PROXIMITY_COLLECTION).doc(ORDER).get()).data() ?? null;
const alertsFor = async () => (await db.collection("alerts").where("orderId", "==", ORDER).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function reset() {
  for (const ref of [db.doc(`orders/${ORDER}`), db.doc(`${P.PROXIMITY_COLLECTION}/${ORDER}`)]) await ref.delete();
  for (const a of (await db.collection("alerts").where("orderId", "==", ORDER).get()).docs) await a.ref.delete();
}

test("near is confirmed by fixes, the alert is raised once after 15 min, and delivery resolves it", async () => {
  await reset();
  await db.doc(`orders/${ORDER}`).set(orderDoc());

  await run(T0);
  assert.equal((await prox()).confirmedAtMs, null, "one fix: tracked, not confirmed");
  for (let t = T0 + MIN; t <= T0 + 2 * MIN; t += MIN) await run(t);
  assert.equal((await prox()).confirmedAtMs, T0 + 2 * MIN, "confirmed after two minutes inside");

  // Heartbeats keep arriving while the Rider waits at the clinic.
  for (let t = T0 + 3 * MIN; t <= T0 + 17 * MIN; t += 2 * MIN) await run(t);
  let alerts = await alertsFor();
  assert.equal(alerts.length, 1, "raised once");
  assert.equal(alerts[0].id, P.proximityAlertId(ORDER, T0 + 2 * MIN));
  assert.equal(alerts[0].type, P.ALERT_TYPE);
  assert.equal(alerts[0].status, "active");
  assert.match(alerts[0].message, /Rider Prox has been within 300 m of Prox Clinic for 15 minutes, but Order VT-ORD-1-PROX has not been completed/);
  await run(T0 + 19 * MIN);
  assert.equal((await alertsFor()).length, 1, "a later fix does not raise it again");

  // Delivered: the order trigger clears proximity and resolves the alert.
  const before = (await db.doc(`orders/${ORDER}`).get()).data();
  const after = { ...before, status: "delivered" };
  await db.doc(`orders/${ORDER}`).set(after);
  const settled = await ops.settleProximityOnOrderWrite({ db, FieldValue, orderId: ORDER, before, after });
  assert.equal(settled.reason, "delivered");
  assert.equal(await prox(), null);
  alerts = await alertsFor();
  assert.equal(alerts[0].status, "resolved");
  assert.equal(alerts[0].resolutionReason, "delivered");
  // Replayed order write: nothing more to do, nothing breaks.
  await ops.settleProximityOnOrderWrite({ db, FieldValue, orderId: ORDER, before, after });
  assert.equal((await alertsFor())[0].status, "resolved");
});

test("leaving the clinic, or a reassignment, clears the state; no alert is raised", async () => {
  await reset();
  await db.doc(`orders/${ORDER}`).set(orderDoc());
  await run(T0);
  await run(T0 + 2 * MIN);
  assert.ok((await prox()).confirmedAtMs);
  await run(T0 + 3 * MIN, 900);
  assert.equal(await prox(), null, "outside the radius");

  await run(T0 + 4 * MIN);
  assert.ok(await prox());
  await db.doc(`orders/${ORDER}`).set(orderDoc({ assignedRiderId: "someoneElse" }));
  await run(T0 + 5 * MIN);
  assert.equal(await prox(), null, "the Rider no longer carries the order");
  assert.equal((await alertsFor()).length, 0);
});

test.after(async () => {
  await reset();
  await app.delete();
});
