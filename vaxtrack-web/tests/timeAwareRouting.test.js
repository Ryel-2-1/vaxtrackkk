import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXACT_ORDER_LIMIT,
  bufferedMinutes,
  legMinutes,
  matrixMinutes,
  plannedStopEtas,
  suggestStopOrder,
} from "../src/services/timeAwareRouting.js";
import { planDeparture } from "../src/services/departurePlanner.js";
import {
  ROUTING_DEFAULTS,
  SUGGESTED_HUB,
  routingFormValues,
  routingSettingsOf,
  validateRoutingSettings,
} from "../src/services/routingSettings.js";

/**
 * Time-aware trip planning: Valhalla motorcycle travel times feed the
 * requested-arrival planner, and the stop order is chosen to meet requested
 * times before it is chosen to be short.
 */

const DAY = "2026-10-29";
const any = { version: 1, mode: "any_time" };
const before = (time) => ({ version: 1, mode: "before", time });
const windowOf = (start, end) => ({ version: 1, mode: "window", start, end });
const exact = (time) => ({ version: 1, mode: "exact", time });
const stop = (id, matrixIndex, requestedArrival = any, extra = {}) => ({
  id, matrixIndex, requestedDeliveryDate: DAY, requestedArrival, serviceMinutes: 10, ...extra,
});

// hub=0, A=1, B=2. Shortest ride is A then B (10 + 15 = 25 < 12 + 15 = 27).
const M = [
  [0, 10, 12],
  [10, 0, 15],
  [12, 15, 0],
];

// ---------------------------------------------------------------- travel times

test("travel minutes include the traffic buffer and round up; unreachable stays unknown", () => {
  assert.equal(bufferedMinutes(600, 15), 12, "10 min × 1.15 = 11.5 → 12");
  assert.equal(bufferedMinutes(600, 0), 10);
  assert.equal(bufferedMinutes(61, 0), 2, "a partial minute rounds up, never down");
  assert.equal(bufferedMinutes(Infinity, 15), null);
  assert.equal(bufferedMinutes(-5, 15), null);
  assert.deepEqual(matrixMinutes([[0, 600], [Infinity, 0]], 15), [[0, 12], [null, 0]]);
  assert.deepEqual(legMinutes(M, [2, 1]), [12, 15], "hub→B, then B→A");
  assert.deepEqual(legMinutes([[0, null], [null, 0]], [1]), [null]);
});

// ---------------------------------------------------------------- stop order

test("a requested time outranks the shorter ride", () => {
  const stops = [stop("A", 1), stop("B", 2, before("08:30"))];
  const r = suggestStopOrder({ stops, minutes: M, planDate: DAY, nowMinute: 8 * 60 });
  assert.deepEqual(r.order, ["B", "A"], "A first would reach B at 08:35 — late");
  assert.equal(r.exact, true);
  assert.equal(r.score.unmet, 0);
});

test("with no time requests the shortest ride wins", () => {
  const stops = [stop("A", 1), stop("B", 2)];
  const r = suggestStopOrder({ stops, minutes: M, planDate: DAY, nowMinute: 8 * 60 });
  assert.deepEqual(r.order, ["A", "B"]);
  assert.equal(r.score.ride, 25);
});

test("when no order meets every request, the least-late order is chosen — never reported as met", () => {
  // Both want to be first thing; only one can.
  const stops = [stop("A", 1, before("08:15")), stop("B", 2, before("08:15"))];
  const r = suggestStopOrder({ stops, minutes: M, planDate: DAY, nowMinute: 8 * 60 });
  assert.equal(r.score.unmet, 1);
  const plan = planDeparture({
    planDate: DAY, nowMinute: 8 * 60, allowWaiting: true,
    stops: r.order.map((id, k) => ({ ...stops.find((s) => s.id === id), travelMinutes: legMinutes(M, r.order.map((x) => stops.find((s) => s.id === x).matrixIndex))[k] })),
  });
  assert.equal(plan.status, "conflict");
});

test("waiting is used only when allowed, and the least waiting is preferred", () => {
  const stops = [stop("A", 1, exact("10:00")), stop("B", 2, windowOf("10:20", "10:40"))];
  const noWait = suggestStopOrder({ stops, minutes: M, planDate: DAY, nowMinute: 8 * 60, allowWaiting: false });
  const wait = suggestStopOrder({ stops, minutes: M, planDate: DAY, nowMinute: 8 * 60, allowWaiting: true });
  assert.deepEqual(wait.order, ["A", "B"]);
  assert.equal(wait.score.unmet, 0);
  assert.equal(wait.score.wait, 0, "departing at 09:50 needs no waiting at all");
  assert.equal(noWait.score.unmet, 0);
});

test("a stop for another day never steers the order", () => {
  const other = stop("C", 2, before("08:15"), { requestedDeliveryDate: "2026-10-30" });
  const r = suggestStopOrder({ stops: [stop("A", 1), other], minutes: M, planDate: DAY, nowMinute: 8 * 60 });
  assert.deepEqual(r.order, ["A", "C"], "shortest ride; C's date cannot be met by any order");
});

test("an unreachable leg removes that order; nothing reachable → no suggestion", () => {
  const oneWay = [
    [0, 10, 12],
    [10, 0, null],
    [12, 15, 0],
  ];
  const r = suggestStopOrder({ stops: [stop("A", 1), stop("B", 2)], minutes: oneWay, planDate: DAY, nowMinute: 0 });
  assert.deepEqual(r.order, ["B", "A"], "A→B is unreachable, B→A is not");
  const none = [
    [0, null, null],
    [null, 0, null],
    [null, null, 0],
  ];
  assert.equal(suggestStopOrder({ stops: [stop("A", 1), stop("B", 2)], minutes: none, planDate: DAY }), null);
});

test("a missing service time means no suggestion (nothing is assumed)", () => {
  assert.equal(suggestStopOrder({ stops: [stop("A", 1, any, { serviceMinutes: "" }), stop("B", 2)], minutes: M, planDate: DAY }), null);
});

test(`exact up to ${EXACT_ORDER_LIMIT} stops; above that a best effort that still visits every stop once`, () => {
  const n = EXACT_ORDER_LIMIT + 2;
  const size = n + 1;
  const minutes = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 0 : 5 + Math.abs(i - j))));
  // s9 is 14 min from the hub; via any other stop it is at least 6 + 10 + 6 = 22 min away.
  const stops = Array.from({ length: n }, (_, k) => stop(`s${k + 1}`, k + 1, k === n - 1 ? before("08:20") : any));
  const t0 = Date.now();
  const r = suggestStopOrder({ stops, minutes, planDate: DAY, nowMinute: 8 * 60 });
  assert.ok(Date.now() - t0 < 5000, "bounded work in the browser");
  assert.equal(r.exact, false);
  assert.deepEqual([...r.order].sort(), stops.map((s) => s.id).sort());
  assert.equal(r.order[0], `s${n}`, "the deadline stop goes first");
  const small = suggestStopOrder({ stops: stops.slice(0, 3), minutes, planDate: DAY, nowMinute: 8 * 60 });
  assert.equal(small.exact, true);
});

// ---------------------------------------------------------------- saved arrival times

test("saved stop ETAs include earlier stops' service and waiting, measured from departure", () => {
  const stops = [
    { id: "A", requestedDeliveryDate: DAY, requestedArrival: windowOf("09:30", "10:00"), travelMinutes: 10, serviceMinutes: 10 },
    { id: "B", requestedDeliveryDate: DAY, requestedArrival: any, travelMinutes: 15, serviceMinutes: 10 },
  ];
  const plan = planDeparture({ planDate: DAY, nowMinute: 0, allowWaiting: true, departureMinute: 9 * 60 + 10, stops });
  // Leave 09:10 → A 09:20, waits 10 to 09:30, serves to 09:40 → B 09:55.
  assert.deepEqual(plannedStopEtas(plan), [
    { orderId: "A", sequence: 1, etaSeconds: 10 * 60, etaText: "9:20 AM" },
    { orderId: "B", sequence: 2, etaSeconds: 45 * 60, etaText: "9:55 AM" },
  ]);
  const incomplete = planDeparture({ planDate: DAY, stops: [{ ...stops[0], travelMinutes: null }, stops[1]] });
  assert.equal(plannedStopEtas(incomplete), null, "an unknown arrival is never saved");
});

test("a long wait is flagged as a cold-chain warning; the travel note replaces the generic one", () => {
  const plan = planDeparture({
    planDate: DAY, nowMinute: 0, allowWaiting: true, departureMinute: 8 * 60, longWaitMinutes: 30,
    travelNote: "Motorcycle travel times from Valhalla plus a 15% traffic buffer.",
    stops: [{ id: "A", label: "Clinic A", requestedDeliveryDate: DAY, requestedArrival: exact("09:00"), travelMinutes: 10, serviceMinutes: 10 }],
  });
  assert.match(plan.warnings[0], /Stop 1 \(Clinic A\) waits 50 min — over 30 min/);
  assert.ok(plan.warnings.includes("Motorcycle travel times from Valhalla plus a 15% traffic buffer."));
  assert.equal(plan.warnings.some((w) => /minutes entered/.test(w)), false);
});

// ---------------------------------------------------------------- settings

test("routing settings: validation, defaults, and no guessed hub", () => {
  const ok = validateRoutingSettings({ hubName: " Puremart Zapote ", latitude: "14.3123223", longitude: "121.0848667", serviceMinutes: "10", trafficBufferPercent: "15", longWaitMinutes: "30" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { hubName: "Puremart Zapote", hubLatitude: 14.3123223, hubLongitude: 121.0848667, serviceMinutes: 10, trafficBufferPercent: 15, longWaitMinutes: 30 });
  const bad = validateRoutingSettings({ hubName: "", latitude: "91", longitude: "x", serviceMinutes: "7.5", trafficBufferPercent: "101", longWaitMinutes: "" });
  assert.equal(bad.ok, false);
  for (const k of ["hubName", "latitude", "longitude", "serviceMinutes", "trafficBufferPercent", "longWaitMinutes"]) assert.ok(bad.errors[k], k);
  assert.ok(validateRoutingSettings({ hubName: "H", serviceMinutes: 1, trafficBufferPercent: 1, longWaitMinutes: 5 }).errors.location);

  assert.deepEqual(routingSettingsOf(null), { hub: null, ...ROUTING_DEFAULTS }, "no saved hub → no hub, never the suggestion");
  const saved = routingSettingsOf({ hubName: "Hub", hubLatitude: 14.3, hubLongitude: 121.08, serviceMinutes: 5, trafficBufferPercent: 20, longWaitMinutes: 45 });
  assert.deepEqual(saved, { hub: { name: "Hub", latLng: [14.3, 121.08] }, serviceMinutes: 5, trafficBufferPercent: 20, longWaitMinutes: 45 });
  assert.equal(routingSettingsOf({ hubName: "Hub", hubLatitude: 95, hubLongitude: 121, serviceMinutes: -1 }).hub, null);
  assert.equal(routingSettingsOf({ serviceMinutes: -1 }).serviceMinutes, ROUTING_DEFAULTS.serviceMinutes);
  assert.equal(routingFormValues(null).hubName, SUGGESTED_HUB.name, "the form is pre-filled with the pharmacy pin");
  assert.deepEqual(ROUTING_DEFAULTS, { serviceMinutes: 10, trafficBufferPercent: 15, longWaitMinutes: 30 });
});

test("the rules accept exactly the fields the validator produces", () => {
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  const block = rules.slice(rules.indexOf("function validRoutingSettings()"), rules.indexOf("match /operationsSettings/"));
  for (const field of ["hubName", "hubLatitude", "hubLongitude", "serviceMinutes", "trafficBufferPercent", "longWaitMinutes", "updatedAt", "updatedByUid"]) {
    assert.match(block, new RegExp(`'${field}'`), field);
  }
  assert.match(block, /d\.serviceMinutes >= 0 && d\.serviceMinutes <= 120/);
  assert.match(block, /d\.trafficBufferPercent >= 0 && d\.trafficBufferPercent <= 100/);
  assert.match(block, /d\.longWaitMinutes >= 5 && d\.longWaitMinutes <= 240/);
});

test("Phase 4 end to end: the server's delivery timing expects each stop at its PLANNED arrival", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const timing = require("../functions/src/deliveryTiming.js");
  const { routeForOrder } = require("../functions/src/riderTracking.js");
  const { encodePolyline } = await import("../src/services/routeService.js");
  // Leave 09:10 → A 09:20 (10 min), waits to 09:30, serves 10 → B 09:55: 45 min after leaving.
  const plan = planDeparture({
    planDate: DAY, nowMinute: 0, allowWaiting: true, departureMinute: 9 * 60 + 10,
    stops: [
      { id: "A", requestedDeliveryDate: DAY, requestedArrival: windowOf("09:30", "10:00"), travelMinutes: 10, serviceMinutes: 10 },
      { id: "B", requestedDeliveryDate: DAY, requestedArrival: any, travelMinutes: 15, serviceMinutes: 10 },
    ],
  });
  const etas = plannedStopEtas(plan);
  const T0 = Date.UTC(2026, 9, 29, 1, 10); // dispatch, whenever it really happens
  const ts = (ms) => ({ toMillis: () => ms });
  const trip = encodePolyline([[14.3123, 121.0849], [14.338, 121.087], [14.313, 121.111]]);
  for (const stopEta of etas) {
    const order = {
      tripId: "t1", stopSequence: stopEta.sequence, tripPolyline: trip, tripGeneratedAt: ts(T0 - 60000),
      assignedAt: ts(T0 - 3600000), stopEtaSeconds: stopEta.etaSeconds,
      // A single-order route of only the riding time must NOT be what counts.
      routePolyline: trip, routeGeneratedAt: ts(T0 - 60000), routeDurationSeconds: 600,
    };
    const b = timing.timingBaseline({ order, dispatchedAtMs: T0, routeForOrder });
    assert.equal(b.source, "trip", stopEta.orderId);
    assert.equal(b.expectedArrivalMs, T0 + stopEta.etaSeconds * 1000, stopEta.orderId);
  }
  assert.deepEqual(etas.map((e) => e.etaSeconds / 60), [10, 45], "B includes A's wait and service, not riding alone (25)");
});

// ---------------------------------------------------------------- automatic plan, slack, live re-plan

test("slack: among departures that meet every request, one with 10 min to spare wins over less waiting", async () => {
  const { DEADLINE_SLACK_MINUTES, planTrip } = await import("../src/services/timeAwareRouting.js");
  assert.equal(DEADLINE_SLACK_MINUTES, 10);
  // The QA scenario: B before 17:17, A window 18:02–18:32; hub→B 21, B→A 27, 10 min service.
  const minutes = [
    [0, 18, 21],
    [19, 0, 27],
    [21, 27, 0],
  ];
  const stops = [
    stop("A", 1, windowOf("18:02", "18:32")),
    stop("B", 2, before("17:17")),
  ];
  const tight = planTrip({ stops, minutes, planDate: DAY, nowMinute: 16 * 60, slackMinutes: 0 });
  const slack = planTrip({ stops, minutes, planDate: DAY, nowMinute: 16 * 60 });
  assert.deepEqual(slack.order, ["B", "A"]);
  assert.equal(tight.plan.evaluatedDeparture, 16 * 60 + 55, "no slack preferred: leave 16:55, 1 min to spare");
  assert.equal(tight.plan.minSlack, 1);
  assert.equal(slack.plan.evaluatedDeparture, 16 * 60 + 46, "leave 16:46: B at 17:07, 10 min to spare");
  assert.equal(slack.plan.minSlack, 10);
  assert.equal(slack.allMet, true);
  assert.deepEqual(slack.etas.map((e) => e.etaSeconds / 60), [21, 58]);
  assert.equal(slack.plan.warnings.some((w) => /to spare/.test(w)), false);
});

test("slack never makes a plan 'miss': when 10 min cannot be kept, it still plans and says how much is left", async () => {
  const { planTrip } = await import("../src/services/timeAwareRouting.js");
  // B cannot be reached with 10 min to spare (earliest arrival 16:21, cutoff 16:28: 7 min).
  const r = planTrip({ stops: [stop("A", 1), stop("B", 2, before("16:28"))], minutes: M, planDate: DAY, nowMinute: 16 * 60 + 9 });
  assert.equal(r.allMet, true);
  assert.equal(r.order[0], "B");
  assert.match(r.plan.warnings[0], /Only 7 min to spare before a requested deadline — less than the preferred 10 min/);
});

test("an exact time has no slack to keep and is not penalised for it", async () => {
  const { planTrip } = await import("../src/services/timeAwareRouting.js");
  const r = planTrip({ stops: [stop("A", 1, exact("10:00")), stop("B", 2)], minutes: M, planDate: DAY, nowMinute: 8 * 60 });
  assert.equal(r.allMet, true);
  assert.equal(r.plan.minSlack, null);
  assert.equal(r.plan.evaluatedDeparture, 9 * 60 + 50);
});

test("live re-plan: with the departure fixed at now, the order is chosen for what is still reachable", async () => {
  const { planTrip } = await import("../src/services/timeAwareRouting.js");
  const stops = [stop("A", 1, before("10:30")), stop("B", 2, before("10:20"))];
  const r = planTrip({ stops, minutes: M, planDate: DAY, nowMinute: 10 * 60, fixedDeparture: 10 * 60 });
  assert.equal(r.plan.evaluatedDeparture, 10 * 60, "never a different departure");
  assert.deepEqual(r.order, ["B", "A"], "B first (10:12), then A (10:37 is late either way, B is not)");
  assert.equal(r.allMet, false);
  assert.equal(r.plan.stops.find((s) => s.id === "B").outcome, "ok");
});

test("arrival check: met, early, late, another day, and no date", async () => {
  const { arrivalCheck } = await import("../src/services/timeAwareRouting.js");
  const at = (hh, mm) => new Date(Date.UTC(2026, 9, 29, hh - 8, mm)); // Manila wall clock on DAY
  const order = { requestedDeliveryDate: DAY, requestedArrival: windowOf("10:00", "11:00") };
  assert.deepEqual(arrivalCheck(order, at(10, 30)), { met: true, text: "Meets the requested time (Within 10:00 AM–11:00 AM)." });
  assert.deepEqual(arrivalCheck(order, at(9, 45)), { met: false, early: true, text: "Arrives 15 min before Within 10:00 AM–11:00 AM — the rider would wait." });
  assert.equal(arrivalCheck(order, at(11, 20)).text, "20 min late for Within 10:00 AM–11:00 AM.");
  assert.equal(arrivalCheck({ ...order, requestedDeliveryDate: "2026-10-30" }, at(10, 30)).met, false);
  assert.equal(arrivalCheck({ requestedArrival: any }, at(10, 30)).met, false, "no date is never 'met'");
  assert.equal(arrivalCheck(order, new Date(NaN)), null);
});
