import test from "node:test";
import assert from "node:assert/strict";
import { dispatcherMonitoringStatus } from "../src/services/dispatcherMonitoringStatus.js";

const nowMs = 1_800_000_000_000;
const rider = (atMs) => ({ location: {
  latitude: 14.5, longitude: 121, capturedAt: atMs, updatedAt: atMs,
} });
const status = (view, fleet = [], extra = {}) => dispatcherMonitoringStatus({ view, fleet, nowMs, ...extra });

test("the dashboard never calls stale or absent Rider positions live", () => {
  assert.equal(status("loading").tone, "waiting");
  assert.equal(status("empty").tone, "idle");
  assert.equal(status("live", [rider(nowMs - 4 * 60_000)]).tone, "waiting");
  assert.equal(status("live", [rider(nowMs), rider(nowMs - 4 * 60_000)]).tone, "partial");
  assert.equal(status("live", [rider(nowMs)]).tone, "live");
  assert.equal(status("live", [rider(nowMs)], { deviationError: true }).tone, "partial");
  assert.equal(status("error").tone, "error");
  assert.equal(status("permission").tone, "error");
});
