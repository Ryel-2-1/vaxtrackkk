import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeRiderPerformance, riderExclusionNote } from "../src/services/riderPerformance.js";

// Nov 11, 2026 12:00 Manila.
const NOW = Date.parse("2026-11-11T12:00:00+08:00");
const at = (iso) => ({ toMillis: () => Date.parse(iso) });
const users = [
  { id: "r1", role: "rider", status: "approved", fullName: "Ana Rider" },
  { id: "r2", role: "rider", status: "approved", fullName: "Ben Rider" },
  { id: "r3", role: "rider", status: "disabled", fullName: "Old Rider" },
  { id: "r4", role: "rider", status: "pending_approval", fullName: "Applicant" },
  { id: "m1", role: "salesrep", status: "approved", fullName: "A Med Rep" },
];
const delivered = (id, rider, deliveredIso, extra = {}) => ({
  id, status: "delivered", assignedRiderId: rider, deliveredAt: at(deliveredIso),
  items: [{ quantity: 10 }], requestedDeliveryDate: "2026-11-10",
  firstDispatchedAt: at(new Date(Date.parse(deliveredIso) - 40 * 60000).toISOString()), ...extra,
});

test("riders are ranked by delivered orders in the range, credited by the rider on the order", () => {
  const orders = [
    delivered("o1", "r1", "2026-11-10T09:00:00+08:00"),
    delivered("o2", "r1", "2026-11-11T09:00:00+08:00"), // a day after the requested date: late
    delivered("o3", "r2", "2026-11-09T09:00:00+08:00", { items: [{ quantity: 4 }] }),
    delivered("o4", "r2", "2026-09-01T09:00:00+08:00"), // outside 30 days
    { id: "o5", status: "in_transit", assignedRiderId: "r2" }, // not delivered
    delivered("o6", "m1", "2026-11-10T09:00:00+08:00"), // not a rider: left out
    delivered("o7", "r4", "2026-11-10T09:00:00+08:00"), // a pending application: left out
    delivered("o1", "r1", "2026-11-10T09:00:00+08:00"), // the same order twice counts once
  ];
  const r = computeRiderPerformance({ orders, users, nowMs: NOW, rangeKey: "30" });
  assert.deepEqual(r.rows.map((x) => [x.name, x.rank, x.delivered, x.vials]), [
    ["Ana Rider", 1, 2, 20],
    ["Ben Rider", 2, 1, 4],
  ], "an inactive rider with nothing in range is not listed; a pending one never is");
  assert.equal(r.rows[0].onTimeRate, 0.5, "on time = by the requested Manila date");
  assert.equal(Math.round(r.rows[0].averageMinutes), 40, "dispatch → completion");
  assert.equal(r.leader.names[0], "Ana Rider");
  assert.deepEqual([r.totals.delivered, r.totals.vials], [3, 24]);
  assert.equal(r.exclusions.total, 2);
  assert.match(riderExclusionNote(r.exclusions), /^2 completed orders were left out/);

  const all = computeRiderPerformance({ orders, users, nowMs: NOW, rangeKey: "all" });
  assert.equal(all.rows.find((x) => x.name === "Ben Rider").delivered, 2);
});

test("an inactive rider appears only with deliveries in the range, and ties share a rank", () => {
  const orders = [
    delivered("a", "r1", "2026-11-10T09:00:00+08:00"),
    delivered("b", "r3", "2026-11-10T10:00:00+08:00"),
  ];
  const r = computeRiderPerformance({ orders, users, nowMs: NOW, rangeKey: "7" });
  const old = r.rows.find((x) => x.name === "Old Rider");
  assert.equal(old.accountStatus, "inactive");
  assert.equal(old.rank, 1);
  assert.equal(r.rows.find((x) => x.name === "Ana Rider").rank, 1);
  assert.equal(r.rows.find((x) => x.name === "Ben Rider").rank, 2);
  assert.equal(r.leader.names.length, 2);
  assert.equal(computeRiderPerformance({ orders: [], users, nowMs: NOW }).leader, null);
});

test("Analytics shows Rider Performance next to Med Rep Performance", () => {
  const page = readFileSync(new URL("../src/pages/admin/Analytics.jsx", import.meta.url), "utf8");
  assert.match(page, /<RiderPerformance\s+orders=\{allOrders\}/);
  assert.ok(page.indexOf("<MedRepPerformance") < page.indexOf("<RiderPerformance"));
});
