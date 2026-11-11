import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { normalizeRequestedArrival, arrivalKey, orderArrivalNote } from "../src/services/requestedArrival.js";
import { PHARMACY_HOURS, pharmacyHoursFor, hubReturnOf, dispatchHoursWarning } from "../src/services/pharmacyHours.js";
import { planTrip } from "../src/services/timeAwareRouting.js";
import { validateCheckoutSchedule } from "../src/services/checkoutSchedule.js";
const require = createRequire(import.meta.url);
const server = require("../functions/src/requestedArrival.js");
const now = new Date("2026-10-27T01:00:00Z");

test("browser and server enforce 7 AM–4 PM every day, at minute boundaries", () => {
  assert.deepEqual(PHARMACY_HOURS, require("../functions/src/pharmacyHours.js").PHARMACY_HOURS);
  for (const requestedDeliveryDate of ["2026-10-31", "2026-11-01", "2026-11-02"]) {
    for (const [value, accepted] of [
      [{ mode: "exact", time: "06:59" }, false], [{ mode: "exact", time: "07:00" }, true],
      [{ mode: "exact", time: "16:00" }, true], [{ mode: "exact", time: "16:01" }, false],
      [{ mode: "window", start: "07:00", end: "16:00" }, true],
      [{ mode: "window", start: "06:59", end: "16:00" }, false],
      [{ mode: "window", start: "07:00", end: "16:01" }, false],
      [{ mode: "before", time: "07:00" }, false], [{ mode: "before", time: "07:01" }, true],
      [{ mode: "before", time: "16:00" }, true], [{ mode: "before", time: "17:00" }, false],
      [{ mode: "any_time" }, true],
    ]) {
      const options = { requestedDeliveryDate, now };
      const web = normalizeRequestedArrival(value, options);
      let trusted;
      try { trusted = { ok: true, value: server.normalizeRequestedArrival(value, options) }; }
      catch (error) { trusted = { ok: false, code: error.code, message: error.message }; }
      assert.equal(web.ok, accepted, JSON.stringify(value));
      assert.equal(trusted.ok, web.ok);
      if (web.ok) assert.deepEqual(trusted.value, web.value);
      else assert.deepEqual([trusted.code, trusted.message], [web.code, web.message]);
    }
  }
});

test("a same-day any-time request ends at closing; old retries retain their schedule", () => {
  const afterClose = new Date("2026-10-27T08:01:00Z");
  for (const value of [undefined, null, { mode: "any_time" }]) {
    assert.equal(normalizeRequestedArrival(value, { requestedDeliveryDate: "2026-10-27", now: afterClose }).code, "requested-arrival-passed");
  }
  const legacy = { mode: "exact", time: "18:00" };
  assert.equal(arrivalKey(legacy), "exact:18:00");
  assert.match(orderArrivalNote({ requestedDeliveryDate: "2026-10-27", requestedArrival: legacy }), /6:00 PM/);
  assert.equal(validateCheckoutSchedule({ requestedDeliveryDate: "2026-10-27", requestedArrival: legacy, recovering: true, now: afterClose }).arrival.ok, true);
});

const trip = (extra = {}) => planTrip({
  planDate: "2026-10-28", operatingHours: PHARMACY_HOURS, slackMinutes: 0,
  stops: [{ id: "a", matrixIndex: 1, requestedDeliveryDate: "2026-10-28", serviceMinutes: 10 }],
  minutes: [[0, 30], [20, 0]], ...extra,
});

test("plans leave no earlier than opening and include the final service and return leg", () => {
  const result = trip();
  assert.equal(result.plan.evaluatedDeparture, 420);
  assert.equal(result.plan.stops[0].arrival, 450);
  assert.deepEqual(result.plan.hubReturn, { minute: 480, durationMinutes: 60, status: "on_time", warning: null });
  assert.equal(result.allMet, true);
});

test("a late hub return warns without mislabelling an arrival or blocking dispatch", () => {
  const result = trip({ stops: [{ id: "a", matrixIndex: 1, requestedDeliveryDate: "2026-10-28", requestedArrival: { mode: "exact", time: "15:30" }, serviceMinutes: 20 }], minutes: [[0, 30], [30, 0]] });
  assert.equal(result.allMet, true);
  assert.equal(result.plan.hubReturn.minute, 980);
  assert.equal(result.plan.hubReturn.status, "late");
  assert.ok(result.plan.warnings.includes(result.plan.hubReturn.warning));
  assert.match(dispatchHoursWarning({ durationMinutes: 80, plannedDeparture: 900 }, new Date("2026-10-28T07:00:00Z")), /after 4:00 PM/);
});

test("unknown return travel or final service stays unknown; live replanning uses the actual hub", () => {
  assert.equal(trip({ minutes: [[0, 30], [null, 0]] }).plan.hubReturn.status, "unknown");
  assert.equal(hubReturnOf({ evaluatedDeparture: 420, stops: [{ leave: null }] }, 20).status, "unknown");
  const result = trip({ hubReturnIndex: 2, minutes: [[0, 30, 40], [5, 0, 45], [40, 45, 0]] });
  assert.equal(result.plan.hubReturn.durationMinutes, 85);
  assert.match(dispatchHoursWarning(null, now), /unknown/);
  assert.match(dispatchHoursWarning({ durationMinutes: 0 }, new Date("2026-10-28T08:01:00Z")), /outside pharmacy/);
});

test("the staging demo lifts the hours cutoff while retaining time and date checks and return estimates", () => {
  const { pharmacyHoursEnforced } = require("../functions/src/pharmacyHours.js");
  const { relaxedProjectIds } = require("../functions/src/pharmacyHoursDemo.json");
  for (const projectId of ["vaxtrack-staging", "vaxtrack-bef1b", "unknown", undefined]) {
    const expected = projectId === "vaxtrack-bef1b" || !relaxedProjectIds.includes(projectId);
    assert.equal(Boolean(pharmacyHoursFor(projectId)), expected);
    assert.equal(pharmacyHoursEnforced(projectId), expected);
  }
  const operatingHours = null;
  const options = { requestedDeliveryDate: "2026-10-28", now, enforceOperatingHours: Boolean(operatingHours) };
  for (const arrival of [{ mode: "exact", time: "06:45" }, { mode: "window", start: "16:30", end: "18:00" }]) {
    const web = normalizeRequestedArrival(arrival, options);
    assert.equal(web.ok, true);
    assert.deepEqual(server.normalizeRequestedArrival(arrival, options), web.value);
  }
  const result = trip({ operatingHours, hubReturnIndex: 0, fixedDeparture: 1020 });
  assert.equal(result.allMet, true);
  assert.deepEqual(result.plan.hubReturn, { minute: 1080, durationMinutes: 60, status: "estimated", warning: null });
  assert.equal(dispatchHoursWarning(result.plan.hubReturn, new Date("2026-10-28T09:00:00Z"), operatingHours), null);
});
