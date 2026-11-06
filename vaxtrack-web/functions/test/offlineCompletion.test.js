"use strict";

// Offline delivery completion — the pure decision (src/offlineCompletion.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../src/offlineCompletion");

const CLINIC = { lat: 14.5995, lng: 120.9842 };
const RADIUS = 50;
const T0 = Date.parse("2026-11-02T08:00:00Z");
const MIN = 60 * 1000;
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const north = (m) => ({ lat: CLINIC.lat + m / M_PER_DEG_LAT, lng: CLINIC.lng });

const order = (over = {}) => ({
  status: "in_transit",
  assignedRiderId: "riderA",
  destinationLat: CLINIC.lat,
  destinationLng: CLINIC.lng,
  destinationGeofenceRadiusM: RADIUS,
  destinationLocationVerified: true,
  dispatchedAt: T0 - 60 * MIN,
  ...over,
});
const capture = (over = {}) => ({ ...north(10), accuracyM: 8, capturedAtMs: T0, ...over });
const point = (metersNorth, atMs, accuracyM = 10) => ({ ...north(metersNorth), accuracyM, atMs });
// Rode in from 3 km away, last trusted fix 6 minutes before the handoff.
const TRAIL = [point(6000, T0 - 20 * MIN), point(3000, T0 - 6 * MIN)];
const decide = (over = {}) =>
  O.evaluateOfflineCapture({ order: order(over.order), capture: capture(over.capture), trail: over.trail ?? TRAIL, receivedAtMs: over.receivedAtMs ?? T0 + 30 * MIN });

test("a fix inside the geofence that fits the tracked trail is accepted", () => {
  const d = decide();
  assert.equal(d.ok, true);
  assert.equal(d.radiusM, RADIUS);
  assert.ok(d.distanceM <= RADIUS);
});

test("the 3-hour window is measured from capture to the server receiving it", () => {
  assert.equal(decide({ receivedAtMs: T0 + 3 * 60 * MIN }).ok, true, "exactly 3 h is still accepted");
  const late = decide({ receivedAtMs: T0 + 3 * 60 * MIN + 1 });
  assert.deepEqual([late.ok, late.reason], [false, "too_old"]);
  assert.match(O.reviewMessage(late.reason, late), /more than 3 hours.*\(3 h 0 min after it was recorded\)/);
});

test("a phone clock ahead of the server, or a fix before leaving the hub, goes to review", () => {
  assert.equal(decide({ receivedAtMs: T0 - 3 * MIN }).reason, "clock_ahead");
  assert.equal(decide({ receivedAtMs: T0 - 1 * MIN }).ok, true, "a small clock difference is allowed");
  assert.equal(decide({ order: { dispatchedAt: T0 + 10 * MIN } }).reason, "before_dispatch");
});

test("same location rules as live completion: accuracy and the order's own radius", () => {
  assert.equal(decide({ capture: { accuracyM: 101 } }).reason, "poor_accuracy");
  assert.equal(decide({ capture: { accuracyM: 100 } }).ok, true);
  const outside = decide({ capture: north(51) });
  assert.deepEqual([outside.ok, outside.reason], [false, "outside_geofence"]);
  assert.equal(decide({ order: { destinationLocationVerified: false } }).reason, "destination_invalid");
});

test("a fix that does not fit the tracked trail goes to review", () => {
  // Last trusted fix 40 km away one minute earlier: not reachable.
  assert.equal(decide({ trail: [point(40000, T0 - MIN)] }).reason, "implausible_track");
  // The first fix after it is 40 km away a minute later: not reachable either.
  assert.equal(decide({ trail: [...TRAIL, point(40000, T0 + MIN)] }).reason, "implausible_track");
  // Moving on to the next stop 2 km away 10 minutes later is fine.
  assert.equal(decide({ trail: [...TRAIL, point(2000, T0 + 10 * MIN)] }).ok, true);
  // No trusted fix before it: it cannot be placed, so a person decides.
  assert.equal(decide({ trail: [] }).reason, "no_track");
  assert.equal(decide({ trail: [point(100, T0 + MIN)] }).reason, "no_track");
});

test("every review reason has a dispatcher message", () => {
  for (const reason of Object.keys(O.REVIEW_REASONS)) assert.ok(O.reviewMessage(reason).length > 10, reason);
});

test("the payload accepts the order id and the recorded fix only", () => {
  const ok = { orderId: "o1", capture: { latitude: CLINIC.lat, longitude: CLINIC.lng, accuracyMeters: 5, capturedAtMs: T0 } };
  assert.deepEqual(O.parseOfflinePayload(ok), { orderId: "o1", capture: { lat: CLINIC.lat, lng: CLINIC.lng, accuracyM: 5, capturedAtMs: T0, mocked: false } });
  const mocked = { ...ok, capture: { ...ok.capture, mocked: true } };
  assert.equal(O.parseOfflinePayload(mocked).capture.mocked, true);
  const bad = [
    { ...ok, capture: { ...ok.capture, mocked: "yes" } },
    null,
    { ...ok, status: "delivered" },
    { ...ok, capture: { ...ok.capture, distanceM: 1 } },
    { ...ok, orderId: "a/b" },
    { ...ok, capture: { ...ok.capture, latitude: 91 } },
    { ...ok, capture: { ...ok.capture, accuracyMeters: -1 } },
    { ...ok, capture: { ...ok.capture, capturedAtMs: 1.5 } },
  ];
  for (const p of bad) assert.throws(() => O.parseOfflinePayload(p), { code: "invalid-payload" }, JSON.stringify(p));
});

test("only promptly stored, active, accurate fixes enter the trail", () => {
  const loc = (over = {}) => ({
    trackingState: "active", latitude: CLINIC.lat, longitude: CLINIC.lng, accuracyMeters: 10,
    capturedAt: T0, updatedAt: T0 + 5000, ...over,
  });
  assert.deepEqual(O.trailPointFrom(loc()), { lat: CLINIC.lat, lng: CLINIC.lng, accuracyM: 10, atMs: T0 });
  assert.equal(O.trailPointFrom(loc({ updatedAt: T0 + 61 * 1000 })), null, "queued offline and uploaded late");
  assert.equal(O.trailPointFrom(loc({ trackingState: "ended" })), null);
  assert.equal(O.trailPointFrom(loc({ accuracyMeters: 150 })), null);
  assert.equal(O.trailPointFrom(loc({ latitude: null })), null);
  assert.equal(O.trailPointFrom(loc({ mockedLocation: true })), null, "from a mock-location app");
  assert.ok(O.trailPointFrom(loc({ mockedLocation: false })));
});

test("a capture the phone reported as mocked always goes to review, even inside the geofence", () => {
  const d = decide({ capture: { mocked: true } });
  assert.deepEqual([d.ok, d.reason], [false, "mocked_location"]);
  assert.ok(d.distanceM <= RADIUS, "the distance is still given to the reviewer");
  assert.match(O.reviewMessage(d.reason, d), /mock-location/);
});

test("the trail keeps one point a minute (unless the rider moved), 4 hours, bounded", () => {
  const a = point(0, T0);
  assert.deepEqual(O.appendTrailPoint([], a, T0), [a]);
  assert.equal(O.appendTrailPoint([a], point(10, T0 + 20 * 1000), T0), null, "too soon and too close");
  assert.equal(O.appendTrailPoint([a], point(500, T0 + 20 * 1000), T0).length, 2, "moved: kept");
  assert.equal(O.appendTrailPoint([a], point(0, T0 + MIN), T0).length, 2, "a minute later: kept");
  assert.equal(O.appendTrailPoint([a], point(0, T0 - 1), T0), null, "older than the last point");
  const old = point(0, T0 - 5 * 60 * MIN);
  assert.deepEqual(O.appendTrailPoint([old], a, T0), [a], "older than 4 h is dropped");
  const many = Array.from({ length: O.TRAIL_MAX_POINTS }, (_, i) => point(0, T0 - (O.TRAIL_MAX_POINTS - i) * MIN / 2));
  assert.equal(O.appendTrailPoint(many, point(0, T0 + MIN), T0 + MIN).length, O.TRAIL_MAX_POINTS);
});
