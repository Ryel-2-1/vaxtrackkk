"use strict";

/**
 * Automatic delivery timing — the pure contract (src/deliveryTiming.js).
 * The Firestore behaviour (freeze at dispatch, scheduler, alert, history,
 * recovery, requeue, completion) is proven against the emulator in
 * test/integration/deliveryTiming.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/deliveryTiming");
const { routeForOrder } = require("../src/riderTracking");
const { encode } = require("./helpers/polyline");

const T0 = Date.parse("2026-10-17T02:00:00Z");
const ts = (ms) => ({ toMillis: () => ms });
const ROUTE = encode([{ lat: 14.6, lng: 121.0 }, { lat: 14.61, lng: 121.01 }]);
const MIN = 60000;
const routed = (over = {}) => ({
  status: "loading",
  assignedAt: ts(T0 - 3600000),
  routePolyline: ROUTE,
  routeGeneratedAt: ts(T0 - 600000),
  routeDurationSeconds: 1800,
  ...over,
});

test("grace: round(ETA minutes × 20 %), never under 10 or over 20 minutes", () => {
  for (const [etaMinutes, grace] of [
    [15, 10], [30, 10], [60, 12], [90, 18], [150, 20], // the specified examples
    [1, 10], [52, 10], [53, 11], // minimum: 52 × 0.2 = 10.4 → 10; 53 → 10.6 → 11
    [97, 19], [98, 20], [100, 20], [600, 20], // maximum boundary
    [62.4, 12], [62.6, 13], // rounding of fractional ETA minutes
  ]) {
    assert.equal(D.graceMinutesFor(etaMinutes * 60), grace, `${etaMinutes} min`);
  }
});

test("the baseline is dispatch SERVER time + route ETA, then + grace — nothing else", () => {
  const b = D.timingBaseline({ order: routed(), dispatchedAtMs: T0, routeForOrder });
  assert.deepEqual(
    [b.known, b.etaSeconds, b.graceSeconds, b.source, b.expectedArrivalMs, b.automaticDelayedMs],
    [true, 1800, 600, "order", T0 + 30 * MIN, T0 + 40 * MIN]
  );
  // Phone/browser times on the order are never read.
  const noisy = routed({ capturedAt: ts(T0 + 99 * MIN), updatedAt: ts(T0 - 99 * MIN), dispatchedAt: ts(T0 + 77 * MIN), clientNow: T0 + 5 });
  assert.equal(D.timingBaseline({ order: noisy, dispatchedAtMs: T0, routeForOrder }).expectedArrivalMs, T0 + 30 * MIN);
  assert.equal(D.timingBaseline({ order: routed({ routeDurationSeconds: 3600 }), dispatchedAtMs: T0, routeForOrder }).automaticDelayedMs, T0 + 72 * MIN);
  assert.equal(D.timingBaseline({ order: routed({ routeDurationSeconds: 9000 }), dispatchedAtMs: T0, routeForOrder }).automaticDelayedMs, T0 + 170 * MIN);
  assert.equal(D.timingBaseline({ order: routed(), dispatchedAtMs: null, routeForOrder }).known, false);
});

test("an optimized-trip stop uses its own cumulative stop ETA", () => {
  const trip = routed({
    tripId: "trip1", stopSequence: 2, tripPolyline: ROUTE, tripGeneratedAt: ts(T0 - 300000),
    stopEtaSeconds: 2700, routeDurationSeconds: 600,
  });
  const b = D.timingBaseline({ order: trip, dispatchedAtMs: T0, routeForOrder });
  assert.deepEqual([b.source, b.etaSeconds, b.expectedArrivalMs], ["trip", 2700, T0 + 45 * MIN]);
});

test("missing, malformed or untrustworthy ETA → unknown, never a guessed deadline", () => {
  const unknown = (over) => D.timingBaseline({ order: routed(over), dispatchedAtMs: T0, routeForOrder });
  for (const [over, reason] of [
    [{ routeDurationSeconds: 0 }, "invalid_eta"],
    [{ routeDurationSeconds: -60 }, "invalid_eta"],
    [{ routeDurationSeconds: "1800" }, "invalid_eta"],
    [{ routeDurationSeconds: NaN }, "invalid_eta"],
    [{ routeDurationSeconds: null }, "invalid_eta"],
    [{ routeDurationSeconds: 25 * 3600 }, "invalid_eta"],
    [{ routePolyline: null }, "missing"],
    [{ routePolyline: "%%%" }, "malformed"],
    [{ routeGeneratedAt: ts(T0 - 7200000) }, "generated_before_assignment"],
    [{ destinationRevision: 2, routeDestinationRevision: 1 }, "destination_changed"],
    [{ tripId: "t", stopSequence: 1, tripPolyline: ROUTE, tripGeneratedAt: ts(T0), stopEtaSeconds: 0 }, "invalid_eta"],
  ]) {
    const b = unknown(over);
    assert.deepEqual([b.known, b.reason], [false, reason], JSON.stringify(over));
  }
});

test("status at server time: on_time before arrival, at_risk until the deadline, delayed from it", () => {
  const b = { expectedArrivalMs: T0 + 30 * MIN, automaticDelayedMs: T0 + 40 * MIN };
  assert.deepEqual(
    [T0, T0 + 30 * MIN - 1, T0 + 30 * MIN, T0 + 40 * MIN - 1, T0 + 40 * MIN, T0 + 999 * MIN].map((n) => D.timingStatusAt(b, n)),
    ["on_time", "on_time", "at_risk", "at_risk", "delayed", "delayed"]
  );
  assert.equal(D.timingStatusAt({}, T0), "unknown");
});

const timed = (over = {}) => ({
  status: "in_transit", timingActive: true, expectedArrivalAt: ts(T0 + 30 * MIN), automaticDelayedAt: ts(T0 + 40 * MIN),
  timingNextCheckAt: ts(T0 + 30 * MIN), timingStatus: "on_time", ...over,
});

test("due-time evaluation: on_time → at_risk (next check = deadline) → delayed (no next check); the clock runs during the hold", () => {
  for (const status of ["in_transit", "delayed"]) {
    const d = (over, now) => D.timingDecision(timed({ status, ...over }), now);
    assert.deepEqual(d({}, T0 + 10 * MIN), { action: "skip", reason: "not_due" }, status);
    assert.deepEqual(d({}, T0 + 30 * MIN), { action: "advance", to: "at_risk", nextCheckMs: T0 + 40 * MIN, firstDelay: false }, status);
    assert.deepEqual(d({ timingStatus: "at_risk", timingNextCheckAt: ts(T0 + 40 * MIN) }, T0 + 39 * MIN), { action: "skip", reason: "not_due" });
    assert.deepEqual(d({ timingStatus: "at_risk", timingNextCheckAt: ts(T0 + 40 * MIN) }, T0 + 40 * MIN), { action: "advance", to: "delayed", nextCheckMs: null, firstDelay: true });
    // A missed at-risk run: straight to delayed in one step.
    assert.deepEqual(d({}, T0 + 41 * MIN), { action: "advance", to: "delayed", nextCheckMs: null, firstDelay: true }, `${status}: missed run`);
  }
});

test("due-time evaluation never moves backwards and re-arms a check that came due too early", () => {
  // Due (next check in the past) but the condition has not changed: re-arm only.
  assert.deepEqual(D.timingDecision(timed({ timingNextCheckAt: ts(T0) }), T0 + 5 * MIN), { action: "reschedule", nextCheckMs: T0 + 30 * MIN });
  assert.deepEqual(D.timingDecision(timed({ timingStatus: "at_risk", timingNextCheckAt: ts(T0 + 31 * MIN) }), T0 + 35 * MIN), { action: "reschedule", nextCheckMs: T0 + 40 * MIN });
  // A clock that went back never downgrades.
  const back = D.timingDecision(timed({ timingStatus: "at_risk", timingNextCheckAt: ts(T0) }), T0 + MIN);
  assert.deepEqual(back, { action: "reschedule", nextCheckMs: T0 + 30 * MIN });
  // An already-late, inactive attempt is skipped (it is not in the due set either).
  assert.deepEqual(
    D.timingDecision(timed({ timingStatus: "delayed", timingActive: false, timingNextCheckAt: null, timingDelayedAt: ts(1) }), T0 + 99 * MIN),
    { action: "skip", reason: "inactive" }
  );
});

test("closed or requeued lifecycles leave the evaluator set; unknown timing is never evaluated", () => {
  for (const status of ["delivered", "delivery_failed", "cancelled", "pending_dispatch", "assigned", "loading"]) {
    assert.deepEqual(D.timingDecision(timed({ status }), T0 + 99 * MIN), { action: "deactivate", reason: "not_active_lifecycle" }, status);
    assert.deepEqual(D.timingDecision(timed({ status, timingActive: false, timingNextCheckAt: null }), T0 + 99 * MIN), { action: "skip", reason: "not_active_lifecycle" }, status);
  }
  // Unknown baseline: inactive, no next check — never evaluated or invented.
  const unknown = { status: "in_transit", timingContractVersion: 1, timingStatus: "unknown", timingActive: false };
  assert.deepEqual(D.timingDecision(unknown, T0 + 99 * MIN), { action: "skip", reason: "no_baseline" });
  // A route saved after dispatch changes nothing: the decision reads only the frozen fields.
  assert.deepEqual(
    D.timingDecision({ ...unknown, routePolyline: ROUTE, routeDurationSeconds: 900, routeGeneratedAt: ts(T0) }, T0 + 99 * MIN),
    { action: "skip", reason: "no_baseline" }
  );
  assert.deepEqual(D.timingDecision({ status: "in_transit" }, T0 + 99 * MIN), { action: "skip", reason: "no_baseline" }, "legacy");
  assert.deepEqual(D.timingDecision({ status: "in_transit", timingActive: true }, T0), { action: "deactivate", reason: "no_baseline" }, "enrolled without a baseline");
  assert.deepEqual(D.timingDecision(null, T0), { action: "skip", reason: "missing" });
});

test("a dispatch trigger registers only the attempt the order is still on", () => {
  const dispatched = { status: "in_transit", failureCount: 1, dispatchedAt: ts(T0) };
  assert.equal(D.sameDispatchAttempt({ ...dispatched }, dispatched), true);
  assert.equal(D.sameDispatchAttempt({ ...dispatched, status: "delayed" }, dispatched), true, "on hold since — same attempt");
  assert.equal(D.sameDispatchAttempt({ ...dispatched, failureCount: 2, status: "in_transit", dispatchedAt: ts(T0 + 5) }, dispatched), false, "redispatched");
  assert.equal(D.sameDispatchAttempt({ ...dispatched, failureCount: 2, status: "pending_dispatch" }, dispatched), false, "requeued");
  assert.equal(D.sameDispatchAttempt({ ...dispatched, dispatchedAt: ts(T0 + 1) }, dispatched), false, "another dispatch write");
  for (const status of ["delivered", "delivery_failed", "cancelled"]) {
    assert.equal(D.sameDispatchAttempt({ ...dispatched, status }, dispatched), false, status);
  }
  assert.equal(D.sameDispatchAttempt(null, dispatched), false);
});

test("there is no post-dispatch timing recovery: no recovery decision, field or callable", () => {
  assert.equal("recoveryDecision" in D, false);
  for (const f of ["timingRecoveredAt", "timingRecoveredByUid", "timingRecoveredByRole"]) assert.equal(D.TIMING_FIELDS.includes(f), false, f);
  assert.equal(typeof require("../index.js").initializeDeliveryTiming, "undefined");
  assert.equal("initializeDeliveryTiming" in require("../src/deliveryTimingOps"), false);
});

test("one alert per order and dispatch attempt; unsafe ids refused", () => {
  assert.equal(D.timingAlertId("ord1", 0), "delivery_delay_ord1_e0");
  assert.equal(D.timingAlertId("ord1", 2), "delivery_delay_ord1_e2");
  assert.throws(() => D.timingAlertId("a/b", 0));
  assert.equal(D.minutesLate(T0, T0 + 12.5 * MIN), 12);
  assert.equal(D.minutesLate(T0, T0 - MIN), 0);
  for (const f of ["timingActive", "timingEpoch", "timingNextCheckAt"]) assert.ok(D.TIMING_FIELDS.includes(f), f);
});
