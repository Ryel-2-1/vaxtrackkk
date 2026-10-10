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
const sample = (point, secondsAfter, accuracyMeters = 10) => ({ ...point, accuracyMeters, capturedAtMs: T0 + secondsAfter * 1000 });
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
    if (r.changed) writes.push(smp.capturedAtMs);
    previousSampleAtMs = smp.capturedAtMs;
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
  assert.deepEqual(run([{ ...north(800), capturedAtMs: T0 }]).ignored, ["poor_accuracy"], "no accuracy = unusable");
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
  assert.equal(T.sampleFromLocation(loc).sample.capturedAtMs, T0);
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
  assert.match(create.data.message, /more than 500 m from the assigned route for order VT-ORD-1 for at least 3 minutes \(now 812 m off route\)/);
  assert.equal(T.planAlertWrite({ existing: { status: "active", episodeCount: 1 }, transition: dev, context: ctx }).action, "noop", "never a second open alert");
  const reopen = T.planAlertWrite({ existing: { status: "resolved", episodeCount: 1 }, transition: dev, context: ctx });
  assert.deepEqual([reopen.action, reopen.data.episodeCount], ["reopen", 2]);
  const resolve = T.planAlertWrite({ existing: { status: "active" }, transition: { type: "returned" }, context: ctx });
  assert.deepEqual([resolve.action, resolve.data.resolutionReason], ["resolve", "returned_to_route"]);
  assert.equal(T.planAlertWrite({ existing: null, transition: { type: "returned" }, context: ctx }).action, "noop", "a return never creates an alert");
  assert.equal(T.planAlertWrite({ existing: { status: "active" }, transition: { type: "session_closed", reason: "completed" }, context: ctx }).data.resolutionReason, "completed");
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
    prev = smp.capturedAtMs;
  }
  assert.equal(state.phase, "on_route");
});
