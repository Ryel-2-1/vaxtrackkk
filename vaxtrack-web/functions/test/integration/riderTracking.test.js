"use strict";

/**
 * Rider tracking + route deviation against a REAL Firestore (emulator), through
 * the trigger handlers in src/riderTrackingOps.js (called directly, as the
 * other integration suites do with their operations).
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-tracking" }, "tracking-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const ops = require("../../src/riderTrackingOps");
const T = require("../../src/riderTracking");
const { encode } = require("../helpers/polyline");

const C = ops.TRACKING_COLLECTIONS;
const RIDER = "rider1";
const REP = "rep1";
const ROUTE = [{ lat: 14.6, lng: 121.0 }, { lat: 14.6, lng: 121.005 }, { lat: 14.6, lng: 121.01 }];
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const north = (m) => ({ lat: 14.6 + m / M_PER_DEG_LAT, lng: 121.0025 });
const T0 = Date.parse("2026-10-10T02:00:00Z");

// The rider's previous fix (the location document's prior version), passed
// to the trigger exactly as Firestore delivers it.
let prevLoc = null;
let retryPrev = null;

async function wipe() {
  prevLoc = null;
  retryPrev = null;
  for (const c of [...Object.values(C)]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}
const get = async (c, id) => {
  const s = await db.collection(c).doc(id).get();
  return s.exists ? s.data() : null;
};
const all = async (c) => (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function seedOrder(id, over = {}) {
  await db.collection(C.ORDERS).doc(id).set({
    orderNumber: `VT-${id}`,
    status: "in_transit",
    assignedRiderId: RIDER,
    assignedRiderName: "Juan Rider",
    createdByUid: REP,
    clinicName: "Private Clinic Name",
    routePolyline: encode(ROUTE),
    // Assigned, then the dispatcher generated the route: it is current.
    assignedAt: Timestamp.fromMillis(T0 - 600000),
    routeGeneratedAt: Timestamp.fromMillis(T0 - 300000),
    ...over,
  });
}

/** Start navigation exactly as the rider app writes it, then run the session trigger. */
async function startSession(sessionId, orderId) {
  const data = { riderUid: RIDER, orderId, sessionId, state: "navigating", startedAt: Timestamp.fromMillis(T0 - 1000), updatedAt: Timestamp.fromMillis(T0 - 1000), endedAt: null, endReason: null };
  await db.collection(C.SESSIONS).doc(RIDER).set(data);
  return ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: data });
}

/**
 * A riderLocations doc as written by the rider, then the location trigger with
 * the previous version. `retry` re-delivers the last write (at-least-once).
 */
function locate(point, seconds, accuracyMeters = 10, { retry = false } = {}) {
  const at = Timestamp.fromMillis(T0 + seconds * 1000);
  const location = { riderUid: RIDER, latitude: point.lat, longitude: point.lng, accuracyMeters, capturedAt: at, updatedAt: at, trackingState: "active" };
  const previous = retry ? retryPrev : prevLoc;
  if (!retry) {
    retryPrev = prevLoc;
    prevLoc = location;
  }
  return ops.processLocationWrite({ db, FieldValue, riderUid: RIDER, location, previous });
}
const stateUpdateTime = async () => (await db.collection(C.STATES).doc(RIDER).get()).updateTime;
const feed = async (point, seconds) => {
  const out = [];
  for (const s of seconds) out.push(await locate(point, s));
  return out;
};

test("a 3-minute deviation opens ONE alert and event; retries and further samples add nothing; return resolves it", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_aaaaaaaa", "o1");
  const far = north(800);

  const results = await feed(far, [0, 60, 120]);
  assert.ok(results.every((r) => r.event === null));
  assert.equal((await all(C.ALERTS)).length, 0, "under 3 minutes: no alert");

  const deviated = await locate(far, 180);
  assert.equal(deviated.event, "deviated");
  const alertId = T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_aaaaaaaa" });
  const alert = await get(C.ALERTS, alertId);
  assert.deepEqual([alert.type, alert.status, alert.severity, alert.source, alert.episodeCount], ["route_deviation", "active", "critical", "server", 1]);
  assert.ok(alert.createdAt instanceof Timestamp);
  assert.ok(!JSON.stringify(alert).includes("Private Clinic Name"), "the alert carries no clinic details");

  // Retry of the same location write (at-least-once trigger) and more off-route samples.
  const alertSnap = await db.collection(C.ALERTS).doc(alertId).get();
  const retried = await locate(far, 180, 10, { retry: true });
  assert.deepEqual([retried.event, retried.ignored, retried.wrote], [null, "out_of_order", false]);
  await feed(far, [240, 300]);
  assert.equal((await all(C.ALERTS)).length, 1, "still exactly one alert");
  assert.ok((await db.collection(C.ALERTS).doc(alertId).get()).updateTime.isEqual(alertSnap.updateTime), "not rewritten");
  assert.deepEqual((await all(C.EVENTS)).map((e) => e.id), ["sess_aaaaaaaa_e1_deviated"]);

  const back = north(100);
  await feed(back, [360, 420]);
  assert.equal((await get(C.ALERTS, alertId)).status, "active", "recovery needs 2 stable minutes");
  assert.equal((await locate(back, 480)).event, "returned");
  const resolved = await get(C.ALERTS, alertId);
  assert.deepEqual([resolved.status, resolved.resolutionReason], ["resolved", "returned_to_route"]);
  assert.deepEqual((await all(C.EVENTS)).map((e) => e.id).sort(), ["sess_aaaaaaaa_e1_deviated", "sess_aaaaaaaa_e1_returned"]);
  const state = await get(C.STATES, RIDER);
  assert.deepEqual([state.phase, state.episode, state.openAlertId], ["on_route", 1, null]);
});

test("starting navigation for another order replaces the route and closes the open alert", async () => {
  await wipe();
  await seedOrder("o1");
  await seedOrder("o2", { routePolyline: encode([ROUTE[0], ROUTE[2]]) });
  await startSession("sess_first111", "o1");
  await feed(north(800), [0, 60, 120, 180]);
  const firstAlert = T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_first111" });
  assert.equal((await get(C.ALERTS, firstAlert)).status, "active");

  await startSession("sess_second22", "o2");
  const closed = await get(C.ALERTS, firstAlert);
  assert.deepEqual([closed.status, closed.resolutionReason], ["resolved", "replaced"]);
  const state = await get(C.STATES, RIDER);
  assert.deepEqual([state.sessionId, state.orderId, state.phase, state.episode, state.sessionState], ["sess_second22", "o2", "on_route", 0, "navigating"]);
  assert.ok((await all(C.EVENTS)).some((e) => e.id === "sess_first111_e1_session_closed"));
  // Only one route is ever monitored: o2's samples are measured against o2.
  await feed(north(100), [400, 460]);
  assert.equal((await get(C.STATES, RIDER)).orderId, "o2");
});

test("completing, failing or cancelling the navigated order ends the session and resolves its alert", async () => {
  for (const [status, reason] of [["delivered", "completed"], ["delivery_failed", "failed"], ["cancelled", "cancelled"]]) {
    await wipe();
    await seedOrder("o1");
    await startSession("sess_endcase1", "o1");
    await feed(north(800), [0, 60, 120, 180]);
    const before = await get(C.ORDERS, "o1");
    await db.collection(C.ORDERS).doc("o1").update({ status });
    const result = await ops.handleOrderWrite({ db, FieldValue, orderId: "o1", before, after: { ...before, status } });
    assert.deepEqual(result.sessionsEnded, [{ riderUid: RIDER, reason }], status);
    const session = await get(C.SESSIONS, RIDER);
    assert.deepEqual([session.state, session.endReason], ["ended", reason]);
    await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: session });
    const alert = await get(C.ALERTS, T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_endcase1" }));
    assert.deepEqual([alert.status, alert.resolutionReason], ["resolved", reason], status);
    // Monitoring has stopped: further far samples change nothing.
    assert.equal((await locate(north(900), 400)).reason, "not_navigating");
  }
});

test("reassigning the order ends the previous rider's session", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_reassign", "o1");
  const before = await get(C.ORDERS, "o1");
  const after = { ...before, assignedRiderId: "rider2" };
  await db.collection(C.ORDERS).doc("o1").set(after);
  const r = await ops.handleOrderWrite({ db, FieldValue, orderId: "o1", before, after });
  assert.deepEqual(r.sessionsEnded, [{ riderUid: RIDER, reason: "reassigned" }]);
});

test("no stored route: live location continues, route marked unavailable, never a deviation", async () => {
  await wipe();
  await seedOrder("o1", { routePolyline: null, clinicLat: 14.62, clinicLng: 121.03 });
  await startSession("sess_noroute1", "o1");
  const results = await feed(north(5000), [0, 60, 120, 180, 240, 300, 360]);
  assert.ok(results.every((r) => r.reason === "no_route"));
  assert.equal((await get(C.STATES, RIDER)).routeStatus, "unavailable");
  assert.equal((await all(C.ALERTS)).length, 0);
  assert.equal((await all(C.EVENTS)).length, 0);
});

test("poor accuracy and late (out-of-order) fixes never move the state", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_accuracy", "o1");
  await locate(north(800), 0);
  const anchored = await stateUpdateTime();
  const r = await locate(north(800), 60, 300);
  assert.deepEqual([r.reason, r.wrote], ["poor_accuracy", false]);
  assert.equal((await locate(north(800), 120)).wrote, false);
  // A late trigger for an OLDER write: the stored location is already newer.
  await db.collection(C.LOCATIONS).doc(RIDER).set({ riderUid: RIDER, capturedAt: Timestamp.fromMillis(T0 + 120000) });
  const late = await ops.processLocationWrite({
    db, FieldValue, riderUid: RIDER,
    location: { riderUid: RIDER, latitude: 14.6, longitude: 121.0025, accuracyMeters: 5, capturedAt: Timestamp.fromMillis(T0 + 90000), updatedAt: Timestamp.fromMillis(T0 + 90000), trackingState: "active" },
    previous: null,
  });
  assert.equal(late.reason, "superseded");
  const state = await get(C.STATES, RIDER);
  assert.equal(state.pendingOffSinceMs, T0, "the original off-route anchor stands");
  assert.ok((await stateUpdateTime()).isEqual(anchored), "no state write since the anchor");
});

test("Med Rep visibility index follows active assigned orders; terminal orders remove it", async () => {
  await wipe();
  await seedOrder("o1", { status: "assigned" });
  await seedOrder("o2", { createdByUid: "rep2", status: "in_transit" });
  await seedOrder("o3", { createdByUid: "rep3", status: "delivered" });
  await ops.handleOrderWrite({ db, FieldValue, orderId: "o1", before: null, after: await get(C.ORDERS, "o1") });
  assert.deepEqual((await get(C.VIEWERS, RIDER)).viewerUids, ["rep1", "rep2"]);

  for (const id of ["o1", "o2"]) {
    const before = await get(C.ORDERS, id);
    await db.collection(C.ORDERS).doc(id).update({ status: "delivered" });
    await ops.handleOrderWrite({ db, FieldValue, orderId: id, before, after: { ...before, status: "delivered" } });
  }
  assert.equal(await get(C.VIEWERS, RIDER), null, "no active order → no Med Rep visibility");
  // Idempotent: a replayed trigger writes nothing new.
  assert.deepEqual((await ops.syncRiderVisibility({ db, FieldValue, riderUid: RIDER })).changed, false);
});

test("retention deletes expired location, ended sessions/states and old events — nothing current", async () => {
  await wipe();
  const now = new Date("2026-10-10T12:00:00Z");
  const ago = (h) => Timestamp.fromMillis(now.getTime() - h * 3600 * 1000);
  await db.collection(C.LOCATIONS).doc("oldRider").set({ riderUid: "oldRider", updatedAt: ago(25) });
  await db.collection(C.LOCATIONS).doc("liveRider").set({ riderUid: "liveRider", updatedAt: ago(0.1) });
  await db.collection(C.SESSIONS).doc("oldRider").set({ state: "ended", updatedAt: ago(30) });
  await db.collection(C.SESSIONS).doc("navRider").set({ state: "navigating", updatedAt: ago(30) });
  await db.collection(C.STATES).doc("oldRider").set({ sessionState: "ended", updatedAt: ago(30) });
  await db.collection(C.EVENTS).doc("old_e1_deviated").set({ createdAt: ago(24 * 91) });
  await db.collection(C.EVENTS).doc("new_e1_deviated").set({ createdAt: ago(24) });
  const counts = await ops.purgeExpiredTrackingData({ db, Timestamp, now });
  assert.deepEqual(counts, { locations: 1, sessions: 1, states: 1, events: 1 });
  assert.deepEqual((await all(C.LOCATIONS)).map((d) => d.id), ["liveRider"]);
  assert.deepEqual((await all(C.SESSIONS)).map((d) => d.id), ["navRider"], "a session still navigating is kept");
  assert.deepEqual((await all(C.EVENTS)).map((d) => d.id), ["new_e1_deviated"]);
});

// ---------------------------------------------------------------- pre-deployment review

const completeOrder = async (id) => {
  const before = await get(C.ORDERS, id);
  const after = { ...before, status: "delivered" };
  await db.collection(C.ORDERS).doc(id).set(after);
  return ops.handleOrderWrite({ db, FieldValue, orderId: id, before, after });
};

test("one rider, two Med Reps: each keeps access while their own order is active", async () => {
  await wipe();
  await seedOrder("oA", { createdByUid: "repA", status: "in_transit" });
  await seedOrder("oB", { createdByUid: "repB", status: "assigned" });
  await ops.syncRiderVisibility({ db, FieldValue, riderUid: RIDER });
  assert.deepEqual((await get(C.VIEWERS, RIDER)).viewerUids, ["repA", "repB"]);

  await completeOrder("oA");
  const afterFirst = await get(C.VIEWERS, RIDER);
  assert.deepEqual(afterFirst.viewerUids, ["repB"], "completing repA's order keeps repB's valid access");
  assert.deepEqual(afterFirst.activeOrderIds, ["oB"]);

  await completeOrder("oB");
  assert.equal(await get(C.VIEWERS, RIDER), null, "the last qualifying order ends Med Rep access");
});

test("reassignment moves Med Rep visibility from the previous rider to the new one", async () => {
  await wipe();
  await seedOrder("oA", { createdByUid: "repA", status: "assigned" });
  await ops.syncRiderVisibility({ db, FieldValue, riderUid: RIDER });
  assert.deepEqual((await get(C.VIEWERS, RIDER)).viewerUids, ["repA"]);
  const before = await get(C.ORDERS, "oA");
  const after = { ...before, assignedRiderId: "rider2" };
  await db.collection(C.ORDERS).doc("oA").set(after);
  await ops.handleOrderWrite({ db, FieldValue, orderId: "oA", before, after });
  assert.equal(await get(C.VIEWERS, RIDER), null, "the previous rider is no longer visible to repA");
  assert.deepEqual((await get(C.VIEWERS, "rider2")).viewerUids, ["repA"]);
});

test("a route saved before the current assignment is never used for deviation", async () => {
  await wipe();
  // Requeued and reassigned: the old route (drawn from the previous rider's
  // position) is still stored, but predates this assignment.
  await seedOrder("o1", {
    assignedAt: Timestamp.fromMillis(T0 - 60000),
    routeGeneratedAt: Timestamp.fromMillis(T0 - 3600000),
  });
  await startSession("sess_stale01", "o1");
  const results = await feed(north(5000), [0, 60, 120, 180, 240]);
  assert.ok(results.every((r) => r.reason === "no_route"));
  const state = await get(C.STATES, RIDER);
  assert.equal(state.routeStatus, "unavailable");
  assert.equal(state.routeUnavailableReason, "generated_before_assignment");
  assert.equal((await all(C.ALERTS)).length, 0);
  assert.equal((await all(C.EVENTS)).length, 0);

  // The dispatcher regenerates the route after the assignment: monitoring resumes.
  await db.collection(C.ORDERS).doc("o1").update({ routeGeneratedAt: Timestamp.fromMillis(T0 + 250000) });
  await locate(north(10), 300);
  const resumed = await get(C.STATES, RIDER);
  assert.equal(resumed.routeStatus, "available");
  assert.equal(resumed.routeUnavailableReason, null);
});

test("a stationary off-route rider on 30-second heartbeats reaches the 3-minute threshold", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_beat0001", "o1");
  const seconds = [0, 30, 60, 90, 120, 150, 180];
  const results = await feed(north(800), seconds);
  assert.deepEqual(results.map((r) => r.event), [null, null, null, null, null, null, "deviated"]);
  assert.equal((await all(C.ALERTS)).length, 1);
});

test("retention boundaries: exactly 24 h / 90 days are kept; navigating and recent data are never deleted", async () => {
  await wipe();
  const now = new Date("2026-10-10T12:00:00Z");
  const at = (ms) => Timestamp.fromMillis(now.getTime() - ms);
  const H24 = 24 * 3600 * 1000;
  const D90 = 90 * 24 * 3600 * 1000;
  await db.collection(C.LOCATIONS).doc("atBoundary").set({ riderUid: "atBoundary", trackingState: "active", updatedAt: at(H24) });
  await db.collection(C.LOCATIONS).doc("justOver").set({ riderUid: "justOver", trackingState: "ended", updatedAt: at(H24 + 1) });
  await db.collection(C.LOCATIONS).doc("live").set({ riderUid: "live", trackingState: "active", updatedAt: at(5000) });
  await db.collection(C.SESSIONS).doc("endedAtBoundary").set({ state: "ended", updatedAt: at(H24) });
  await db.collection(C.SESSIONS).doc("endedOver").set({ state: "ended", updatedAt: at(H24 + 1) });
  await db.collection(C.SESSIONS).doc("navigating").set({ state: "navigating", updatedAt: at(H24 * 30) });
  await db.collection(C.STATES).doc("navigating").set({ sessionState: "navigating", sessionId: "sess_open", updatedAt: at(H24 * 30) });
  await db.collection(C.EVENTS).doc("e_boundary").set({ riderUid: "x", sessionId: "s1", createdAt: at(D90) });
  await db.collection(C.EVENTS).doc("e_over").set({ riderUid: "x", sessionId: "s1", createdAt: at(D90 + 1) });
  await db.collection(C.EVENTS).doc("e_recent").set({ riderUid: "x", sessionId: "s1", createdAt: at(H24) });
  // Old, but its session is still navigating (alert may be unresolved): kept.
  await db.collection(C.EVENTS).doc("e_open").set({ riderUid: "navigating", sessionId: "sess_open", createdAt: at(D90 * 2) });

  const counts = await ops.purgeExpiredTrackingData({ db, Timestamp, now });
  assert.deepEqual(counts, { locations: 1, sessions: 1, states: 0, events: 1 });
  assert.deepEqual((await all(C.LOCATIONS)).map((d) => d.id).sort(), ["atBoundary", "live"]);
  assert.deepEqual((await all(C.SESSIONS)).map((d) => d.id).sort(), ["endedAtBoundary", "navigating"]);
  assert.deepEqual((await all(C.STATES)).map((d) => d.id), ["navigating"]);
  assert.deepEqual((await all(C.EVENTS)).map((d) => d.id).sort(), ["e_boundary", "e_open", "e_recent"]);
});

// ---------------------------------------------------------------- transition-only writes

const updateTimes = async (c) => Object.fromEntries((await db.collection(c).get()).docs.map((d) => [d.id, d.updateTime.toMillis()]));

test("30 on-route fixes write no state; 30 off-route fixes keep offRouteSince with one write", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_quiet001", "o1");
  const created = await stateUpdateTime();
  const onRoute = await feed(north(50), Array.from({ length: 30 }, (_, i) => i * 10));
  assert.ok(onRoute.every((r) => r.wrote === false), "on-route fixes are reads only");
  assert.ok((await stateUpdateTime()).isEqual(created));

  const off = await feed(north(800), Array.from({ length: 30 }, (_, i) => 300 + i * 5)); // 300..445 s
  assert.deepEqual(off.map((r) => r.wrote).filter(Boolean).length, 1, "one write: the off-route anchor");
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, T0 + 300000);
});

test("only the threshold creates the event and alert; remaining deviated writes nothing; recovery anchor is stable", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_steady01", "o1");
  const far = north(800);
  await feed(far, Array.from({ length: 19 }, (_, i) => i * 10)); // deviates at 180 s
  assert.equal((await all(C.ALERTS)).length, 1);
  const [states, events, alerts] = [await updateTimes(C.STATES), await updateTimes(C.EVENTS), await updateTimes(C.ALERTS)];

  const staying = await feed(far, Array.from({ length: 30 }, (_, i) => 190 + i * 10));
  assert.ok(staying.every((r) => r.wrote === false && r.event === null));
  assert.deepEqual(await updateTimes(C.STATES), states, "deviation state not rewritten");
  assert.deepEqual(await updateTimes(C.EVENTS), events, "no new or rewritten event");
  assert.deepEqual(await updateTimes(C.ALERTS), alerts, "no new or rewritten alert");

  const back = north(100);
  await feed(back, [500, 510, 520, 530]);
  const recovering = await get(C.STATES, RIDER);
  assert.equal(recovering.pendingReturnSinceMs, T0 + 500000, "recovery anchor fixed at the first in-corridor fix");
  assert.equal((await locate(back, 620)).event, "returned");
  // Retrying the return transition changes nothing.
  const after = [await updateTimes(C.STATES), await updateTimes(C.EVENTS), await updateTimes(C.ALERTS)];
  assert.equal((await locate(back, 620, 10, { retry: true })).wrote, false);
  assert.deepEqual([await updateTimes(C.STATES), await updateTimes(C.EVENTS), await updateTimes(C.ALERTS)], after);
});

test("a replaced session's late fixes cannot alter the new session's state", async () => {
  await wipe();
  await seedOrder("o1");
  await seedOrder("o2");
  await startSession("sess_old00001", "o1");
  await feed(north(800), [0, 60]);
  // The rider starts navigating o2 at T0 + 100 s.
  const data = { riderUid: RIDER, orderId: "o2", sessionId: "sess_new00001", state: "navigating", startedAt: Timestamp.fromMillis(T0 + 100000), updatedAt: Timestamp.fromMillis(T0 + 100000), endedAt: null, endReason: null };
  await db.collection(C.SESSIONS).doc(RIDER).set(data);
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: data });
  const fresh = await get(C.STATES, RIDER);
  const freshTime = await stateUpdateTime();
  assert.deepEqual([fresh.sessionId, fresh.pendingOffSinceMs], ["sess_new00001", null]);
  // A fix captured under the OLD session, delivered late.
  const late = await locate(north(800), 90);
  assert.deepEqual([late.ignored, late.wrote], ["before_session", false]);
  assert.ok((await stateUpdateTime()).isEqual(freshTime));
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, null);
});
