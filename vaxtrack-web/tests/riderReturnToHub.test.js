import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as web from "../src/services/riderTracking.js";
import { RIDER_TRIP_STATES } from "../src/services/riderTrip.js";

/**
 * Return-to-hub location sharing.
 *
 * After the last order of a trip settles, the server keeps the Rider in
 * `returning_to_hub` (riderDispatchStates, server-written) until a Dispatcher
 * confirms the return. The rider app keeps sharing location — no order, no
 * navigation — until then or sign-out, and Admin / Dispatcher Live Tracking
 * lists the rider as "Returning to hub" with the location's real freshness.
 * Arrival is never inferred from a position or a missing one.
 */

const require = createRequire(import.meta.url);
const dispatch = require("../functions/src/riderDispatch.js");
const serverTracking = require("../functions/src/riderTracking.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const DART = read("../vaxtrack_mobile/lib/tracking/tracking_contract.dart");

function dartConst(name) {
  const m = DART.match(new RegExp(`const String ${name} = '([^']+)';`));
  assert.ok(m, `${name} is declared in tracking_contract.dart`);
  return m[1];
}
function dartList(name) {
  const m = DART.match(new RegExp(`const List<String> ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} is declared in tracking_contract.dart`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const NOW = Date.UTC(2026, 9, 1, 8, 0, 0);
const loc = (over = {}) => ({
  latitude: 14.6,
  longitude: 121.0,
  accuracyMeters: 12,
  capturedAt: NOW - 30_000,
  updatedAt: NOW - 29_000,
  trackingState: "active",
  ...over,
});
const order = (id, status, rider) => ({ id, status, assignedRiderId: rider, orderNumber: `VT-${id}` });
const trips = (entries) => new Map(Object.entries(entries).map(([uid, state]) => [uid, { id: uid, state }]));

// ---------------------------------------------------------------- one contract

test("the rider app, the server and the web agree on the trip states and collection", () => {
  assert.equal(dartConst("kRiderDispatchStatesCollection"), dispatch.RIDER_DISPATCH_STATES);
  assert.equal(dartConst("kTripStateOnTrip"), dispatch.STATE.ON_TRIP);
  assert.equal(dartConst("kTripStateReturning"), dispatch.STATE.RETURNING);
  assert.equal(dartConst("kTripStateAvailable"), dispatch.STATE.AVAILABLE);
  assert.deepEqual(dartList("kHubBoundTripStates"), [dispatch.STATE.ON_TRIP, dispatch.STATE.RETURNING]);
  assert.equal(web.TRIP_STATE_RETURNING, dispatch.STATE.RETURNING);
  assert.equal(RIDER_TRIP_STATES.RETURNING, dispatch.STATE.RETURNING);
});

// ---------------------------------------------------------------- fleet

test("a returning rider with zero active orders is listed, labelled, with the location's own freshness", () => {
  const fleet = web.buildFleet({
    orders: [order("a", "delivered", "r1"), order("b", "in_transit", "r2")],
    locations: { r1: loc(), r2: loc() },
    deviations: {},
    riders: { r1: { fullName: "Ana" }, r2: { fullName: "Ben" } },
    tripStates: trips({ r1: "returning_to_hub", r2: "on_trip" }),
    nowMs: NOW,
  });
  const ana = fleet.find((r) => r.uid === "r1");
  assert.ok(ana, "listed with no active order");
  assert.equal(ana.returningToHub, true);
  assert.deepEqual(ana.orders, []);
  assert.equal(ana.state, "fresh");
  assert.deepEqual(ana.latLng, [14.6, 121.0]);
  assert.equal(ana.deviationText, web.RETURNING_MONITORING_TEXT, "no route is monitored");
  assert.equal(fleet.find((r) => r.uid === "r2").returningToHub, false);
  assert.deepEqual(web.fleetCounts(fleet), { onDelivery: 1, returning: 1 });
});

test("freshness is the location's, never a guess: stale, offline, sharing stopped and no position all stay 'returning'", () => {
  const cases = {
    stale: loc({ capturedAt: NOW - 5 * 60_000, updatedAt: NOW - 5 * 60_000 }),
    offline: loc({ capturedAt: NOW - 30 * 60_000, updatedAt: NOW - 30 * 60_000 }),
    ended: loc({ trackingState: "ended", latitude: null, longitude: null }),
  };
  const fleet = web.buildFleet({
    orders: [],
    locations: cases,
    tripStates: trips({ stale: "returning_to_hub", offline: "returning_to_hub", ended: "returning_to_hub", none: "returning_to_hub" }),
    nowMs: NOW,
  });
  const by = Object.fromEntries(fleet.map((r) => [r.uid, r]));
  assert.equal(by.stale.state, "stale");
  assert.equal(by.offline.state, "offline");
  assert.equal(by.ended.state, "offline");
  assert.equal(by.ended.latLng, null, "a cleared position is not drawn");
  assert.equal(by.none.state, "unavailable");
  for (const r of fleet) assert.equal(r.returningToHub, true, `${r.uid}: still returning — arrival is not inferred`);
});

test("only returning_to_hub adds a rider; other trip states with no active order do not", () => {
  const fleet = web.buildFleet({
    orders: [],
    locations: { a: loc(), b: loc(), c: loc(), d: loc() },
    tripStates: trips({ a: "available_at_hub", b: "trip_forming", c: "on_trip", d: "something_else" }),
    nowMs: NOW,
  });
  assert.deepEqual(fleet, []);
  // Without trip states (feed not loaded / failed) the fleet is as before.
  assert.deepEqual(web.buildFleet({ orders: [], locations: { a: loc() }, nowMs: NOW }), []);
  // A plain object of state docs works too.
  assert.equal(web.buildFleet({ orders: [], locations: {}, tripStates: { x: { state: "returning_to_hub" } }, nowMs: NOW }).length, 1);
});

test("return confirmed (available_at_hub): the rider drops off the map, whatever the last position says", () => {
  const args = { orders: [], locations: { r1: loc() }, nowMs: NOW };
  assert.equal(web.buildFleet({ ...args, tripStates: trips({ r1: "returning_to_hub" }) }).length, 1);
  assert.equal(web.buildFleet({ ...args, tripStates: trips({ r1: "available_at_hub" }) }).length, 0);
});

test("a leftover deviation document never marks a returning rider as deviating", () => {
  const [r] = web.buildFleet({
    orders: [],
    locations: { r1: loc() },
    deviations: { r1: { sessionState: "navigating", routeStatus: "available", phase: "deviating", orderId: "old" } },
    tripStates: trips({ r1: "returning_to_hub" }),
    nowMs: NOW,
  });
  assert.equal(r.state, "fresh");
  assert.equal(r.navigatingOrderId, null);
  assert.equal(r.deviation, "not_navigating");
});

test("a rider with an active order is 'on delivery' even if the trip doc lags", () => {
  const [r] = web.buildFleet({
    orders: [order("a", "assigned", "r1")],
    locations: { r1: loc() },
    tripStates: trips({ r1: "returning_to_hub" }),
    nowMs: NOW,
  });
  assert.equal(r.returningToHub, false);
  assert.equal(r.orders.length, 1);
});

test("dashboard overview rows say 'Returning to hub' instead of a delivery count", () => {
  const fleet = web.buildFleet({ orders: [], locations: { r1: loc() }, tripStates: trips({ r1: "returning_to_hub" }), nowMs: NOW });
  const { rows } = web.trackingOverviewRows(fleet, NOW);
  assert.equal(rows[0].deliveryLabel, "Returning to hub");
  assert.equal(rows[0].orderNumbers, "");
  assert.equal(rows[0].label, "Fresh");
});

// ---------------------------------------------------------------- privacy (server)

test("a returning rider has no Med Rep viewers: the server index empties once every order settles", () => {
  const { viewerUids, activeOrderIds } = serverTracking.viewersForRider("r1", [
    { id: "a", data: { assignedRiderId: "r1", status: "delivered", createdByUid: "sr1" } },
    { id: "b", data: { assignedRiderId: "r1", status: "cancelled", createdByUid: "sr2" } },
  ]);
  assert.deepEqual(viewerUids, []);
  assert.deepEqual(activeOrderIds, []);
});

// ---------------------------------------------------------------- wiring

test("Live Tracking and the dashboard overview read trip states through the shared, read-only feeds", () => {
  const feeds = strip(read("src/components/tracking/useRiderTrackingFeeds.js"));
  assert.match(feeds, /import \{ subscribeRiderDispatchStates \} from "\.\.\/\.\.\/services\/riderDispatchService";/);
  assert.match(feeds, /return \{ locations, deviations, tripStates, error, deviationError, tripStatesError, retry \};/);
  assert.equal(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction|httpsCallable/.test(feeds), false);
  const panel = strip(read("src/components/tracking/LiveTrackingPanel.jsx"));
  assert.match(panel, /buildFleet\(\{ orders, locations, deviations, riders, tripStates, nowMs \}\)/);
  assert.match(panel, /tripStatesError &&/);
  assert.match(panel, /does not mean the rider has arrived/);
  const overview = strip(read("src/components/tracking/DispatcherTrackingOverview.jsx"));
  assert.match(overview, /buildFleet\(\{ orders, locations, deviations, riders: ridersById, tripStates, nowMs \}\)/);
  assert.match(strip(read("src/components/tracking/FleetMap.jsx")), /r\.returningToHub \?/);
});

test("nothing on the web infers arrival from coordinates", () => {
  const code = strip(read("src/services/riderTracking.js"));
  for (const word of ["haversine", "distanceTo", "arrived", "atHub"]) {
    assert.equal(code.includes(word), false, `riderTracking.js must not use ${word}`);
  }
});
