/**
 * Time-aware trip planning — pure and dependency-free (no Firebase, no fetch).
 *
 * Joins the two halves the app already had:
 *   - Valhalla motorcycle travel times (routeService.travelMatrix), and
 *   - the requested-arrival departure planner (departurePlanner.js).
 *
 * suggestStopOrder chooses the visiting order, by these priorities in turn:
 *   1. the fewest stops that miss their requested time (early or late),
 *   2. the fewest minutes early/late in total,
 *   3. the most slack before deadlines, up to DEADLINE_SLACK_MINUTES,
 *   4. the least waiting,
 *   5. the shortest total ride,
 *   6. the earliest departure.
 * Up to EXACT_ORDER_LIMIT stops every order is tried; above that a local search
 * is used and the result is marked as a best effort. A stop requested for
 * another day can never be met by any order and does not steer the choice.
 *
 * Each order is scored at a set of candidate departures (every 15 minutes, plus
 * the departures at which a stop would arrive exactly at a bound of its
 * request). The planner itself then checks every minute of the day for the
 * chosen order, so the times shown are exact for that order.
 */

import { DAY_MINUTES, constraintOf, minSlackOf, planDeparture, walk, readMinutes } from "./departurePlanner.js";
import { formatMinute, manilaClock, requestedArrivalLabel, requestedArrivalOf } from "./requestedArrival.js";

export const EXACT_ORDER_LIMIT = 7;
// Preferred minutes to spare before each window / "before" deadline. The
// traffic buffer covers slower riding; this covers everything else (parking,
// finding the doctor). A fixed default, not yet an Admin setting.
export const DEADLINE_SLACK_MINUTES = 10;
const GRID_MINUTES = 15;

/**
 * [lat, lng] the Rider rides to, or null. Same precedence as the server
 * (functions/src/deliveryGeofence.js normalizeOrderDestination): the canonical
 * destination* fields win whenever any is present; clinic* only for orders that
 * never had them. Nothing is defaulted.
 */
export function stopLatLng(order) {
  const canonical = ["destinationLat", "destinationLng"].some((k) => order?.[k] !== undefined);
  const lat = canonical ? order?.destinationLat : order?.clinicLat;
  const lng = canonical ? order?.destinationLng : order?.clinicLng;
  const ok = typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  return ok ? [lat, lng] : null;
}

/** Riding seconds → whole minutes including the traffic buffer, rounded up. null when unreachable. */
export function bufferedMinutes(seconds, bufferPercent) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const pct = Number.isFinite(bufferPercent) && bufferPercent > 0 ? bufferPercent : 0;
  return Math.ceil((seconds * (1 + pct / 100)) / 60);
}

/** A seconds matrix (routeService.travelMatrix) as buffered minutes. */
export function matrixMinutes(seconds, bufferPercent) {
  return seconds.map((row) => row.map((s) => bufferedMinutes(s, bufferPercent)));
}

/**
 * Travel minutes into each stop of a sequence of matrix indices, starting at
 * the hub (index 0). null where a leg is unknown or unreachable.
 */
export function legMinutes(minutes, sequence) {
  let previous = 0;
  return sequence.map((index) => {
    const m = minutes?.[previous]?.[index];
    previous = index;
    return Number.isInteger(m) ? m : null;
  });
}

function plannerStops(stops, minutes, sequence) {
  const legs = legMinutes(minutes, sequence.map((i) => stops[i].matrixIndex));
  return sequence.map((i, k) => ({ ...stops[i], travelMinutes: legs[k] }));
}

function candidateDepartures(planStops, constraints, earliest, slackMinutes) {
  const set = new Set([earliest]);
  for (let d = Math.ceil(earliest / GRID_MINUTES) * GRID_MINUTES; d < DAY_MINUTES; d += GRID_MINUTES) set.add(d);
  // Offsets with no waiting: departing at d puts stop i at d + offset[i].
  const base = walk(planStops, constraints, 0, false);
  base.rows.forEach((row, i) => {
    const bounds = constraints[i].bounds;
    if (!bounds || row.arrival === null) return;
    for (const target of [bounds[0], bounds[1], bounds[1] - slackMinutes, bounds[1] + 1 - slackMinutes]) {
      const d = target - row.arrival;
      if (d >= earliest && d < DAY_MINUTES) set.add(d);
    }
  });
  return [...set];
}

const KEYS = ["unmet", "deviation", "shortfall", "wait", "ride", "departure"];
function better(a, b) {
  if (!b) return true;
  for (const k of KEYS) {
    if (a[k] !== b[k]) return a[k] < b[k];
  }
  return false;
}

/** The best score of one visiting order, or null when a leg is unreachable. */
function scoreOrder(stops, minutes, sequence, { planDate, earliest, allowWaiting, slackMinutes = 0, fixedDeparture = null }) {
  const planStops = plannerStops(stops, minutes, sequence);
  if (planStops.some((s) => s.travelMinutes === null)) return null;
  const constraints = planStops.map((s) => constraintOf(s, planDate));
  const ride = planStops.reduce((sum, s) => sum + s.travelMinutes, 0);
  let best = null;
  const departures = Number.isInteger(fixedDeparture) ? [fixedDeparture] : candidateDepartures(planStops, constraints, earliest, slackMinutes);
  for (const departure of departures) {
    const w = walk(planStops, constraints, departure, allowWaiting);
    if (w.unknown > 0) return null;
    const missed = w.rows.filter((r) => r.outcome === "early" || r.outcome === "late");
    const score = {
      unmet: missed.length,
      deviation: missed.reduce((sum, r) => sum + Math.abs(r.deviation), 0),
      shortfall: missed.length === 0 ? Math.max(0, slackMinutes - minSlackOf(w, constraints)) : 0,
      wait: w.totalWait,
      ride,
      departure,
    };
    if (better(score, best)) best = score;
  }
  return best;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

/** Earliest deadline first — the local search's starting point. */
function deadlineOrder(stops, planDate) {
  return stops
    .map((s, i) => ({ i, bounds: constraintOf(s, planDate).bounds }))
    .sort((a, b) => (a.bounds?.[1] ?? DAY_MINUTES) - (b.bounds?.[1] ?? DAY_MINUTES) || (a.bounds?.[0] ?? 0) - (b.bounds?.[0] ?? 0) || a.i - b.i)
    .map((x) => x.i);
}

function localSearch(stops, minutes, opts) {
  let order = deadlineOrder(stops, opts.planDate);
  let best = scoreOrder(stops, minutes, order, opts);
  for (let pass = 0; pass < 50; pass += 1) {
    let improved = false;
    for (let from = 0; from < order.length; from += 1) {
      for (let to = 0; to < order.length; to += 1) {
        if (from === to) continue;
        const next = [...order];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        const score = scoreOrder(stops, minutes, next, opts);
        if (score && better(score, best)) {
          order = next;
          best = score;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { order, best };
}

/**
 * Suggest the visiting order.
 *
 * @param {object} input
 * @param {Array<{id: string, matrixIndex: number, requestedDeliveryDate?: string,
 *   requestedArrival?: object, serviceMinutes: number|string|null}>} input.stops
 *   matrixIndex ≥ 1 is the stop's row in `minutes` (0 is the hub)
 * @param {Array<Array<number|null>>} input.minutes  buffered minutes (matrixMinutes)
 * @param {string} input.planDate   'YYYY-MM-DD' (Manila)
 * @param {number|null} [input.nowMinute]  earliest allowed departure today
 * @param {boolean} [input.allowWaiting]
 * @param {number} [input.slackMinutes]  preferred slack before deadlines
 * @param {number|null} [input.fixedDeparture]  the departure is decided (e.g. the rider is already riding: now)
 * @returns {{order: string[], exact: boolean, score: object} | null}  null when no order is fully reachable
 */
export function suggestStopOrder({ stops, minutes, planDate, nowMinute = null, allowWaiting = false, slackMinutes = 0, fixedDeparture = null }) {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  // The last stop's service changes no arrival; every other one must be known.
  if (stops.some((s, i) => i < stops.length - 1 && readMinutes(s.serviceMinutes) === null)) {
    // Service times are per stop, not per position: require all of them.
    return null;
  }
  const opts = { planDate, earliest: Number.isInteger(nowMinute) ? nowMinute : 0, allowWaiting, slackMinutes, fixedDeparture };
  if (stops.length <= EXACT_ORDER_LIMIT) {
    let best = null;
    let bestOrder = null;
    for (const order of permutations(stops.map((_, i) => i))) {
      const score = scoreOrder(stops, minutes, order, opts);
      if (score && better(score, best)) {
        best = score;
        bestOrder = order;
      }
    }
    return bestOrder ? { order: bestOrder.map((i) => stops[i].id), exact: true, score: best } : null;
  }
  const { order, best } = localSearch(stops, minutes, opts);
  return best ? { order: order.map((i) => stops[i].id), exact: false, score: best } : null;
}

/**
 * The trip fields a planned departure saves for each stop, from a
 * planDeparture result. `etaSeconds` is the planned ARRIVAL at the stop
 * measured from departure — riding (with the traffic buffer), every earlier
 * stop's service time and any planned waiting. The server's delivery timing
 * adds it to the real dispatch time (functions/src/deliveryTiming.js), so
 * stops after the first are no longer expected too early.
 *
 * Returns null unless every stop has a known arrival at the evaluated departure.
 */
export function plannedStopEtas(plan) {
  const departure = plan?.evaluatedDeparture;
  if (!Number.isInteger(departure) || !Array.isArray(plan.stops) || plan.stops.length === 0) return null;
  if (plan.stops.some((r) => !Number.isInteger(r.arrival))) return null;
  return plan.stops.map((row, i) => ({
    orderId: row.id,
    sequence: i + 1,
    // Never zero: the server refuses a non-positive ETA as invalid.
    etaSeconds: Math.max(60, (row.arrival - departure) * 60),
    etaText: formatMinute(row.arrival) || "",
  }));
}

/**
 * The whole automatic plan in one step: choose the order, plan the departure
 * (or use the fixed one), and produce the arrivals to save.
 *
 * @param {object} input  as suggestStopOrder, plus:
 * @param {Array<{id: string, label?: string, matrixIndex: number, requestedDeliveryDate?: string,
 *   requestedArrival?: object, serviceMinutes: number|string|null}>} input.stops
 * @param {number|null} [input.longWaitMinutes]
 * @param {string|null} [input.travelNote]
 * @returns {null | {
 *   order: string[], exact: boolean,
 *   plan: object,          // planDeparture result for that order
 *   etas: Array|null,      // plannedStopEtas(plan): null when an arrival is unknown
 *   allMet: boolean,       // every requested arrival for today is met
 * }}  null when no order is fully reachable or a service time is missing
 */
export function planTrip({
  stops, minutes, planDate, nowMinute = null, allowWaiting = true,
  slackMinutes = DEADLINE_SLACK_MINUTES, fixedDeparture = null, longWaitMinutes = null, travelNote = null,
}) {
  const suggestion = suggestStopOrder({ stops, minutes, planDate, nowMinute, allowWaiting, slackMinutes, fixedDeparture });
  if (!suggestion) return null;
  const byId = new Map(stops.map((s) => [s.id, s]));
  const ordered = suggestion.order.map((id) => byId.get(id));
  const legs = legMinutes(minutes, ordered.map((s) => s.matrixIndex));
  const plan = planDeparture({
    planDate,
    nowMinute,
    allowWaiting,
    slackMinutes,
    longWaitMinutes,
    travelNote,
    departureMinute: Number.isInteger(fixedDeparture) ? fixedDeparture : null,
    stops: ordered.map((s, k) => ({ ...s, travelMinutes: legs[k] })),
  });
  return {
    order: suggestion.order,
    exact: suggestion.exact,
    plan,
    etas: plannedStopEtas(plan),
    allMet: plan.status === "feasible",
  };
}

/**
 * One arrival (a Date) against the order's requested arrival, Manila time.
 * Returns { met: true|false, early?: true, text } — e.g. "Meets the requested time (Before
 * 5:17 PM)" or "12 min late for Before 5:17 PM". An order with no requested
 * date is never reported as met.
 */
export function arrivalCheck(order, arrival) {
  if (!(arrival instanceof Date) || Number.isNaN(arrival.getTime())) return null;
  const clock = manilaClock(arrival);
  const spec = requestedArrivalOf(order);
  const label = requestedArrivalLabel(spec);
  const c = constraintOf({ requestedDeliveryDate: order?.requestedDeliveryDate, requestedArrival: order?.requestedArrival }, clock.date);
  if (c.dateIssue === "missing") return { met: false, text: "No requested date to check against." };
  if (c.dateIssue) return { met: false, text: `Requested for another day (${label}).` };
  if (!c.bounds) return { met: false, text: `Cannot meet ${label}.` };
  // Early is not a miss: the rider can wait. Reported, never shown as a failure.
  if (clock.minute < c.bounds[0]) return { met: false, early: true, text: `Arrives ${c.bounds[0] - clock.minute} min before ${label} — the rider would wait.` };
  if (clock.minute > c.bounds[1]) return { met: false, text: `${clock.minute - c.bounds[1]} min late for ${label}.` };
  return { met: true, text: `Meets the requested time (${label}).` };
}
