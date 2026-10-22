"use strict";

// Rider tracking + route deviation — the pure contract (src/riderTracking.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../src/riderTracking");
const { encode } = require("./helpers/polyline");

// A straight east-west road through Manila, ~1.08 km long, split in two segments.
const A = { lat: 14.6, lng: 121.0 };
const B = { lat: 14.6, lng: 121.005 };
const C = { lat: 14.6, lng: 121.01 };
const ROUTE = [A, B, C];
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
/** A point `meters` north of the middle of the road. */
const north = (meters, lng = 121.0025) => ({ lat: 14.6 + meters / M_PER_DEG_LAT, lng });

const T0 = Date.parse("2026-10-10T02:00:00Z");
const sample = (point, secondsAfter, accuracyMeters = 10) => ({ ...point, accuracyMeters, atMs: T0 + secondsAfter * 1000 });
/**
 * Feed samples in order, each with the PREVIOUS sample's time as the rider's
 * previous fix (what the trigger gets from the location document's prior
 * version). `prev` seeds it when continuing from an earlier run. Returns the
 * final state, every event, the ignore reasons and which samples were writes.
 */
function run(samples, { state = null, route = ROUTE, rules, prev = null } = {}) {
  let s = state;
  let previousSampleAtMs = prev;
  const events = [];
  const ignored = [];
  const writes = [];
  for (const smp of samples) {
    const r = T.evaluateDeviation({ state: s, sample: smp, route, previousSampleAtMs, ...(rules ? { rules } : {}) });
    s = r.state;
    if (r.event) events.push(r.event);
    if (r.ignored) ignored.push(r.ignored);
    if (r.changed) writes.push(smp.atMs);
    previousSampleAtMs = smp.atMs;
  }
  return { state: s, events, ignored, writes };
}
const at = (seconds) => T0 + seconds * 1000;

// ---------------------------------------------------------------- geometry

test("distance from a coordinate to a route segment is the perpendicular distance", () => {
  const d = T.distanceToPolylineMeters(north(300), [A, C]);
  assert.ok(Math.abs(d - 300) < 0.5, `${d}`);
  // Beyond a segment's end it measures to the endpoint, not the infinite line.
  const past = { lat: 14.6, lng: 121.011 };
  assert.ok(Math.abs(T.distanceToPolylineMeters(past, [A, C]) - T.haversineMeters(past, C)) < 0.5);
});

test("nearest distance across a multi-segment polyline — never just to the destination", () => {
  // An L-shaped route: east then north. A point beside the first leg is near it,
  // although far from the destination at the end of the second leg.
  const D = { lat: 14.61, lng: 121.01 };
  const route = [A, C, D];
  const p = north(120, 121.004);
  assert.ok(Math.abs(T.distanceToPolylineMeters(p, route) - 120) < 0.5);
  assert.ok(T.haversineMeters(p, D) > 1000, "the destination is far away");
  assert.equal(T.distanceToPolylineMeters(p, []), Infinity);
});

test("polyline decoding is exact and refuses malformed input", () => {
  const decoded = T.decodePolyline(encode(ROUTE));
  assert.deepEqual(decoded, ROUTE);
  for (const bad of ["", null, 42, "~~~~", "\u0001\u0002", "_p~iF~ps|U_ulLnnqC_mqNvxq`@" + "\u007f"]) {
    assert.deepEqual(T.decodePolyline(bad), [], String(bad));
  }
});

test("the authoritative route: whole-trip route for a trip stop, else the order's own; never a straight line", () => {
  const order = { routePolyline: encode(ROUTE), assignedAt: T0, routeGeneratedAt: T0 + 60000 };
  assert.deepEqual([T.routeForOrder(order).available, T.routeForOrder(order).source], [true, "order"]);
  const trip = { ...order, tripId: "t1", stopSequence: 2, tripPolyline: encode([A, C]), tripGeneratedAt: T0 + 120000 };
  assert.equal(T.routeForOrder(trip).source, "trip");
  assert.equal(T.routeForOrder(trip).points.length, 2);
  // Clinic and rider coordinates alone never make a route.
  const noRoute = { clinicLat: 14.61, clinicLng: 121.02, lastLocation: { lat: 14.6, lng: 121 }, assignedAt: T0 };
  assert.deepEqual(T.routeForOrder(noRoute), { available: false, source: null, points: [], fingerprint: null, reason: "missing" });
  assert.notEqual(T.routeForOrder(order).fingerprint, T.routeForOrder({ ...order, routePolyline: encode([A, B]) }).fingerprint);
});

test("a stored route is used only for the CURRENT assignment and destination", () => {
  const base = { routePolyline: encode(ROUTE), assignedAt: T0, routeGeneratedAt: T0 + 1 };
  assert.equal(T.routeForOrder(base).available, true);
  // Generated before the current assignment (requeue + reassignment keep the
  // old route, which started at the previous rider's position).
  assert.equal(T.routeForOrder({ ...base, routeGeneratedAt: T0 - 1 }).reason, "generated_before_assignment");
  assert.equal(T.routeForOrder({ ...base, routeGeneratedAt: T0 }).available, true, "same instant counts as current");
  // Missing timestamps cannot prove ownership.
  assert.equal(T.routeForOrder({ ...base, routeGeneratedAt: undefined }).available, false);
  assert.equal(T.routeForOrder({ ...base, assignedAt: undefined }).available, false);
  // Route for an older destination revision.
  assert.equal(T.routeForOrder({ ...base, destinationRevision: 1 }).reason, "destination_changed");
  assert.equal(T.routeForOrder({ ...base, destinationRevision: 1, routeDestinationRevision: 1 }).available, true);
  // Trip generated before a destination correction.
  const trip = { ...base, tripId: "t1", stopSequence: 1, tripPolyline: encode([A, C]), tripGeneratedAt: T0 + 10 };
  assert.equal(T.routeForOrder(trip).available, true);
  assert.equal(T.routeForOrder({ ...trip, destinationCorrectedAt: T0 + 20 }).reason, "destination_changed");
  assert.equal(T.routeForOrder({ ...trip, tripGeneratedAt: T0 - 5 }).reason, "generated_before_assignment");
  // Malformed polyline.
  assert.equal(T.routeForOrder({ ...base, routePolyline: "~~~" }).reason, "malformed");
  // Firestore Timestamps work as well as numbers.
  const ts = (ms) => ({ toMillis: () => ms });
  assert.equal(T.routeForOrder({ ...base, assignedAt: ts(T0), routeGeneratedAt: ts(T0 + 5) }).available, true);
});

// ---------------------------------------------------------------- deviation rule

test("exactly the 500 m boundary is on route; just beyond it counts", () => {
  const p = north(500);
  const d = T.distanceToPolylineMeters(p, ROUTE);
  const at = { ...T.DEVIATION_RULES, offRouteMeters: d };
  const r = run([sample(p, 0), sample(p, 60), sample(p, 120), sample(p, 200)], { rules: at });
  assert.equal(r.events.length, 0, "a distance equal to the threshold is not 'more than' it");
  assert.equal(r.state.pendingOffSinceMs, null);
  const beyond = run([sample(p, 0), sample(p, 60), sample(p, 120), sample(p, 180)], { rules: { ...at, offRouteMeters: d - 0.01 } });
  assert.equal(beyond.events[0]?.type, "deviated");
  assert.equal(T.DEVIATION_RULES.offRouteMeters, 500);
});

test("more than 500 m for less than 3 minutes does not deviate", () => {
  const far = north(800);
  const r = run([sample(far, 0), sample(far, 60), sample(far, 120), sample(far, 179)]);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.phase, "on_route");
  assert.equal(r.state.pendingOffSinceMs, T0);
});

test("more than 500 m continuously for 3 minutes deviates — once", () => {
  const far = north(800);
  const r = run([sample(far, 0), sample(far, 60), sample(far, 120), sample(far, 180), sample(far, 240), sample(far, 300)]);
  assert.equal(r.events.length, 1);
  assert.deepEqual([r.events[0].type, r.events[0].sinceMs, r.events[0].atMs], ["deviated", T0, T0 + 180000]);
  assert.ok(r.events[0].distanceMeters > 500);
  assert.deepEqual([r.state.phase, r.state.episode], ["deviating", 1]);
});

test("returning within 500 m before 3 minutes resets the pending timer", () => {
  const far = north(800);
  const near = north(100);
  const r = run([sample(far, 0), sample(far, 120), sample(near, 150), sample(far, 160), sample(far, 260), sample(far, 300)]);
  assert.equal(r.events.length, 0, "the timer restarted at 160 s; 300 − 160 < 180");
  assert.equal(r.state.pendingOffSinceMs, T0 + 160000);
  const later = run([sample(far, 340)], { state: r.state, prev: at(300) });
  assert.equal(later.events[0]?.type, "deviated");
});

test("a gap in samples breaks continuity — 3 minutes is never inferred across missing data", () => {
  const far = north(800);
  const r = run([sample(far, 0), sample(far, 200)]); // 200 s gap > 2 min
  assert.equal(r.events.length, 0);
  assert.equal(r.state.pendingOffSinceMs, T0 + 200000);
});

test("poor-accuracy or invalid readings are ignored and never trigger or reset", () => {
  const far = north(800);
  const near = north(50);
  const r = run([sample(far, 0), sample(near, 60, 250), sample({ lat: 999, lng: 1 }, 70), sample(far, 120), sample(far, 180)]);
  assert.deepEqual(r.ignored, ["poor_accuracy", "invalid_coordinates"]);
  assert.equal(r.events[0]?.type, "deviated", "the inaccurate 'near' fix did not reset the timer");
  // A single inaccurate far-away reading on its own triggers nothing.
  const one = run([sample(north(5000), 0, 500), sample(north(5000), 300, 500)]);
  assert.deepEqual([one.events.length, one.state.pendingOffSinceMs], [0, null]);
  assert.deepEqual(run([{ ...north(800), atMs: T0 }]).ignored, ["poor_accuracy"], "no accuracy = unusable");
});

test("stale and out-of-order samples are rejected; replays are no-ops", () => {
  const far = north(800);
  const r = run([sample(far, 120), sample(far, 60), sample(far, 120)]);
  assert.deepEqual(r.ignored, ["out_of_order", "out_of_order"]);
  assert.equal(r.state.lastTransitionAtMs, T0 + 120000);
  assert.equal(r.state.pendingOffSinceMs, T0 + 120000);
  // Samples at or before the session start never count.
  assert.deepEqual(T.evaluateDeviation({ state: null, sample: sample(far, 10), route: ROUTE, notBeforeMs: at(10) }).ignored, "before_session");
});

test("hysteresis: 400–500 m does not recover; < 400 m for 2 minutes returns to route", () => {
  const far = north(800);
  const band = north(450);
  const back = north(100);
  const deviated = run([sample(far, 0), sample(far, 60), sample(far, 120), sample(far, 180)]).state;
  const inBand = run([sample(band, 240), sample(band, 300), sample(band, 360), sample(band, 420)], { state: deviated, prev: at(180) });
  assert.deepEqual([inBand.events.length, inBand.state.phase], [0, "deviating"], "no flapping near the boundary");
  const returned = run([sample(back, 480), sample(back, 540), sample(back, 600)], { state: inBand.state, prev: at(420) });
  assert.equal(returned.events[0]?.type, "returned");
  assert.equal(returned.state.phase, "on_route");
  // A dip back off-route interrupts recovery.
  const interrupted = run([sample(back, 480), sample(far, 540), sample(back, 560), sample(back, 660)], { state: inBand.state, prev: at(420) });
  assert.equal(interrupted.events.length, 0);
});

test("no route produces no deviation — ever", () => {
  const far = north(5000);
  for (const route of [[], [A], null]) {
    const r = run([sample(far, 0), sample(far, 60), sample(far, 120), sample(far, 180), sample(far, 240)], { route });
    assert.equal(r.events.length, 0);
    assert.ok(r.ignored.every((x) => x === "no_route"));
  }
});

test("a sample from a location document clamps a future device clock to the server time", () => {
  const loc = {
    trackingState: "active", latitude: 14.6, longitude: 121, accuracyMeters: 8,
    capturedAt: { toMillis: () => T0 + 60000 }, updatedAt: { toMillis: () => T0 },
  };
  assert.equal(T.sampleFromLocation(loc).sample.atMs, T0);
  assert.equal(T.sampleFromLocation({ ...loc, trackingState: "ended" }).reason, "not_tracking");
  assert.equal(T.sampleFromLocation({ ...loc, latitude: 0, longitude: 0 }).reason, "invalid_coordinates");
});

// ---------------------------------------------------------------- alerts, events, ids

const ctx = { orderId: "order1", riderUid: "rider1", sessionId: "sess_abc12345", orderNumber: "VT-ORD-1", riderName: "Juan" };

test("only one open alert per rider/order/session; reopen and resolve on transitions", () => {
  const dev = { type: "deviated", distanceMeters: 812.4, sinceMs: T0, atMs: T0 + 180000 };
  const create = T.planAlertWrite({ existing: null, transition: dev, context: ctx });
  assert.equal(create.action, "create");
  assert.deepEqual([create.data.type, create.data.status, create.data.severity, create.data.source], ["route_deviation", "active", "critical", "server"]);
  assert.equal(create.data.message, "Juan is 812 m away from the planned route for Order VT-ORD-1. The deviation has continued for at least 3 minutes.");
  assert.deepEqual(
    [create.data.presentationVersion, create.data.thresholdMeters, create.data.minimumDurationMinutes, create.data.path],
    [1, 500, 3, "/dispatcher/shipments?order=order1"]
  );
  assert.equal(T.planAlertWrite({ existing: { status: "active", episodeCount: 1 }, transition: dev, context: ctx }).action, "noop", "never a second open alert");
  const reopen = T.planAlertWrite({ existing: { status: "resolved", episodeCount: 1 }, transition: dev, context: ctx });
  assert.deepEqual([reopen.action, reopen.data.episodeCount], ["reopen", 2]);
  const resolve = T.planAlertWrite({ existing: { status: "active" }, transition: { type: "returned" }, context: ctx });
  assert.deepEqual([resolve.action, resolve.data.resolutionReason], ["resolve", "returned_to_route"]);
  assert.equal(resolve.data.message, "Juan returned to the planned route for Order VT-ORD-1.", "a resolved alert no longer says off route");
  // Closed from the stored state (no names in the context): the alert's own names are used.
  const closed = T.planAlertWrite({
    existing: { status: "active", riderName: "Abdul Malik", orderNumber: "VT-ORD-1791165600000-6IMB" },
    transition: { type: "session_closed", reason: "abandoned" },
    context: { orderId: "o1", riderUid: "r1", sessionId: "sess_abc12345" },
  });
  assert.equal(closed.data.message, "Route monitoring for Order 6IMB has ended.");
  assert.equal(T.planAlertWrite({ existing: null, transition: { type: "returned" }, context: ctx }).action, "noop", "a return never creates an alert");
  assert.equal(T.planAlertWrite({ existing: { status: "active" }, transition: { type: "session_closed", reason: "completed" }, context: ctx }).data.resolutionReason, "completed");
});

test("alert wording: human order code, friendly distance, never an id; safe without names", () => {
  assert.equal(T.orderCodeOf("VT-ORD-1791165600000-6IMB"), "6IMB");
  assert.equal(T.orderCodeOf("VT-ORD-1783611813231"), "VT-ORD-1783611813231", "a legacy number is shown whole");
  for (const v of [null, undefined, "", "  ", 42]) assert.equal(T.orderCodeOf(v), null);
  assert.deepEqual([0, 650, 999.4, 999.6, 1000, 1650, 1604, 2000].map(T.formatDistanceMeters),
    ["0 m", "650 m", "999 m", "1 km", "1 km", "1.65 km", "1.6 km", "2 km"]);
  assert.equal(T.formatDistanceMeters(NaN), null);
  // No order number and no rider name: generic wording — the order id is never used.
  assert.equal(
    T.deviationAlertText({ status: "active", distanceMeters: 650 }),
    "The rider is 650 m away from the planned route for this order. The deviation has continued for at least 3 minutes."
  );
  const noNames = { orderId: "Zx81kQpLmN0aBcDeFgHi", riderUid: "uidQwErTy123", sessionId: "sess_abc12345" };
  const created = T.planAlertWrite({ existing: null, transition: { type: "deviated", distanceMeters: 1650, sinceMs: T0, atMs: T0 }, context: noNames });
  assert.equal(/Zx81kQpLmN0aBcDeFgHi|uidQwErTy123/.test(created.data.message), false);
});

test("alert and event ids are deterministic per session (retries cannot duplicate)", () => {
  assert.equal(T.deviationAlertId(ctx), "route_deviation_order1_rider1_sess_abc12345");
  assert.equal(T.deviationAlertId(ctx), T.deviationAlertId({ ...ctx }));
  assert.notEqual(T.deviationAlertId(ctx), T.deviationAlertId({ ...ctx, sessionId: "sess_other999" }), "a replaced route is a new session");
  assert.equal(T.deviationEventId({ sessionId: "sess_abc12345", episode: 2, type: "deviated" }), "sess_abc12345_e2_deviated");
  for (const bad of [{ ...ctx, orderId: "a/b" }, { ...ctx, riderUid: "" }, { ...ctx, sessionId: "x".repeat(200) }]) {
    assert.throws(() => T.deviationAlertId(bad));
  }
  assert.throws(() => T.deviationEventId({ sessionId: "s1", episode: 0, type: "deviated" }));
});

// ---------------------------------------------------------------- lifecycle + visibility

test("tracking and navigation statuses come from the order workflow", () => {
  assert.deepEqual(T.TRACKED_ORDER_STATUSES, ["assigned", "loading", "in_transit", "delayed"]);
  assert.deepEqual(T.NAVIGABLE_STATUSES, ["in_transit", "delayed"]);
  for (const s of ["delivered", "cancelled", "delivery_failed", "pending_dispatch", "Completed", "canceled"]) {
    assert.equal(T.isTrackedStatus(s), false, s);
  }
  assert.equal(T.isTrackedStatus("In Transit"), true);
});

test("completion, failure, cancellation, unassignment and reassignment end monitoring", () => {
  const base = { assignedRiderId: "rider1", status: "in_transit" };
  assert.equal(T.sessionEndReasonForOrder(base, "rider1"), null);
  assert.equal(T.sessionEndReasonForOrder({ ...base, status: "delayed" }, "rider1"), null);
  assert.equal(T.sessionEndReasonForOrder({ ...base, status: "delivered" }, "rider1"), "completed");
  assert.equal(T.sessionEndReasonForOrder({ ...base, status: "cancelled" }, "rider1"), "cancelled");
  assert.equal(T.sessionEndReasonForOrder({ ...base, status: "delivery_failed" }, "rider1"), "failed");
  assert.equal(T.sessionEndReasonForOrder({ ...base, assignedRiderId: null }, "rider1"), "reassigned");
  assert.equal(T.sessionEndReasonForOrder({ ...base, assignedRiderId: "rider2" }, "rider1"), "reassigned");
  assert.equal(T.sessionEndReasonForOrder(null, "rider1"), "order_missing");
});

test("Med Rep visibility: only owners of a tracked order on that rider; terminal orders give none", () => {
  const orders = [
    { id: "o1", data: { assignedRiderId: "r1", status: "in_transit", createdByUid: "rep1" } },
    { id: "o2", data: { assignedRiderId: "r1", status: "assigned", createdByUid: "rep2" } },
    { id: "o3", data: { assignedRiderId: "r1", status: "delivered", createdByUid: "rep3" } },
    { id: "o4", data: { assignedRiderId: "r1", status: "cancelled", createdByUid: "rep4" } },
    { id: "o5", data: { assignedRiderId: "r2", status: "in_transit", createdByUid: "rep5" } },
    { id: "o6", data: { assignedRiderId: "r1", status: "loading", createdByUid: "rep1" } },
  ];
  assert.deepEqual(T.viewersForRider("r1", orders), { viewerUids: ["rep1", "rep2"], activeOrderIds: ["o1", "o2", "o6"] });
  assert.deepEqual(T.viewersForRider("r9", orders), { viewerUids: [], activeOrderIds: [] });
  // Only changes that can matter trigger a resync.
  const o = { assignedRiderId: "r1", status: "in_transit", createdByUid: "rep1", lastLocation: 1 };
  assert.deepEqual(T.ridersAffectedByOrderWrite(o, { ...o, lastLocation: 2 }), []);
  assert.deepEqual(T.ridersAffectedByOrderWrite(o, { ...o, status: "delivered" }), ["r1"]);
  assert.deepEqual(T.ridersAffectedByOrderWrite(o, { ...o, assignedRiderId: "r2" }), ["r1", "r2"]);
});

// ---------------------------------------------------------------- freshness

test("freshness: a stale coordinate is never shown as live; a late offline write shows its age", () => {
  const at = (ms) => ({ toMillis: () => ms });
  const loc = (capturedMs, updatedMs, extra = {}) => ({ latitude: 14.6, longitude: 121, trackingState: "active", capturedAt: at(capturedMs), updatedAt: at(updatedMs), ...extra });
  const now = T0 + 60 * 60 * 1000;
  assert.equal(T.locationFreshness(loc(now - 30000, now - 29000), now), "fresh");
  assert.equal(T.locationFreshness(loc(now - 5 * 60000, now - 5 * 60000), now), "stale");
  assert.equal(T.locationFreshness(loc(now - 11 * 60000, now - 11 * 60000), now), "offline");
  // Captured 9 minutes ago, delivered to the server just now (offline queue).
  assert.equal(T.locationFreshness(loc(now - 9 * 60000, now - 1000), now), "stale");
  assert.equal(T.locationFreshness(loc(now - 1000, now - 1000, { trackingState: "ended" }), now), "offline");
  assert.equal(T.locationFreshness({ trackingState: "active" }, now), "unavailable");
  assert.equal(T.locationFreshness(null, now), "unavailable");
  assert.deepEqual(T.FRESHNESS, { freshMs: 120000, offlineMs: 600000 });
});

test("display state of the server deviation record", () => {
  assert.equal(T.deviationDisplayState(null), "not_navigating");
  assert.equal(T.deviationDisplayState({ sessionState: "navigating", routeStatus: "unavailable" }), "route_unavailable");
  assert.equal(T.deviationDisplayState({ sessionState: "navigating", routeStatus: "available", phase: "deviating" }), "deviating");
  assert.equal(T.deviationDisplayState({ sessionState: "navigating", routeStatus: "available", phase: "on_route", pendingOffSinceMs: T0 }), "pending_deviation");
  assert.equal(T.deviationDisplayState({ sessionState: "navigating", routeStatus: "available", phase: "on_route", pendingOffSinceMs: null }), "on_route");
});


// ---------------------------------------------------------------- trigger safety (static)

test("tracking triggers cannot loop: they never write the documents that trigger them", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const ops = strip(fs.readFileSync(path.join(__dirname, "..", "src", "riderTrackingOps.js"), "utf8"));
  const index = strip(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8"));

  // Which collections the tracking triggers listen on.
  const listened = [...index.matchAll(/exports\.(trackRiderLocation|trackNavigationSession|syncRiderTrackingOnOrderWrite) = onDocumentWritten\(\s*\{ document: "([^/]+)\//g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(listened), {
    trackRiderLocation: "riderLocations",
    trackNavigationSession: "riderNavigationSessions",
    syncRiderTrackingOnOrderWrite: "orders",
  });

  // riderLocations and orders are only READ by the trigger code (the purge
  // may delete an expired location; a delete is ignored by the trigger).
  assert.equal(/db\.collection\(C\.ORDERS\)[^;]*\.(set|update|create|delete)\(/.test(ops), false);
  assert.equal(/(tx|batch)\.(set|update|create)\([^)]*C\.LOCATIONS/.test(ops), false);
  assert.match(index, /if \(!after \|\| after\.riderUid !== event\.params\.riderUid\) return;/, "a deleted or forged location does nothing");

  // Sessions are written only to END them; ending re-runs the session trigger,
  // which only closes state (never writes a session) — so the chain stops.
  const handleSession = ops.slice(ops.indexOf("async function handleSessionWrite"), ops.indexOf("async function syncRiderVisibility"));
  assert.equal(/sessionRef|C\.SESSIONS/.test(handleSession), false, "the session trigger never writes a session");
  const sessionWrites = [...ops.matchAll(/tx\.update\(sessionRef, \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(sessionWrites.length >= 2);
  for (const w of sessionWrites) assert.match(w, /state: "ended"/);
  // No trigger listens on the collections the handlers mostly write.
  for (const c of ["riderDeviationStates", "routeDeviationEvents", "riderLocationViewers", "alerts"]) {
    assert.equal(index.includes(`document: "${c}/`), false, c);
  }
});

// ---------------------------------------------------------------- transition-only persistence

const every = (from, count, step) => Array.from({ length: count }, (_, i) => from + i * step);

test("30 consecutive on-route fixes are not a single state write", () => {
  const r = run(every(0, 30, 10).map((s) => sample(north(50), s)));
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.events, []);
});

test("30 consecutive off-route fixes keep the ORIGINAL offRouteSince; only the first is a write", () => {
  const r = run(every(0, 30, 5).map((s) => sample(north(800), s))); // 145 s < 3 min
  assert.equal(r.state.pendingOffSinceMs, at(0));
  assert.deepEqual(r.writes, [at(0)]);
  assert.deepEqual(r.events, []);
});

test("only the threshold sample is a transition with an event; staying deviated writes nothing", () => {
  const r = run(every(0, 61, 10).map((s) => sample(north(800), s))); // 0..600 s
  assert.deepEqual(r.writes, [at(0), at(180)], "off-route anchor, then the deviation — nothing else");
  assert.equal(r.events.length, 1);
  assert.deepEqual([r.events[0].type, r.events[0].sinceMs, r.events[0].atMs], ["deviated", at(0), at(180)]);
  assert.deepEqual([r.state.phase, r.state.lastTransitionAtMs], ["deviating", at(180)]);
});

test("recovery: its start stays fixed, and every transition in the cycle is persisted exactly once", () => {
  const deviated = run(every(0, 19, 10).map((s) => sample(north(800), s))).state; // deviates at 180
  const back = north(100);
  const recovering = run(every(190, 10, 10).map((s) => sample(back, s)), { state: deviated, prev: at(180) }); // 190..280
  assert.equal(recovering.state.pendingReturnSinceMs, at(190), "recovery anchor is stable");
  assert.deepEqual(recovering.writes, [at(190)]);
  // pending recovery → deviating again (back off route) → pending recovery → resolved.
  const cycle = run([sample(north(800), 290), sample(north(800), 300), sample(back, 310), sample(back, 370), sample(back, 430)], { state: recovering.state, prev: at(280) });
  assert.deepEqual(cycle.writes, [at(290), at(310), at(430)]);
  assert.deepEqual(cycle.events.map((e) => [e.type, e.sinceMs]), [["returned", at(310)]]);
  assert.equal(cycle.state.phase, "on_route");
});

test("pending deviation → on route is one write; the anchor clears", () => {
  const r = run([sample(north(800), 0), sample(north(800), 60), sample(north(50), 90), sample(north(50), 120)]);
  assert.deepEqual(r.writes, [at(0), at(90)]);
  assert.equal(r.state.pendingOffSinceMs, null);
});

test("retrying any transition sample is idempotent: no change, no event", () => {
  const far = north(800);
  const back = north(100);
  const seq = [...every(0, 19, 10).map((s) => sample(far, s)), ...every(190, 13, 10).map((s) => sample(back, s))];
  let state = null;
  let prev = null;
  for (const smp of seq) {
    const first = T.evaluateDeviation({ state, sample: smp, route: ROUTE, previousSampleAtMs: prev });
    if (first.changed) {
      const replay = T.evaluateDeviation({ state: first.state, sample: smp, route: ROUTE, previousSampleAtMs: prev });
      assert.deepEqual([replay.changed, replay.event, replay.ignored], [false, null, "out_of_order"]);
    }
    state = first.state;
    prev = smp.atMs;
  }
  assert.equal(state.phase, "on_route");
});

// ---------------------------------------------------------------- session lifecycle + server time (staging QA 2026-10-14)

const ts = (ms) => ({ toMillis: () => ms });
const SESSION = { sessionId: "sessCurrent01", orderId: "orderNav", riderUid: "rider1", state: "navigating", startedAt: ts(T0) };
const fix = (over = {}) => ({
  riderUid: "rider1",
  trackingState: "active", latitude: 14.6, longitude: 121.0025, accuracyMeters: 8,
  capturedAt: ts(T0 + 30000), updatedAt: ts(T0 + 30000),
  navigationSessionId: "sessCurrent01", activeOrderId: "orderNav",
  ...over,
});

test("deviation time is the SERVER write time; a late-delivered fix is refused", () => {
  const ahead = fix({ capturedAt: ts(T0 + 90000), updatedAt: ts(T0 + 30000) });
  assert.equal(T.sampleFromLocation(ahead).sample.atMs, T0 + 30000, "a device clock ahead never moves the time");
  const behind = fix({ capturedAt: ts(T0 - 50000), updatedAt: ts(T0 + 10000) });
  assert.equal(T.sampleFromLocation(behind).sample.atMs, T0 + 10000, "60 s old is still current");
  assert.equal(T.sampleFromLocation(fix({ capturedAt: ts(T0 - 50001), updatedAt: ts(T0 + 10000) })).reason, "stale_fix");
  assert.equal(T.sampleFromLocation(fix({ updatedAt: null })).reason, "no_server_time");
  assert.equal(T.DEVIATION_RULES.maxFixAgeMs, 60000);
});

test("A-F1: only a fix tagged with the CURRENT session and order is ever evaluated", () => {
  // A state created with the session records every tagged fix from its start.
  const d = (over) => T.navigationFixDecision({ session: SESSION, location: fix(over), taggedHistorySinceMs: T0 });
  assert.deepEqual(d({}), { action: "evaluate", reason: null });
  // Ordinary tracking (untagged): never measured against the route.
  assert.deepEqual(d({ navigationSessionId: null, activeOrderId: null, updatedAt: ts(T0 + 59999) }), { action: "ignore", reason: "untagged_fix" });
  // ...and once past the start-up grace it proves the app is not navigating it.
  assert.deepEqual(d({ navigationSessionId: null, activeOrderId: null, updatedAt: ts(T0 + 60000) }), { action: "end", reason: "abandoned" });
  // The 2026-10-10 session evaluated by 2026-10-14 ordinary fixes: ended instead.
  const fourDaysLater = T0 + 4 * 24 * 3600 * 1000;
  assert.deepEqual(d({ navigationSessionId: null, activeOrderId: null, capturedAt: ts(fourDaysLater), updatedAt: ts(fourDaysLater) }), { action: "end", reason: "abandoned" });
  assert.deepEqual(d({ navigationSessionId: "sessOther0001" }), { action: "ignore", reason: "other_session" });
  assert.deepEqual(d({ activeOrderId: "otherOrder" }), { action: "ignore", reason: "other_order" });
  assert.deepEqual(d({ trackingState: "ended", latitude: null, longitude: null, navigationSessionId: null, activeOrderId: null }), { action: "end", reason: "tracking_stopped" });
  assert.deepEqual(d({ updatedAt: ts(T0) }), { action: "ignore", reason: "before_session" }, "a write at or before the start");
  assert.equal(T.SESSION_RULES.untaggedGraceMs, 60000);
});

test("session fix times: tagged = proof of navigation; qualifying = usable for the timer", () => {
  assert.deepEqual(T.sessionFixTimes(fix(), SESSION), { taggedAtMs: T0 + 30000, qualifyingAtMs: T0 + 30000 });
  assert.deepEqual(T.sessionFixTimes(fix({ accuracyMeters: 150 }), SESSION), { taggedAtMs: T0 + 30000, qualifyingAtMs: null }, "inaccurate: tagged, not qualifying");
  assert.deepEqual(T.sessionFixTimes(fix({ capturedAt: ts(T0 - 40000) }), SESSION), { taggedAtMs: T0 + 30000, qualifyingAtMs: null }, "delivered late");
  for (const over of [{ navigationSessionId: null, activeOrderId: null }, { navigationSessionId: "sessOther0001" }, { activeOrderId: "otherOrder" }, { trackingState: "ended" }, { latitude: 0, longitude: 0 }]) {
    assert.deepEqual(T.sessionFixTimes(fix(over), SESSION), { taggedAtMs: null, qualifyingAtMs: null }, JSON.stringify(over));
  }
  assert.deepEqual(T.sessionFixTimes(null, SESSION), { taggedAtMs: null, qualifyingAtMs: null });
});

test("abandonment race: a live session with a tagged fix seconds ago SURVIVES an accidental untagged fix", () => {
  const thirtyMin = T0 + 30 * 60 * 1000;
  const untagged = fix({ navigationSessionId: null, activeOrderId: null, capturedAt: ts(thirtyMin), updatedAt: ts(thirtyMin) });
  // 30 minutes after the start, last tagged fix 10 s ago: still navigating.
  const decide = (location, lastTaggedFixAtMs, taggedHistorySinceMs = T0) =>
    T.navigationFixDecision({ session: SESSION, location, lastTaggedFixAtMs, taggedHistorySinceMs });
  assert.deepEqual(decide(untagged, thirtyMin - 10000), { action: "ignore", reason: "untagged_fix" });
  assert.deepEqual(decide(untagged, thirtyMin - 179999).action, "ignore");
  // Genuinely stale: no tagged fix for 3 minutes.
  assert.deepEqual(decide(untagged, thirtyMin - 180000), { action: "end", reason: "abandoned" });
  // Never any tagged fix: the start-up grace applies from the session start.
  const early = fix({ navigationSessionId: null, activeOrderId: null, updatedAt: ts(T0 + 59999) });
  assert.equal(decide(early, null).action, "ignore");
  assert.equal(decide({ ...early, updatedAt: ts(T0 + 60000) }, null).reason, "abandoned");
  assert.equal(T.SESSION_RULES.staleAfterMs, 180000);
});

test("missing history is never proof of staleness; a record that began mid-session must cover a full stale period", () => {
  const thirtyMin = T0 + 30 * 60 * 1000;
  const untagged = fix({ navigationSessionId: null, activeOrderId: null, capturedAt: ts(thirtyMin), updatedAt: ts(thirtyMin) });
  // No record at all (no own state): never abandoned, whatever the age.
  assert.equal(T.navigationFixDecision({ session: SESSION, location: untagged }).action, "ignore");
  assert.equal(T.navigationFixDecision({ session: SESSION, location: untagged, lastTaggedFixAtMs: T0 + 1000 }).action, "ignore");
  // Recording began 10 s ago (a state from before recording existed): the old
  // stored time is not trusted; a full stale period from the record start is.
  const since = thirtyMin - 10000;
  const stale = (w, last = T0 + 1000) => T.untaggedSessionIsStale({ writtenMs: w, startedMs: T0, lastTaggedFixAtMs: last, taggedHistorySinceMs: since });
  assert.equal(stale(thirtyMin), false);
  assert.equal(stale(since + 179999), false);
  assert.equal(stale(since + 180000), true);
  assert.equal(stale(since + 180000, since + 100000), false, "a tagged fix recorded after the start moves the clock");
  // Complete record from the start: grace without a tagged fix, stale period with one.
  const complete = (w, last) => T.untaggedSessionIsStale({ writtenMs: w, startedMs: T0, lastTaggedFixAtMs: last, taggedHistorySinceMs: T0 });
  assert.deepEqual([complete(T0 + 59999, null), complete(T0 + 60000, null)], [false, true]);
  assert.deepEqual([complete(T0 + 300000, T0 + 120001), complete(T0 + 300000, T0 + 120000)], [false, true]);
  assert.equal(T.untaggedSessionIsStale({ writtenMs: T0 + 999999, startedMs: T0, lastTaggedFixAtMs: null, taggedHistorySinceMs: null }), false);
});

test("session evidence: every observed tagged/qualifying fix is recorded, forward only, exact session/order/rider", () => {
  const state = { sessionId: "sessCurrent01", sessionState: "navigating", taggedHistorySinceMs: T0 };
  const good = (sec, over = {}) => fix({ capturedAt: ts(T0 + sec * 1000), updatedAt: ts(T0 + sec * 1000), ...over });
  const untagged = (sec) => good(sec, { navigationSessionId: null, activeOrderId: null });
  const ev = (o) => T.sessionEvidence({ session: SESSION, state, ...o });

  // An evaluated fix records ITSELF; continuity comes from the fix before it.
  const self = ev({ location: good(60), previous: good(30) });
  assert.deepEqual(self.patch, { lastTaggedFixAtMs: T0 + 60000, lastQualifyingFixAtMs: T0 + 60000 });
  assert.deepEqual([self.previousQualifyingAtMs, self.ownQualifyingAtMs, self.replay], [T0 + 30000, T0 + 60000, false]);
  // Replayed after it was recorded: recognised, nothing to store.
  const recorded = { ...state, ...self.patch };
  const replay = T.sessionEvidence({ session: SESSION, state: recorded, location: good(60), previous: good(30) });
  assert.deepEqual([replay.replay, replay.patch], [true, {}]);
  // Untagged fix whose previous fix was tagged: the tagged one is recorded.
  assert.deepEqual(ev({ location: untagged(70), previous: good(60) }).patch, { lastTaggedFixAtMs: T0 + 60000, lastQualifyingFixAtMs: T0 + 60000 });
  // The stored CURRENT document adds tagged evidence only (never a qualifying
  // time: it may not have been evaluated yet).
  assert.deepEqual(ev({ location: untagged(40), previous: untagged(30), current: good(90) }).patch, { lastTaggedFixAtMs: T0 + 90000 });
  // Never backwards.
  const later = { ...state, lastTaggedFixAtMs: T0 + 100000, lastQualifyingFixAtMs: T0 + 100000 };
  const older = T.sessionEvidence({ session: SESSION, state: later, location: untagged(80), previous: good(60) });
  assert.deepEqual([older.patch, older.lastTaggedFixAtMs], [{}, T0 + 100000]);
  // Inaccurate / late tagged fixes are evidence of navigation, never continuity.
  assert.deepEqual(ev({ location: good(90, { accuracyMeters: 150 }), previous: untagged(80) }).patch, { lastTaggedFixAtMs: T0 + 90000 });
  // Another session, order or rider contributes nothing.
  for (const over of [{ navigationSessionId: "sessOther0001" }, { activeOrderId: "otherOrder" }, { riderUid: "rider2" }]) {
    assert.deepEqual(ev({ location: untagged(70), previous: good(60, over), current: good(65, over) }).patch, {}, JSON.stringify(over));
  }
  // A state of another session: nothing is recorded and no history is known.
  const other = T.sessionEvidence({ session: SESSION, state: { ...state, sessionId: "sessOther0001" }, location: untagged(70), previous: good(60) });
  assert.deepEqual([other.patch, other.taggedHistorySinceMs, other.lastTaggedFixAtMs], [{}, null, T0 + 60000]);
  // A state written before recording existed: recording starts now, once.
  const legacy = { sessionId: "sessCurrent01", sessionState: "navigating", lastTaggedFixAtMs: T0 + 1000 };
  const first = T.sessionEvidence({ session: SESSION, state: legacy, location: untagged(500), previous: untagged(490), nowMs: T0 + 500000 });
  assert.deepEqual([first.patch, first.taggedHistorySinceMs], [{ taggedHistorySinceMs: T0 + 500000 }, T0 + 500000]);
});

test("session fix times: only this rider's fixes count", () => {
  assert.deepEqual(T.sessionFixTimes(fix({ riderUid: "rider2" }), SESSION), { taggedAtMs: null, qualifyingAtMs: null });
});

// ---------------------------------------------------------------- confirmed continuity (navigation continuity version 1)

const CONFIRMED = { ...SESSION, continuityVersion: 1 };
const untaggedAt = (ms) => fix({ navigationSessionId: null, activeOrderId: null, capturedAt: ts(ms), updatedAt: ts(ms) });

test("confirmed continuity: the session's own anchor decides, whatever the trigger evidence says", () => {
  assert.equal(T.NAVIGATION_CONTINUITY_VERSION, 1);
  const decide = (session, writtenMs, extra = {}) => T.navigationFixDecision({ session, location: untaggedAt(writtenMs), ...extra });
  // Tn confirmed 155 s before U2; the trigger record still says T(n-1) at -30 s
  // with a complete history — the legacy rule would abandon (REPRO-1).
  const tn = T0 + 3600000;
  const confirmed = { ...CONFIRMED, startedAt: ts(T0), lastNavigationFixAt: ts(tn) };
  const evidence = { lastTaggedFixAtMs: tn - 30000, taggedHistorySinceMs: T0, lastQualifyingFixAtMs: tn - 30000 };
  assert.deepEqual(decide({ ...SESSION, startedAt: ts(T0) }, tn + 155000, evidence), { action: "end", reason: "abandoned" }, "legacy session: the race");
  assert.deepEqual(decide(confirmed, tn + 155000, evidence), { action: "ignore", reason: "untagged_fix" });
  assert.deepEqual(decide(confirmed, tn + 179999, evidence).action, "ignore");
  assert.deepEqual(decide(confirmed, tn + 180000, evidence), { action: "end", reason: "abandoned" }, "a genuinely stale session still ends");
  // Startup grace (REPRO-2): Tn confirmed at +50 s, U2 at +65 s.
  assert.equal(decide({ ...CONFIRMED, lastNavigationFixAt: ts(T0 + 50000) }, T0 + 65000).action, "ignore");
  assert.equal(decide(CONFIRMED, T0 + 59999).action, "ignore", "no confirmation yet: inside the grace");
  assert.deepEqual(decide(CONFIRMED, T0 + 60000), { action: "end", reason: "abandoned" }, "grace expired with no qualifying fix");
  // Trigger evidence can only extend a confirmed session, never shorten it.
  assert.equal(decide({ ...CONFIRMED, lastNavigationFixAt: ts(T0 + 10000) }, T0 + 250000, { lastQualifyingFixAtMs: T0 + 100000 }).action, "ignore");
});

test("confirmed continuity: only QUALIFYING fixes keep a session alive; tagged-only evidence does not", () => {
  // Inaccurate or late tagged fixes reach the trigger evidence as tagged, never
  // qualifying: with confirmed continuity they do not extend the session.
  const last = T0 + 1000;
  const r = T.navigationFixDecision({
    session: { ...CONFIRMED, lastNavigationFixAt: ts(last) },
    location: untaggedAt(last + 180000),
    lastTaggedFixAtMs: last + 170000, // a poor-accuracy tagged fix 10 s ago
    taggedHistorySinceMs: T0,
    lastQualifyingFixAtMs: last,
  });
  assert.deepEqual(r, { action: "end", reason: "abandoned" });
});

test("confirmed anchor: a value at or before the start, a non-timestamp, or an undeclared session is ignored", () => {
  assert.equal(T.confirmedNavigationFixMs({ ...CONFIRMED, lastNavigationFixAt: ts(T0 + 5) }), T0 + 5);
  assert.equal(T.confirmedNavigationFixMs({ ...CONFIRMED, lastNavigationFixAt: ts(T0) }), null, "not after the start");
  assert.equal(T.confirmedNavigationFixMs({ ...CONFIRMED, lastNavigationFixAt: "2026-10-10" }), null);
  assert.equal(T.confirmedNavigationFixMs({ ...SESSION, lastNavigationFixAt: ts(T0 + 5) }), null, "no continuity declared");
  assert.equal(T.confirmedNavigationFixMs({ ...SESSION, continuityVersion: 2, lastNavigationFixAt: ts(T0 + 5) }), null);
  assert.equal(T.confirmedNavigationFixMs(null), null);
  // Staleness boundaries.
  const stale = (w, last) => T.confirmedSessionIsStale({ writtenMs: w, startedMs: T0, lastQualifyingFixAtMs: last });
  assert.deepEqual([stale(T0 + 59999, null), stale(T0 + 60000, null)], [false, true]);
  assert.deepEqual([stale(T0 + 300000, T0 + 120001), stale(T0 + 300000, T0 + 120000)], [false, true]);
  assert.equal(stale(T0 + 60000, T0), true, "a 'fix' at the start time is not after it: grace applies");
  assert.equal(T.confirmedSessionIsStale({ writtenMs: T0 + 999999, startedMs: null, lastQualifyingFixAtMs: null }), false, "no server start: never");
  assert.equal(T.confirmedSessionIsStale({ writtenMs: NaN, startedMs: T0, lastQualifyingFixAtMs: null }), false);
});

test("session evidence reports the newest QUALIFYING fix it sees, including the stored current one", () => {
  const state = { sessionId: "sessCurrent01", sessionState: "navigating", taggedHistorySinceMs: T0, lastQualifyingFixAtMs: T0 + 20000 };
  const good = (sec, over = {}) => fix({ capturedAt: ts(T0 + sec * 1000), updatedAt: ts(T0 + sec * 1000), ...over });
  const untagged = (sec) => good(sec, { navigationSessionId: null, activeOrderId: null });
  const ev = T.sessionEvidence({ session: SESSION, state, location: untagged(40), previous: untagged(30), current: good(90) });
  assert.equal(ev.lastQualifyingFixAtMs, T0 + 90000);
  assert.deepEqual(ev.patch, { lastTaggedFixAtMs: T0 + 90000 }, "the current doc is still recorded as tagged evidence only");
  const poor = T.sessionEvidence({ session: SESSION, state, location: untagged(40), previous: good(30, { accuracyMeters: 150 }) });
  assert.equal(poor.lastQualifyingFixAtMs, T0 + 20000, "inaccurate: not qualifying");
});

test("the session trigger skips a write that only confirms a navigation fix", () => {
  const base = { riderUid: "rider1", orderId: "orderNav", sessionId: "sessCurrent01", state: "navigating", startedAt: ts(T0), updatedAt: ts(T0), endedAt: null, endReason: null, continuityVersion: 1 };
  const confirmed = { ...base, lastNavigationFixAt: ts(T0 + 30000), updatedAt: ts(T0 + 31000) };
  assert.equal(T.isFixConfirmationOnly(base, confirmed), true);
  assert.equal(T.isFixConfirmationOnly(confirmed, { ...confirmed, lastNavigationFixAt: ts(T0 + 60000), updatedAt: ts(T0 + 61000) }), true);
  // Anything that starts, replaces or ends a session is handled.
  assert.equal(T.isFixConfirmationOnly(confirmed, { ...confirmed, state: "ended", endReason: "rider_stopped", endedAt: ts(T0 + 90000) }), false);
  assert.equal(T.isFixConfirmationOnly(confirmed, { ...base, sessionId: "sessNext00001", startedAt: ts(T0 + 90000) }), false);
  assert.equal(T.isFixConfirmationOnly(base, { ...base, updatedAt: ts(T0 + 5) }), false, "no confirmation in it");
  assert.equal(T.isFixConfirmationOnly(null, base), false);
  assert.equal(T.isFixConfirmationOnly(base, null), false);
});

test("strict continuity: an inaccurate fix neither bridges a real gap nor breaks a short one", () => {
  const far = north(800);
  // good 0 → [inaccurate 100] → good 200: the qualifying gap is 200 s > 2 min → the anchor restarts at 200.
  const bridged = run([sample(far, 0)]);
  const after = run([sample(far, 200)], { state: bridged.state, prev: at(0) });
  assert.deepEqual([after.state.pendingOffSinceMs, after.events.length], [at(200), 0]);
  // good 0 → [inaccurate 30] → good 60: qualifying gap 60 s → the anchor stays at 0.
  const short = run([sample(far, 60)], { state: bridged.state, prev: at(0) });
  assert.equal(short.state.pendingOffSinceMs, at(0));
});

test("DEV-2: 30-second navigation fixes keep the FIRST anchor; no alert at 2:59, exactly one at 3:00", () => {
  const far = north(800);
  const seconds = [0, 30, 60, 90, 120, 150, 179];
  const before = run(seconds.map((s) => sample(far, s)));
  assert.deepEqual([before.events.length, before.state.pendingOffSinceMs], [0, at(0)], "2:59 — pending, anchor unchanged");
  const atThree = run([sample(far, 180)], { state: before.state, prev: at(179) });
  assert.deepEqual(atThree.events.map((e) => [e.type, e.sinceMs, e.atMs]), [["deviated", at(0), at(180)]]);
  const later = run([sample(far, 210), sample(far, 240)], { state: atThree.state, prev: at(180) });
  assert.equal(later.events.length, 0, "still exactly one");
});

test("DEV-2 root cause: the 2-minute ordinary heartbeat restarted the timer — such fixes are no longer evaluated", () => {
  // What staging recorded: ordinary fixes ~2 min 2–7 s apart, each > maxSampleGapMs.
  const far = north(1600);
  const ordinary = run([sample(far, 0), sample(far, 137), sample(far, 259), sample(far, 381)]);
  assert.deepEqual(ordinary.writes, [at(0), at(137), at(259), at(381)], "every fix restarted the anchor");
  assert.equal(ordinary.events.length, 0, "...so the alert could never fire this way");
  // Those fixes were untagged: the server no longer feeds them to the timer at all.
  assert.equal(T.navigationFixDecision({ session: SESSION, location: fix({ navigationSessionId: null, activeOrderId: null, updatedAt: ts(T0 + 30000) }) }).action, "ignore");
});

test("an invalid or poor-accuracy fix neither anchors, advances nor confirms a deviation", () => {
  const far = north(800);
  const r = run([sample(north(5000), 0, 150), sample(north(5000), 30, 150), sample(far, 60), sample({ lat: 999, lng: 0 }, 90), sample(far, 120)]);
  assert.equal(r.state.pendingOffSinceMs, at(60), "anchored by the first QUALIFYING fix only");
  const late = run([sample(north(5000), 240, 150)], { state: r.state, prev: at(120) });
  assert.deepEqual([late.events.length, late.ignored], [0, ["poor_accuracy"]], "a poor fix past 3:00 does not confirm");
});
