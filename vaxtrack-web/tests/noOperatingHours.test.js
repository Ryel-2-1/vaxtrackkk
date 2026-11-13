import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { normalizeRequestedArrival } from "../src/services/requestedArrival.js";
import { planTrip, hubReturnOf } from "../src/services/timeAwareRouting.js";
const require = createRequire(import.meta.url);
const server = require("../functions/src/requestedArrival.js");
const now = new Date("2026-10-27T01:00:00Z"); // 09:00 Manila

// The 7 AM–4 PM pharmacy hours rule was removed completely on 2026-11-13.

test("browser and server accept any time of day, and agree", () => {
  for (const value of [
    { mode: "exact", time: "06:00" }, { mode: "exact", time: "16:01" }, { mode: "exact", time: "23:30" },
    { mode: "window", start: "05:00", end: "20:00" }, { mode: "before", time: "07:00" },
    { mode: "before", time: "21:00" }, { mode: "any_time" },
  ]) {
    const options = { requestedDeliveryDate: "2026-10-28", now };
    const web = normalizeRequestedArrival(value, options);
    assert.equal(web.ok, true, JSON.stringify(value));
    assert.deepEqual(server.normalizeRequestedArrival(value, options), web.value);
  }
});

test("a same-day any-time request is never 'already passed', even late in the evening", () => {
  const evening = new Date("2026-10-27T12:30:00Z"); // 20:30 Manila
  for (const value of [undefined, null, { mode: "any_time" }]) {
    assert.equal(normalizeRequestedArrival(value, { requestedDeliveryDate: "2026-10-27", now: evening }).ok, true);
    assert.equal(server.normalizeRequestedArrival(value, { requestedDeliveryDate: "2026-10-27", now: evening }).mode, "any_time");
  }
  // A time already gone by today is still refused (that is not an hours rule).
  assert.equal(normalizeRequestedArrival({ mode: "exact", time: "20:00" }, { requestedDeliveryDate: "2026-10-27", now: evening }).code, "requested-arrival-passed");
});

const trip = (extra = {}) => planTrip({
  planDate: "2026-10-28", slackMinutes: 0, hubReturnIndex: 0,
  stops: [{ id: "a", matrixIndex: 1, requestedDeliveryDate: "2026-10-28", serviceMinutes: 10 }],
  minutes: [[0, 30], [20, 0]], ...extra,
});

test("the hub return is an estimate with no 4 PM target or warning", () => {
  const late = trip({ stops: [{ id: "a", matrixIndex: 1, requestedDeliveryDate: "2026-10-28", requestedArrival: { mode: "exact", time: "18:30" }, serviceMinutes: 20 }], minutes: [[0, 30], [30, 0]] });
  assert.equal(late.allMet, true);
  assert.equal(late.plan.hubReturn.minute, 18 * 60 + 30 + 20 + 30);
  assert.equal(late.plan.hubReturn.status, "estimated");
  assert.equal(late.plan.hubReturn.warning, null);
  assert.ok(!late.plan.warnings.some((w) => /4:00 PM|operating hours|Hub hours/.test(w)));
  assert.equal(trip({ minutes: [[0, 30], [null, 0]] }).plan.hubReturn.status, "unknown");
  assert.equal(hubReturnOf({ evaluatedDeparture: 420, stops: [{ leave: null }] }, 20).status, "unknown");
  const live = trip({ hubReturnIndex: 2, minutes: [[0, 30, 40], [5, 0, 45], [40, 45, 0]] });
  assert.equal(live.plan.hubReturn.durationMinutes, 85);
});

test("no code or text mentions the old pharmacy hours", () => {
  assert.equal(existsSync(new URL("../src/services/pharmacyHours.js", import.meta.url)), false);
  assert.equal(existsSync(new URL("../functions/src/pharmacyHours.js", import.meta.url)), false);
  assert.equal(existsSync(new URL("../functions/src/pharmacyHoursDemo.json", import.meta.url)), false);
  const scan = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? scan(`${dir}${e.name}/`) : /\.(jsx?|cjs|mjs)$/.test(e.name) ? [`${dir}${e.name}`] : []);
  for (const file of [...scan("../src/"), ...scan("../functions/src/"), "../functions/index.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /pharmacyHours|PHARMACY_HOURS|enforceOperatingHours|operatingHours|pharmacy operating hours|4:00 PM target/i, file);
  }
});
