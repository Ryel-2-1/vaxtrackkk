"use strict";

/**
 * Automatic delivery timing — the contract (pure: no Firestore, no SDK).
 *
 * LIFECYCLE vs TIMING
 *   `status` is the physical workflow (in_transit, delivered, delivery_failed,
 *   cancelled …) including the RIDER-REPORTED `delayed` hold. `timingStatus`
 *   is SCHEDULE health: unknown, on_time, at_risk or delayed. Timing never
 *   changes `status`. It never blocks proof or completion of an in-transit
 *   order; the manual `delayed` hold still does, until the rider resumes.
 *
 * ONE DISPATCH ATTEMPT = ONE BASELINE (timingContractVersion 1)
 *   Frozen once, by the status-history trigger, from the loading → in_transit
 *   write's own snapshot and commit time — and only while the order is still
 *   on THAT attempt (same failure epoch, same server-pinned dispatchedAt):
 *     etaSeconds          the Dispatcher-saved route ETA on the order at
 *                         dispatch (the stop's cumulative ETA on an optimized
 *                         trip, else the route duration), only from a route that
 *                         belongs to the current assignment and destination
 *                         (riderTracking.routeForOrder);
 *     expectedArrivalAt   = attempt dispatch server time + etaSeconds;
 *     grace               = round(ETA minutes × 20 %), clamped to 10–20 min;
 *     automaticDelayedAt  = expectedArrivalAt + grace.
 *   TRUST BOUNDARY: the route ETA is operational input saved by an approved
 *   Dispatcher's client before dispatch — not verified routing-service data.
 *   What the server guarantees is that it is read ONCE, at dispatch, and that
 *   nothing a client writes afterwards can create, move or clear the baseline.
 *
 *   No usable ETA at dispatch → the attempt is "unknown" for good: no
 *   deadline, never evaluated, and a route saved later changes nothing. A new
 *   baseline only comes with a new attempt (failure → requeue → dispatch).
 *
 * DUE-TIME EVALUATION (server time only; scheduled every 5 minutes)
 *   An attempt with a baseline carries `timingNextCheckAt`, the next moment
 *   its condition can change. The scheduler reads only orders that are DUE:
 *     baseline frozen      on_time,  next check = expectedArrivalAt
 *     due before deadline  at_risk,  next check = automaticDelayedAt
 *     due at/after it      delayed (one history event, one alert), inactive
 *   A missed run is caught up in one step (straight to delayed). Every
 *   processed order leaves the due set — its next check moves into the future
 *   or it becomes inactive — so a backlog drains oldest-first and nothing is
 *   hidden behind work already done. The clock runs during the manual hold.
 */

const TIMING_CONTRACT_VERSION = 1;
const TIMING_STATUSES = Object.freeze(["unknown", "on_time", "at_risk", "delayed"]);
const TIMING_RULES = Object.freeze({
  graceRatio: 0.2,
  minGraceMinutes: 10,
  maxGraceMinutes: 20,
  /** An ETA longer than this is not a delivery route (bad data): unknown. */
  maxEtaSeconds: 24 * 60 * 60,
});
/** The reason recorded when an order first becomes automatically delayed. */
const AUTOMATIC_DELAY_REASON = "eta_grace_exceeded";
/** Lifecycles during which the delivery clock runs (the manual hold included). */
const TIMED_LIFECYCLES = Object.freeze(["in_transit", "delayed"]);

/** Every server-owned timing field on an order (firestore.rules serverOnlyOrderFields). */
const TIMING_FIELDS = Object.freeze([
  "timingContractVersion", "timingActive", "timingEpoch", "timingNextCheckAt",
  "timingStatus", "expectedArrivalAt", "automaticDelayedAt", "timingEtaSeconds",
  "timingGraceSeconds", "timingRouteSource", "timingBaselineAt", "timingStatusChangedAt",
  "timingDelayedAt", "timingDelayReason", "timingUnknownReason",
]);

const RANK = Object.freeze({ unknown: 0, on_time: 1, at_risk: 2, delayed: 3 });

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

const lifecycleOf = (order) => (typeof order?.status === "string" ? order.status.trim().toLowerCase() : "");

/** The failure epoch: advances exactly once per failed delivery (orderHistory.epochOf). */
function epochOf(order) {
  return Number.isInteger(order?.failureCount) && order.failureCount > 0 ? order.failureCount : 0;
}

/** Grace in whole minutes for an ETA in seconds: round(ETA min × 20 %), 10–20. */
function graceMinutesFor(etaSeconds, rules = TIMING_RULES) {
  const raw = Math.round((etaSeconds / 60) * rules.graceRatio);
  return Math.min(rules.maxGraceMinutes, Math.max(rules.minGraceMinutes, raw));
}

/**
 * The route ETA an order is measured against, or { ok: false, reason }.
 * `routeForOrder` is riderTracking.routeForOrder (passed in: keeps this module
 * pure and lets tests drive it). The web mirror is
 * src/services/deliveryTiming.js dispatchEtaCheck (parity-tested).
 */
function plannedEta(order, routeForOrder, rules = TIMING_RULES) {
  const route = routeForOrder(order);
  if (!route.available) return { ok: false, reason: route.reason || "route_unavailable" };
  const raw = route.source === "trip" ? order.stopEtaSeconds : order.routeDurationSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > rules.maxEtaSeconds) {
    return { ok: false, reason: "invalid_eta" };
  }
  return { ok: true, etaSeconds: Math.round(raw), source: route.source };
}

/** The baseline for an attempt dispatched at `dispatchedAtMs` (server time), as epoch millis. */
function timingBaseline({ order, dispatchedAtMs, routeForOrder, rules = TIMING_RULES }) {
  if (!Number.isFinite(dispatchedAtMs)) return { known: false, reason: "no_dispatch_time" };
  const eta = plannedEta(order, routeForOrder, rules);
  if (!eta.ok) return { known: false, reason: eta.reason };
  const graceSeconds = graceMinutesFor(eta.etaSeconds, rules) * 60;
  const expectedArrivalMs = dispatchedAtMs + eta.etaSeconds * 1000;
  return {
    known: true,
    etaSeconds: eta.etaSeconds,
    graceSeconds,
    source: eta.source,
    expectedArrivalMs,
    automaticDelayedMs: expectedArrivalMs + graceSeconds * 1000,
  };
}

/** The schedule condition at server time `nowMs` for a known baseline. */
function timingStatusAt({ expectedArrivalMs, automaticDelayedMs }, nowMs) {
  if (!Number.isFinite(expectedArrivalMs) || !Number.isFinite(automaticDelayedMs) || !Number.isFinite(nowMs)) return "unknown";
  if (nowMs >= automaticDelayedMs) return "delayed";
  if (nowMs >= expectedArrivalMs) return "at_risk";
  return "on_time";
}

/**
 * Is the order, as stored now, still on the dispatch attempt that `dispatched`
 * (the dispatch write's snapshot) began? Same failure epoch, same server-pinned
 * dispatch time, and a lifecycle in which the clock runs. A late-delivered
 * trigger of an earlier attempt (after a requeue or a redispatch) is not.
 */
function sameDispatchAttempt(current, dispatched) {
  if (!current || !dispatched) return false;
  if (!TIMED_LIFECYCLES.includes(lifecycleOf(current))) return false;
  if (epochOf(current) !== epochOf(dispatched)) return false;
  return millisOf(current.dispatchedAt) === millisOf(dispatched.dispatchedAt);
}

/**
 * What the evaluator does with a stored order at server time `nowMs`. The
 * decision is made from the order as it is NOW (never from what a scheduler
 * page read earlier), so a stale run cannot touch a newer attempt.
 *   { action: "advance", to, nextCheckMs, firstDelay }
 *       timingStatus moves forward; nextCheckMs is the next due time, or null
 *       when the attempt is finished being timed (automatically delayed);
 *   { action: "reschedule", nextCheckMs }   due too early: re-arm, no change;
 *   { action: "deactivate", reason }        leave the evaluator's set;
 *   { action: "skip", reason }              nothing to do (not due, inactive).
 */
function timingDecision(order, nowMs) {
  if (!order) return { action: "skip", reason: "missing" };
  const enrolled = order.timingActive === true || order.timingNextCheckAt != null;
  if (!TIMED_LIFECYCLES.includes(lifecycleOf(order))) {
    return enrolled ? { action: "deactivate", reason: "not_active_lifecycle" } : { action: "skip", reason: "not_active_lifecycle" };
  }
  const expectedArrivalMs = millisOf(order.expectedArrivalAt);
  const automaticDelayedMs = millisOf(order.automaticDelayedAt);
  if (expectedArrivalMs === null || automaticDelayedMs === null) {
    return enrolled ? { action: "deactivate", reason: "no_baseline" } : { action: "skip", reason: "no_baseline" };
  }
  if (order.timingActive !== true) return { action: "skip", reason: "inactive" };
  const nextCheckMs = millisOf(order.timingNextCheckAt);
  if (nextCheckMs !== null && nextCheckMs > nowMs) return { action: "skip", reason: "not_due" };

  const current = TIMING_STATUSES.includes(order.timingStatus) ? order.timingStatus : "unknown";
  const next = timingStatusAt({ expectedArrivalMs, automaticDelayedMs }, nowMs);
  if (next === "delayed") {
    return { action: "advance", to: "delayed", nextCheckMs: null, firstDelay: order.timingDelayedAt == null };
  }
  const nextDue = next === "at_risk" ? automaticDelayedMs : expectedArrivalMs;
  if (RANK[next] > RANK[current]) return { action: "advance", to: next, nextCheckMs: nextDue, firstDelay: false };
  // Due but nothing new yet (a check armed too early, or a missing one): re-arm.
  return { action: "reschedule", nextCheckMs: nextDue };
}

/** One alert per order and dispatch attempt. */
function timingAlertId(orderId, epoch) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) throw new Error("unsafe order id");
  return `delivery_delay_${orderId}_e${Number.isInteger(epoch) && epoch > 0 ? epoch : 0}`;
}

/** Whole minutes `nowMs` is past `fromMs`; never negative. */
function minutesLate(fromMs, nowMs) {
  return Math.max(0, Math.floor((nowMs - fromMs) / 60000));
}

module.exports = {
  TIMING_CONTRACT_VERSION,
  TIMING_STATUSES,
  TIMING_RULES,
  TIMING_FIELDS,
  TIMED_LIFECYCLES,
  AUTOMATIC_DELAY_REASON,
  epochOf,
  graceMinutesFor,
  plannedEta,
  timingBaseline,
  timingStatusAt,
  sameDispatchAttempt,
  timingDecision,
  timingAlertId,
  minutesLate,
};
