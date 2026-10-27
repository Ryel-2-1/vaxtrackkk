/**
 * Departure planning for ONE proposed stop sequence — pure and dependency-free.
 *
 * What it does
 *   Given the stops in the order the Rider would visit them, the travel time
 *   into each stop (from the hub for the first), each stop's service time and
 *   each order's requested arrival (services/requestedArrival.js), it evaluates
 *   every departure minute of the plan day and reports:
 *     - the departures that satisfy every request (an interval),
 *     - a recommended departure within it,
 *     - and, for the departure being looked at (the Dispatcher's planned one,
 *       else the recommendation, else the least-bad one), each stop's physical
 *       arrival, any waiting, its service, and whether its request is met.
 *   Earlier stops push later ones: a stop's arrival is the previous stop's
 *   departure (service start + service time) plus the travel time into it.
 *
 * What it does NOT do
 *   It does not change the visiting order (no sequence optimisation — the
 *   sequence is the Dispatcher's), does not route or estimate travel, and has
 *   no traffic model. It never invents an input: a missing travel or service
 *   time makes everything after it unknown and the plan provisional, and
 *   nothing is assumed about opening hours, which VaxTrack does not record —
 *   they are reported as unknown, never treated as "always open".
 *
 * Constraints (minute precision, Manila wall clock of the plan day)
 *   window  start <= service start <= end
 *   before  service start <= cutoff − 1      (arriving AT the cutoff is late)
 *   exact   service start == time
 *   any     within the requested day         (0 … 1439)
 *   A stop requested for an earlier or later day than the plan day cannot be
 *   met by any departure and is reported as such.
 *
 * Waiting
 *   Off unless the Dispatcher allows it. When allowed, a Rider who arrives
 *   before a window opens (or before an exact time) waits there; the physical
 *   arrival, the wait and the delivery time are all shown. When not allowed,
 *   an early arrival is a conflict.
 *
 * Objective
 *   Among departures that satisfy every request: the least total waiting,
 *   then the EARLIEST such departure (the most slack against windows ending
 *   and deadlines, since traffic is not modelled). When none does: the
 *   departure with the smallest total deviation (minutes early + minutes
 *   late), then the earliest — shown as a conflict, never as feasible.
 */

import { arrivalBounds, formatMinute, requestedArrivalLabel, requestedArrivalOf } from "./requestedArrival.js";

export const DAY_MINUTES = 24 * 60;

export const PLAN_OBJECTIVE =
  "Satisfies every requested arrival; among such departures, the least total waiting, then the earliest " +
  "(most slack, since traffic is not modelled). The visiting order is yours — it is not optimised here.";

export const PLAN_WARNINGS = Object.freeze({
  destinationHours: "Destination opening hours are not recorded in VaxTrack, so they are not checked.",
  hubHours: "Hub hours are not recorded, so a departure is not checked against them.",
  traffic: "Times are planning estimates from the minutes entered; traffic and delays are not modelled.",
});

/** A non-negative whole number of minutes, or null when absent/blank/invalid. */
export function readMinutes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) && n >= 0 && n <= DAY_MINUTES ? n : null;
}

function dateIssueOf(requestedDate, planDate) {
  if (typeof requestedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return "missing";
  if (requestedDate < planDate) return "passed";
  if (requestedDate > planDate) return "later";
  return null;
}

/**
 * One stop's constraint for the plan day.
 * @returns {{bounds: [number, number] | null, dateIssue: null|"passed"|"later"|"missing", spec: object}}
 */
function constraintOf(stop, planDate) {
  const spec = requestedArrivalOf(stop);
  const dateIssue = dateIssueOf(stop.requestedDeliveryDate, planDate);
  return { spec, dateIssue, bounds: dateIssue ? null : arrivalBounds(spec) };
}

/**
 * Walk the route from departure minute D. Pure; `constraints[i]` from constraintOf.
 * Every stop gets an outcome: ok | early | late | unknown | date.
 */
function walk(stops, constraints, departure, allowWaiting) {
  let clock = departure; // minute the Rider leaves the previous point, or null once unknown
  let totalWait = 0;
  let totalDeviation = 0;
  let unmet = 0;
  let unknown = 0;
  const rows = stops.map((stop, index) => {
    const c = constraints[index];
    const travel = readMinutes(stop.travelMinutes);
    const service = readMinutes(stop.serviceMinutes);
    const row = {
      id: stop.id,
      arrival: null,
      wait: 0,
      serviceStart: null,
      service,
      leave: null,
      outcome: "unknown",
      deviation: 0,
    };
    if (clock === null || travel === null) {
      clock = null;
      unknown += 1;
      if (c.dateIssue) {
        row.outcome = "date";
        unmet += 1;
      }
      return row;
    }
    const arrival = clock + travel;
    let start = arrival;
    if (c.bounds && allowWaiting && arrival < c.bounds[0]) {
      row.wait = c.bounds[0] - arrival;
      start = c.bounds[0];
      totalWait += row.wait;
    }
    row.arrival = arrival;
    row.serviceStart = start;
    if (c.dateIssue) {
      row.outcome = "date";
      unmet += 1;
    } else if (!c.bounds) {
      // Unreachable for a validated spec ("before 00:00" is refused); kept safe.
      row.outcome = "late";
      unmet += 1;
    } else if (start < c.bounds[0]) {
      row.outcome = "early";
      row.deviation = start - c.bounds[0];
      totalDeviation += -row.deviation;
      unmet += 1;
    } else if (start > c.bounds[1]) {
      row.outcome = "late";
      row.deviation = start - c.bounds[1];
      totalDeviation += row.deviation;
      unmet += 1;
    } else {
      row.outcome = "ok";
    }
    if (service === null) {
      clock = null;
    } else {
      row.leave = start + service;
      clock = row.leave;
    }
    return row;
  });
  return { rows, totalWait, totalDeviation, unmet, unknown };
}

/** Contiguous [from, to] runs of a sorted list of minutes. */
function runsOf(minutes) {
  const runs = [];
  for (const m of minutes) {
    const last = runs[runs.length - 1];
    if (last && m === last.to + 1) last.to = m;
    else runs.push({ from: m, to: m });
  }
  return runs;
}

/**
 * Plan one route.
 *
 * @param {object} input
 * @param {string} input.planDate          'YYYY-MM-DD', the Manila day the trip runs
 * @param {number|null} input.nowMinute    the current Manila minute when planDate is today; null for a later day
 * @param {boolean} [input.allowWaiting]   the Rider may wait at a stop until it can be served
 * @param {number|null} [input.departureMinute]  the Dispatcher's planned departure, if any
 * @param {Array<{id: string, label?: string, requestedDeliveryDate: string,
 *   requestedArrival?: object, travelMinutes: number|string|null,
 *   serviceMinutes: number|string|null}>} input.stops  in visiting order
 */
export function planDeparture({ planDate, nowMinute = null, allowWaiting = false, departureMinute = null, stops = [] }) {
  const constraints = stops.map((s) => constraintOf(s, planDate));
  const missing = [];
  stops.forEach((s, i) => {
    if (readMinutes(s.travelMinutes) === null) missing.push({ stopId: s.id, kind: "travel", index: i });
    // The last stop's service time changes no arrival, so it is not required.
    if (i < stops.length - 1 && readMinutes(s.serviceMinutes) === null) missing.push({ stopId: s.id, kind: "service", index: i });
  });
  const complete = missing.length === 0 && stops.length > 0;
  const dateBlocked = constraints.some((c) => c.dateIssue);
  const earliestAllowed = Number.isInteger(nowMinute) ? nowMinute : 0;

  // ---- every departure minute of the day (complete inputs only) ----
  let window = null;
  let pastOnlyWindow = null;
  let recommended = null;
  let bestEffort = null;
  let windowRuns = 0;
  if (complete) {
    const feasibleAll = [];
    let best = null;
    let fallback = null;
    for (let d = 0; d < DAY_MINUTES; d += 1) {
      const w = walk(stops, constraints, d, allowWaiting);
      // Date conflicts cannot be fixed by any departure; the search looks for
      // the departure that best serves the other stops.
      const fixableUnmet = w.rows.filter((r) => r.outcome === "early" || r.outcome === "late").length;
      if (fixableUnmet === 0) feasibleAll.push(d);
      if (d < earliestAllowed) continue;
      if (fixableUnmet === 0) {
        if (!best || w.totalWait < best.totalWait) best = { d, totalWait: w.totalWait };
      } else if (!fallback || w.totalDeviation < fallback.totalDeviation) {
        fallback = { d, totalDeviation: w.totalDeviation };
      }
    }
    const future = feasibleAll.filter((d) => d >= earliestAllowed);
    const runs = runsOf(future);
    windowRuns = runs.length;
    window = runs[0] ?? null;
    if (!window && feasibleAll.length > 0) {
      const pastRuns = runsOf(feasibleAll);
      pastOnlyWindow = pastRuns[pastRuns.length - 1];
    }
    if (best && !dateBlocked) recommended = best.d;
    if (!best && fallback) bestEffort = fallback.d;
    if (best && dateBlocked) bestEffort = best.d;
  }

  // ---- the departure being looked at ----
  const planned = Number.isInteger(departureMinute) && departureMinute >= 0 && departureMinute < DAY_MINUTES ? departureMinute : null;
  let evaluated = null;
  let source = null;
  if (planned !== null) {
    evaluated = planned;
    source = "planned";
  } else if (recommended !== null) {
    evaluated = recommended;
    source = "recommended";
  } else if (bestEffort !== null) {
    evaluated = bestEffort;
    source = "best-effort";
  }
  const run = evaluated === null ? null : walk(stops, constraints, evaluated, allowWaiting);

  const rows = stops.map((stop, i) => {
    const c = constraints[i];
    const r = run ? run.rows[i] : { arrival: null, wait: 0, serviceStart: null, service: readMinutes(stop.serviceMinutes), leave: null, outcome: c.dateIssue ? "date" : "unknown", deviation: 0 };
    return {
      ...r,
      id: stop.id,
      label: stop.label ?? "",
      requestedDeliveryDate: stop.requestedDeliveryDate ?? null,
      requestLabel: requestedArrivalLabel(c.spec),
      mode: c.spec.mode,
      dateIssue: c.dateIssue,
      bounds: c.bounds,
      travel: readMinutes(stop.travelMinutes),
      note: noteFor(r, c),
    };
  });

  const conflicts = rows.filter((r) => r.outcome === "early" || r.outcome === "late" || r.outcome === "date");
  // A planned departure already behind the clock cannot be followed as entered.
  const departureInPast = planned !== null && Number.isInteger(nowMinute) && planned < nowMinute;
  const warnings = [PLAN_WARNINGS.destinationHours, PLAN_WARNINGS.hubHours, PLAN_WARNINGS.traffic];
  if (departureInPast) {
    warnings.unshift(`The planned departure, ${formatMinute(planned)}, has already passed.`);
  }
  if (complete && !window && pastOnlyWindow) {
    warnings.unshift(
      `Every departure that meets these requests was before now (${formatMinute(pastOnlyWindow.from)}–${formatMinute(pastOnlyWindow.to)}). It cannot be achieved today as planned.`
    );
  }
  if (windowRuns > 1) {
    warnings.unshift("Departures that meet these requests fall in more than one separate interval; the earliest is shown.");
  }

  let status;
  if (conflicts.length > 0 || departureInPast) status = "conflict";
  else if (!complete || (run && run.unknown > 0)) status = "incomplete";
  else if (run && run.unmet === 0) status = "feasible";
  else status = "conflict";
  // No departure today meets every request (complete inputs, nothing feasible).
  const infeasible = complete && !window;

  return {
    status,
    infeasible,
    evaluatedDeparture: evaluated,
    evaluatedSource: source,
    departureInPast,
    // A stop requested for another day: no departure can meet it, so the
    // departure interval above covers only the OTHER stops' requests.
    dateBlocked,
    recommended,
    window,
    pastOnlyWindow,
    stops: rows,
    conflicts,
    missing,
    totalWait: run ? run.totalWait : 0,
    warnings,
    objective: PLAN_OBJECTIVE,
  };
}

function noteFor(r, c) {
  if (c.dateIssue === "passed") return "Its requested day has already passed.";
  if (c.dateIssue === "later") return "It is requested for a later day.";
  if (c.dateIssue === "missing") return "It has no requested date.";
  if (r.outcome === "unknown") return "Arrival unknown — enter the missing travel or service time.";
  if (r.outcome === "early") return `${-r.deviation} min early${c.spec.mode === "exact" ? ` for ${formatMinute(c.bounds[0])}` : ""}.`;
  if (r.outcome === "late") {
    if (c.spec.mode === "before" && r.serviceStart === c.bounds[1] + 1) return "Arrives at the cutoff — not before it.";
    return `${r.deviation} min late.`;
  }
  if (r.wait > 0) return `Waits ${r.wait} min before delivering.`;
  return "";
}
