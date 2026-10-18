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

// A passed preflight is early feedback only — it authorizes nothing. Each case
// below passes the preflight, then the Rider's latest trusted fix changes
// before the completion is pressed; completion re-reads it and refuses with no
// Delivered transition, no consumption and no history. A NEW good fix then
// completes exactly once, showing the decision is made at completion time.
async function refusedAfterPassedPreflight({ change, completeAt = NOW, code }) {
  await world();
  await locate(north(100));
  const passed = await preflight();
  assert.equal(passed.eligible, true);
  await change();
  const before = await snapshot();
  const at = completeAt;
  assert.equal(
    await codeOf(ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: ORDER, now: at })),
    code
  );
  const after = await snapshot();
  assert.deepEqual(after, before, code);
  assert.equal(after.order.status, "in_transit", code);
  assert.equal(after.reservation.status, "reserved", code);
  assert.equal(after.inventory.quantity, 10, code);
  assert.equal(after.inventory.reservedQuantity, 2, code);
  assert.equal(after.history, 0, code);
  // Recovery is a fresh, good fix — not the earlier preflight.
  await ref("riderLocations", RIDER).set({
    riderUid: RIDER, trackingState: "active", latitude: CLINIC.lat, longitude: CLINIC.lng, accuracyMeters: 10,
    capturedAt: Timestamp.fromMillis(at.getTime() - 5000), updatedAt: Timestamp.fromMillis(at.getTime() - 5000),
  });
  const done = await ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: ORDER, now: at });
  assert.equal(done.status, "delivered", code);
  const settled = await snapshot();
  assert.equal(settled.reservation.status, "consumed", code);
  assert.equal(settled.inventory.quantity, 8, code);
  assert.equal(settled.inventory.reservedQuantity, 0, code);
}

test("after a passed preflight, a latest fix OUTSIDE the radius refuses completion (no consumption, not Delivered)", async () => {
  await refusedAfterPassedPreflight({
    change: () => locate(north(RADIUS + 1), { ageMs: 5000 }),
    code: "delivery-outside-geofence",
  });
});

test("after a passed preflight, the fix going STALE (no new fix for over 3 min) refuses completion", async () => {
  // The preflight saw a 20 s old fix; nothing new arrives, and the Rider
  // presses Complete 3 min later (fix age 3 min 20 s > the 3 min limit).
  await refusedAfterPassedPreflight({
    change: async () => {},
    completeAt: new Date(NOW.getTime() + 3 * 60 * 1000),
    code: "rider-location-stale",
  });
});

test("after a passed preflight, a latest fix with unacceptable ACCURACY refuses completion — even at the clinic", async () => {
  await refusedAfterPassedPreflight({
    change: () => locate(CLINIC, { ageMs: 5000, accuracyMeters: 101 }),
    code: "rider-location-inaccurate",
  });
});

test("an ASSIGNED order (not yet dispatched) is refused by the preflight and the completion, at the clinic with evidence", async () => {
  await world({ order: { status: "assigned" } });
  await locate(CLINIC);
  const before = await snapshot();
  assert.equal(await codeOf(preflight()), "invalid-status-transition");
  assert.equal(await codeOf(complete()), "invalid-status-transition");
  const after = await snapshot();
  assert.deepEqual(after, before);
  assert.equal(after.order.status, "assigned");
  assert.equal(after.reservation.status, "reserved");
  assert.equal(after.history, 0);
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

// ---------------------------------------------------------------- proof/completion eligibility (Delayed bug)

test("Delayed + inside the geofence: preflight and completion refuse 'delivery-delayed'; nothing changes", async () => {
  await world({ order: { status: "delayed" } });
  await locate(north(40));
  const before = await snapshot();
  await assert.rejects(preflight(), (e) => e.code === "delivery-delayed" && /Resume it \(In Transit\)/.test(e.message));
  assert.equal(await codeOf(complete()), "delivery-delayed");
  assert.deepEqual(await snapshot(), before, "no status, reservation, inventory or history change");
});

test("Delayed + outside the geofence: refused for being Delayed (status is decided before location)", async () => {
  await world({ order: { status: "delayed" } });
  await locate(north(900));
  const before = await snapshot();
  assert.equal(await codeOf(preflight()), "delivery-delayed");
  assert.equal(await codeOf(complete()), "delivery-delayed");
  assert.deepEqual(await snapshot(), before);
});

test("In Transit + outside: refused; In Transit + inside + valid location: completes once", async () => {
  await world();
  await locate(north(301)); // just beyond the configured 300 m radius
  assert.equal(await codeOf(preflight()), "delivery-outside-geofence");
  await locate(north(299), { ageMs: 1000 }); // within the configured radius
  assert.equal((await preflight()).eligible, true);
  assert.equal((await complete()).consumed, true);
});

test("reported Delayed after a successful preflight (e.g. during uploads): completion refuses, stock untouched; resuming allows it", async () => {
  await world();
  await locate(north(60));
  assert.equal((await preflight()).eligible, true);
  // The rider (or another device) reports a delay while the photos upload.
  await ref("orders", ORDER).update({ status: "delayed" });
  const before = await snapshot();
  assert.equal(await codeOf(complete()), "delivery-delayed");
  assert.deepEqual(await snapshot(), before, "not delivered, nothing consumed, reservation still reserved");
  assert.equal(before.reservation.status, "reserved");
  // Resumed (in transit) and still at the clinic: the recorded evidence completes it once.
  await ref("orders", ORDER).update({ status: "in_transit" });
  assert.equal((await complete()).consumed, true);
  assert.equal((await get("inventory", "inv1")).quantity, 8);
});

test("only the order id is accepted: any client-supplied status, destination, radius or location is refused", async () => {
  await world();
  await locate(north(5000)); // far away — an override would be the only way in
  const before = await snapshot();
  for (const extra of [
    { status: "in_transit" },
    { destinationLat: north(5000).lat, destinationLng: north(5000).lng },
    { destinationGeofenceRadiusM: 100000 },
    { latitude: CLINIC.lat, longitude: CLINIC.lng, accuracyMeters: 1 },
  ]) {
    const payload = { orderId: ORDER, ...extra };
    assert.equal(
      await codeOf(ops.validateDeliveryCompletionGeofence({ db, uid: RIDER, orderId: ORDER, payload, now: NOW })),
      "invalid-payload",
      JSON.stringify(extra)
    );
    assert.equal(
      await codeOf(ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId: ORDER, payload, now: NOW })),
      "invalid-payload",
      JSON.stringify(extra)
    );
  }
  assert.deepEqual(await snapshot(), before);
  // The normal request (order id only) is still decided on the server's own data.
  const plain = ops.validateDeliveryCompletionGeofence({ db, uid: RIDER, orderId: ORDER, payload: { orderId: ORDER }, now: NOW });
  assert.equal(await codeOf(plain), "delivery-outside-geofence");
});

test("repeated taps: concurrent completions consume the reservation exactly once", async () => {
  await world();
  await locate(north(20));
  const results = await Promise.allSettled([complete(), complete(), complete()]);
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  assert.ok(ok.length >= 1, "at least one succeeds");
  assert.equal(ok.filter((r) => r.consumed === true).length, 1, "exactly one consumes");
  assert.equal((await get("inventory", "inv1")).quantity, 8);
  assert.equal((await get("inventory", "inv1")).reservedQuantity, 0);
  assert.equal((await get("inventoryReservations", ORDER)).status, "consumed");
  assert.equal((await get("orders", ORDER)).status, "delivered");
  assert.equal((await snapshot()).history, 1, "one consumption event");
});
