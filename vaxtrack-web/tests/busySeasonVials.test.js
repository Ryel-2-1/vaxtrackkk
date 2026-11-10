import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticsConfigPayload, configFormFrom, plainSeasonLine, seasonSummary } from "../src/services/inventoryAnalytics.js";

test("a monthly total round-trips without being interpreted as a percentage", () => {
  const form = { busyMonths: "5,6", busyMonthlyVials: "500" };
  const payload = analyticsConfigPayload("v", form);
  assert.deepEqual(payload, { ok: true, value: { vaccineId: "v", busyMonths: [5, 6], busyMonthlyVials: 500 } });
  assert.deepEqual(configFormFrom(payload.value), form);
  assert.equal(seasonSummary(payload.value), "Busy in May and Jun · 500 vials per month");
  assert.deepEqual(configFormFrom({ busyMonths: [5], busyIncreasePercent: 50 }), { busyMonths: "5", busyMonthlyVials: "" });
});

test("monthly vial settings reject incomplete, fractional and oversized values", () => {
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "100000001", "5e2"]) {
    assert.equal(analyticsConfigPayload("v", { busyMonths: "5", busyMonthlyVials: value }).ok, false, value);
  }
  assert.deepEqual(analyticsConfigPayload("v", { busyMonths: "", busyMonthlyVials: "500" }).value,
    { vaccineId: "v", busyMonths: [], busyMonthlyVials: 0 });
});

test("vial-based season explanations identify a total and partial-month treatment", () => {
  const line = plainSeasonLine({ seasonAdjustment: { source: "calendar", percent: 0, busyMonths: [5], monthlyVials: 500 } });
  assert.match(line, /500 vials in total per month in May/);
  assert.match(line, /Partial months/);
  assert.doesNotMatch(line, /%|additional|more/);
});
