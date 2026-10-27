import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAY_MINUTES, PLAN_WARNINGS, planDeparture, readMinutes } from "../src/services/departurePlanner.js";

/**
 * Departure planning for one proposed stop sequence (services/departurePlanner.js).
 * Deterministic fixtures; times are Manila wall-clock minutes of the plan day.
 */

const DAY = "2026-10-28";
const at = (h, m = 0) => h * 60 + m;
const stop = (id, requestedArrival, travelMinutes, serviceMinutes, requestedDeliveryDate = DAY) => ({
  id,
  label: id,
  requestedDeliveryDate,
  requestedArrival,
  travelMinutes,
  serviceMinutes,
});
const plan = (stops, extra = {}) => planDeparture({ planDate: DAY, nowMinute: at(8), stops, ...extra });
const row = (result, id) => result.stops.find((s) => s.id === id);

// The specification's fixture: Hub→A 20 min, service at A 10 min, A→B 30 min,
// A window 10:00–10:30, B exactly 11:00.
const A = stop("A", { mode: "window", start: "10:00", end: "10:30" }, 20, 10);
const B_EXACT = stop("B", { mode: "exact", time: "11:00" }, 30, 5);
const B_BEFORE = stop("B", { mode: "before", time: "11:00" }, 30, 5);

test("one timed stop: the departures that land in its window, earliest suggested", () => {
  const r = plan([A]);
  assert.equal(r.status, "feasible");
  assert.deepEqual(r.window, { from: at(9, 40), to: at(10, 10) });
  assert.equal(r.recommended, at(9, 40));
  assert.equal(row(r, "A").arrival, at(10));
});

test("the specification's fixture: departing 10:00 reaches A at 10:20 and B at exactly 11:00", () => {
  const r = plan([A, B_EXACT], { departureMinute: at(10) });
  assert.equal(r.status, "feasible");
  assert.equal(row(r, "A").arrival, at(10, 20));
  assert.equal(row(r, "A").leave, at(10, 30), "service at A ends 10:30");
  assert.equal(row(r, "B").arrival, at(11));
  assert.equal(row(r, "B").outcome, "ok");
  // And 10:00 is the only departure that meets both.
  const search = plan([A, B_EXACT]);
  assert.deepEqual(search.window, { from: at(10), to: at(10) });
  assert.equal(search.recommended, at(10));
});

test("\"before 11:00\" is not satisfied by arriving at 11:00", () => {
  const r = plan([A, B_BEFORE], { departureMinute: at(10) });
  assert.equal(r.status, "conflict");
  assert.equal(row(r, "B").arrival, at(11));
  assert.equal(row(r, "B").outcome, "late");
  assert.equal(row(r, "B").deviation, 1);
  assert.equal(row(r, "B").note, "Arrives at the cutoff — not before it.");
  // The departures that do meet it end one minute earlier.
  const search = plan([A, B_BEFORE]);
  assert.deepEqual(search.window, { from: at(9, 40), to: at(9, 59) });
  assert.equal(row(planDeparture({ planDate: DAY, nowMinute: at(8), departureMinute: at(9, 59), stops: [A, B_BEFORE] }), "B").outcome, "ok");
});

test("multiple timed stops: a window's end is inclusive", () => {
  const r = plan([A, B_EXACT], { departureMinute: at(10, 10) });
  assert.equal(row(r, "A").arrival, at(10, 30));
  assert.equal(row(r, "A").outcome, "ok", "arriving at 10:30 is within 10:00–10:30");
  assert.equal(row(r, "B").outcome, "late");
  assert.equal(row(r, "B").deviation, 10);
});

test("earlier travel and service push every later stop", () => {
  const slowA = { ...A, serviceMinutes: 25 };
  const r = plan([slowA, B_EXACT], { departureMinute: at(10) });
  assert.equal(row(r, "B").arrival, at(11, 15), "15 more minutes at A arrive 15 minutes later at B");
  assert.equal(row(r, "B").outcome, "late");
  const search = plan([slowA, B_EXACT]);
  assert.equal(search.recommended, at(9, 45), "the only departure that still meets both");
});

test("mixed windows, deadlines, exact times and flexible-day orders", () => {
  const stops = [
    stop("W", { mode: "window", start: "09:00", end: "10:00" }, 30, 10),
    stop("D", { mode: "before", time: "11:00" }, 20, 10),
    stop("X", { mode: "exact", time: "11:30" }, 25, 10),
    stop("F", null, 15, null), // flexible: any time that day; last service not needed
  ];
  const r = plan(stops);
  // X exact: D + 30 + 10 + 20 + 10 + 25 = D + 95 = 11:30 → D = 9:55; W: 10:25 is past its 10:00 end.
  assert.equal(r.status, "conflict");
  assert.equal(r.infeasible, true, "no departure today meets every request in this order");
  // Reordering is the Dispatcher's decision; the same stops in another order can work.
  const reordered = plan([stops[0], stops[1], { ...stops[2], travelMinutes: 70 }, stops[3]]);
  assert.equal(reordered.status, "feasible");
  assert.equal(row(reordered, "F").outcome, "ok");
  assert.equal(row(reordered, "F").requestLabel, "Within the requested day");
});

test("waiting is used only when allowed, and stays visible", () => {
  const stops = [
    stop("A", { mode: "exact", time: "10:00" }, 20, 5),
    stop("B", { mode: "window", start: "10:30", end: "10:45" }, 10, 5),
  ];
  const strict = plan(stops);
  assert.equal(strict.infeasible, true, "without waiting, B would be reached before its window opens");
  const early = plan(stops, { departureMinute: at(9, 40) });
  assert.equal(row(early, "B").outcome, "early");
  assert.equal(row(early, "B").deviation, -15);

  const waiting = plan(stops, { allowWaiting: true });
  assert.equal(waiting.status, "feasible");
  assert.equal(waiting.recommended, at(9, 40), "the least total waiting");
  const b = row(waiting, "B");
  assert.equal(b.arrival, at(10, 15), "the physical arrival is not hidden");
  assert.equal(b.wait, 15);
  assert.equal(b.serviceStart, at(10, 30));
  assert.equal(waiting.totalWait, 15);
  assert.equal(b.note, "Waits 15 min before delivering.");
});

test("missing travel or service makes the plan provisional; nothing is assumed", () => {
  const r = plan([A, { ...B_EXACT, travelMinutes: "" }]);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.missing.map((m) => [m.stopId, m.kind]), [["B", "travel"]]);
  assert.equal(r.recommended, null);
  assert.equal(r.window, null);

  const noService = plan([{ ...A, serviceMinutes: null }, B_EXACT], { departureMinute: at(10) });
  assert.equal(row(noService, "A").outcome, "ok", "what can be computed still is");
  assert.equal(row(noService, "B").arrival, null);
  assert.equal(row(noService, "B").outcome, "unknown");
  assert.equal(noService.status, "incomplete");

  // The last stop's service time changes no arrival, so it is not required.
  assert.equal(plan([A, { ...B_EXACT, serviceMinutes: null }]).missing.length, 0);
  // A known conflict is reported even when later inputs are missing.
  const known = plan([A, { ...B_EXACT, travelMinutes: null }], { departureMinute: at(11) });
  assert.equal(known.status, "conflict");
  assert.equal(row(known, "A").outcome, "late");
});

test("conflicting constraints: shown as a conflict with the closest possible departure", () => {
  const stops = [stop("A", { mode: "exact", time: "10:00" }, 20, 0), stop("B", { mode: "exact", time: "10:05" }, 30, 0)];
  const r = plan(stops);
  assert.equal(r.infeasible, true);
  assert.equal(r.status, "conflict");
  assert.equal(r.recommended, null, "nothing is recommended as feasible");
  assert.equal(r.evaluatedSource, "best-effort");
  const deviations = r.stops.map((s) => Math.abs(s.deviation));
  assert.equal(deviations.reduce((a, b) => a + b, 0), 25, "the smallest total deviation");
});

test("a departure that would have to be in the past is flagged, never recommended", () => {
  const r = planDeparture({ planDate: DAY, nowMinute: at(10, 15), stops: [A, B_EXACT] });
  assert.equal(r.window, null);
  assert.deepEqual(r.pastOnlyWindow, { from: at(10), to: at(10) });
  assert.equal(r.recommended, null);
  assert.match(r.warnings[0], /before now/);

  const planned = planDeparture({ planDate: DAY, nowMinute: at(10), departureMinute: at(9, 50), stops: [A] });
  assert.equal(planned.departureInPast, true);
  assert.equal(planned.status, "conflict");
  assert.match(planned.warnings[0], /already passed/);
});

test("a Dispatcher-adjusted departure recalculates every arrival", () => {
  const a = plan([A, B_EXACT], { departureMinute: at(10) });
  const b = plan([A, B_EXACT], { departureMinute: at(10, 5) });
  assert.equal(row(b, "A").arrival - row(a, "A").arrival, 5);
  assert.equal(row(b, "B").arrival - row(a, "B").arrival, 5);
  assert.equal(b.evaluatedSource, "planned");
  assert.equal(row(b, "B").outcome, "late");
});

test("a stop requested for another day cannot be met by any departure", () => {
  const passed = plan([A, stop("Old", null, 10, 5, "2026-10-27")], { departureMinute: at(10) });
  assert.equal(row(passed, "Old").outcome, "date");
  assert.equal(row(passed, "Old").note, "Its requested day has already passed.");
  assert.equal(passed.status, "conflict");
  const later = plan([stop("Next", { mode: "exact", time: "10:00" }, 10, 5, "2026-10-29")]);
  assert.equal(row(later, "Next").outcome, "date");
  assert.equal(later.recommended, null);
});

test("a flexible-day order still has to arrive on its day", () => {
  const r = plan([stop("F", null, 90, 0)], { departureMinute: at(23) });
  assert.equal(row(r, "F").arrival, at(24, 30));
  assert.equal(row(r, "F").outcome, "late");
});

test("operating hours are reported unknown, never assumed open", () => {
  const r = plan([A]);
  assert.ok(r.warnings.includes(PLAN_WARNINGS.destinationHours));
  assert.ok(r.warnings.includes(PLAN_WARNINGS.hubHours));
  assert.match(r.objective, /least total waiting, then the earliest/);
  assert.match(r.objective, /not optimised here/);
});

test("readMinutes accepts whole non-negative minutes only", () => {
  assert.equal(readMinutes("15"), 15);
  assert.equal(readMinutes(0), 0);
  for (const v of ["", " ", null, undefined, "-1", "1.5", "abc", DAY_MINUTES + 1]) assert.equal(readMinutes(v), null, String(v));
});

test("the plan is deterministic", () => {
  assert.deepEqual(plan([A, B_EXACT]), plan([A, B_EXACT]));
});

test("the planner UI is planning only and never reuses a stale entry", () => {
  const ui = readFileSync(new URL("../src/components/dispatch/DeparturePlanner.jsx", import.meta.url), "utf8");
  // No writes, no callables, no dispatch: it imports only the pure planner,
  // the arrival helpers, icons and its stylesheet.
  const imports = [...ui.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["../../services/departurePlanner", "../../services/requestedArrival", "lucide-react", "react"].sort());
  assert.equal(/setDoc|updateDoc|addDoc|httpsCallable|finalizeRiderDispatch|updateOrderLoadedState|localStorage|sessionStorage/.test(ui), false);
  // Entries are keyed by order AND destination revision; legs by both ends.
  assert.match(ui, /const keyOf = \(order\) => `\$\{order\.id\}@\$\{Number\.isInteger\(order\.destinationRevision\)/);
  assert.match(ui, /const legKey = \(index\) => `\$\{index === 0 \? "hub" : keyOf\(sequenced\[index - 1\]\)\}>\$\{keyOf\(sequenced\[index\]\)\}`;/);
  // The plan is recomputed from the live orders on every render.
  assert.match(ui, /const plan = planDeparture\(\{/);
  const cargo = readFileSync(new URL("../src/pages/dispatcher/DispatcherCargoLoading.jsx", import.meta.url), "utf8");
  assert.match(cargo, /\{!dispatched && <DeparturePlanner orders=\{group\.orders\} riderName=\{group\.rider\.name\} \/>\}/);
});

test("with a stop for another day, the interval is labelled as covering only the other stops", () => {
  const r = plan([A, stop("Next", { mode: "exact", time: "10:00" }, 10, 5, "2026-10-29")]);
  assert.equal(r.dateBlocked, true);
  assert.equal(r.recommended, null, "nothing is suggested as meeting every request");
  assert.deepEqual(r.window, { from: at(9, 40), to: at(10, 10) }, "the other stops' departures are still shown");
  const ui = readFileSync(new URL("../src/components/dispatch/DeparturePlanner.jsx", import.meta.url), "utf8");
  assert.match(ui, /plan\.dateBlocked \? "Departures that meet every other request" : "Departures that meet every request"/);
});
