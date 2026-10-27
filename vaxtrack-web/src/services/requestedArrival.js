/**
 * Requested arrival at the destination — pure and dependency-free.
 *
 * WHEN THE DELIVERY IS NEEDED AT THE DESTINATION on the order's
 * `requestedDeliveryDate`: never the Rider's hub departure, an estimate, or a
 * promise. The authority is functions/src/requestedArrival.js (which also
 * documents the stored shape); this file applies the SAME rules in the
 * browser so the checkout can say what is wrong before a round trip, and
 * gives every screen one way to word a request. tests/requestedArrival.test.js
 * checks the two agree case by case.
 *
 *   any_time  within the requested day (no time; not midnight, noon or now)
 *   window    start <= arrival <= end, inclusive; start strictly before end
 *   before    arrival strictly before the cutoff (arriving AT it is late)
 *   exact     arrival at that minute
 *
 * Times are 'HH:MM' 24-hour Asia/Manila wall-clock strings at whole-minute
 * precision. They are never turned into Date objects in the browser's own
 * timezone, so a device set to another zone cannot move them.
 */

export const REQUESTED_ARRIVAL_VERSION = 1;
export const ARRIVAL_MODES = Object.freeze(["any_time", "window", "before", "exact"]);

/** The choices the checkout offers, in order. */
export const ARRIVAL_MODE_OPTIONS = Object.freeze([
  { value: "any_time", label: "Any time within the requested day" },
  { value: "window", label: "Within a time window" },
  { value: "before", label: "Before a time" },
  { value: "exact", label: "At an exact time" },
]);

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MODE_FIELDS = Object.freeze({ any_time: [], window: ["start", "end"], before: ["time"], exact: ["time"] });
const MINUTES_PER_DAY = 24 * 60;
const MANILA_OFFSET_MINUTES = 8 * 60;

export const ANY_TIME = Object.freeze({ version: REQUESTED_ARRIVAL_VERSION, mode: "any_time" });

/** 'HH:MM' → minutes since midnight, or null. */
export function minutesOf(hhmm) {
  if (typeof hhmm !== "string" || !TIME_PATTERN.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes since midnight → 'HH:MM' (wraps nothing: callers keep 0–1439). */
export function hhmmOf(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The Manila date and minute of day for an instant (fixed UTC+8, no DST). */
export function manilaClock(now = new Date()) {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MINUTES * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** "10:00 AM", "12:00 noon", "12:00 midnight", "3:05 PM" — Manila wall clock as stored. */
export function formatArrivalTime(hhmm) {
  const total = minutesOf(hhmm);
  if (total === null) return "";
  if (total === 0) return "12:00 midnight";
  if (total === 12 * 60) return "12:00 noon";
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A minute count of the day, worded the same way. */
export function formatMinute(minute) {
  return Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY ? formatArrivalTime(hhmmOf(minute)) : "";
}

/**
 * The [earliest, latest] arrival minutes a spec allows on its own day, or null
 * when no minute satisfies it. any_time spans the day.
 */
export function arrivalBounds(spec) {
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

function fail(message, field = "mode", code = "invalid-requested-arrival") {
  return { ok: false, code, field, message };
}

// A required time not entered yet. Same refusal as the server's; flagged so a
// form can wait until the rep tries to continue before saying so.
function incomplete(message, field) {
  return { ...fail(message, field), incomplete: true };
}

function readTime(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return { missing: true };
  const text = typeof value === "string" ? value.trim() : "";
  return TIME_PATTERN.test(text) ? { value: text } : { invalid: true };
}

/**
 * Validate a requested arrival exactly as the server does.
 * @returns {{ok: true, value: object} | {ok: false, code: string, field: string, message: string}}
 *   `field` names the input to point at: "mode", "start", "end" or "time".
 */
export function normalizeRequestedArrival(value, { requestedDeliveryDate = null, now = new Date(), validateFuture = true } = {}) {
  if (value === undefined || value === null) return { ok: true, value: { ...ANY_TIME } };
  if (typeof value !== "object" || Array.isArray(value)) return fail("The requested delivery time was malformed.");
  const mode = value.mode;
  if (typeof mode !== "string" || !ARRIVAL_MODES.includes(mode)) {
    return fail("Choose how the delivery time is requested: any time that day, a window, before a time, or an exact time.");
  }
  const allowed = new Set(["version", "mode", ...MODE_FIELDS[mode]]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail(`A "${mode}" delivery time cannot carry "${key}".`);
  }
  if (value.version !== undefined && value.version !== REQUESTED_ARRIVAL_VERSION) {
    return fail("The requested delivery time uses an unsupported format. Reload the app and try again.");
  }

  let spec;
  if (mode === "any_time") {
    spec = { ...ANY_TIME };
  } else if (mode === "window") {
    const start = readTime(value.start);
    const end = readTime(value.end);
    if (start.missing || end.missing) {
      return incomplete("Enter both the start and the end of the delivery window.", start.missing ? "start" : "end");
    }
    if (start.invalid || end.invalid) return fail("Enter times as HH:MM, from 00:00 to 23:59.", start.invalid ? "start" : "end");
    if (start.value === end.value) {
      return fail("The window starts and ends at the same time. Choose \"At an exact time\" instead.", "end");
    }
    if (minutesOf(end.value) < minutesOf(start.value)) {
      return fail("The window must end after it starts, on the requested day. Overnight windows are not supported.", "end");
    }
    spec = { version: REQUESTED_ARRIVAL_VERSION, mode, start: start.value, end: end.value };
  } else {
    const time = readTime(value.time);
    if (time.missing) {
      return incomplete(mode === "before" ? "Enter the time the delivery must arrive before." : "Enter the exact delivery time.", "time");
    }
    if (time.invalid) return fail("Enter times as HH:MM, from 00:00 to 23:59.", "time");
    if (mode === "before" && time.value === "00:00") {
      return fail("\"Before 12:00 midnight\" leaves no time on the requested day. Choose a later cutoff.", "time");
    }
    spec = { version: REQUESTED_ARRIVAL_VERSION, mode, time: time.value };
  }

  const clock = manilaClock(now);
  if (validateFuture && spec.mode !== "any_time" && requestedDeliveryDate === clock.date) {
    const bounds = arrivalBounds(spec);
    if (!bounds || bounds[1] < clock.minute) {
      return fail(
        "That requested time has already passed today. Choose a later time or another day.",
        spec.mode === "window" ? "end" : "time",
        "requested-arrival-passed"
      );
    }
  }
  return { ok: true, value: spec };
}

/**
 * The spec an order (or receipt) carries, read leniently: a missing field —
 * every order placed before this existed — or an unrecognisable one is any_time.
 */
export function requestedArrivalOf(source) {
  const spec = source?.requestedArrival;
  if (!spec || typeof spec !== "object") return { ...ANY_TIME };
  if (spec.mode === "window" && minutesOf(spec.start) !== null && minutesOf(spec.end) !== null) {
    return { version: REQUESTED_ARRIVAL_VERSION, mode: "window", start: spec.start, end: spec.end };
  }
  if ((spec.mode === "before" || spec.mode === "exact") && minutesOf(spec.time) !== null) {
    return { version: REQUESTED_ARRIVAL_VERSION, mode: spec.mode, time: spec.time };
  }
  return { ...ANY_TIME };
}

/** True when the spec asks for a particular time (anything but any_time). */
export function isTimedArrival(spec) {
  return spec?.mode === "window" || spec?.mode === "before" || spec?.mode === "exact";
}

/**
 * "Within the requested day", "Within 10:00 AM–12:00 noon",
 * "Before 10:00 AM", "Exactly 10:00 AM".
 */
export function requestedArrivalLabel(spec) {
  switch (spec?.mode) {
    case "window":
      return `Within ${formatArrivalTime(spec.start)}–${formatArrivalTime(spec.end)}`;
    case "before":
      return `Before ${formatArrivalTime(spec.time)}`;
    case "exact":
      return `Exactly ${formatArrivalTime(spec.time)}`;
    default:
      return "Within the requested day";
  }
}

// ------------------------------------------------------------ checkout form

/** The checkout's editable state: the mode plus the raw time inputs. */
export const EMPTY_ARRIVAL_FORM = Object.freeze({ mode: "any_time", start: "", end: "", time: "" });

function timeOrBlank(value) {
  return typeof value === "string" && TIME_PATTERN.test(value) ? value : "";
}

/**
 * A saved or restored arrival in form shape. Unknown modes fall back to
 * any_time; only well-formed times survive, and only the ones the mode uses —
 * so a draft never carries a stale value from a mode that is no longer chosen.
 */
export function normalizeArrivalForm(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_ARRIVAL_FORM };
  const mode = ARRIVAL_MODES.includes(value.mode) ? value.mode : "any_time";
  return {
    mode,
    start: mode === "window" ? timeOrBlank(value.start) : "",
    end: mode === "window" ? timeOrBlank(value.end) : "",
    time: mode === "before" || mode === "exact" ? timeOrBlank(value.time) : "",
  };
}

/** Switching mode clears every time: nothing typed for one mode is reused by another. */
export function withArrivalMode(form, mode) {
  return normalizeArrivalForm({ mode });
}

/** What the checkout sends: only the chosen mode and its own fields. */
export function arrivalPayloadOf(form) {
  const f = normalizeArrivalFormLoose(form);
  switch (f.mode) {
    case "window":
      return { mode: "window", start: f.start, end: f.end };
    case "before":
    case "exact":
      return { mode: f.mode, time: f.time };
    default:
      return { mode: "any_time" };
  }
}

// Like normalizeArrivalForm, but keeps whatever was typed (blank or not) so
// validation can say which input is missing rather than silently dropping it.
function normalizeArrivalFormLoose(value) {
  const mode = ARRIVAL_MODES.includes(value?.mode) ? value.mode : "any_time";
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  return { mode, start: text(value?.start), end: text(value?.end), time: text(value?.time) };
}

/** A stable comparison key for a submitted arrival (absent = any_time). */
export function arrivalKey(value) {
  const r = normalizeRequestedArrival(value, { requestedDeliveryDate: null });
  if (!r.ok) {
    const f = normalizeArrivalFormLoose(value);
    return `invalid:${f.mode}:${f.start}:${f.end}:${f.time}`;
  }
  const s = r.value;
  return s.mode === "window" ? `window:${s.start}:${s.end}` : s.mode === "any_time" ? "any_time" : `${s.mode}:${s.time}`;
}

// ------------------------------------------------------------ date + arrival

/** "Oct 28, 2026" from 'YYYY-MM-DD', formatted in UTC so no zone moves the day. */
export function formatRequestedDate(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Oct 28, 2026 · Before 10:00 AM" — or just the arrival when there is no date. */
export function requestedScheduleLabel(dateIso, spec) {
  const date = formatRequestedDate(dateIso);
  const arrival = requestedArrivalLabel(spec);
  return date ? `${date} · ${arrival}` : arrival;
}

/** Read-only order-row wording. Never substitutes a route ETA for a request. */
export function orderArrivalNote(order) {
  // An Admin reschedule is an operational commitment, not a rewrite of what
  // the Med Rep originally requested. Existing schedule controls show it apart.
  const date = formatRequestedDate(order?.originalRequestedDeliveryDate)
    || formatRequestedDate(order?.requestedDeliveryDate);
  const check = normalizeRequestedArrival(order?.requestedArrival, { validateFuture: false });
  if (!check.ok) return "Requested arrival: unavailable — check order";
  if (!date && check.value.mode === "any_time") return "Requested arrival: not specified";
  const label = requestedArrivalLabel(check.value);
  return `Requested arrival: ${date ? `${date} · ` : ""}${label} (PHT)`;
}
