"use strict";

// Pure date/time validation for rescheduleOrderDelivery. The emulator suite
// (integration/scheduleOperations.test.js) proves the transaction itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeScheduleDate, normalizeScheduleTime } = require("../src/scheduleOperations");

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return e.code; }
};

test("times are HH:MM, 00:00–23:59, or absent", () => {
  for (const ok of ["00:00", "09:30", "23:59"]) assert.equal(normalizeScheduleTime(ok), ok);
  for (const none of [undefined, null, ""]) assert.equal(normalizeScheduleTime(none), null);
  for (const bad of ["24:00", "9:30", "09:60", "0930", "noon", 930, "09:30:00"]) {
    assert.equal(codeOf(() => normalizeScheduleTime(bad)), "invalid-schedule-time", String(bad));
  }
});

test("dates are real calendar days, today in Manila or later", () => {
  const now = new Date("2026-10-05T02:00:00Z"); // 10:00, Oct 5 in Manila
  assert.equal(normalizeScheduleDate("2026-10-05", now), "2026-10-05");
  assert.equal(normalizeScheduleDate("2027-01-01", now), "2027-01-01");
  assert.equal(codeOf(() => normalizeScheduleDate("2026-10-04", now)), "schedule-date-in-past");
  for (const bad of ["2026-02-31", "2026-13-01", "10/05/2026", "", null, 20261005]) {
    assert.equal(codeOf(() => normalizeScheduleDate(bad, now)), "invalid-schedule-date", String(bad));
  }
});

test("'today' is the Manila calendar day, not the UTC one", () => {
  // 16:30 UTC on Oct 4 is already 00:30 on Oct 5 in Manila.
  const justAfterManilaMidnight = new Date("2026-10-04T16:30:00Z");
  assert.equal(codeOf(() => normalizeScheduleDate("2026-10-04", justAfterManilaMidnight)), "schedule-date-in-past");
  assert.equal(normalizeScheduleDate("2026-10-05", justAfterManilaMidnight), "2026-10-05");
  // 15:59 UTC on Oct 4 is still Oct 4 in Manila.
  assert.equal(normalizeScheduleDate("2026-10-04", new Date("2026-10-04T15:59:00Z")), "2026-10-04");
});
