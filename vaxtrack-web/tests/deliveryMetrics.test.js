import test from "node:test";
import assert from "node:assert/strict";
import {
  averageDeliveryTime,
  formatDuration,
  formatRate,
  onTimeStats,
} from "../src/services/deliveryMetrics.js";

// Delivery performance from the order history: full delivery time and on-time.

const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

test("average delivery time spans first dispatch → delivered, delays included", () => {
  const r = averageDeliveryTime([
    // Dispatched 08:00, delayed, resumed (startedAt re-stamped 11:00), delivered 12:00 → 4h, not 1h.
    { statusKey: "delivered", firstDispatchedAt: ts("2026-10-04T00:00:00Z"), startedAt: ts("2026-10-04T03:00:00Z"), deliveredAt: ts("2026-10-04T04:00:00Z") },
    { statusKey: "completed", firstDispatchedAt: ts("2026-10-04T00:00:00Z"), deliveredAt: ts("2026-10-04T02:00:00Z") },
  ]);
  assert.equal(r.count, 2);
  assert.equal(formatDuration(r.averageMinutes), "3h 0m");
});

test("orders without a recorded first dispatch are not measured, never back-filled", () => {
  const r = averageDeliveryTime([
    { statusKey: "delivered", startedAt: ts("2026-10-04T00:00:00Z"), deliveredAt: ts("2026-10-04T05:00:00Z") },
    { statusKey: "in_transit", firstDispatchedAt: ts("2026-10-04T00:00:00Z") },
    { statusKey: "delivered", firstDispatchedAt: ts("2026-10-04T05:00:00Z"), deliveredAt: ts("2026-10-04T04:00:00Z") },
  ]);
  assert.deepEqual(r, { averageMinutes: null, count: 0 });
  assert.equal(formatDuration(r.averageMinutes), "—");
});

test("on time means delivered on or before the requested MANILA date", () => {
  const s = onTimeStats([
    // 23:30 Manila on Oct 4 (15:30Z) → Oct 4: on time for Oct 4.
    { statusKey: "delivered", requestedDeliveryDate: "2026-10-04", deliveredAt: ts("2026-10-04T15:30:00Z") },
    // 00:30 Manila on Oct 5 (16:30Z Oct 4) → Oct 5: late for Oct 4, though still Oct 4 in UTC.
    { statusKey: "delivered", requestedDeliveryDate: "2026-10-04", deliveredAt: ts("2026-10-04T16:30:00Z") },
    // Early is on time.
    { statusKey: "delivered", requestedDeliveryDate: "2026-10-06", deliveredAt: ts("2026-10-04T02:00:00Z") },
    // Not measurable: no date, a malformed date, not delivered.
    { statusKey: "delivered", deliveredAt: ts("2026-10-04T02:00:00Z") },
    { statusKey: "delivered", requestedDeliveryDate: "2026-02-31", deliveredAt: ts("2026-10-04T02:00:00Z") },
    { statusKey: "in_transit", requestedDeliveryDate: "2026-10-04" },
  ]);
  assert.deepEqual(s, { measured: 3, onTime: 2, late: 1, rate: 2 / 3 });
  assert.equal(formatRate(s.rate), "67%");
  assert.equal(formatRate(onTimeStats([]).rate), "—");
});
