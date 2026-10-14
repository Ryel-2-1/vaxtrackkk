"use strict";

// Clinic delivery geofence — the pure decision (src/deliveryGeofence.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/deliveryGeofence");

const CLINIC = { lat: 14.5995, lng: 120.9842 };
const RADIUS = 300;
const NOW = Date.parse("2026-10-10T08:00:00Z");
const UID = "riderA";
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
/** A point `m` metres due north of the clinic. */
const north = (m) => ({ lat: CLINIC.lat + m / M_PER_DEG_LAT, lng: CLINIC.lng });

const order = (over = {}) => ({
  destinationLat: CLINIC.lat,
  destinationLng: CLINIC.lng,
  destinationGeofenceRadiusM: RADIUS,
  destinationLocationVerified: true,
  ...over,
});
const loc = (point = CLINIC, over = {}) => ({
  riderUid: UID,
  trackingState: "active",
  latitude: point.lat,
  longitude: point.lng,
  accuracyMeters: 10,
  capturedAt: NOW - 30000,
  updatedAt: NOW - 29000,
  ...over,
});
const evaluate = (o, l) => G.evaluateDeliveryGeofence({ order: o, location: l, uid: UID, nowMs: NOW });
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
};

// ---------------------------------------------------------------- distance

test("Haversine: zero at the clinic, ~111.2 km per degree of latitude, symmetric", () => {
  assert.equal(G.haversineMeters(CLINIC, CLINIC), 0);
  const d = G.haversineMeters({ lat: 0, lng: 0.5 }, { lat: 1, lng: 0.5 });
  assert.ok(Math.abs(d - 111195) < 1, String(d));
  assert.equal(G.haversineMeters(CLINIC, north(250)), G.haversineMeters(north(250), CLINIC));
  assert.ok(Math.abs(G.haversineMeters(CLINIC, north(250)) - 250) < 0.01);
});

test("the exact radius boundary is inside; accuracy is never added to the radius", () => {
  // Find, by bisection, the furthest point whose computed distance is still
  // <= the radius, and the nearest one beyond it: the decision flips exactly
  // between them (distance <= radius is inside).
  let lo = RADIUS - 1;
  let hi = RADIUS + 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (G.haversineMeters(CLINIC, north(mid)) <= RADIUS) lo = mid;
    else hi = mid;
  }
  const inside = north(lo);
  const outside = north(hi);
  assert.ok(G.haversineMeters(CLINIC, inside) <= RADIUS);
  assert.ok(G.haversineMeters(CLINIC, outside) > RADIUS);
  assert.ok(RADIUS - G.haversineMeters(CLINIC, inside) < 1e-6, "the boundary point is at the radius");
  assert.equal(evaluate(order(), loc(inside)).eligible, true, "distance == radius is inside");
  assert.equal(codeOf(() => evaluate(order(), loc(outside))), "delivery-outside-geofence");
  // 50 m accuracy does NOT let a rider 320 m away count as inside 300 m.
  assert.equal(codeOf(() => evaluate(order(), loc(north(320), { accuracyMeters: 50 }))), "delivery-outside-geofence");
});

test("just inside and just outside", () => {
  assert.equal(evaluate(order(), loc(north(299.5))).eligible, true);
  let err;
  try {
    evaluate(order(), loc(north(300.5)));
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, "delivery-outside-geofence");
  assert.deepEqual(err.details, { distanceM: 301, radiusM: 300 });
  assert.equal(err.message, "You are 301 m from the clinic. Move within the 300 m delivery area before submitting.");
});

test("a safe summary only: distance, radius, age, accuracy", () => {
  assert.deepEqual(evaluate(order(), loc(north(120.2))), {
    eligible: true, distanceM: 121, radiusM: 300, locationAgeSeconds: 30, accuracyM: 10,
  });
});

// ---------------------------------------------------------------- destination

test("missing, unverified or invalid destination is blocked — no fallback coordinates or radius", () => {
  const bad = [
    order({ destinationLocationVerified: false }),
    order({ destinationLocationVerified: undefined }),
    order({ destinationLat: undefined }),
    order({ destinationLat: 0, destinationLng: 0 }),
    order({ destinationLat: 91 }),
    order({ destinationLng: "120.98" }),
    order({ destinationGeofenceRadiusM: undefined }),
    order({ destinationGeofenceRadiusM: 0 }),
    order({ destinationGeofenceRadiusM: 49 }),
    order({ destinationGeofenceRadiusM: 1001 }),
    order({ destinationGeofenceRadiusM: 300.5 }),
    {},
  ];
  for (const o of bad) assert.equal(codeOf(() => evaluate(o, loc())), "delivery-destination-invalid", JSON.stringify(o));
});

test("clinic-prefixed aliases are read only when the canonical fields are absent", () => {
  const legacy = { clinicLat: CLINIC.lat, clinicLng: CLINIC.lng, clinicGeofenceRadiusM: 200, clinicLocationVerified: true };
  assert.equal(evaluate(legacy, loc(north(150))).radiusM, 200);
  // Canonical present but unverified: the aliases cannot rescue it.
  assert.equal(codeOf(() => evaluate({ ...legacy, destinationLocationVerified: false }, loc())), "delivery-destination-invalid");
  // Canonical wins over a different alias.
  assert.equal(evaluate({ ...legacy, ...order() }, loc(north(250))).radiusM, 300);
});

// ---------------------------------------------------------------- freshness

test("exactly 3 minutes old is allowed; 3 minutes + 1 ms is stale", () => {
  const aged = (ms) => loc(CLINIC, { capturedAt: NOW - ms, updatedAt: NOW - ms });
  assert.equal(evaluate(order(), aged(G.MAX_LOCATION_AGE_MS)).locationAgeSeconds, 180);
  assert.equal(codeOf(() => evaluate(order(), aged(G.MAX_LOCATION_AGE_MS + 1))), "rider-location-stale");
  assert.equal(G.MAX_LOCATION_AGE_MS, 3 * 60 * 1000);
});

test("a future capture time cannot hide an old server write", () => {
  const l = loc(CLINIC, { capturedAt: NOW + 60000, updatedAt: NOW - G.MAX_LOCATION_AGE_MS - 1 });
  assert.equal(codeOf(() => evaluate(order(), l)), "rider-location-stale");
});

test("a late upload cannot hide an old captured fix", () => {
  const l = loc(CLINIC, { capturedAt: NOW - G.MAX_LOCATION_AGE_MS - 1, updatedAt: NOW - 1000 });
  assert.equal(codeOf(() => evaluate(order(), l)), "rider-location-stale");
});

test("missing timestamps cannot prove freshness", () => {
  assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { capturedAt: null }))), "rider-location-stale");
  assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { updatedAt: undefined }))), "rider-location-stale");
});

test("Firestore Timestamps and Dates are read the same way", () => {
  const ts = (ms) => ({ toMillis: () => ms });
  assert.equal(evaluate(order(), loc(CLINIC, { capturedAt: ts(NOW - 5000), updatedAt: new Date(NOW - 4000) })).eligible, true);
});

// ---------------------------------------------------------------- accuracy

test("accuracy exactly 100 m is allowed; over 100 m, missing or invalid is blocked", () => {
  assert.equal(evaluate(order(), loc(CLINIC, { accuracyMeters: 100 })).accuracyM, 100);
  for (const accuracyMeters of [100.01, 500, null, undefined, -1, Number.NaN, Infinity, "8"]) {
    assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { accuracyMeters }))), "rider-location-inaccurate", String(accuracyMeters));
  }
});

// ---------------------------------------------------------------- tracking state

test("tracking explicitly stopped, missing, or another rider's document is blocked", () => {
  assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { trackingState: "ended", latitude: null, longitude: null }))), "rider-location-unavailable");
  assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { trackingState: "ended" }))), "rider-location-unavailable");
  assert.equal(codeOf(() => evaluate(order(), null)), "rider-location-unavailable");
  assert.equal(codeOf(() => evaluate(order(), loc(CLINIC, { riderUid: "someoneElse" }))), "rider-location-unavailable");
  assert.equal(codeOf(() => evaluate(order(), loc({ lat: 0, lng: 0 }))), "rider-location-unavailable");
});

test("the decision never reads route-deviation state or client input", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../src/deliveryGeofence.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/riderDeviationStates|riderTracking|payload|request\.data/.test(src), false);
});
