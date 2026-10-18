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
// The session the rider app is navigating: its fixes carry this tag, exactly
// as RiderTrackingController writes them (navigationSessionId + activeOrderId).
let navSession = null;
let navOrder = null;

async function wipe() {
  prevLoc = null;
  retryPrev = null;
  navSession = null;
  navOrder = null;
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
async function startSession(sessionId, orderId, startedMs = T0 - 1000) {
  const data = { riderUid: RIDER, orderId, sessionId, state: "navigating", startedAt: Timestamp.fromMillis(startedMs), updatedAt: Timestamp.fromMillis(startedMs), endedAt: null, endReason: null };
  await db.collection(C.SESSIONS).doc(RIDER).set(data);
  navSession = sessionId;
  navOrder = orderId;
  return ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: data });
}

/**
 * A riderLocations doc as written by the rider, then the location trigger with
 * the previous version. `retry` re-delivers the last write (at-least-once).
 * Fixes are tagged with the navigated session unless `untagged` (ordinary
 * tracking) or `session` names another one; `ended` is the sign-out write.
 */
function locate(point, seconds, accuracyMeters = 10, { retry = false, untagged = false, session = navSession, ended = false } = {}) {
  const at = Timestamp.fromMillis(T0 + seconds * 1000);
  const tag = untagged || ended ? { navigationSessionId: null, activeOrderId: null } : { navigationSessionId: session, activeOrderId: session === navSession ? navOrder : "otherOrder" };
  const location = ended
    ? { riderUid: RIDER, latitude: null, longitude: null, accuracyMeters: null, capturedAt: at, updatedAt: at, trackingState: "ended", ...tag }
    : { riderUid: RIDER, latitude: point.lat, longitude: point.lng, accuracyMeters, capturedAt: at, updatedAt: at, trackingState: "active", ...tag };
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
  assert.deepEqual([retried.event, retried.ignored, retried.wrote], [null, "replay", false], "a redelivered fix is a recognised replay");
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

test("poor accuracy and late (out-of-order) fixes never move the deviation state", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_accuracy", "o1");
  await locate(north(800), 0);
  // The inaccurate fix interrupts the run: its ONLY write is the last good time.
  const r = await locate(north(800), 60, 300);
  assert.deepEqual([r.reason, r.wrote], ["poor_accuracy", true]);
  const afterPoor = await get(C.STATES, RIDER);
  assert.deepEqual([afterPoor.pendingOffSinceMs, afterPoor.lastQualifyingFixAtMs, afterPoor.phase], [T0, T0, "on_route"]);
  // The next good fix (qualifying gap 120 s: continuous) is recorded as
  // navigation evidence — the deviation anchor itself does not move.
  const good = await locate(north(800), 120);
  assert.deepEqual([good.event, good.wrote], [null, true]);
  assert.deepEqual([(await get(C.STATES, RIDER)).pendingOffSinceMs, (await get(C.STATES, RIDER)).lastQualifyingFixAtMs], [T0, T0 + 120000]);
  const anchored = await stateUpdateTime();
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
  assert.ok((await stateUpdateTime()).isEqual(anchored), "a superseded event with no session evidence writes nothing");
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

test("write contract: each NEW tagged fix records itself once; deviation anchors move only on transitions; replays write nothing", async () => {
  // Contract changed with the event-ordering fix: recording every tagged fix
  // (one state write each, ~2/min while navigating) is what lets a reordered
  // or superseded event still know the session is alive.
  await wipe();
  await seedOrder("o1");
  await startSession("sess_quiet001", "o1");
  const onRoute = await feed(north(50), Array.from({ length: 30 }, (_, i) => i * 10));
  assert.ok(onRoute.every((r) => r.wrote === true && r.event === null), "each new fix: one evidence write");
  const quiet = await get(C.STATES, RIDER);
  assert.deepEqual([quiet.phase, quiet.pendingOffSinceMs, quiet.lastTransitionAtMs], ["on_route", null, null], "no deviation transition");
  assert.deepEqual([quiet.lastTaggedFixAtMs, quiet.lastQualifyingFixAtMs], [T0 + 290000, T0 + 290000]);

  // Replays of the latest fix: no write at all.
  const written = await stateUpdateTime();
  for (let i = 0; i < 3; i++) assert.equal((await locate(north(50), 290, 10, { retry: true })).wrote, false);
  assert.ok((await stateUpdateTime()).isEqual(written));

  const off = await feed(north(800), Array.from({ length: 30 }, (_, i) => 300 + i * 5)); // 300..445 s
  assert.ok(off.every((r) => r.wrote === true));
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, T0 + 300000, "the off-route anchor is set once and never restarts");
});

test("only the threshold creates the event and alert; remaining deviated writes nothing; recovery anchor is stable", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_steady01", "o1");
  const far = north(800);
  await feed(far, Array.from({ length: 19 }, (_, i) => i * 10)); // deviates at 180 s
  assert.equal((await all(C.ALERTS)).length, 1);
  const [states, events, alerts] = [await updateTimes(C.STATES), await updateTimes(C.EVENTS), await updateTimes(C.ALERTS)];

  const deviated = await get(C.STATES, RIDER);
  const staying = await feed(far, Array.from({ length: 30 }, (_, i) => 190 + i * 10));
  assert.ok(staying.every((r) => r.event === null));
  assert.equal(Object.keys(states).length, 1, "one state document per rider");
  const still = await get(C.STATES, RIDER);
  assert.deepEqual(
    [still.phase, still.episode, still.openAlertId, still.lastTransitionAtMs, still.pendingReturnSinceMs],
    [deviated.phase, deviated.episode, deviated.openAlertId, deviated.lastTransitionAtMs, deviated.pendingReturnSinceMs],
    "deviation state unchanged (only the navigation evidence advances)"
  );
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
  const late = await locate(north(800), 90, 10, { session: "sess_old00001" });
  assert.deepEqual([late.evaluated, late.reason], [false, "before_session"]);
  assert.ok((await stateUpdateTime()).isEqual(freshTime));
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, null);
});

// ---------------------------------------------------------------- staging QA 2026-10-14: session lifecycle + timer

test("A-F1: a session left behind is never evaluated by ordinary fixes — it is ended as abandoned, no alert", async () => {
  await wipe();
  // The staging shape: a DELAYED order whose navigation session was never ended.
  await seedOrder("o1", { status: "delayed" });
  await startSession("sess_leftover1", "o1");
  const created = await stateUpdateTime();
  const far = north(1650);

  // Inside the start-up grace an untagged fix is merely ignored — no write.
  const early = await locate(far, 30, 10, { untagged: true });
  assert.deepEqual([early.evaluated, early.reason], [false, "untagged_fix"]);
  assert.ok((await stateUpdateTime()).isEqual(created));

  // Ordinary tracking past the grace: the app is not navigating it. Ended, not measured.
  const ordinary = await locate(far, 137, 10, { untagged: true });
  assert.deepEqual([ordinary.evaluated, ordinary.reason, ordinary.ended], [false, "abandoned", true]);
  const session = await get(C.SESSIONS, RIDER);
  assert.deepEqual([session.state, session.endReason], ["ended", "abandoned"]);
  assert.ok(session.endedAt instanceof Timestamp);
  const state = await get(C.STATES, RIDER);
  assert.deepEqual([state.sessionState, state.endReason, state.pendingOffSinceMs, state.openAlertId], ["ended", "abandoned", null, null]);

  // Hours of further ordinary tracking: nothing is ever evaluated or alerted.
  await feed(far, [259, 381, 503, 3600]);
  assert.equal((await all(C.ALERTS)).length, 0, "no false route-deviation alert");
  assert.equal((await all(C.EVENTS)).length, 0);
});

test("abandoning a session that WAS deviating resolves its open alert exactly once (retry-safe)", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_wasdev01", "o1");
  await feed(north(800), [0, 30, 60, 90, 120, 150, 180]);
  const alertId = T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_wasdev01" });
  assert.equal((await get(C.ALERTS, alertId)).status, "active");

  const ended = await locate(north(800), 400, 10, { untagged: true });
  assert.equal(ended.reason, "abandoned");
  const alert = await get(C.ALERTS, alertId);
  assert.deepEqual([alert.status, alert.resolutionReason], ["resolved", "abandoned"]);
  assert.ok((await all(C.EVENTS)).some((e) => e.id === "sess_wasdev01_e1_session_closed"));

  // The session trigger re-fires for the ended doc, and the location trigger is retried: no change.
  const times = [await updateTimes(C.ALERTS), await updateTimes(C.EVENTS), await updateTimes(C.STATES)];
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: await get(C.SESSIONS, RIDER) });
  const retried = await locate(north(800), 400, 10, { untagged: true, retry: true });
  assert.equal(retried.reason, "not_navigating");
  assert.deepEqual([await updateTimes(C.ALERTS), await updateTimes(C.EVENTS), await updateTimes(C.STATES)], times);
});

test("sign-out (sharing ended) ends the session and resolves its alert", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_signout1", "o1");
  await feed(north(800), [0, 30, 60, 90, 120, 150, 180]);
  const r = await locate(null, 200, 10, { ended: true });
  assert.deepEqual([r.reason, r.ended], ["tracking_stopped", true]);
  assert.deepEqual([(await get(C.SESSIONS, RIDER)).endReason, (await get(C.STATES, RIDER)).sessionState], ["tracking_stopped", "ended"]);
  const alert = await get(C.ALERTS, T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_signout1" }));
  assert.deepEqual([alert.status, alert.resolutionReason], ["resolved", "tracking_stopped"]);
});

test("a DELAYED order keeps being monitored only through tagged fixes, and the rider's Stop ends it", async () => {
  await wipe();
  await seedOrder("o1", { status: "delayed" });
  await startSession("sess_delayed1", "o1");
  const results = await feed(north(800), [0, 30, 60, 90, 120, 150, 180]);
  assert.equal(results.at(-1).event, "deviated", "delayed is still navigable — tagged fixes are evaluated");
  // Stop Navigation (rider_stopped), as the app writes it for a delayed order.
  const session = await get(C.SESSIONS, RIDER);
  const stopped = { ...session, state: "ended", endReason: "rider_stopped", endedAt: Timestamp.fromMillis(T0 + 200000), updatedAt: Timestamp.fromMillis(T0 + 200000) };
  await db.collection(C.SESSIONS).doc(RIDER).set(stopped);
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: stopped });
  const alert = await get(C.ALERTS, T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_delayed1" }));
  assert.deepEqual([alert.status, alert.resolutionReason], ["resolved", "rider_stopped"]);
  assert.equal((await locate(north(900), 300)).reason, "not_navigating");
});

test("DEV-2: a continuously deviating navigating rider alerts once at 3:00 — the anchor never restarts", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_dev2a001", "o1");
  const far = north(800);
  const results = await feed(far, [0, 30, 60, 90, 120, 150, 179]);
  assert.ok(results.every((r) => r.event === null));
  assert.equal((await all(C.ALERTS)).length, 0, "2:59 — no alert");
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, T0, "the FIRST off-route fix stays the anchor");
  assert.equal((await locate(far, 180)).event, "deviated");
  await feed(far, [210, 240, 270]);
  const alerts = await all(C.ALERTS);
  assert.equal(alerts.length, 1, "exactly one");
  assert.equal(alerts[0].deviatingSinceMs, T0);
});

test("ordinary (untagged) fixes never evaluate, advance or reset the deviation timer", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_mixed001", "o1");
  const far = north(800);
  await locate(far, 0);
  // An untagged ON-ROUTE fix slips in: never evaluated, so it cannot reset the off-route anchor.
  const u = await locate(north(50), 20, 10, { untagged: true });
  assert.deepEqual([u.evaluated, u.reason], [false, "untagged_fix"]);
  // The next tagged fixes continue from the last GOOD fix (0 s): the anchor stands.
  await locate(far, 30);
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, T0, "the ordinary fix neither reset nor broke continuity");
  const results = await feed(far, [60, 90, 120, 150, 179]);
  assert.ok(results.every((x) => x.event === null));
  assert.equal((await locate(far, 180)).event, "deviated", "alert at 3:00 from the FIRST off-route fix");
  assert.equal((await all(C.ALERTS)).length, 1);
});

test("abandonment race: a 30-minute session with a tagged fix 10 s ago survives an accidental untagged fix", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_long0001", "o1");
  const seconds = Array.from({ length: 60 }, (_, i) => i * 30); // tagged every 30 s for 29.5 min
  await feed(north(50), seconds);
  const before = await stateUpdateTime();
  const accidental = await locate(north(50), 1780, 10, { untagged: true }); // 10 s after the last tagged fix
  assert.deepEqual([accidental.reason, accidental.ended], ["untagged_fix", undefined]);
  assert.equal((await get(C.SESSIONS, RIDER)).state, "navigating", "not abandoned");
  // The last tagged fix was already recorded by its OWN event, so the untagged
  // fix — and its replay — write nothing.
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0 + 1770000);
  assert.ok((await stateUpdateTime()).isEqual(before), "nothing new to record");
  assert.equal((await locate(north(50), 1780, 10, { untagged: true, retry: true })).wrote, undefined);
  assert.ok((await stateUpdateTime()).isEqual(before), "replay: no write");
  // A SECOND untagged fix still measures staleness from the stored last tagged fix.
  assert.equal((await locate(north(50), 1800, 10, { untagged: true })).reason, "untagged_fix");
  // Navigation resumes normally.
  assert.equal((await locate(north(50), 1810)).evaluated, true);
});

test("stale session: no tagged fix for 3 minutes + an untagged fix → abandoned exactly once; its alert resolved once", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_stale0001", "o1");
  await feed(north(800), [0, 30, 60, 90, 120, 150, 180]);
  const alertId = T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_stale0001" });
  assert.equal((await get(C.ALERTS, alertId)).status, "active");
  // The app stops tagging (killed); 2:59 after the last tagged fix an untagged fix is not yet stale.
  assert.equal((await locate(north(800), 359, 10, { untagged: true })).reason, "untagged_fix");
  assert.equal((await get(C.SESSIONS, RIDER)).state, "navigating");
  // 3:00 after the last tagged fix: stale → abandoned.
  const ended = await locate(north(800), 360, 10, { untagged: true });
  assert.deepEqual([ended.reason, ended.ended], ["abandoned", true]);
  const alert = await get(C.ALERTS, alertId);
  assert.deepEqual([alert.status, alert.resolutionReason], ["resolved", "abandoned"]);
  const times = [await updateTimes(C.ALERTS), await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.EVENTS)];
  // Duplicate triggers: the same write retried, and the session trigger for the ended doc.
  assert.equal((await locate(north(800), 360, 10, { untagged: true, retry: true })).reason, "not_navigating");
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: await get(C.SESSIONS, RIDER) });
  assert.deepEqual([await updateTimes(C.ALERTS), await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.EVENTS)], times, "exactly once");
});

test("strict continuity: an inaccurate fix does not bridge a real gap between good fixes", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_bridge01", "o1");
  const far = north(800);
  await locate(far, 0);
  await locate(far, 100, 150); // inaccurate, tagged
  await locate(far, 200); // 200 s after the last GOOD fix: a gap → the anchor restarts
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, T0 + 200000);
  assert.equal((await all(C.ALERTS)).length, 0, "no alert from a timer bridged by an inaccurate fix");
});

test("a stale fix (written > 60 s after capture) and a session of another rider never count", async () => {
  await wipe();
  await seedOrder("o1");
  await startSession("sess_stalefx1", "o1");
  const at = (s) => Timestamp.fromMillis(T0 + s * 1000);
  const stale = await ops.processLocationWrite({
    db, FieldValue, riderUid: RIDER, previous: null,
    location: { riderUid: RIDER, latitude: north(800).lat, longitude: north(800).lng, accuracyMeters: 5, capturedAt: at(100), updatedAt: at(161), trackingState: "active", navigationSessionId: "sess_stalefx1", activeOrderId: "o1" },
  });
  assert.equal(stale.reason, "stale_fix");
  assert.equal((await get(C.STATES, RIDER)).pendingOffSinceMs, null);

  // A session document that does not belong to the rider whose location moved.
  await db.collection(C.SESSIONS).doc(RIDER).update({ riderUid: "someoneElse" });
  assert.equal((await locate(north(800), 200)).reason, "not_navigating");
});

// ---------------------------------------------------------------- event-ordering race (superseded / reordered triggers)
//
// These write the riderLocations document for real, then deliver each trigger
// event with the exact before/after snapshots Firestore sends for that write —
// in whatever order the test chooses. Delivery is at-least-once and unordered,
// so every order below is one production can produce.

let stored = null; // the riderLocations document as currently stored
const sAt = (s) => Timestamp.fromMillis(T0 + s * 1000);
function fixDoc(seconds, { tagged = true, point = north(50), accuracyMeters = 10, session = navSession, order = navOrder, writtenSeconds = seconds } = {}) {
  return {
    riderUid: RIDER, latitude: point.lat, longitude: point.lng, accuracyMeters,
    capturedAt: sAt(seconds), updatedAt: sAt(writtenSeconds), trackingState: "active",
    navigationSessionId: tagged ? session : null, activeOrderId: tagged ? order : null,
  };
}
/** The rider app's write: stored now; its trigger event is returned for delivery later. */
async function write(doc) {
  const event = { before: stored, after: doc };
  await db.collection(C.LOCATIONS).doc(RIDER).set(doc);
  stored = doc;
  return event;
}
const deliver = (event) => ops.processLocationWrite({ db, FieldValue, riderUid: RIDER, location: event.after, previous: event.before });
async function writeAndDeliver(doc) {
  return deliver(await write(doc));
}

/** Navigating for an hour; tagged fixes every 30 s, delivered in order, the last one at T0 (Tn). */
async function hourOfNavigation(sessionId) {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession(sessionId, "o1", T0 - 3600 * 1000);
  for (let s = -3600 + 30; s <= 0; s += 30) {
    const r = await writeAndDeliver(fixDoc(s));
    assert.equal(r.evaluated, true, `tagged fix at ${s}s is evaluated`);
  }
}
const navigating = async () => (await get(C.SESSIONS, RIDER)).state;

test("RACE-A: Tn, U1, U2 — U1's event arrives after U2 is stored (superseded): healthy navigation is not abandoned", async () => {
  await hourOfNavigation("sess_raceA001");
  const u1 = await write(fixDoc(10, { tagged: false }));
  const u2 = await write(fixDoc(20, { tagged: false }));
  assert.equal((await deliver(u1)).reason, "superseded");
  const r2 = await deliver(u2);
  assert.notEqual(r2.reason, "abandoned", "U2 must not abandon a session tagged 20 s ago");
  assert.equal(await navigating(), "navigating");
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0, "Tn is the last tagged fix on record");
});

test("RACE-B: Tn, U1, U2 — U2's event is processed before U1's: healthy navigation is not abandoned", async () => {
  await hourOfNavigation("sess_raceB001");
  const u1 = await write(fixDoc(10, { tagged: false }));
  const u2 = await write(fixDoc(20, { tagged: false }));
  const r2 = await deliver(u2);
  assert.notEqual(r2.reason, "abandoned");
  assert.equal((await deliver(u1)).reason, "superseded");
  assert.equal(await navigating(), "navigating");
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0);
});

test("RACE-C: Tn's own event is late too (U2, U1, then Tn): not abandoned; the record converges on Tn", async () => {
  await hourOfNavigation("sess_raceC001");
  const tn1 = await write(fixDoc(30)); // Tn+1 at +30 s — its event is the late one
  const u1 = await write(fixDoc(40, { tagged: false }));
  const u2 = await write(fixDoc(50, { tagged: false }));
  assert.notEqual((await deliver(u2)).reason, "abandoned", "Tn (T0) is on record: 50 s ago");
  assert.equal((await deliver(u1)).reason, "superseded");
  assert.equal((await deliver(tn1)).reason, "superseded");
  assert.equal(await navigating(), "navigating");
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0 + 30000, "the late tagged fix is still recorded");
});

test("RACE-D: duplicates and replays after the reordered sequences change nothing; the record never moves back", async () => {
  await hourOfNavigation("sess_raceD001");
  const u1 = await write(fixDoc(10, { tagged: false }));
  const u2 = await write(fixDoc(20, { tagged: false }));
  await deliver(u2);
  await deliver(u1);
  const state = await get(C.STATES, RIDER);
  const time = await stateUpdateTime();
  for (const e of [u2, u1, u2, u1]) {
    const r = await deliver(e);
    assert.notEqual(r.reason, "abandoned");
  }
  assert.ok((await stateUpdateTime()).isEqual(time), "replays write nothing");
  assert.deepEqual(await get(C.STATES, RIDER), state);
  assert.equal(await navigating(), "navigating");
  // Navigation continues: the next tagged fix is evaluated and advances the record.
  assert.equal((await writeAndDeliver(fixDoc(30))).evaluated, true);
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0 + 30000);
  // An OLDER tagged fix's event, replayed late, never moves the record backwards.
  await deliver({ before: fixDoc(-30), after: fixDoc(0) });
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0 + 30000);
});

test("RACE-E: a stored last-tagged time that LOOKS stale is overridden by a newer tagged fix the event can see", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession("sess_raceE001", "o1", T0 - 3600 * 1000);
  await writeAndDeliver(fixDoc(-400)); // last tagged fix ON RECORD: 400 s before T0
  // Tn at T0 is written but its own event has not run yet …
  await write(fixDoc(0));
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0 - 400000, "the record looks stale");
  // … U1's event carries Tn as its previous fix: 10 s ago, not stale.
  const r = await deliver(await write(fixDoc(10, { tagged: false })));
  assert.equal(r.reason, "untagged_fix");
  assert.equal(await navigating(), "navigating");
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, T0, "the newer tagged fix is now on record");
});

test("RACE-F: missing history is not proof — a state written before recording existed is never presumed stale at once", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession("sess_raceF001", "o1", T0 - 3600 * 1000);
  // The shape of a state written by the previous code: an old interruption
  // time and no record start.
  const legacy = await get(C.STATES, RIDER);
  delete legacy.taggedHistorySinceMs;
  await db.collection(C.STATES).doc(RIDER).set({ ...legacy, lastTaggedFixAtMs: T0 - 1800 * 1000, lastQualifyingFixAtMs: null });
  const u1 = await writeAndDeliver(fixDoc(0, { tagged: false }));
  assert.equal(u1.reason, "untagged_fix", "unknown history: not abandoned");
  assert.equal((await get(C.STATES, RIDER)).taggedHistorySinceMs, T0, "recording starts now");
  assert.equal((await writeAndDeliver(fixDoc(179, { tagged: false }))).reason, "untagged_fix");
  assert.equal(await navigating(), "navigating");
  // A full stale period with no tagged fix since recording began: genuinely stale.
  assert.equal((await writeAndDeliver(fixDoc(180, { tagged: false }))).reason, "abandoned");
  assert.equal(await navigating(), "ended");
});

test("RACE-G: a truly stale session is still abandoned exactly once — whatever order its untagged events arrive in", async () => {
  await hourOfNavigation("sess_raceG001"); // last tagged fix at T0
  const u1 = await write(fixDoc(170, { tagged: false }));
  const u2 = await write(fixDoc(185, { tagged: false }));
  const u3 = await write(fixDoc(200, { tagged: false }));
  assert.equal((await deliver(u3)).reason, "abandoned", "the latest untagged fix, 3:20 after the last tagged one");
  const times = [await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.ALERTS)];
  for (const e of [u1, u2, u3, u2]) assert.equal((await deliver(e)).reason, "not_navigating");
  assert.deepEqual([await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.ALERTS)], times, "ended once");
  assert.equal((await get(C.SESSIONS, RIDER)).endReason, "abandoned");
});

test("RACE-H: startup grace — no tagged fix ever: ignored inside 60 s, abandoned after it (complete record from the start)", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession("sess_raceH001", "o1", T0);
  assert.equal((await get(C.STATES, RIDER)).taggedHistorySinceMs, T0, "a state created with the session records from its start");
  assert.equal((await writeAndDeliver(fixDoc(59, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(60, { tagged: false }))).reason, "abandoned");
});

test("RACE-I: after a session is replaced, delayed events of the OLD session neither record evidence for, nor end, the new one", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await seedOrder("o2");
  await startSession("sess_raceIold", "o1", T0 - 600 * 1000);
  const oldA = await write(fixDoc(-20)); // old-session tagged fixes whose events are still in flight
  const oldB = await write(fixDoc(-10));
  await startSession("sess_raceInew", "o2", T0);
  const fresh = await get(C.STATES, RIDER);
  const freshTime = await stateUpdateTime();
  // Delivered late: one superseded, one the latest stored document.
  assert.equal((await deliver(oldA)).reason, "superseded");
  assert.equal((await deliver(oldB)).reason, "before_session");
  assert.ok((await stateUpdateTime()).isEqual(freshTime), "the new session's state is untouched");
  assert.deepEqual(await get(C.STATES, RIDER), fresh);
  assert.equal(await navigating(), "navigating");
  // An old-session fix written AFTER the new start does not count either:
  // the new session has still seen no tagged fix, so its grace decides.
  await writeAndDeliver(fixDoc(30, { session: "sess_raceIold", order: "o1" }));
  assert.equal((await get(C.STATES, RIDER)).lastTaggedFixAtMs, null);
  assert.equal((await writeAndDeliver(fixDoc(61, { tagged: false }))).reason, "abandoned");
});

test("RACE-J: reordered events — no alert before 3:00, exactly one at 3:00 with real continuity, resolved exactly once", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession("sess_raceJ001", "o1", T0 - 1000);
  const far = north(800);
  // Off route, tagged every 30 s, with an untagged fix after each. Each pair's
  // events are delivered in REVERSE order (the untagged one first), so every
  // tagged fix is only ever seen as evidence, never evaluated itself.
  for (let s = 0; s <= 150; s += 30) {
    const tagged = await write(fixDoc(s, { point: far }));
    const untagged = await write(fixDoc(s + 10, { tagged: false, point: far }));
    assert.equal((await deliver(untagged)).reason, "untagged_fix");
    assert.equal((await deliver(tagged)).reason, "superseded");
  }
  assert.equal((await all(C.ALERTS)).length, 0, "nothing before 3:00");
  assert.equal(await navigating(), "navigating");
  // The next tagged fix is evaluated; continuity comes from the recorded
  // qualifying fix at 150 s. The timer starts at the first EVALUATED off-route
  // fix — a fix seen only as evidence is never measured against the route.
  assert.equal((await writeAndDeliver(fixDoc(180, { point: far }))).event, null);
  const anchor = (await get(C.STATES, RIDER)).pendingOffSinceMs;
  assert.equal(anchor, T0 + 180000);
  for (const s of [210, 240, 270, 300, 330]) assert.equal((await writeAndDeliver(fixDoc(s, { point: far }))).event, null, `${s}s`);
  const crossing = await writeAndDeliver(fixDoc(360, { point: far }));
  assert.equal(crossing.event, "deviated", "exactly 3:00 after the anchor");
  const alertId = T.deviationAlertId({ orderId: "o1", riderUid: RIDER, sessionId: "sess_raceJ001" });
  assert.deepEqual([(await get(C.ALERTS, alertId)).status, (await get(C.ALERTS, alertId)).deviatingSinceMs], ["active", T0 + 180000]);
  // Replays of the crossing: still exactly one alert, not rewritten.
  const alertTime = (await db.collection(C.ALERTS).doc(alertId).get()).updateTime;
  assert.equal((await deliver({ before: fixDoc(330, { point: far }), after: fixDoc(360, { point: far }) })).ignored, "replay");
  assert.ok((await db.collection(C.ALERTS).doc(alertId).get()).updateTime.isEqual(alertTime));
  assert.equal((await all(C.ALERTS)).length, 1);
  // Back on route for 2 minutes: resolved once; replays do not resolve again.
  const back = north(100);
  for (const s of [390, 420, 450, 480]) await writeAndDeliver(fixDoc(s, { point: back }));
  const ret = await writeAndDeliver(fixDoc(510, { point: back }));
  assert.equal(ret.event, "returned");
  const resolved = await get(C.ALERTS, alertId);
  assert.deepEqual([resolved.status, resolved.resolutionReason], ["resolved", "returned_to_route"]);
  const resolvedTime = (await db.collection(C.ALERTS).doc(alertId).get()).updateTime;
  await deliver({ before: fixDoc(480, { point: back }), after: fixDoc(510, { point: back }) });
  assert.ok((await db.collection(C.ALERTS).doc(alertId).get()).updateTime.isEqual(resolvedTime), "resolved exactly once");
  assert.deepEqual((await all(C.EVENTS)).map((e) => e.id).sort(), ["sess_raceJ001_e1_deviated", "sess_raceJ001_e1_returned"]);
});

test("RACE-K: no bridging — poor, late, untagged and wrong-session fixes (in any order) never close a real qualifying gap", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startSession("sess_raceK001", "o1", T0 - 1000);
  const far = north(800);
  await writeAndDeliver(fixDoc(0, { point: far })); // qualifying, off route: anchor 0
  // Between 0 and 200 s: nothing that qualifies.
  const poor = await write(fixDoc(40, { point: far, accuracyMeters: 150 }));
  const late = await write(fixDoc(80, { point: far, writtenSeconds: 145 })); // written 65 s after capture
  const untagged = await write(fixDoc(150, { tagged: false, point: far }));
  const wrong = await write(fixDoc(170, { point: far, session: "sess_someoneElse", order: "oX" }));
  for (const e of [wrong, poor, untagged, late]) await deliver(e); // scrambled
  assert.equal((await get(C.STATES, RIDER)).lastQualifyingFixAtMs, T0, "only the real qualifying fix is on record");
  const next = await writeAndDeliver(fixDoc(200, { point: far }));
  assert.equal(next.event, null);
  const state = await get(C.STATES, RIDER);
  assert.equal(state.pendingOffSinceMs, T0 + 200000, "200 s since the last qualifying fix: the timer restarts");
  assert.equal(state.lastQualifyingFixAtMs, T0 + 200000);
  assert.equal(state.lastTaggedFixAtMs, T0 + 200000);
  assert.equal((await all(C.ALERTS)).length, 0);
  // 3:00 is measured from the restart, not from 0.
  for (const s of [230, 260, 290, 320, 350]) assert.equal((await writeAndDeliver(fixDoc(s, { point: far }))).event, null);
  assert.equal((await writeAndDeliver(fixDoc(380, { point: far }))).event, "deviated");
});

// ---------------------------------------------------------------- confirmed continuity (navigation continuity version 1)
//
// The residual race of the evidence rule: Tn's own event AND the event of the
// write after it (whose `before` is Tn) are both still undelivered when a later
// untagged fix is processed. Nothing in any trigger snapshot then shows Tn, and
// a legacy session is falsely abandoned (reproduced against the previous code:
// REPRO-1/2/3 in the 2026-10-17 report). A session started with
// continuityVersion 1 carries its own anchor: the Rider app confirms each
// qualifying tagged fix on the session document (lastNavigationFixAt = that
// fix's server write time; firestore.rules verify it — see the rules suite),
// and the app's writes commit in order, so the confirmation is stored before
// any later location write. `appWrite` below is the app: it stores the fix,
// then confirms it exactly when the rules would accept the confirmation.

const ms = (t) => t.toMillis();
async function startConfirmedSession(sessionId, orderId, startedMs) {
  const data = {
    riderUid: RIDER, orderId, sessionId, state: "navigating",
    startedAt: Timestamp.fromMillis(startedMs), updatedAt: Timestamp.fromMillis(startedMs),
    endedAt: null, endReason: null, continuityVersion: 1,
  };
  await db.collection(C.SESSIONS).doc(RIDER).set(data);
  navSession = sessionId;
  navOrder = orderId;
  return ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: data, before: null });
}
/** The Rider app's confirmation, accepted exactly when firestore.rules accept it (atomic with the session doc). */
async function appConfirm(doc) {
  const ref = db.collection(C.SESSIONS).doc(RIDER);
  return db.runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data();
    const qualifies = typeof doc.navigationSessionId === "string" && typeof doc.activeOrderId === "string" &&
      doc.trackingState === "active" && T.isValidCoordinate(doc.latitude, doc.longitude) &&
      typeof doc.accuracyMeters === "number" && doc.accuracyMeters <= 100 &&
      ms(doc.updatedAt) - ms(doc.capturedAt) <= 60000;
    const accepted = qualifies && s?.state === "navigating" && s.continuityVersion === 1 &&
      s.sessionId === doc.navigationSessionId && s.orderId === doc.activeOrderId &&
      ms(doc.updatedAt) > ms(s.startedAt) && (s.lastNavigationFixAt == null || ms(doc.updatedAt) > ms(s.lastNavigationFixAt));
    if (accepted) tx.update(ref, { lastNavigationFixAt: doc.updatedAt, updatedAt: doc.updatedAt });
    return accepted;
  });
}
async function appWrite(doc) {
  const event = await write(doc);
  event.confirmed = await appConfirm(doc);
  return event;
}
const sessionDoc = () => get(C.SESSIONS, RIDER);

/** Confirmed-continuity navigation for an hour, tagged every 30 s, every event delivered in order up to T(n-1) at -30 s. */
async function confirmedHour(sessionId) {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startConfirmedSession(sessionId, "o1", T0 - 3600 * 1000);
  for (let s = -3600 + 30; s <= -30; s += 30) {
    const e = await appWrite(fixDoc(s));
    assert.equal(e.confirmed, true);
    assert.equal((await deliver(e)).evaluated, true);
  }
}

test("CC-1 normal order: Tn, U1, U2 (U2 155 s after Tn) — not abandoned; 3:00 after Tn it is", async () => {
  await confirmedHour("sess_cc000001");
  const tn = await appWrite(fixDoc(0));
  assert.equal(tn.confirmed, true);
  const u1 = await appWrite(fixDoc(10, { tagged: false }));
  const u2 = await appWrite(fixDoc(155, { tagged: false }));
  assert.equal((await deliver(tn)).reason, "superseded", "already overwritten by U2 when it runs");
  assert.equal((await deliver(u1)).reason, "superseded");
  assert.equal((await deliver(u2)).reason, "untagged_fix");
  assert.equal(await navigating(), "navigating");
  assert.equal(ms((await sessionDoc()).lastNavigationFixAt), T0);
  assert.equal((await writeAndDeliver(fixDoc(179, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(180, { tagged: false }))).reason, "abandoned");
});

test("CC-2 reverse processing: U2, U1, then Tn — not abandoned (the case that ended the session before)", async () => {
  await confirmedHour("sess_cc000002");
  const tn = await appWrite(fixDoc(0));
  const u1 = await appWrite(fixDoc(10, { tagged: false }));
  const u2 = await appWrite(fixDoc(155, { tagged: false }));
  assert.equal((await deliver(u2)).reason, "untagged_fix", "REPRO-1 abandoned here");
  assert.equal((await deliver(u1)).reason, "superseded");
  assert.equal((await deliver(tn)).reason, "superseded");
  assert.equal(await navigating(), "navigating");
  const st = await get(C.STATES, RIDER);
  assert.equal(st.lastQualifyingFixAtMs, T0, "the trigger record converges on Tn too");
});

test("CC-3/4 Tn overwritten before its handler runs, and Tn/U1 never delivered: the qualifying fix is not lost", async () => {
  await confirmedHour("sess_cc000003");
  await appWrite(fixDoc(0));
  await appWrite(fixDoc(10, { tagged: false }));
  const u2 = await appWrite(fixDoc(20, { tagged: false }));
  assert.equal((await deliver(u2)).reason, "untagged_fix");
  // Only U2's event ever arrives. The anchor is Tn regardless.
  assert.equal(ms((await sessionDoc()).lastNavigationFixAt), T0);
  assert.equal((await writeAndDeliver(fixDoc(179, { tagged: false }))).reason, "untagged_fix", "protected for 3 minutes from Tn");
  assert.equal(await navigating(), "navigating");
  // A superseded handler of Tn, delivered last, still records it — never loses or moves it back.
  await deliver({ before: fixDoc(-30), after: fixDoc(0) });
  assert.equal((await get(C.STATES, RIDER)).lastQualifyingFixAtMs, T0);
  assert.equal((await writeAndDeliver(fixDoc(180, { tagged: false }))).reason, "abandoned");
});

test("CC-5 duplicate delivery of Tn changes nothing after the first", async () => {
  await confirmedHour("sess_cc000005");
  const tn = await appWrite(fixDoc(0));
  assert.equal((await deliver(tn)).evaluated, true);
  const before = await stateUpdateTime();
  const snapshot = await get(C.STATES, RIDER);
  for (let i = 0; i < 3; i += 1) assert.equal((await deliver(tn)).ignored, "replay");
  assert.ok((await stateUpdateTime()).isEqual(before), "no write");
  assert.deepEqual(await get(C.STATES, RIDER), snapshot);
  assert.equal(await navigating(), "navigating");
});

test("CC-6 two qualifying tagged fixes processed in reverse order: the anchor stays at the newer one", async () => {
  await confirmedHour("sess_cc000006");
  const ta = await appWrite(fixDoc(0));
  const tb = await appWrite(fixDoc(30));
  await deliver(tb);
  await deliver(ta);
  assert.equal((await get(C.STATES, RIDER)).lastQualifyingFixAtMs, T0 + 30000);
  assert.equal(ms((await sessionDoc()).lastNavigationFixAt), T0 + 30000);
  // A late, repeated confirmation of the older fix is refused (forward only).
  assert.equal(await appConfirm(fixDoc(0)), false);
  assert.equal(ms((await sessionDoc()).lastNavigationFixAt), T0 + 30000);
  // Staleness counts from the newer one.
  assert.equal((await writeAndDeliver(fixDoc(209, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(210, { tagged: false }))).reason, "abandoned");
});

test("CC-7 an old session's tagged fix arriving after a replacement session started never extends the new one", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await seedOrder("o2");
  await startConfirmedSession("sess_cc07old0", "o1", T0 - 600 * 1000);
  assert.equal((await appWrite(fixDoc(-10))).confirmed, true);
  await startConfirmedSession("sess_cc07new0", "o2", T0);
  assert.equal((await sessionDoc()).lastNavigationFixAt, undefined, "a new session starts without an anchor");
  // The old session's fix, written after the new start.
  const late = await appWrite(fixDoc(30, { session: "sess_cc07old0", order: "o1" }));
  assert.equal(late.confirmed, false, "refused: not this session");
  assert.equal((await deliver(late)).reason, "other_session");
  assert.equal((await sessionDoc()).lastNavigationFixAt, undefined);
  assert.equal((await writeAndDeliver(fixDoc(59, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(60, { tagged: false }))).reason, "abandoned", "the new session's grace decides");
});

test("CC-8 a tagged fix arriving after the session ended does not resurrect or extend it", async () => {
  await confirmedHour("sess_cc000008");
  const ref = db.collection(C.SESSIONS).doc(RIDER);
  const before = await sessionDoc();
  const ended = { ...before, state: "ended", endReason: "rider_stopped", endedAt: sAt(5), updatedAt: sAt(5) };
  await ref.set(ended);
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: ended, before });
  const late = await appWrite(fixDoc(10));
  assert.equal(late.confirmed, false, "refused: the session ended");
  assert.equal((await deliver(late)).reason, "not_navigating");
  const s = await sessionDoc();
  assert.deepEqual([s.state, s.endReason, ms(s.lastNavigationFixAt)], ["ended", "rider_stopped", T0 - 30000]);
  assert.equal((await get(C.STATES, RIDER)).sessionState, "ended");
});

test("CC-9 untagged fixes for under 3 minutes, then a valid tagged fix: never abandoned; the clock restarts from it", async () => {
  await confirmedHour("sess_cc000009");
  await appWrite(fixDoc(0));
  for (const s of [30, 60, 90, 120, 150, 179]) {
    assert.equal((await deliver(await appWrite(fixDoc(s, { tagged: false })))).reason, "untagged_fix", `${s}s`);
  }
  const back = await appWrite(fixDoc(179.5));
  assert.equal(back.confirmed, true);
  assert.equal((await deliver(back)).evaluated, true);
  assert.equal((await writeAndDeliver(fixDoc(359, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(359.5, { tagged: false }))).reason, "abandoned");
});

test("CC-10 no tagged fix for the full threshold: exactly one abandoned ending, whatever is redelivered", async () => {
  await confirmedHour("sess_cc000010");
  const tn = await appWrite(fixDoc(0));
  const u1 = await appWrite(fixDoc(100, { tagged: false }));
  const u2 = await appWrite(fixDoc(180, { tagged: false }));
  const r = await deliver(u2);
  assert.deepEqual([r.reason, r.ended], ["abandoned", true]);
  const times = [await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.ALERTS), await updateTimes(C.EVENTS)];
  for (const e of [u2, u1, tn, u2, tn]) assert.equal((await deliver(e)).reason, "not_navigating");
  await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: await sessionDoc(), before: null });
  assert.deepEqual([await updateTimes(C.SESSIONS), await updateTimes(C.STATES), await updateTimes(C.ALERTS), await updateTimes(C.EVENTS)], times, "ended once");
  assert.equal((await sessionDoc()).endReason, "abandoned");
});

test("CC-11 concurrent stale evaluations and tagged-fix persistence never produce a false ending", async () => {
  for (let round = 0; round < 3; round += 1) {
    await confirmedHour(`sess_cc11r${round}00`);
    const tn = await appWrite(fixDoc(0));
    const u1 = await appWrite(fixDoc(10, { tagged: false }));
    const u2 = await appWrite(fixDoc(170, { tagged: false }));
    // Every event at once, twice over — evidence transactions and stale
    // evaluations racing on the same state and session documents.
    const results = await Promise.all([u2, tn, u1, u2].map(deliver));
    assert.equal(results.some((x) => x.reason === "abandoned"), false, `round ${round}`);
    assert.equal(await navigating(), "navigating");
    assert.equal((await get(C.STATES, RIDER)).lastQualifyingFixAtMs, T0);
  }
  // A genuinely stale write racing the app's NEXT tagged fix (written after
  // it, confirmed concurrently with its evaluation): either the stale write
  // was judged first (abandoned — correct at that moment; the late
  // confirmation is then refused) or it became superseded (never ends). Never
  // anything else, and never an anchor on an ended session.
  await confirmedHour("sess_cc11last");
  await appWrite(fixDoc(0));
  const stale = await appWrite(fixDoc(181, { tagged: false }));
  const [r, confirmed] = await Promise.all([
    deliver(stale),
    (async () => appConfirm((await write(fixDoc(190))).after))(),
  ]);
  const s = await sessionDoc();
  if (r.reason === "abandoned") {
    assert.deepEqual([s.state, confirmed], ["ended", false]);
  } else {
    assert.equal(r.reason, "superseded");
    assert.deepEqual([s.state, confirmed, ms(s.lastNavigationFixAt)], ["navigating", true, T0 + 190000]);
  }
});

test("CC-12 missing or malformed session/order tags never extend continuity", async () => {
  await confirmedHour("sess_cc000012");
  await appWrite(fixDoc(0));
  const bad = [
    { ...fixDoc(40), navigationSessionId: "" },
    { ...fixDoc(60), activeOrderId: null },
    { ...fixDoc(80), activeOrderId: "otherOrder" },
    { ...fixDoc(100), navigationSessionId: 12345 },
    { ...fixDoc(120), navigationSessionId: "sess_someoneElse" },
    { ...fixDoc(140), activeOrderId: undefined },
  ].map((d) => JSON.parse(JSON.stringify({ ...d, capturedAt: null, updatedAt: null })))
    .map((d, i) => ({ ...d, capturedAt: sAt(40 + i * 20), updatedAt: sAt(40 + i * 20) }));
  for (const d of bad) {
    const e = await appWrite(d);
    assert.equal(e.confirmed, false, JSON.stringify(d.navigationSessionId) + "/" + JSON.stringify(d.activeOrderId));
    await deliver(e);
  }
  assert.equal(ms((await sessionDoc()).lastNavigationFixAt), T0);
  assert.equal((await writeAndDeliver(fixDoc(180, { tagged: false }))).reason, "abandoned", "measured from Tn only");
});

test("CC-13 inaccurate or late-written tagged fixes never extend continuity", async () => {
  await confirmedHour("sess_cc000013");
  await appWrite(fixDoc(0));
  const poor = await appWrite(fixDoc(60, { accuracyMeters: 150 }));
  const late = await appWrite(fixDoc(90, { writtenSeconds: 155 })); // stored 65 s after capture
  assert.deepEqual([poor.confirmed, late.confirmed], [false, false]);
  await deliver(late);
  await deliver(poor);
  const st = await get(C.STATES, RIDER);
  assert.equal(st.lastQualifyingFixAtMs, T0, "only Tn qualified");
  assert.equal(st.lastTaggedFixAtMs, T0 + 155000, "they are still recorded as tagged evidence");
  assert.equal((await writeAndDeliver(fixDoc(180, { tagged: false }))).reason, "abandoned", "3:00 after the last QUALIFYING fix");
});

test("CC-14 startup grace with no tagged fix still expires", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startConfirmedSession("sess_cc000014", "o1", T0);
  assert.equal((await writeAndDeliver(fixDoc(59, { tagged: false }))).reason, "untagged_fix");
  assert.equal((await writeAndDeliver(fixDoc(60, { tagged: false }))).reason, "abandoned");
  // …but a qualifying fix within the grace protects it (the startup-grace form of the race).
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startConfirmedSession("sess_cc014b00", "o1", T0);
  const tn = await appWrite(fixDoc(50));
  const u1 = await appWrite(fixDoc(55, { tagged: false }));
  const u2 = await appWrite(fixDoc(65, { tagged: false }));
  assert.equal((await deliver(u2)).reason, "untagged_fix", "REPRO-2 abandoned here");
  await deliver(u1);
  await deliver(tn);
  assert.equal(await navigating(), "navigating");
  assert.equal((await writeAndDeliver(fixDoc(230, { tagged: false }))).reason, "abandoned", "3:00 after Tn");
});

test("CC-15 repeated and reordered handlers create no duplicate deviation, recovery or abandonment events", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startConfirmedSession("sess_cc000015", "o1", T0 - 1000);
  const far = north(800);
  const back = north(100);
  const events = [];
  // Off route 0–180 s (deviation), back on route 210–330 s (recovery), off again
  // 360–540 s (second deviation), then the app stops tagging.
  const plan = [
    ...[0, 30, 60, 90, 120, 150, 180].map((s) => [s, far]),
    ...[210, 240, 270, 300, 330].map((s) => [s, back]),
    ...[360, 390, 420, 450, 480, 510, 540].map((s) => [s, far]),
  ];
  for (const [s, point] of plan) {
    const e = await appWrite(fixDoc(s, { point }));
    events.push(e);
    await deliver(e);
    await deliver(e); // at-least-once
  }
  const u1 = await appWrite(fixDoc(600, { tagged: false, point: far }));
  const u2 = await appWrite(fixDoc(720, { tagged: false, point: far })); // 3:00 after 540 s
  events.push(u1, u2);
  assert.equal((await deliver(u2)).reason, "abandoned");
  // Everything again, reversed and doubled.
  for (const e of [...events].reverse()) {
    await deliver(e);
    await deliver(e);
  }
  const ids = (await all(C.EVENTS)).map((e) => e.id).sort();
  assert.deepEqual(ids, [
    "sess_cc000015_e1_deviated", "sess_cc000015_e1_returned",
    "sess_cc000015_e2_deviated", "sess_cc000015_e2_session_closed",
  ]);
  const alerts = await all(C.ALERTS);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].status, alerts[0].resolutionReason, alerts[0].episodeCount], ["resolved", "abandoned", 2]);
  assert.deepEqual([(await sessionDoc()).state, (await sessionDoc()).endReason], ["ended", "abandoned"]);
});

test("a confirmation-only session write is skipped by the session trigger; real session changes are not", async () => {
  await wipe();
  stored = null;
  await seedOrder("o1");
  await startConfirmedSession("sess_ccskip01", "o1", T0 - 1000);
  const stateTime = await stateUpdateTime();
  const before = await sessionDoc();
  await appWrite(fixDoc(0));
  const after = await sessionDoc();
  assert.deepEqual(await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after, before }), { started: null, closed: null, skipped: "fix_confirmation" });
  assert.ok((await stateUpdateTime()).isEqual(stateTime));
  // An end is handled as before.
  const ended = { ...after, state: "ended", endReason: "rider_stopped", endedAt: sAt(5), updatedAt: sAt(5) };
  await db.collection(C.SESSIONS).doc(RIDER).set(ended);
  assert.equal((await ops.handleSessionWrite({ db, FieldValue, riderUid: RIDER, after: ended, before: after })).closed, "sess_ccskip01");
});
