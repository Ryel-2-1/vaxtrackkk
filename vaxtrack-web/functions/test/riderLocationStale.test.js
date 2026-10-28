"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const S = require("../src/riderLocationStale");
const D = require("../src/deliveryTiming");

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-27T02:00:00Z");
const ts = (ms) => ({ toMillis: () => ms });
const fix = (capturedMs, writtenMs = capturedMs, over = {}) => ({
  latitude: 14.6, longitude: 120.98, trackingState: "active", capturedAt: ts(capturedMs), updatedAt: ts(writtenMs), ...over,
});
const onTrip = (over = {}) => ({ state: "on_trip", tripId: "trip1", orderIds: ["o1", "o2"], departedAt: ts(T0), ...over });
const TRIP = { riderUid: "r1", status: "departed" };
const decide = (over) => S.staleDecision({ riderUid: "r1", state: onTrip(), trip: TRIP, location: null, watch: null, alert: null, nowMs: T0, ...over });

test("a current fix: coordinates, not ended, written within 2 minutes of capture", () => {
  assert.equal(S.trustworthyFixMs(fix(T0)), T0);
  assert.equal(S.trustworthyFixMs(fix(T0, T0 + 2 * MIN)), T0, "on the limit");
  assert.equal(S.trustworthyFixMs(fix(T0, T0 + 3 * MIN)), null, "replayed from an offline queue");
  assert.equal(S.trustworthyFixMs(fix(T0 + 30000, T0)), T0, "a device clock ahead is clamped to the server write");
  assert.equal(S.trustworthyFixMs(fix(T0, T0, { trackingState: "ended", latitude: null, longitude: null })), null);
  assert.equal(S.trustworthyFixMs(fix(T0, T0, { latitude: 200 })), null);
  assert.equal(S.trustworthyFixMs({ latitude: 1, longitude: 1, trackingState: "active" }), null, "no times: not trusted");
  assert.equal(S.trustworthyFixMs(null), null);
});

test("only a departed, server-owned trip of THIS rider is watched", () => {
  assert.equal(S.watchedTrip({ riderUid: "r1", state: onTrip(), trip: TRIP }).watched, true);
  assert.deepEqual(S.watchedTrip({ riderUid: "r1", state: onTrip({ state: "trip_forming" }), trip: TRIP }), { watched: false, reason: "not_departed" });
  assert.deepEqual(S.watchedTrip({ riderUid: "r1", state: onTrip({ state: "returning_to_hub" }), trip: TRIP }), { watched: false, reason: "returning" });
  assert.equal(S.watchedTrip({ riderUid: "r1", state: onTrip(), trip: { riderUid: "r2" } }).reason, "trip_unproven");
  assert.equal(S.watchedTrip({ riderUid: "r1", state: onTrip(), trip: null }).reason, "trip_unproven");
  assert.equal(S.watchedTrip({ riderUid: "r1", state: onTrip({ tripId: "bad/id" }), trip: TRIP }).reason, "no_server_trip");
});

test("no fix since departure: stale at exactly 10 minutes, not before", () => {
  assert.equal(decide({ nowMs: T0 + 9 * MIN + 59999 }).alert, null);
  const d = decide({ nowMs: T0 + 10 * MIN });
  assert.deepEqual(d.alert, { create: { staleSinceMs: T0, lastFixMs: null, anchorSource: "departure" } });
  assert.deepEqual(d.watch.set, { tripId: "trip1", anchorMs: T0, anchorSource: "departure", status: "stale" });
  // A fix from before the departure never counts.
  assert.ok(decide({ nowMs: T0 + 10 * MIN, location: fix(T0 - MIN) }).alert.create);
});

test("a stale fix: measured from the last current fix", () => {
  const location = fix(T0 + 3 * MIN);
  assert.equal(decide({ nowMs: T0 + 12 * MIN, location }).alert, null);
  assert.deepEqual(decide({ nowMs: T0 + 13 * MIN, location }).alert.create, { staleSinceMs: T0 + 3 * MIN, lastFixMs: T0 + 3 * MIN, anchorSource: "departure" });
  // A replayed old fix (written 20 minutes after capture) is not current.
  assert.ok(decide({ nowMs: T0 + 25 * MIN, location: fix(T0 + 2 * MIN, T0 + 22 * MIN) }).alert.create);
});

test("reconnect resolves; going silent again reopens the same incident; an Admin-resolved episode is not re-raised", () => {
  const watch = { tripId: "trip1", status: "stale", anchorAt: ts(T0), anchorSource: "departure" };
  const active = { status: "active" };
  const fresh = decide({ nowMs: T0 + 30 * MIN, location: fix(T0 + 29 * MIN), watch, alert: active });
  assert.deepEqual(fresh.alert, { resolve: "location_updating" });
  assert.equal(fresh.watch.set.status, "watching");
  // Same episode, resolved by an Admin while still silent: left resolved.
  assert.equal(decide({ nowMs: T0 + 40 * MIN, watch, alert: { status: "resolved" } }).alert, null);
  // A NEW episode (fresh in between, so the watch says watching): reopened.
  const reopened = decide({ nowMs: T0 + 50 * MIN, location: fix(T0 + 30 * MIN), watch: { ...watch, status: "watching" }, alert: { status: "resolved" } });
  assert.ok(reopened.alert.reopen);
  // Already raised and still stale: nothing to write.
  const still = decide({ nowMs: T0 + 45 * MIN, watch, alert: active });
  assert.deepEqual([still.alert, still.watch], [null, null]);
});

test("forming and returning trips never alert; a trip ending or being replaced resolves its open incident", () => {
  assert.equal(decide({ state: onTrip({ state: "trip_forming" }), nowMs: T0 + 60 * MIN }).alert, null);
  const watch = { tripId: "trip1", status: "stale", anchorAt: ts(T0) };
  const returning = decide({ state: onTrip({ state: "returning_to_hub" }), watch, previousAlert: { status: "active" }, nowMs: T0 + 60 * MIN });
  assert.deepEqual([returning.previousAlert, returning.watch, returning.alert], [{ resolve: "trip_ended" }, { close: true, reason: "returning" }, null]);
  const next = decide({ state: onTrip({ tripId: "trip2", departedAt: ts(T0 + 50 * MIN) }), watch, previousAlert: { status: "active" }, nowMs: T0 + 55 * MIN });
  assert.deepEqual(next.previousAlert, { resolve: "trip_superseded" });
  assert.equal(next.watch.set.tripId, "trip2");
  assert.equal(next.alert, null, "the new trip is 5 minutes old");
});

test("a legacy trip with no departure time is anchored at the first observation — never earlier", () => {
  const legacy = onTrip({ departedAt: null });
  const first = decide({ state: legacy, nowMs: T0 + 60 * MIN, trip: TRIP });
  assert.equal(first.alert, null, "never alerted on first sight");
  assert.deepEqual(first.watch.set, { tripId: "trip1", anchorMs: T0 + 60 * MIN, anchorSource: "first_observed", status: "watching" });
  const watch = { tripId: "trip1", status: "watching", anchorAt: ts(T0 + 60 * MIN), anchorSource: "first_observed" };
  assert.equal(decide({ state: legacy, watch, nowMs: T0 + 69 * MIN }).alert, null);
  assert.equal(decide({ state: legacy, watch, nowMs: T0 + 70 * MIN }).alert.create.anchorSource, "first_observed");
  // The trip document's departure is used when the state lacks one.
  assert.equal(decide({ state: legacy, trip: { ...TRIP, departedAt: ts(T0) }, nowMs: T0 + 10 * MIN }).alert.create.anchorSource, "departure");
});

test("the alert id is per Rider and server trip; its text carries no place, coordinate or id", () => {
  assert.equal(S.alertId("r1", "trip1"), "rider_location_stale_r1_trip1");
  assert.throws(() => S.alertId("r1", "a/b"));
  const text = S.staleAlertText({ status: "active", riderName: "Ana Cruz", minutes: 14.7 });
  assert.equal(text, "Ana Cruz's location hasn't updated for 14 minutes during a delivery trip. Check that the rider app is open and has signal.");
  assert.doesNotMatch(text, /\d+\.\d+|trip1|r1/);
  assert.equal(S.staleAlertText({ status: "resolved", riderName: "Ana", resolutionReason: "location_updating" }), "Ana's location is updating again.");
  assert.equal(S.staleAlertText({ status: "resolved", resolutionReason: "trip_ended" }), "The rider's trip has ended, so location monitoring stopped.");
});

test("a late alert resolves for the attempt its ending write closed — never a newer one", () => {
  const after = { status: "delivered", timingContractVersion: 1, timingEpoch: 2 };
  assert.deepEqual(D.endedTimingAttempt({ from: "in_transit", to: "delivered" }, after), { epoch: 2, reason: "delivered" });
  assert.deepEqual(D.endedTimingAttempt({ from: "delayed", to: "cancelled" }, after), { epoch: 2, reason: "cancelled" });
  // A failure write still carries the attempt it ended (timingEpoch), not the advanced failure count.
  assert.deepEqual(D.endedTimingAttempt({ from: "in_transit", to: "delivery_failed" }, { ...after, failureCount: 3 }), { epoch: 2, reason: "delivery_failed" });
  assert.equal(D.endedTimingAttempt({ from: "in_transit", to: "delayed" }, after), null, "the manual hold keeps the clock");
  assert.equal(D.endedTimingAttempt({ from: "loading", to: "in_transit" }, after), null);
  assert.equal(D.endedTimingAttempt({ from: "in_transit", to: "delivered" }, { status: "delivered" }), null, "no baseline, no alert");
});

test("the scheduler runs both passes, each isolated from the other's failure", () => {
  const index = readFileSync(path.join(__dirname, "../index.js"), "utf8").replace(/\r\n/g, "\n");
  const job = index.slice(index.indexOf("exports.evaluateDeliveryTiming = onSchedule("), index.indexOf("exports.purgeRiderTrackingData"));
  assert.match(job, /schedule: "every 5 minutes"/);
  assert.match(job, /try \{\s*const counts = await deliveryTimingOps\.evaluateDeliveryTimingRun/);
  assert.match(job, /try \{\s*const counts = await riderLocationStaleOps\.evaluateStaleLocationsRun/);
  assert.deepEqual([...index.matchAll(/exports\.(\w+) = onSchedule\(/g)].map((m) => m[1]).sort(),
    ["evaluateDeliveryTiming", "purgeRiderTrackingData", "reviewInventoryVisibility"],
    "inventory housekeeping has its own approval-gated job; operational alerts still share one job");
  // Each pass's failure is logged; the job rethrows only after BOTH have run.
  assert.match(job, /catch \(error\) \{\s*failed = error;\s*logger\.error\("delivery-timing pass failed"/);
  assert.match(job, /catch \(error\) \{\s*failed = failed \?\? error;\s*logger\.error\("stale-locations pass failed"/);
  assert.ok(job.indexOf("if (failed) throw failed;") > job.indexOf("evaluateStaleLocationsRun"));

  // The location trigger's fast resolve: a failure is LOGGED and swallowed —
  // never retried in a loop, never allowed to fail the route-deviation work —
  // and the open watch leaves the Rider in the 5-minute sweep (proven against
  // Firestore in operationalAlerts.test.js "SAFETY 1").
  const trigger = index.slice(index.indexOf("exports.trackRiderLocation"), index.indexOf("exports.trackNavigationSession"));
  assert.ok(trigger.indexOf("processLocationWrite") < trigger.indexOf("resolveStaleOnFix"), "after the deviation work");
  const guarded = /try \{\s*await riderLocationStaleOps\.resolveStaleOnFix\([\s\S]*?\}\);\s*\} catch \(error\) \{([\s\S]*?)\}\s*\}\s*\);/.exec(trigger);
  assert.ok(guarded, "the fast resolve is wrapped");
  assert.match(guarded[1], /logger\.warn\("stale-location resolve deferred"/);
  assert.doesNotMatch(guarded[1], /throw/);
});
