"use strict";

/**
 * The Med Rep's requested ARRIVAL at the destination — when the delivery is
 * needed there, never when the Rider leaves the hub.
 *
 * Stored on the order as `requestedArrival`, written only by
 * createOrderWithReservation (firestore.rules lists it in
 * serverOnlyOrderFields), and snapshotted onto the confirmation receipt:
 *
 *   { version: 1, mode: "any_time" }                       within the requested day
 *   { version: 1, mode: "window", start: "HH:MM", end: "HH:MM" }
 *   { version: 1, mode: "before", time: "HH:MM" }
 *   { version: 1, mode: "exact",  time: "HH:MM" }
 *
 * Every time is a 24-hour Asia/Manila wall-clock time on the order's own
 * `requestedDeliveryDate`, at whole-minute precision. 00:00 is midnight at the
 * START of that day; 12:00 is noon. There is no date in the spec, so a browser
 * timezone can never shift it, and nothing here moves a request to another day.
 *
 * Boundaries, at minute precision (arrival A, in minutes since midnight):
 *   window  start <= A <= end, both inclusive. start must be strictly before
 *           end: an end at or before the start is refused, never read as an
 *           overnight window, and an equal pair is refused with a pointer to
 *           "exact" rather than silently converted.
 *   before  A < time, strictly. Arrival AT the cutoff does not satisfy it; the
 *           latest satisfying minute is time − 1. No buffer is added.
 *   exact   A == time.
 *   any_time  any minute of the requested day — NOT midnight, noon or now,
 *           and not a claim that the destination is open all day.
 *
 * Absent, null and { mode: "any_time" } all mean any_time. Legacy orders have
 * no field and read as any_time. `scheduledDeliveryTime` (an Admin reschedule's
 * 'HH:MM', with no documented arrival meaning) is a separate field and is
 * never mapped onto this one.
 *
 * src/services/requestedArrival.js applies the same rules in the browser;
 * tests/requestedArrival.test.js checks the two agree.
 */

const { PolicyError } = require("./policy");

const REQUESTED_ARRIVAL_VERSION = 1;
const ARRIVAL_MODES = Object.freeze(["any_time", "window", "before", "exact"]);
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MINUTES_PER_DAY = 24 * 60;
const MANILA_OFFSET_MINUTES = 8 * 60;

/** The keys each mode carries, besides `version` and `mode`. */
const MODE_FIELDS = Object.freeze({
  any_time: [],
  window: ["start", "end"],
  before: ["time"],
  exact: ["time"],
});

const ANY_TIME = Object.freeze({ version: REQUESTED_ARRIVAL_VERSION, mode: "any_time" });

function refuse(message, code = "invalid-requested-arrival") {
  throw new PolicyError(code, message);
}

/** 'HH:MM' → minutes since midnight, or null. */
function minutesOf(hhmm) {
  if (typeof hhmm !== "string" || !TIME_PATTERN.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function readTime(value, missingMessage) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    refuse(missingMessage);
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!TIME_PATTERN.test(text)) {
    refuse("Enter times as HH:MM, from 00:00 to 23:59.");
  }
  return text;
}

/** Minutes since midnight in Manila for `now`, and the Manila date it falls on. */
function manilaClock(now) {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MINUTES * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * The [earliest, latest] arrival minutes a spec allows on its day, or null for
 * a spec with no satisfying minute. any_time spans the whole day.
 */
function arrivalBounds(spec) {
  switch (spec?.mode) {
    case "window":
      return [minutesOf(spec.start), minutesOf(spec.end)];
    case "before": {
      const t = minutesOf(spec.time);
      return t > 0 ? [0, t - 1] : null;
    }
    case "exact": {
      const t = minutesOf(spec.time);
      return [t, t];
    }
    default:
      return [0, MINUTES_PER_DAY - 1];
  }
}

/**
 * The canonical spec for a create payload's `requestedArrival`, or a
 * PolicyError. `requestedDeliveryDate` is the already-validated order date and
 * `now` the server's clock: a time that has already passed today is refused.
 */
function normalizeRequestedArrival(value, { requestedDeliveryDate, now, validateFuture = true }) {
  if (value === undefined || value === null) return { ...ANY_TIME };
  if (typeof value !== "object" || Array.isArray(value)) {
    refuse("The requested delivery time was malformed.");
  }
  const mode = value.mode;
  if (typeof mode !== "string" || !ARRIVAL_MODES.includes(mode)) {
    refuse("Choose how the delivery time is requested: any time that day, a window, before a time, or an exact time.");
  }
  const allowed = new Set(["version", "mode", ...MODE_FIELDS[mode]]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      refuse(`A "${mode}" delivery time cannot carry "${key}".`);
    }
  }
  if (value.version !== undefined && value.version !== REQUESTED_ARRIVAL_VERSION) {
    refuse("The requested delivery time uses an unsupported format. Reload the app and try again.");
  }

  let spec;
  if (mode === "any_time") {
    spec = { ...ANY_TIME };
  } else if (mode === "window") {
    const start = readTime(value.start, "Enter both the start and the end of the delivery window.");
    const end = readTime(value.end, "Enter both the start and the end of the delivery window.");
    if (start === end) {
      refuse("The window starts and ends at the same time. Choose \"At an exact time\" instead.");
    }
    if (minutesOf(end) < minutesOf(start)) {
      refuse("The window must end after it starts, on the requested day. Overnight windows are not supported.");
    }
    spec = { version: REQUESTED_ARRIVAL_VERSION, mode, start, end };
  } else {
    const time = readTime(value.time, mode === "before" ? "Enter the time the delivery must arrive before." : "Enter the exact delivery time.");
    if (mode === "before" && time === "00:00") {
      refuse("\"Before 12:00 midnight\" leaves no time on the requested day. Choose a later cutoff.");
    }
    spec = { version: REQUESTED_ARRIVAL_VERSION, mode, time };
  }

  // A request for today whose latest acceptable minute has already gone by
  // could never be met; it is refused rather than quietly moved.
  const clock = manilaClock(now);
  if (validateFuture && spec.mode !== "any_time" && requestedDeliveryDate === clock.date) {
    const bounds = arrivalBounds(spec);
    if (!bounds || bounds[1] < clock.minute) {
      refuse("That requested time has already passed today. Choose a later time or another day.", "requested-arrival-passed");
    }
  }
  return spec;
}

/**
 * The spec an order carries, read leniently: a missing field (every legacy
 * order) or one that is not a recognisable spec reads as any_time.
 */
function requestedArrivalOf(order) {
  const spec = order?.requestedArrival;
  if (!spec || typeof spec !== "object") return { ...ANY_TIME };
  if (spec.mode === "window" && minutesOf(spec.start) !== null && minutesOf(spec.end) !== null) {
    return { version: REQUESTED_ARRIVAL_VERSION, mode: "window", start: spec.start, end: spec.end };
  }
  if ((spec.mode === "before" || spec.mode === "exact") && minutesOf(spec.time) !== null) {
    return { version: REQUESTED_ARRIVAL_VERSION, mode: spec.mode, time: spec.time };
  }
  return { ...ANY_TIME };
}

module.exports = {
  REQUESTED_ARRIVAL_VERSION,
  ARRIVAL_MODES,
  normalizeRequestedArrival,
  requestedArrivalOf,
  arrivalBounds,
  minutesOf,
  manilaClock,
};
