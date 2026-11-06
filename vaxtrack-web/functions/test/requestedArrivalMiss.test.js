"use strict";

// Past requested arrival — the deadline and the decision (src/requestedArrival.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/requestedArrival");

const at = (text) => Date.parse(`${text}+08:00`);
const order = (over = {}) => ({
  status: "in_transit",
  requestedDeliveryDate: "2026-11-04",
  requestedArrival: { version: 1, mode: "window", start: "17:00", end: "19:00" },
  ...over,
});

test("the deadline is the minute after the last acceptable arrival, on the requested Manila date", () => {
  assert.equal(R.requestedArrivalDeadlineMs(order()), at("2026-11-04T19:01:00"), "a window's last minute still counts");
  assert.equal(R.requestedArrivalDeadlineMs(order({ requestedArrival: { mode: "before", time: "10:00" } })), at("2026-11-04T10:00:00"), "before is strict");
  assert.equal(R.requestedArrivalDeadlineMs(order({ requestedArrival: { mode: "exact", time: "10:00" } })), at("2026-11-04T10:01:00"));
  assert.equal(R.requestedArrivalDeadlineMs(order({ requestedArrival: undefined })), at("2026-11-05T00:00:00"), "any time runs to midnight");
  assert.equal(R.requestedArrivalDeadlineMs(order({ requestedDeliveryDate: undefined })), null);
  assert.equal(R.requestedArrivalDeadlineMs(order({ requestedDeliveryDate: "tomorrow" })), null);
});

test("before the deadline nothing happens; from the deadline the order is marked", () => {
  assert.equal(R.requestedArrivalDecision(order(), at("2026-11-04T19:00:59")), null);
  assert.deepEqual(R.requestedArrivalDecision(order(), at("2026-11-04T19:01:00")), {
    action: "mark", deadlineMs: at("2026-11-04T19:01:00"), firstMiss: true,
  });
});

test("every undelivered stage with a rider counts; finished and unassigned orders never do", () => {
  const late = at("2026-11-05T00:15:00");
  for (const status of ["assigned", "loading", "in_transit", "delayed"]) {
    assert.equal(R.requestedArrivalDecision(order({ status }), late)?.action, "mark", status);
  }
  for (const status of ["pending_dispatch", "delivered", "cancelled", "delivery_failed"]) {
    assert.equal(R.requestedArrivalDecision(order({ status }), late), null, status);
  }
});

test("a marked order stays quiet, follows a later deadline, and clears when rescheduled ahead", () => {
  const deadline = new Date(at("2026-11-04T19:01:00"));
  const marked = order({ requestedArrivalMissedAt: new Date(), requestedArrivalDeadlineAt: deadline });
  const late = at("2026-11-05T00:15:00");
  assert.equal(R.requestedArrivalDecision(marked, late), null, "already recorded");
  assert.deepEqual(R.requestedArrivalDecision({ ...marked, requestedDeliveryDate: "2026-11-03" }, late), {
    action: "mark", deadlineMs: at("2026-11-03T19:01:00"), firstMiss: false,
  });
  assert.deepEqual(R.requestedArrivalDecision({ ...marked, requestedDeliveryDate: "2026-11-06" }, late), { action: "clear" });
  assert.equal(R.requestedArrivalDecision({ ...marked, status: "delivered" }, late), null, "kept as a record");
});
