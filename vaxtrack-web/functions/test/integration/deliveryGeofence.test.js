"use strict";

/**
 * Clinic delivery geofence against a REAL Firestore (emulator): the preflight
 * callable's operation and the authoritative re-check inside the completion
 * transaction. Run: npm run test:emulator (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-delivery-geofence" }, "delivery-geofence-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const ops = require("../../src/operations");
const { ALLOCATION_VERSION } = require("../../src/policy");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const RIDER = "geoRider";
const OTHER = "geoRider2";
const ORDER = "geoOrder";
const CLINIC = { lat: 14.5995, lng: 120.9842 };
const RADIUS = 300;
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const north = (m) => ({ lat: CLINIC.lat + m / M_PER_DEG_LAT, lng: CLINIC.lng });
const NOW = new Date("2026-10-10T08:00:00.000Z");

const ref = (c, id) => db.collection(c).doc(id);
const get = async (c, id) => {
  const s = await ref(c, id).get();
  return s.exists ? s.data() : null;
};

async function wipe() {
  for (const c of ["users", "orders", "inventoryReservations", "inventory", "riderLocations", "riderDeviationStates", "inventoryAllocationEvents"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

/** An in-transit, fully reserved order at the clinic, assigned to RIDER, with both photos recorded. */
async function world({ order: over = {}, evidence = true } = {}) {
  await wipe();
  await ref("users", RIDER).set({ role: "rider", status: "approved" });
  await ref("users", OTHER).set({ role: "rider", status: "approved" });
  await ref("inventory", "inv1").set({ quantity: 10, reservedQuantity: 2, sellingPriceCentavos: 125000 });
  await ref("inventoryReservations", ORDER).set({ status: "reserved", items: [{ inventoryId: "inv1", quantity: 2 }] });
  await ref("orders", ORDER).set({
    orderNumber: "VT-ORD-GEO",
    status: "in_transit",
    assignedRiderId: RIDER,
    createdByUid: "rep1",
    allocationVersion: ALLOCATION_VERSION,
    items: [{ inventoryId: "inv1", quantity: 2 }],
    destinationLat: CLINIC.lat,
    destinationLng: CLINIC.lng,
    destinationGeofenceRadiusM: RADIUS,
    destinationLocationVerified: true,
    ...(evidence ? {
      proofOfDeliveryUrl: `https://storage/${ORDER}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(ORDER),
      proofRecipientName: "Maria Santos", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
      invoiceUrl: `https://storage/${ORDER}/invoice.jpg`, invoicePath: canonicalInvoicePath(ORDER),
      invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
    } : {}),
    ...over,
  });
}

/** The rider's tracking document, as the app writes it (rules-shaped). */
function locate(point, { ageMs = 20000, accuracyMeters = 10, trackingState = "active", uid = RIDER } = {}) {
  const at = Timestamp.fromMillis(NOW.getTime() - ageMs);
  return ref("riderLocations", uid).set({
    riderUid: uid, trackingState, latitude: point.lat, longitude: point.lng, accuracyMeters, capturedAt: at, updatedAt: at,
  });
}

const preflight = (uid = RIDER) => ops.validateDeliveryCompletionGeofence({ db, uid, orderId: ORDER, now: NOW });
const complete = (uid = RIDER) => ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid, orderId: ORDER, now: NOW });
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};

/** Everything a refused completion must leave exactly as it was. */
async function snapshot() {
  const order = await get("orders", ORDER);
  return {
    order,
    reservation: await get("inventoryReservations", ORDER),
    inventory: await get("inventory", "inv1"),
    // Consumption history is a top-level ledger (orderHistory.js).
    history: (await db.collection("inventoryAllocationEvents").get()).size,
  };
}

test("inside: preflight is eligible with a safe summary, and completion consumes once", async () => {
  await world();
  await locate(north(120));
  assert.deepEqual(await preflight(), { eligible: true, distanceM: 120, radiusM: 300, locationAgeSeconds: 20, accuracyM: 10 });
  const r = await complete();
  assert.deepEqual([r.status, r.consumed, r.replayed], ["delivered", true, false]);
  assert.equal((await get("inventory", "inv1")).quantity, 8);
  assert.equal((await get("inventoryReservations", ORDER)).status, "consumed");
  assert.equal((await snapshot()).history, 1, "one consumption event — so an unchanged count elsewhere is meaningful");
});

test("outside: preflight and completion refuse; status, reservation, inventory and history unchanged", async () => {
  await world();
  await locate(north(450));
  const before = await snapshot();
  await assert.rejects(preflight(), (e) => e.code === "delivery-outside-geofence" && e.details.distanceM === 450 && e.details.radiusM === 300);
  assert.equal(await codeOf(complete()), "delivery-outside-geofence");
  assert.deepEqual(await snapshot(), before);
});

test("the preflight writes nothing, whatever it decides", async () => {
  await world({ evidence: false });
  await locate(north(450));
  const before = await snapshot();
  await codeOf(preflight());
  await locate(north(10));
  await preflight();
  const after = await snapshot();
  assert.deepEqual(after, before, "no proof, invoice, status or stock change");
  assert.equal(after.order.proofOfDeliveryUrl, undefined);
  assert.equal(after.order.invoiceUrl, undefined);
});

test("missing or unverified destination is blocked", async () => {
  for (const over of [
    { destinationLocationVerified: false },
    { destinationLat: FieldValue.delete(), destinationLng: FieldValue.delete() },
    { destinationGeofenceRadiusM: FieldValue.delete() },
  ]) {
    await world();
    await ref("orders", ORDER).update(over);
    await locate(CLINIC);
    const before = await snapshot();
    assert.equal(await codeOf(preflight()), "delivery-destination-invalid", JSON.stringify(Object.keys(over)));
    assert.equal(await codeOf(complete()), "delivery-destination-invalid");
    assert.deepEqual(await snapshot(), before);
  }
});

test("missing, stale, low-accuracy or stopped Rider location is blocked", async () => {
  const cases = [
    [async () => {}, "rider-location-unavailable"],
    [() => locate(CLINIC, { ageMs: 3 * 60 * 1000 + 1 }), "rider-location-stale"],
    [() => locate(CLINIC, { accuracyMeters: 150 }), "rider-location-inaccurate"],
    [() => locate(CLINIC, { trackingState: "ended" }), "rider-location-unavailable"],
  ];
  for (const [setup, code] of cases) {
    await world();
    await setup();
    const before = await snapshot();
    assert.equal(await codeOf(preflight()), code);
    assert.equal(await codeOf(complete()), code);
    assert.deepEqual(await snapshot(), before, code);
  }
  // Boundaries that pass: exactly 3 minutes old, exactly 100 m accuracy.
  await world();
  await locate(CLINIC, { ageMs: 3 * 60 * 1000, accuracyMeters: 100 });
  assert.equal((await preflight()).eligible, true);
});

test("a wrong or reassigned Rider is blocked — even standing at the clinic", async () => {
  await world();
  await locate(CLINIC, { uid: OTHER });
  assert.equal(await codeOf(preflight(OTHER)), "not-assigned-rider");
  assert.equal(await codeOf(complete(OTHER)), "not-assigned-rider");
});

test("cancelled, failed, loading and delivered orders stay protected", async () => {
  for (const status of ["cancelled", "delivery_failed", "loading", "assigned"]) {
    await world({ order: { status } });
    await locate(CLINIC);
    const before = await snapshot();
    assert.equal(await codeOf(preflight()), "invalid-status-transition", status);
    assert.equal(await codeOf(complete()), "invalid-status-transition", status);
    assert.deepEqual(await snapshot(), before, status);
  }
  // Delivered: the preflight refuses; completion replays without consuming again.
  await world();
  await locate(CLINIC);
  await complete();
  const done = await snapshot();
  assert.equal(await codeOf(preflight()), "invalid-status-transition");
  await locate(north(5000)); // even far away, a replay is a no-op success
  assert.equal((await complete()).replayed, true);
  assert.deepEqual(await snapshot(), done);
});

test("moving outside after a successful preflight fails at completion; nothing is consumed", async () => {
  await world();
  await locate(north(100));
  assert.equal((await preflight()).eligible, true);
  await locate(north(600), { ageMs: 5000 });
  const before = await snapshot();
  assert.equal(await codeOf(complete()), "delivery-outside-geofence");
  assert.deepEqual(await snapshot(), before);
});

test("reassignment after a successful preflight fails at completion", async () => {
  await world();
  await locate(CLINIC);
  assert.equal((await preflight()).eligible, true);
  await ref("orders", ORDER).update({ assignedRiderId: OTHER });
  const before = await snapshot();
  assert.equal(await codeOf(complete()), "not-assigned-rider");
  assert.deepEqual(await snapshot(), before);
});

test("completion-only retry: refused outside, then completes once inside without touching the evidence", async () => {
  await world();
  await locate(north(400));
  const evidence = await get("orders", ORDER);
  assert.equal(await codeOf(complete()), "delivery-outside-geofence");
  await locate(north(50), { ageMs: 1000 });
  const r = await complete();
  assert.equal(r.consumed, true);
  const after = await get("orders", ORDER);
  for (const k of ["proofOfDeliveryUrl", "proofOfDeliveryPath", "invoiceUrl", "invoicePath", "proofSubmittedByUid", "invoiceSubmittedByUid"]) {
    assert.equal(after[k], evidence[k], `${k} unchanged`);
  }
  assert.equal((await get("inventory", "inv1")).quantity, 8, "consumed exactly once");
  assert.equal((await complete()).replayed, true, "a repeated valid completion stays idempotent");
  assert.equal((await get("inventory", "inv1")).quantity, 8);
});

test("route-deviation state never decides delivery eligibility", async () => {
  // Deviating per the route monitor, but at the clinic: eligible.
  await world();
  await ref("riderDeviationStates", RIDER).set({ sessionState: "navigating", routeStatus: "available", phase: "deviating" });
  await locate(north(40));
  assert.equal((await preflight()).eligible, true);
  // On route per the route monitor, but outside the clinic geofence: refused.
  await world();
  await ref("riderDeviationStates", RIDER).set({ sessionState: "navigating", routeStatus: "available", phase: "on_route" });
  await locate(north(700));
  assert.equal(await codeOf(preflight()), "delivery-outside-geofence");
});
