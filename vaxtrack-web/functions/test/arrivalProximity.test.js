"use strict";

// Arrival proximity — the pure decision (src/arrivalProximity.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/arrivalProximity");

const CLINIC = { lat: 14.5995, lng: 120.9842 };
const RADIUS = 300;
const UID = "riderA";
const ORDER_ID = "order1";
const T0 = Date.parse("2026-11-01T08:00:00Z");
const MIN = 60 * 1000;
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const north = (m) => ({ lat: CLINIC.lat + m / M_PER_DEG_LAT, lng: CLINIC.lng });

const order = (over = {}) => ({
  status: "in_transit",
  assignedRiderId: UID,
  destinationLat: CLINIC.lat,
  destinationLng: CLINIC.lng,
  destinationGeofenceRadiusM: RADIUS,
  destinationLocationVerified: true,
  ...over,
});
/** A fix captured at `at` (written a second later), `m` metres north. */
const fix = (at, m = 50, over = {}) => ({
  riderUid: UID,
  trackingState: "active",
  latitude: north(m).lat,
  longitude: north(m).lng,
  accuracyMeters: 10,
  capturedAt: at,
  updatedAt: at + 1000,
  ...over,
});
const step = (previous, at, { m = 50, o = order(), loc = {} } = {}) =>
  P.nextProximity({ previous, order: o, orderId: ORDER_ID, riderUid: UID, location: fix(at, m, loc), nowMs: at + 2000 });

test("two trusted fixes ≥ 2 min apart inside the radius confirm 'near'; one never does", () => {
  const a = step(null, T0);
  assert.equal(a.reason, "started");
  assert.equal(a.next.confirmedAtMs, null, "one GPS point never claims the Rider is near");
  const b = step(a.next, T0 + 1 * MIN);
  assert.equal(b.next.confirmedAtMs, null, "a minute is not enough");
  const c = step(b.next, T0 + 2 * MIN);
  assert.equal(c.next.confirmedAtMs, T0 + 2 * MIN);
  assert.equal(c.next.firstFixMs, T0);
  // Once confirmed it stays confirmed at the same moment.
  assert.equal(step(c.next, T0 + 3 * MIN).next.confirmedAtMs, T0 + 2 * MIN);
});

test("outside, untrusted or discontinuous fixes reset the visit", () => {
  const near = step(step(null, T0).next, T0 + 2 * MIN).next;
  assert.equal(step(near, T0 + 3 * MIN, { m: 400 }).next, null, "outside the radius");
  assert.equal(step(near, T0 + 3 * MIN, { loc: { accuracyMeters: 150 } }).next, null, "inaccurate");
  assert.equal(step(near, T0 + 3 * MIN, { loc: { trackingState: "ended" } }).next, null, "sharing stopped");
  const gap = step(near, T0 + 2 * MIN + P.CONTINUITY_MS + 1000);
  assert.equal(gap.reason, "started", "a gap restarts the visit");
  assert.equal(gap.next.confirmedAtMs, null);
});

test("only an in-transit or delayed order of THIS rider, with a verified destination", () => {
  for (const o of [order({ status: "delivered" }), order({ status: "assigned" }), order({ assignedRiderId: "other" }),
    order({ destinationLocationVerified: false }), null]) {
    assert.equal(step(null, T0, { o }).next, null);
  }
  assert.ok(step(null, T0, { o: order({ status: "delayed" }) }).next);
});

test("a replayed fix changes nothing", () => {
  const a = step(null, T0).next;
  const replay = step(a, T0);
  assert.equal(replay.reason, "replay");
  assert.equal(replay.next, a);
});

test("awaiting completion is due 15 minutes after confirmation, by the Rider's own fixes", () => {
  const confirmed = { confirmedAtMs: T0, lastFixMs: T0 + 14 * MIN };
  assert.equal(P.awaitingCompletionDue(confirmed), false);
  assert.equal(P.awaitingCompletionDue({ ...confirmed, lastFixMs: T0 + 15 * MIN }), true);
  assert.equal(P.awaitingCompletionDue({ confirmedAtMs: null, lastFixMs: T0 + 60 * MIN }), false);
  assert.equal(P.proximityAlertId("o1", T0), `awaiting_completion_o1_${T0}`);
});

test("the alert ends with the order: delivered, failed, cancelled, reassigned or parked", () => {
  assert.equal(P.resolutionReasonFor({ status: "delivered", assignedRiderId: UID }, UID), "delivered");
  assert.equal(P.resolutionReasonFor({ status: "delivery_failed", assignedRiderId: UID }, UID), "delivery_failed");
  assert.equal(P.resolutionReasonFor({ status: "cancelled", assignedRiderId: UID }, UID), "cancelled");
  assert.equal(P.resolutionReasonFor({ status: "in_transit", assignedRiderId: "other" }, UID), "reassigned");
  assert.equal(P.resolutionReasonFor({ status: "pending_dispatch", assignedRiderId: UID }, UID), "no_longer_in_transit");
  assert.equal(P.resolutionReasonFor(null, UID), "order_removed");
  assert.equal(P.resolutionReasonFor({ status: "delayed", assignedRiderId: UID }, UID), null, "still on its way");
});
