import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  analyzeOrders,
  assertStagingTarget,
  averageLatestTransit,
  classify,
  coordinateIssues,
  chronologyIssues,
  deliveriesMetrics,
  duplicateGroups,
  inventoryReconciliation,
  invoiceMetrics,
  proofKind,
  statusTypeOf,
} from "../scripts/stagingAuditAnalysis.mjs";

// The read-only staging audit. These pin that its figures follow the SAME rules
// as the Admin pages, that its classification never proposes deleting an order
// that still holds stock, and that the I/O script cannot write.

const H = 3600000;
const NOW = Date.UTC(2026, 9, 4, 4, 0, 0);
const at = (hoursAgo) => ({ toMillis: () => NOW - hoursAgo * H });

const base = (over = {}) => ({
  id: over.id || "o1",
  status: "pending_dispatch",
  createdAt: at(10),
  requestedDeliveryDate: "2026-10-05",
  clinicDocId: "c1",
  doctorId: "d1",
  doctorAddressId: "a1",
  clinicLat: 14.6,
  clinicLng: 121.0,
  createdByUid: "rep1",
  allocationVersion: 1,
  allocationStatus: "reserved",
  items: [{ inventoryId: "inv1", quantity: 5 }],
  ...over,
});

const refs = {
  clinics: new Set(["c1"]),
  doctors: new Set(["d1"]),
  addresses: new Set(["d1/a1"]),
  users: new Map([
    ["rep1", { uid: "rep1", role: "salesrep", status: "approved", name: "Rep" }],
    ["r1", { uid: "r1", role: "rider", status: "approved", name: "Rider" }],
  ]),
};

test("status mapping matches the Admin pages, legacy aliases included", () => {
  assert.equal(statusTypeOf({ status: "In Transit" }), "in_transit");
  assert.equal(statusTypeOf({ status: "completed" }), "delivered");
  assert.equal(statusTypeOf({ status: "canceled" }), "cancelled");
  assert.equal(statusTypeOf({ status: "pending" }), "unknown");
  assert.equal(statusTypeOf({ orderStatus: "delayed" }), "delayed");
  assert.equal(statusTypeOf({}), "unknown");
});

test("deliveries KPIs count the statuses the cards name", () => {
  const m = deliveriesMetrics([
    base({ id: "a", status: "pending_dispatch" }),
    base({ id: "b", status: "assigned" }),
    base({ id: "c", status: "loading" }),
    base({ id: "d", status: "in_transit" }),
    base({ id: "e", status: "delayed" }),
    base({ id: "f", status: "delivery_failed" }),
    base({ id: "g", status: "delivered" }),
    base({ id: "h", status: "cancelled" }),
  ]);
  assert.deepEqual(
    [m.totalDeliveries, m.inTransit, m.delayed, m.deliveryFailed, m.preparing],
    [8, 1, 1, 1, 3]
  );
});

test("average transit mirrors Analytics: delivered only, end > start, 30-day createdAt window", () => {
  const orders = [
    base({ id: "a", status: "delivered", createdAt: at(30), startedAt: at(26), deliveredAt: at(24) }), // 2h
    base({ id: "b", status: "delivered", createdAt: at(20), startedAt: at(10), deliveredAt: at(6) }), // 4h
    base({ id: "c", status: "delivered", createdAt: at(20), startedAt: at(5), deliveredAt: at(6) }), // end<start: excluded
    base({ id: "d", status: "in_transit", startedAt: at(5) }), // not delivered
    base({ id: "e", status: "delivered", createdAt: at(24 * 40), startedAt: at(24 * 40 - 1), deliveredAt: at(1) }), // outside 30d
  ];
  const r = averageLatestTransit(orders, { nowMs: NOW, days: 30 });
  assert.equal(r.legs.length, 2);
  assert.equal(r.formatted, "3h 0m");
});

test("pending invoices = every non-cancelled order without an issued/cancelled invoice", () => {
  const orders = [
    base({ id: "a", status: "pending_dispatch", priority: "Urgent" }),
    base({ id: "b", status: "delivered" }),
    base({ id: "c", status: "cancelled", priority: "Urgent" }),
    base({ id: "d", status: "delivered" }),
  ];
  const invoices = [{ id: "d", orderId: "d", invoiceStatus: "issued" }];
  const m = invoiceMetrics(orders, invoices);
  assert.equal(m.pendingInvoices, 2);
  assert.equal(m.highPriority, 1);
  assert.equal(m.totalIssued, 1);
  assert.deepEqual(m.pendingByOrderStatus, { pending_dispatch: 1, delivered: 1 });
});

test("coordinate checks catch missing, partial, nonnumeric, out of range and outside PH", () => {
  assert.deepEqual(coordinateIssues({}), ["missing-coordinates"]);
  assert.deepEqual(coordinateIssues({ clinicLat: 14.6 }), ["missing-one-coordinate"]);
  assert.deepEqual(coordinateIssues({ clinicLat: "14.6", clinicLng: 121 }), ["nonnumeric-coordinates"]);
  assert.deepEqual(coordinateIssues({ clinicLat: 95, clinicLng: 121 }), ["out-of-range-coordinates"]);
  assert.deepEqual(coordinateIssues({ clinicLat: 0, clinicLng: 0 }), ["null-island-coordinates"]);
  assert.deepEqual(coordinateIssues({ clinicLat: 35.6, clinicLng: 139.7 }), ["coordinates-outside-philippines"]);
  assert.deepEqual(coordinateIssues({ clinicLat: 14.6, clinicLng: 121.0 }), []);
});

test("chronology flags completion before transit start", () => {
  assert.ok(chronologyIssues({ startedAt: at(2), deliveredAt: at(3) }).includes("completed-before-transit-start"));
  assert.deepEqual(chronologyIssues({ createdAt: at(5), assignedAt: at(4), startedAt: at(3), deliveredAt: at(2) }), []);
});

test("an order still holding stock is never DELETE — it must be cancelled through the callable", () => {
  const [held] = analyzeOrders([base({ status: "in_transit", assignedRiderId: "r1", startedAt: at(100) })], {
    refs, invoices: [], alerts: [], nowMs: NOW,
  });
  assert.ok(held.issues.includes("abandoned-open-transit"));
  assert.equal(held.allocation.holdsInventory, true);
  assert.equal(held.classification.verdict, "REPAIR");

  const [released] = analyzeOrders(
    [base({ status: "cancelled", cancelledAt: at(1), allocationStatus: "released", clinicLat: undefined, clinicLng: undefined })],
    { refs, invoices: [], alerts: [], nowMs: NOW }
  );
  assert.equal(released.classification.verdict, "DELETE");
});

test("age alone is never a deletion signal", () => {
  const [old] = analyzeOrders(
    [base({ status: "delivered", createdAt: at(24 * 400), assignedRiderId: "r1", assignedAt: at(24 * 400 - 1), startedAt: at(24 * 400 - 2), deliveredAt: at(24 * 400 - 3), allocationStatus: "consumed" })],
    { refs, invoices: [], alerts: [], nowMs: NOW }
  );
  assert.equal(old.classification.verdict, "KEEP");
});

test("a broken allocation goes to manual review, not deletion", () => {
  const v = classify({ issues: ["missing-coordinates"], allocation: { holdsInventory: false, issues: ["allocation-reserved-but-order-delivered"] } });
  assert.equal(v.verdict, "REVIEW MANUALLY");
});

test("duplicates cluster identical orders created minutes apart and keep the earliest", () => {
  const groups = duplicateGroups([
    base({ id: "a", createdAt: at(10) }),
    base({ id: "b", createdAt: { toMillis: () => NOW - 10 * H + 60000 } }),
    base({ id: "c", createdAt: at(2) }),
  ]);
  assert.deepEqual(groups, [["a", "b"]]);
});

test("inventory reconciliation compares reservedQuantity with open reserved orders", () => {
  const r = inventoryReconciliation(
    [{ id: "inv1", quantity: 20, reservedQuantity: 8 }],
    [base({ id: "a" }), base({ id: "b", status: "delivered", allocationStatus: "consumed" })]
  );
  assert.equal(r.rows[0].expectedReserved, 5);
  assert.ok(r.rows[0].issues.includes("reserved-mismatch"));
});

test("proof references are reported by host kind only, never the URL", () => {
  assert.equal(proofKind("https://firebasestorage.googleapis.com/v0/b/x/o/y?token=secret"), "storage-object");
  assert.equal(proofKind("https://example.org/p.png"), "external-url");
  assert.equal(proofKind(""), null);
});

test("the target guard requires --project vaxtrack-staging AND a staging config", () => {
  assert.equal(assertStagingTarget({ argv: ["node", "x"], configuredProjectId: "vaxtrack-staging" }).ok, false);
  assert.equal(assertStagingTarget({ argv: ["node", "x", "--project", "vaxtrack-bef1b"], configuredProjectId: "vaxtrack-staging" }).ok, false);
  assert.equal(assertStagingTarget({ argv: ["node", "x", "--project", "vaxtrack-staging"], configuredProjectId: "vaxtrack-bef1b" }).ok, false);
  assert.equal(assertStagingTarget({ argv: ["node", "x", "--project", "vaxtrack-staging"], configuredProjectId: "vaxtrack-staging" }).ok, true);
});

test("the audit script cannot write to Firestore and never prints secrets", () => {
  const src = readFileSync(new URL("../scripts/auditStagingData.mjs", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  for (const w of ["setDoc", "updateDoc", "deleteDoc", "addDoc", "writeBatch", "runTransaction", "deleteField", "httpsCallable"]) {
    assert.ok(!code.includes(w), `must not use ${w}`);
  }
  assert.match(code, /import \{ initializeFirestore, collection, doc, getDoc, getDocs \} from "firebase\/firestore";/);
  assert.doesNotMatch(code, /console\.log\([^)]*password/i);
  assert.doesNotMatch(code, /proofOfDeliveryUrl|invoiceUrl|phone|email:/);
});
