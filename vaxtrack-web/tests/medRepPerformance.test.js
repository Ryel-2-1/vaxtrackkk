import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_PERFORMANCE_MESSAGE,
  computeMedRepPerformance,
  exclusionNote,
  manilaDayStartMs,
  orderVials,
  performanceRange,
} from "../src/services/medRepPerformance.js";

// Admin → Analytics → Med Rep Performance. The aggregation is pure, so these
// tests drive it directly; the page is checked by source contract, matching the
// other Admin suites (no jsdom in this repo).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) => read(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const H = 3600 * 1000;
const D = 24 * H;
// 2026-10-04 14:00 in Manila.
const NOW = Date.UTC(2026, 9, 4, 6, 0, 0);
const ago = (days, hours = 0) => NOW - days * D - hours * H;

const users = [
  { id: "ana", role: "salesrep", status: "approved", fullName: "Ana Reyes", assignedAreaIds: ["laguna"], assignedClinicIds: ["c1"] },
  { id: "ben", role: "salesrep", status: "approved", fullName: "Ben Cruz" },
  { id: "cora", role: "salesrep", status: "approved", fullName: "Cora Lim" },
  { id: "dan", role: "salesrep", status: "disabled", fullName: "Dan Tan" },
  { id: "eve", role: "salesrep", status: "disabled", fullName: "Eve Uy" }, // inactive, no history
  { id: "pat", role: "salesrep", status: "pending", fullName: "Pat Pending" },
  { id: "rex", role: "salesrep", status: "rejected", fullName: "Rex Rejected" },
  { id: "disp", role: "dispatcher", status: "approved", fullName: "Dispatcher" },
  { id: "rid", role: "rider", status: "approved", fullName: "Rider" },
  { id: "adm", role: "admin", status: "approved", fullName: "Admin" },
];

let n = 0;
const order = (over) => ({
  id: over.id ?? `o${++n}`,
  status: "delivered",
  createdByUid: "ana",
  createdAt: ago(3),
  deliveredAt: ago(2),
  items: [{ inventoryId: "b", quantity: 5 }],
  ...over,
});
const run = (orders, rangeKey = "30") => computeMedRepPerformance({ orders, users, nowMs: NOW, rangeKey });
const row = (r, uid) => r.rows.find((x) => x.uid === uid);

test("1 · delivered and legacy completed orders count", () => {
  const r = run([order({}), order({ status: "completed" }), order({ status: " Delivered " })]);
  assert.equal(row(r, "ana").delivered, 3);
});

test("2/3/4 · open, delayed, cancelled and unrecovered failed orders never count", () => {
  const statuses = ["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "cancelled", "canceled", "delivery_failed", "mystery", ""];
  const r = run(statuses.map((status) => order({ status, deliveredAt: ago(1) })));
  assert.equal(row(r, "ana").delivered, 0);
  assert.equal(r.totals.delivered, 0);
});

test("5 · a delivery that failed, was retried and completed counts once", () => {
  const recovered = order({ id: "rec", status: "delivered", deliveryFailedAt: ago(4), deliveryFailureReason: "Clinic closed", deliveredAt: ago(1) });
  // The same document arriving twice (e.g. two snapshots merged) is one order.
  const r = run([recovered, { ...recovered }]);
  assert.equal(row(r, "ana").delivered, 1);
});

test("6 · orders without a valid Med Rep uid are excluded and reported", () => {
  const r = run([
    order({ createdByUid: undefined }),
    order({ createdByUid: "SALESREP" }), // placeholder that names no account
    order({ createdByUid: "disp" }), // not a Med Rep
    order({ createdByUid: "Ana Reyes" }), // a name is never an identity
  ]);
  assert.equal(r.totals.delivered, 0);
  assert.equal(r.exclusions.missingMedRep, 4);
});

test("7 · orders without a completion timestamp are excluded and reported", () => {
  const r = run([order({ deliveredAt: undefined }), order({ deliveredAt: "2026-10-01" }), order({ deliveredAt: NaN })]);
  assert.equal(row(r, "ana").delivered, 0);
  assert.equal(r.exclusions.missingCompletion, 3);
});

test("8 · the range filters on completion time, not creation time", () => {
  const r = run([
    order({ createdAt: ago(200), deliveredAt: ago(1) }), // old order, delivered recently → counts
    order({ createdAt: ago(1), deliveredAt: ago(40) }), // recent order, delivered long ago → not in 30 days
  ]);
  assert.equal(row(r, "ana").delivered, 1);
  assert.equal(run([order({ deliveredAt: ago(40) })], "all").rows.find((x) => x.uid === "ana").delivered, 1);
});

test("9 · ranges start at 00:00 Asia/Manila", () => {
  const range = performanceRange("7", NOW);
  // Today (Oct 4) plus the six Manila days before it: from Sep 28 00:00 Manila.
  assert.equal(range.startMs, Date.UTC(2026, 8, 27, 16, 0, 0));
  assert.equal(range.startDate, "2026-09-28");
  assert.equal(range.endDate, "2026-10-04");
  assert.equal(manilaDayStartMs(Date.UTC(2026, 9, 3, 16, 30)), Date.UTC(2026, 9, 3, 16, 0)); // 00:30 Oct 4 Manila
  const r = run([
    order({ deliveredAt: Date.UTC(2026, 8, 27, 15, 59, 59) }), // Sep 27 23:59:59 Manila → out
    order({ deliveredAt: Date.UTC(2026, 8, 27, 16, 0, 0) }), // Sep 28 00:00:00 Manila → in
  ], "7");
  assert.equal(row(r, "ana").delivered, 1);
});

test("10/11 · vials come only from counted deliveries, and malformed quantities never make NaN", () => {
  assert.equal(orderVials({ items: [{ quantity: 2 }, { quantity: "5" }, { quantity: NaN }, { quantity: -3 }, {}, null] }), 2);
  assert.equal(orderVials({ quantity: 7 }), 7);
  assert.equal(orderVials({ quantity: "lots" }), 0);
  assert.equal(orderVials({}), 0);
  const r = run([
    order({ items: [{ quantity: 4 }, { quantity: 6 }] }),
    order({ items: [{ quantity: "x" }] }),
    order({ status: "in_transit", items: [{ quantity: 100 }] }), // not delivered → not in vials
    order({ status: "cancelled", items: [{ quantity: 100 }] }),
  ]);
  assert.equal(row(r, "ana").vials, 10);
  assert.equal(r.totals.vials, 10);
  assert.ok(Number.isFinite(r.totals.vials));
});

test("12/13/14 · who appears: active always, inactive only with period history, never pending/rejected/other roles", () => {
  const r = run([order({ createdByUid: "dan" })]);
  const ids = r.rows.map((x) => x.uid).sort();
  assert.deepEqual(ids, ["ana", "ben", "cora", "dan"]);
  assert.equal(row(r, "ben").delivered, 0);
  assert.equal(row(r, "dan").accountStatus, "inactive");
  // A pending or rejected creator's delivery is not ranked; it is reported.
  const r2 = run([order({ createdByUid: "pat" }), order({ createdByUid: "rex" })]);
  assert.equal(r2.rows.some((x) => ["pat", "rex"].includes(x.uid)), false);
  assert.equal(r2.exclusions.ineligibleAccount, 2);
});

test("15 · dense ranking: delivered ↓, vials ↓, then name; full ties share a rank", () => {
  const r = run([
    order({ createdByUid: "ana", items: [{ quantity: 5 }] }),
    order({ createdByUid: "ana", items: [{ quantity: 5 }] }),
    order({ createdByUid: "cora", items: [{ quantity: 3 }] }),
    order({ createdByUid: "cora", items: [{ quantity: 7 }] }),
    order({ createdByUid: "ben", items: [{ quantity: 50 }] }),
  ]);
  assert.deepEqual(r.rows.map((x) => [x.uid, x.rank]), [["ana", 1], ["cora", 1], ["ben", 2]]);
  assert.deepEqual(r.leader.names, ["Ana Reyes", "Cora Lim"]);

  const tieBreak = run([order({ createdByUid: "ana", items: [{ quantity: 1 }] }), order({ createdByUid: "cora", items: [{ quantity: 9 }] })]);
  assert.deepEqual(tieBreak.rows.map((x) => [x.uid, x.rank]), [["cora", 1], ["ana", 2], ["ben", 3]]);
});

test("12 · with no deliveries everyone shows zero and no top performer is claimed", () => {
  const r = run([]);
  assert.deepEqual(r.rows.map((x) => [x.uid, x.delivered, x.rank]), [["ana", 0, 1], ["ben", 0, 1], ["cora", 0, 1]]);
  assert.equal(r.leader, null);
  assert.equal(EMPTY_PERFORMANCE_MESSAGE, "No completed Med Rep deliveries were recorded for this period.");
});

test("16 · legacy exclusions are summarised for the Admin note", () => {
  const r = run([order({ createdByUid: "SALESREP" }), order({ deliveredAt: undefined }), order({ createdByUid: "pat" })]);
  assert.equal(r.exclusions.total, 3);
  assert.equal(exclusionNote(r.exclusions), "3 completed orders were excluded because their Med Rep or completion record could not be verified.");
  assert.equal(exclusionNote({ total: 1 }), "1 completed order was excluded because its Med Rep or completion record could not be verified.");
  assert.equal(exclusionNote({ total: 0 }), "");
});

test("supporting data: orders placed (by creation time), last delivery, territory", () => {
  const r = run([
    order({ status: "pending_dispatch", createdAt: ago(1), deliveredAt: null }),
    order({ deliveredAt: ago(5) }),
    order({ deliveredAt: ago(2) }),
  ]);
  const ana = row(r, "ana");
  assert.equal(ana.ordersPlaced, 3);
  assert.equal(ana.lastDeliveredMs, ago(2));
  assert.deepEqual(ana.territory.areaIds, ["laguna"]);
});

test("money never affects the ranking", () => {
  const pricey = order({ createdByUid: "ben", subtotalCentavos: 99999999, invoiceStatus: "issued" });
  const r = run([pricey, order({ createdByUid: "ana" }), order({ createdByUid: "ana" })]);
  assert.equal(r.rows[0].uid, "ana");
});

// ---------------------------------------------------------------- page contract

test("17 · one users and one areas listener for the whole table; orders are reused", () => {
  const page = code("src/pages/admin/MedRepPerformance.jsx");
  assert.equal(page.split("subscribeUsers(").length - 1, 1);
  assert.equal(page.split("subscribeAreas(").length - 1, 1);
  assert.doesNotMatch(page, /onSnapshot|subscribeDeliveries|subscribeOwnProfile|getDoc/);
  // Listeners are created once (empty deps) and cleaned up.
  assert.match(page, /return \(\) => \{\s*unsubUsers\(\);\s*unsubAreas\(\);\s*\};\s*\}, \[\]\);/);
  // Read-only: no write or edit controls.
  assert.doesNotMatch(page, /updateDoc|setDoc|deleteDoc|<input|<form/);
  // Low ranks are not painted as errors: red (danger) appears only in the
  // error-state rule, never on the table, ranks or badges.
  const css = read("src/pages/admin/MedRepPerformance.css");
  const dangerRules = [...css.matchAll(/([^{}]+)\{[^}]*danger[^}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(dangerRules, [".mrp-error"]);
});

test("18 · Admin Analytics keeps its existing data and adds the section", () => {
  const analytics = code("src/pages/admin/Analytics.jsx");
  assert.equal(analytics.split("subscribeDeliveries(").length - 1, 1, "still one orders subscription");
  assert.match(analytics, /subscribeAllAlerts\(/);
  assert.match(analytics, /<MedRepPerformance\s+orders=\{allOrders\}\s+ordersLoading=\{loading\}\s+ordersError=\{loadError\}\s+nowMs=\{nowMs\}\s*\/>/);
  for (const kept of ["analytics-kpi-grid", "analytics-volume-card", "analytics-heatmap-card", "AnalyticsModal"]) {
    assert.ok(analytics.includes(kept), kept);
  }
});
