/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ANY_TIME,
  EMPTY_ARRIVAL_FORM,
  arrivalKey,
  arrivalPayloadOf,
  formatArrivalTime,
  formatRequestedDate,
  isTimedArrival,
  manilaClock,
  normalizeArrivalForm,
  normalizeRequestedArrival,
  requestedArrivalLabel,
  requestedArrivalOf,
  requestedScheduleLabel,
  withArrivalMode,
} from "../src/services/requestedArrival.js";

/**
 * The requested ARRIVAL at the destination, browser side. The server module
 * (functions/src/requestedArrival.js) is the authority; these tests prove the
 * browser accepts and refuses exactly what it does, words every request the
 * same way everywhere, and cannot be moved by the device's timezone.
 */

const require = createRequire(import.meta.url);
const server = require("../functions/src/requestedArrival.js");

const NOW = new Date(Date.UTC(2026, 9, 27, 1, 0)); // 09:00 Manila, Oct 27

const CASES = [
  [undefined, "2026-10-28"],
  [null, "2026-10-28"],
  [{ mode: "any_time" }, "2026-10-27"],
  [{ mode: "window", start: "10:00", end: "12:00" }, "2026-10-28"],
  [{ mode: "window", start: "10:00" }, "2026-10-28"],
  [{ mode: "window", start: "12:00", end: "10:00" }, "2026-10-28"],
  [{ mode: "window", start: "10:00", end: "10:00" }, "2026-10-28"],
  [{ mode: "window", start: "07:00", end: "08:59" }, "2026-10-27"],
  [{ mode: "before", time: "10:00" }, "2026-10-28"],
  [{ mode: "before", time: "00:00" }, "2026-10-28"],
  [{ mode: "before", time: "09:00" }, "2026-10-27"],
  [{ mode: "before", time: "09:01" }, "2026-10-27"],
  [{ mode: "exact", time: "12:00" }, "2026-10-28"],
  [{ mode: "exact", time: "00:00" }, "2026-10-28"],
  [{ mode: "exact", time: "24:00" }, "2026-10-28"],
  [{ mode: "exact" }, "2026-10-28"],
  [{ mode: "morning" }, "2026-10-28"],
  [{ mode: "before", time: "10:00", start: "09:00" }, "2026-10-28"],
  [{ version: 2, mode: "any_time" }, "2026-10-28"],
  ["10:00", "2026-10-28"],
];

test("browser and server accept and refuse exactly the same requests", () => {
  for (const [value, date] of CASES) {
    const browser = normalizeRequestedArrival(value, { requestedDeliveryDate: date, now: NOW });
    let serverResult;
    try {
      serverResult = { ok: true, value: server.normalizeRequestedArrival(value, { requestedDeliveryDate: date, now: NOW }) };
    } catch (e) {
      serverResult = { ok: false, code: e.code, message: e.message };
    }
    assert.equal(browser.ok, serverResult.ok, JSON.stringify(value));
    if (browser.ok) {
      assert.deepEqual(browser.value, serverResult.value, JSON.stringify(value));
    } else {
      assert.equal(browser.code, serverResult.code, JSON.stringify(value));
      assert.equal(browser.message, serverResult.message, JSON.stringify(value));
    }
  }
});

test("every request is worded the same way: day, window, before, exact", () => {
  assert.equal(requestedArrivalLabel(ANY_TIME), "Within the requested day");
  assert.equal(requestedArrivalLabel({ mode: "window", start: "10:00", end: "12:00" }), "Within 10:00 AM–12:00 noon");
  assert.equal(requestedArrivalLabel({ mode: "before", time: "10:00" }), "Before 10:00 AM");
  assert.equal(requestedArrivalLabel({ mode: "exact", time: "10:00" }), "Exactly 10:00 AM");
  assert.equal(requestedArrivalLabel({ mode: "exact", time: "00:00" }), "Exactly 12:00 midnight");
  assert.equal(formatArrivalTime("12:30"), "12:30 PM");
  assert.equal(formatArrivalTime("00:05"), "12:05 AM");
  assert.equal(formatArrivalTime("23:59"), "11:59 PM");
  assert.equal(requestedScheduleLabel("2026-10-28", { mode: "before", time: "10:00" }), "Oct 28, 2026 · Before 10:00 AM");
  assert.equal(requestedScheduleLabel(null, ANY_TIME), "Within the requested day");
  assert.equal(formatRequestedDate("2026-02-31"), "", "an impossible date is not shown as another day");
  assert.equal(formatRequestedDate("2026-10-28"), "Oct 28, 2026");
  assert.equal(isTimedArrival(ANY_TIME), false);
  assert.equal(isTimedArrival({ mode: "before", time: "10:00" }), true);
});

test("legacy orders and receipts with no field read as any time; an Admin time is not a request", () => {
  assert.deepEqual(requestedArrivalOf({}), ANY_TIME);
  assert.deepEqual(requestedArrivalOf(null), ANY_TIME);
  assert.deepEqual(requestedArrivalOf({ requestedArrival: null }), ANY_TIME);
  assert.deepEqual(requestedArrivalOf({ scheduledDeliveryTime: "09:30" }), ANY_TIME);
  assert.deepEqual(requestedArrivalOf({ requestedArrival: { version: 1, mode: "exact", time: "10:00" } }), { version: 1, mode: "exact", time: "10:00" });
});

test("form: switching mode clears every time, and clearing returns to any time", () => {
  const window = { mode: "window", start: "10:00", end: "12:00", time: "" };
  assert.deepEqual(withArrivalMode(window, "before"), { mode: "before", start: "", end: "", time: "" });
  assert.deepEqual(withArrivalMode(window, "any_time"), EMPTY_ARRIVAL_FORM);
  assert.deepEqual(withArrivalMode({ mode: "exact", time: "10:00" }, "window"), { mode: "window", start: "", end: "", time: "" });
  // A saved draft keeps only well-formed times of its own mode; an unknown mode reads as any time.
  assert.deepEqual(normalizeArrivalForm({ mode: "before", time: "10:00", start: "09:00" }), { mode: "before", start: "", end: "", time: "10:00" });
  assert.deepEqual(normalizeArrivalForm({ mode: "warp", time: "10:00" }), EMPTY_ARRIVAL_FORM);
  assert.deepEqual(normalizeArrivalForm({ mode: "exact", time: "25:00" }), { mode: "exact", start: "", end: "", time: "" });
  assert.deepEqual(normalizeArrivalForm(undefined), EMPTY_ARRIVAL_FORM);
});

test("form: the payload carries only the chosen mode's own fields", () => {
  assert.deepEqual(arrivalPayloadOf(EMPTY_ARRIVAL_FORM), { mode: "any_time" });
  assert.deepEqual(arrivalPayloadOf({ mode: "window", start: "10:00", end: "12:00", time: "08:00" }), { mode: "window", start: "10:00", end: "12:00" });
  assert.deepEqual(arrivalPayloadOf({ mode: "exact", start: "09:00", time: "10:00" }), { mode: "exact", time: "10:00" });
  // An incomplete window is sent as typed, so validation names the missing input.
  const r = normalizeRequestedArrival(arrivalPayloadOf({ mode: "window", start: "10:00", end: "" }), {});
  assert.equal(r.ok, false);
  assert.equal(r.field, "end");
  assert.equal(r.incomplete, true, "a missing time waits for Finalize before it is shown");
  const reversed = normalizeRequestedArrival({ mode: "window", start: "12:00", end: "10:00" }, {});
  assert.equal(reversed.incomplete, undefined, "a reversed window is shown at once");
});

test("arrivalKey: absent and any_time compare equal; any change of mode or time does not", () => {
  assert.equal(arrivalKey(null), arrivalKey({ mode: "any_time" }));
  assert.equal(arrivalKey({ mode: "exact", time: "10:00" }), arrivalKey({ version: 1, mode: "exact", time: "10:00" }));
  assert.notEqual(arrivalKey({ mode: "exact", time: "10:00" }), arrivalKey({ mode: "before", time: "10:00" }));
  assert.notEqual(arrivalKey({ mode: "exact", time: "10:00" }), arrivalKey({ mode: "exact", time: "10:01" }));
});

test("Philippine date rollover: the Manila clock is fixed UTC+8", () => {
  assert.deepEqual(manilaClock(new Date(Date.UTC(2026, 9, 27, 15, 59))), { date: "2026-10-27", minute: 1439 });
  assert.deepEqual(manilaClock(new Date(Date.UTC(2026, 9, 27, 16, 0))), { date: "2026-10-28", minute: 0 });
  assert.deepEqual(manilaClock(new Date(Date.UTC(2026, 11, 31, 16, 30))), { date: "2027-01-01", minute: 30 });
});

test("the same business request gives the same result from browsers in different timezones", () => {
  const modulePath = fileURLToPath(new URL("../src/services/requestedArrival.js", import.meta.url));
  const script = `
    import(${JSON.stringify("file:///" + modulePath.replace(/\\/g, "/"))}).then((m) => {
      const now = new Date(Date.UTC(2026, 9, 27, 15, 59)); // 23:59 Manila
      const spec = { mode: "window", start: "00:00", end: "12:00" };
      process.stdout.write(JSON.stringify([
        m.manilaClock(now),
        m.normalizeRequestedArrival(spec, { requestedDeliveryDate: "2026-10-28", now }),
        m.normalizeRequestedArrival({ mode: "exact", time: "23:58" }, { requestedDeliveryDate: "2026-10-27", now }).code,
        m.requestedScheduleLabel("2026-10-28", spec),
        m.formatRequestedDate("2026-01-01"),
        new Date(0).getTimezoneOffset(),
      ]));
    });`;
  const runs = ["Asia/Manila", "America/Los_Angeles", "Pacific/Kiritimati", "UTC"].map((tz) => {
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  });
  // The host zones really differ (otherwise this test proves nothing)...
  assert.ok(new Set(runs.map((r) => r[5])).size > 1, "child processes ran in different timezones");
  // ...and every business result is identical.
  for (const r of runs) assert.deepEqual(r.slice(0, 5), runs[0].slice(0, 5));
  assert.equal(runs[0][3], "Oct 28, 2026 · Within 12:00 midnight–12:00 noon");
  assert.equal(runs[0][4], "Jan 1, 2026");
  assert.equal(runs[0][2], "requested-arrival-passed");
});

test("no local-time Date reading anywhere in the time logic", () => {
  for (const file of ["../src/services/requestedArrival.js", "../src/services/departurePlanner.js", "../functions/src/requestedArrival.js"]) {
    const code = require("node:fs").readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/\.(getHours|getMinutes|getDate|getDay|getMonth|getFullYear|setHours)\(/.test(code), false, file);
  }
});
