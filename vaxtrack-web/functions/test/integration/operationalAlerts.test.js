"use strict";

/**
 * Operational alerts against a REAL Firestore (emulator): stale rider location
 * (riderLocationStaleOps.js) and the late-delivery alert's resolution
 * (statusEvents.recordStatusEvent). Transactions, replays and races are
 * properties a pure test cannot prove.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-operational-alerts" }, "operational-alerts");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const ops = require("../../src/riderLocationStaleOps");
const S = require("../../src/riderLocationStale");
const timingOps = require("../../src/deliveryTimingOps");
const { recordStatusEvent, deriveStatusEvent } = require("../../src/statusEvents");
const D = require("../../src/deliveryTiming");

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-27T02:00:00Z");
const R = "rider1";
const at = (ms) => new Date(ms);
const tsAt = (ms) => Timestamp.fromMillis(ms);

async function wipe() {
  for (const c of ["riderDispatchStates", "riderTrips", "riderLocations", ops.WATCHES, "alerts", "users", "orders"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map(async (d) => {
      for (const sub of await d.ref.listCollections()) {
        const s = await sub.get();
        await Promise.all(s.docs.map((x) => x.ref.delete()));
      }
      await d.ref.delete();
    }));
  }
  await db.collection("users").doc(R).set({ role: "rider", status: "approved", fullName: "Ana Cruz" });
}

/** A Rider on a departed, server-owned trip (as Finalize Dispatch leaves it). */
async function departed({ tripId = "trip1", departedMs = T0, orderIds = ["o1", "o2"], riderUid = R } = {}) {
  await db.collection("riderTrips").doc(tripId).set({ riderUid, status: "departed", orderIds, departedAt: departedMs === null ? null : tsAt(departedMs) });
  await db.collection("riderDispatchStates").doc(riderUid).set({
    riderUid, state: "on_trip", tripId, orderIds, heldOrderIds: [], departedAt: departedMs === null ? null : tsAt(departedMs),
  });
}
/** A fix as the rider app writes it: capture time, and the server write time the rules pin. */
const writeFix = (capturedMs, writtenMs = capturedMs) =>
  db.collection("riderLocations").doc(R).set({
    riderUid: R, latitude: 14.6, longitude: 120.98, accuracyMeters: 12, headingDegrees: null, speedMps: null,
    capturedAt: tsAt(capturedMs), updatedAt: tsAt(writtenMs), trackingState: "active",
    activeOrderId: null, navigationSessionId: null, source: "geolocator", schemaVersion: 1,
  });

const evaluate = (nowMs, riderUid = R) => ops.evaluateRiderLocationStale({ db, FieldValue, Timestamp, riderUid, now: at(nowMs) });
const sweep = (nowMs) => ops.evaluateStaleLocationsRun({ db, FieldValue, Timestamp, now: at(nowMs) });
const onFix = (nowMs) => ops.resolveStaleOnFix({ db, FieldValue, Timestamp, riderUid: R, now: at(nowMs) });
const alertDoc = async (tripId = "trip1") => {
  const s = await db.collection("alerts").doc(S.alertId(R, tripId)).get();
  return s.exists ? s.data() : null;
};
const watch = async () => (await db.collection(ops.WATCHES).doc(R).get()).data();
const allAlerts = async () => (await db.collection("alerts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

// ------------------------------------------------------------------ stale location

test("no fix since dispatch: one alert at 10 minutes, replays and concurrent runs change nothing", async () => {
  await wipe();
  await departed();
  assert.equal((await evaluate(T0 + 9 * MIN)).raised, false);
  assert.equal(await alertDoc(), null);
  const r = await evaluate(T0 + 10 * MIN);
  assert.equal(r.raised, true);
  const a = await alertDoc();
  assert.deepEqual(
    [a.type, a.status, a.severity, a.riderId, a.riderName, a.tripId, a.episodeCount, a.orderCount, a.lastFixAt, a.anchorSource, a.path],
    ["rider_location_stale", "active", "warning", R, "Ana Cruz", "trip1", 1, 2, null, "departure", "/dispatcher/live-tracking?rider=rider1"],
  );
  assert.equal(a.message, "Ana Cruz's location hasn't updated for 10 minutes during a delivery trip. Check that the rider app is open and has signal.");
  assert.equal((await watch()).status, "stale");

  // Replayed, and raced: still exactly one alert, one episode.
  const before = (await db.collection("alerts").doc(S.alertId(R, "trip1")).get()).updateTime;
  await evaluate(T0 + 10 * MIN);
  await Promise.all([evaluate(T0 + 11 * MIN), evaluate(T0 + 11 * MIN), sweep(T0 + 11 * MIN), sweep(T0 + 12 * MIN)]);
  assert.equal((await allAlerts()).length, 1);
  assert.equal((await alertDoc()).episodeCount, 1);
  assert.ok((await db.collection("alerts").doc(S.alertId(R, "trip1")).get()).updateTime.isEqual(before), "nothing rewritten");
});

test("a stale fix: measured from the last current fix; a fresh reconnect resolves at once; silence again reopens the SAME alert", async () => {
  await wipe();
  await departed();
  await writeFix(T0 + 3 * MIN);
  assert.equal((await evaluate(T0 + 12 * MIN)).raised, false, "9 minutes since the fix");
  assert.equal((await evaluate(T0 + 13 * MIN)).raised, true);
  assert.equal((await alertDoc()).lastFixAt.toMillis(), T0 + 3 * MIN);

  // The phone comes back: the location trigger resolves it without waiting for the sweep.
  await writeFix(T0 + 14 * MIN);
  const r = await onFix(T0 + 14 * MIN);
  assert.equal(r.resolved, true);
  let a = await alertDoc();
  assert.deepEqual([a.status, a.resolutionReason, a.resolvedBy, a.message], ["resolved", "location_updating", "server", "Ana Cruz's location is updating again."]);
  assert.equal((await watch()).status, "watching");
  assert.deepEqual(await onFix(T0 + 15 * MIN), { skipped: "not_stale" }, "one read for a Rider with nothing open");

  // Silent again on the same trip: the same document reopens.
  assert.equal((await evaluate(T0 + 24 * MIN)).reopened, true);
  a = await alertDoc();
  assert.deepEqual([a.status, a.episodeCount, a.resolvedAt, a.resolutionReason], ["active", 2, null, null]);
  assert.equal((await allAlerts()).length, 1);
});

test("several orders on one trip raise ONE alert for the Rider", async () => {
  await wipe();
  await departed({ orderIds: ["o1", "o2", "o3", "o4"] });
  await sweep(T0 + 15 * MIN);
  const alerts = await allAlerts();
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].id, alerts[0].orderCount], [S.alertId(R, "trip1"), 4]);
});

test("forming and returning Riders never alert; a trip that ends or is replaced resolves its incident", async () => {
  await wipe();
  await db.collection("riderTrips").doc("tf").set({ riderUid: R, status: "forming", orderIds: ["o1"] });
  await db.collection("riderDispatchStates").doc(R).set({ riderUid: R, state: "trip_forming", tripId: "tf", orderIds: ["o1"], departedAt: null });
  await sweep(T0 + 60 * MIN);
  assert.equal((await allAlerts()).length, 0, "forming: not watched");

  await departed();
  await sweep(T0 + 15 * MIN);
  assert.equal((await alertDoc()).status, "active");
  // Every order finished: the Rider is returning to the hub.
  await db.collection("riderDispatchStates").doc(R).update({ state: "returning_to_hub" });
  const counts = await sweep(T0 + 20 * MIN);
  assert.equal(counts.resolved, 1);
  const a = await alertDoc();
  assert.deepEqual([a.status, a.resolutionReason, a.message], ["resolved", "trip_ended", "Ana Cruz's trip has ended, so location monitoring stopped."]);
  assert.deepEqual([(await watch()).status, (await watch()).active], ["closed", false]);
  await sweep(T0 + 90 * MIN);
  assert.equal((await alertDoc()).status, "resolved", "returning: never raised again");

  // A new trip departs while an old incident is still open: the old one is superseded.
  await departed({ tripId: "trip2", departedMs: T0 + 100 * MIN });
  await db.collection("alerts").doc(S.alertId(R, "trip1")).update({ status: "active" });
  await db.collection(ops.WATCHES).doc(R).set({ riderUid: R, tripId: "trip1", status: "stale", active: true, anchorAt: tsAt(T0), anchorSource: "departure" });
  await sweep(T0 + 105 * MIN);
  assert.deepEqual([(await alertDoc("trip1")).status, (await alertDoc("trip1")).resolutionReason], ["resolved", "trip_superseded"]);
  assert.equal(await alertDoc("trip2"), null, "the new trip is 5 minutes old");
  assert.equal((await watch()).tripId, "trip2");
});

test("legacy trips: no departure time → anchored at the sweep's first observation; an unproven trip never alerts", async () => {
  await wipe();
  await departed({ departedMs: null });
  await sweep(T0);
  assert.equal((await allAlerts()).length, 0, "never on first sight");
  const w = await watch();
  assert.deepEqual([w.anchorSource, w.anchorAt.toMillis(), w.status], ["first_observed", T0, "watching"]);
  await sweep(T0 + 9 * MIN);
  assert.equal((await allAlerts()).length, 0);
  await sweep(T0 + 10 * MIN);
  assert.equal((await alertDoc()).anchorSource, "first_observed");

  // A trip document that is missing, or belongs to someone else, proves nothing.
  await wipe();
  await departed();
  await db.collection("riderTrips").doc("trip1").set({ riderUid: "someoneElse", status: "departed" });
  await sweep(T0 + 60 * MIN);
  assert.equal((await allAlerts()).length, 0);
});

test("delayed and reordered events cannot resolve wrongly: the CURRENT location decides", async () => {
  await wipe();
  await departed();
  await sweep(T0 + 15 * MIN);
  // A fix captured 13 minutes ago, replayed now from the phone's offline queue.
  await writeFix(T0 + 2 * MIN, T0 + 15 * MIN);
  assert.equal((await onFix(T0 + 15 * MIN)).resolved, false);
  assert.equal((await alertDoc()).status, "active", "a replayed old position is not a current fix");
  // A late trigger for a fresh fix that has since been REPLACED by an ended tracking state.
  await db.collection("riderLocations").doc(R).set({
    riderUid: R, latitude: null, longitude: null, accuracyMeters: null, headingDegrees: null, speedMps: null,
    capturedAt: tsAt(T0 + 16 * MIN), updatedAt: tsAt(T0 + 16 * MIN), trackingState: "ended",
    activeOrderId: null, navigationSessionId: null, source: "geolocator", schemaVersion: 1,
  });
  assert.equal((await onFix(T0 + 16 * MIN)).resolved, false);
  assert.equal((await alertDoc()).status, "active");
});

test("an Admin's manual resolve holds while the Rider stays silent", async () => {
  await wipe();
  await departed();
  await sweep(T0 + 15 * MIN);
  await db.collection("alerts").doc(S.alertId(R, "trip1")).update({ status: "resolved" });
  await sweep(T0 + 20 * MIN);
  await sweep(T0 + 25 * MIN);
  assert.equal((await alertDoc()).status, "resolved");
});

// ------------------------------------------------------------------ late delivery

async function lateOrder(orderId, epoch) {
  // An in-transit order whose dispatch-frozen ETA + grace has passed.
  await db.collection("orders").doc(orderId).set({
    orderNumber: `VT-ORD-1-${orderId.toUpperCase()}`, status: "in_transit", assignedRiderId: R, assignedRiderName: "Ana Cruz",
    clinicName: "Clinic", destinationType: "clinic", failureCount: epoch, dispatchedAt: tsAt(T0),
    timingContractVersion: 1, timingEpoch: epoch, timingActive: true, timingStatus: "at_risk",
    expectedArrivalAt: tsAt(T0 + 30 * MIN), automaticDelayedAt: tsAt(T0 + 40 * MIN), timingNextCheckAt: tsAt(T0 + 40 * MIN),
  });
  const r = await timingOps.advanceDeliveryTiming({ db, FieldValue, Timestamp, orderId, now: at(T0 + 41 * MIN) });
  assert.equal(r.firstDelay, true);
  return db.collection("alerts").doc(D.timingAlertId(orderId, epoch));
}
async function endWith(orderId, eventId, before, after) {
  await db.collection("orders").doc(orderId).set(after);
  return recordStatusEvent({ db, orderId, eventId, event: deriveStatusEvent({ before, after }), at: tsAt(T0 + 50 * MIN), after, FieldValue, Timestamp });
}

test("a late-delivery alert resolves when its attempt is delivered, failed or cancelled — once", async () => {
  await wipe();
  for (const [to, extra] of [["delivered", {}], ["delivery_failed", { deliveryFailureReason: "Closed", failureCount: 1 }], ["cancelled", { cancelReason: "Clinic closed" }]]) {
    const id = `late_${to}`;
    const ref = await lateOrder(id, 0);
    assert.equal((await ref.get()).get("status"), "active");
    const before = (await db.collection("orders").doc(id).get()).data();
    const r = await endWith(id, `evt-${to}`, before, { ...before, status: to, ...extra });
    assert.equal(r.lateAlertResolved, to);
    const a = (await ref.get()).data();
    assert.deepEqual([a.status, a.resolutionReason, a.resolvedBy], ["resolved", to, "server"]);
    // Redelivered trigger: nothing again.
    const again = await recordStatusEvent({ db, orderId: id, eventId: `evt-${to}`, event: deriveStatusEvent({ before, after: { ...before, status: to } }), at: tsAt(T0 + 50 * MIN), after: { ...before, status: to }, FieldValue, Timestamp });
    assert.equal(again.recorded, false);
  }
  // The rider's manual hold keeps the clock running — and the alert open.
  const ref = await lateOrder("late_hold", 0);
  const before = (await db.collection("orders").doc("late_hold").get()).data();
  const r = await endWith("late_hold", "evt-hold", before, { ...before, status: "delayed", delayReason: "Flat tyre" });
  assert.equal(r.lateAlertResolved, null);
  assert.equal((await ref.get()).get("status"), "active");
});

test("a late trigger of an earlier attempt never resolves the newer attempt's alert", async () => {
  await wipe();
  // Attempt 1 is out and running late; its alert is open.
  const newer = await lateOrder("late_retry", 1);
  // The failure event of attempt 0 arrives only now (its write's snapshot still says timingEpoch 0).
  const attempt0 = { status: "delivery_failed", timingContractVersion: 1, timingEpoch: 0, failureCount: 1, deliveryFailureReason: "Closed" };
  const r = await recordStatusEvent({
    db, orderId: "late_retry", eventId: "evt-old-failure",
    event: deriveStatusEvent({ before: { status: "in_transit" }, after: attempt0 }),
    at: tsAt(T0 - 60 * MIN), after: attempt0, FieldValue, Timestamp,
  });
  assert.equal(r.lateAlertResolved, null);
  assert.equal((await newer.get()).get("status"), "active", "attempt 1's alert untouched");
});

test("an Admin-resolved late alert is left as the Admin left it", async () => {
  await wipe();
  const ref = await lateOrder("late_admin", 0);
  await ref.update({ status: "resolved" });
  const before = (await db.collection("orders").doc("late_admin").get()).data();
  const r = await endWith("late_admin", "evt-admin", before, { ...before, status: "delivered" });
  assert.equal(r.lateAlertResolved, null);
  const a = (await ref.get()).data();
  assert.deepEqual([a.status, a.resolutionReason], ["resolved", undefined]);
});

// ------------------------------------------------------------------ safety properties

/** The real database, except that every transaction fails (an outage mid-trigger). */
const failingTransactions = new Proxy(db, {
  get(target, prop) {
    if (prop === "runTransaction") return () => Promise.reject(Object.assign(new Error("UNAVAILABLE"), { code: 14 }));
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

test("SAFETY 1: a failed fast resolve writes nothing and the next 5-minute sweep resolves the alert", async () => {
  await wipe();
  await departed();
  await sweep(T0 + 15 * MIN);
  assert.equal((await alertDoc()).status, "active");
  await writeFix(T0 + 16 * MIN);
  // The location trigger's fast resolve fails (index.js catches and logs it).
  await assert.rejects(
    ops.resolveStaleOnFix({ db: failingTransactions, FieldValue, Timestamp, riderUid: R, now: at(T0 + 16 * MIN) }),
    /UNAVAILABLE/
  );
  assert.equal((await alertDoc()).status, "active", "nothing half-written");
  assert.deepEqual([(await watch()).status, (await watch()).active], ["stale", true], "the open watch keeps the Rider in the sweep");
  // The sweep reaches the Rider through the open watch and resolves it.
  const counts = await sweep(T0 + 20 * MIN);
  assert.deepEqual([counts.resolved, counts.failed], [1, 0]);
  const a = await alertDoc();
  assert.deepEqual([a.status, a.resolutionReason], ["resolved", "location_updating"]);
  assert.equal((await watch()).status, "watching");
});

test("SAFETY 2: the sweep pages through on-trip Riders AND open watches; one failing Rider blocks neither the rest nor the next run", async () => {
  await wipe();
  for (const [uid, trip] of [["rA", "tA"], ["rB", "tB"], ["rC", "tC"]]) {
    await db.collection("users").doc(uid).set({ role: "rider", status: "approved", fullName: uid });
    await departed({ riderUid: uid, tripId: trip });
  }
  // rW is no longer on a trip, but its watch is still open with an active alert:
  // only the watch query can reach it.
  await db.collection("riderTrips").doc("tW").set({ riderUid: "rW", status: "settled", orderIds: [] });
  await db.collection("riderDispatchStates").doc("rW").set({ riderUid: "rW", state: "returning_to_hub", tripId: "tW", orderIds: [] });
  await db.collection(ops.WATCHES).doc("rW").set({ riderUid: "rW", tripId: "tW", status: "stale", active: true, anchorAt: tsAt(T0), anchorSource: "departure" });
  await db.collection("alerts").doc("rider_location_stale_rW_tW").set({ type: "rider_location_stale", status: "active", riderId: "rW", tripId: "tW", episodeCount: 1 });

  const failFirst = (args) => (args.riderUid === "rA" ? Promise.reject(new Error("bad rider")) : ops.evaluateRiderLocationStale(args));
  // pageSize 2 forces several pages in both queries.
  const counts = await ops.evaluateStaleLocationsRun({ db, FieldValue, Timestamp, now: at(T0 + 15 * MIN), pageSize: 2, evaluate: failFirst });
  assert.deepEqual(counts, { riders: 4, raised: 2, reopened: 0, resolved: 1, failed: 1 });
  const alertOf = async (uid, trip) => (await db.collection("alerts").doc(`rider_location_stale_${uid}_${trip}`).get()).data();
  assert.equal(await alertOf("rA", "tA"), undefined, "the failing Rider (sorted FIRST) is skipped…");
  assert.equal((await alertOf("rB", "tB")).status, "active", "…and does not block those after it");
  assert.equal((await alertOf("rC", "tC")).status, "active");
  assert.deepEqual([(await alertOf("rW", "tW")).status, (await alertOf("rW", "tW")).resolutionReason], ["resolved", "trip_ended"]);

  // The next run reaches the Rider that failed.
  const next = await ops.evaluateStaleLocationsRun({ db, FieldValue, Timestamp, now: at(T0 + 20 * MIN), pageSize: 2 });
  assert.deepEqual([next.raised, next.failed], [1, 0]);
  assert.equal((await alertOf("rA", "tA")).status, "active");
});

test("SAFETY 3: with BOTH attempts' late alerts open, a replayed end of the older attempt resolves only its own", async () => {
  await wipe();
  const older = await lateOrder("late_two", 0);
  const newer = await lateOrder("late_two", 1);
  assert.deepEqual([(await older.get()).get("status"), (await newer.get()).get("status")], ["active", "active"]);
  // The failure of attempt 0, delivered late and twice (two different event ids).
  const attempt0 = { status: "delivery_failed", timingContractVersion: 1, timingEpoch: 0, failureCount: 1, deliveryFailureReason: "Closed" };
  const replay = (eventId) => recordStatusEvent({
    db, orderId: "late_two", eventId, event: deriveStatusEvent({ before: { status: "in_transit" }, after: attempt0 }),
    at: tsAt(T0 - 60 * MIN), after: attempt0, FieldValue, Timestamp,
  });
  assert.equal((await replay("evt-a0-first")).lateAlertResolved, "delivery_failed");
  assert.equal((await older.get()).get("status"), "resolved");
  assert.equal((await newer.get()).get("status"), "active", "attempt 1 untouched");
  assert.equal((await replay("evt-a0-second")).lateAlertResolved, null, "already resolved: nothing again");
  assert.equal((await newer.get()).get("status"), "active");

  // Attempt 1 ends: only its own alert resolves, with its own reason.
  const before = (await db.collection("orders").doc("late_two").get()).data();
  const r = await endWith("late_two", "evt-a1-delivered", before, { ...before, status: "delivered" });
  assert.equal(r.lateAlertResolved, "delivered");
  assert.deepEqual([(await newer.get()).get("status"), (await newer.get()).get("resolutionReason")], ["resolved", "delivered"]);
  assert.equal((await older.get()).get("resolutionReason"), "delivery_failed", "the older resolution is not rewritten");
});
