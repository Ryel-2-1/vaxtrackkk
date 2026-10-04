import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCleanupPlan, releaseByBatch, verifyPlanAgainstLive } from "../scripts/stagingCleanupPlan.mjs";

// The staging cleanup plan: exact ids only, cancel-before-delete for anything
// holding stock, never orphan an invoice, and refuse on any drift.

const finding = (over) => ({
  id: over.id,
  orderNumber: over.id,
  status: over.status,
  allocation: {
    legacy: over.legacy ?? false,
    state: over.state ?? "reserved",
    holdsInventory: over.holds ?? false,
    items: over.items ?? [],
    issues: [],
  },
  alertIds: over.alertIds ?? [],
  invoice: over.invoice ?? null,
  tripId: null,
  classification: { verdict: over.verdict, reason: "x" },
});

const report = {
  orders: [
    finding({ id: "held", status: "in_transit", verdict: "REPAIR", holds: true, items: [{ inventoryId: "b1", quantity: 4 }] }),
    finding({ id: "gone", status: "delivered", verdict: "DELETE", state: "consumed", alertIds: ["al1"] }),
    finding({ id: "legacy", status: "cancelled", verdict: "DELETE", legacy: true, state: "legacy-unallocated" }),
    finding({ id: "invoiced", status: "cancelled", verdict: "DELETE", legacy: true, invoice: { id: "invoiced" } }),
    finding({ id: "kept", status: "assigned", verdict: "KEEP", holds: true, items: [{ inventoryId: "b1", quantity: 2 }] }),
  ],
};
const noDecisions = { overrides: {}, reviewToCancelAndDelete: [], reviewToDelete: [] };

test("stock holders are cancelled first, and an invoiced order is never silently deleted", () => {
  const plan = buildCleanupPlan(report, noDecisions);
  assert.deepEqual(plan.cancelFirst.map((e) => e.id), ["held"]);
  assert.deepEqual(plan.deleteOnly.map((e) => e.id), ["gone", "legacy"]);
  assert.deepEqual(plan.unresolved.map((e) => e.id), ["invoiced"]);
  assert.deepEqual(plan.deletePaths.orders, ["orders/held", "orders/gone", "orders/legacy"]);
  // Legacy orders never had a reservation; server-created ones always do.
  assert.deepEqual(plan.deletePaths.inventoryReservations, ["inventoryReservations/held", "inventoryReservations/gone"]);
  assert.deepEqual(plan.deletePaths.alerts, ["alerts/al1"]);
  assert.deepEqual(releaseByBatch(plan), { b1: 4 });
});

test("an explicit override moves a record out of the deletion set", () => {
  const plan = buildCleanupPlan(report, {
    ...noDecisions,
    overrides: { invoiced: { verdict: "KEEP", reason: "issued invoice" } },
  });
  assert.equal(plan.unresolved.length, 0);
  assert.ok(plan.keep.some((e) => e.id === "invoiced" && e.reason === "issued invoice"));
});

const live = (over = {}) => ({
  orders: [
    { id: "held", status: "in_transit", allocationVersion: 1, allocationStatus: "reserved", items: [{ inventoryId: "b1", quantity: 4 }] },
    { id: "gone", status: "delivered", allocationVersion: 1, allocationStatus: "consumed" },
    { id: "legacy", status: "cancelled" },
    { id: "kept", status: "assigned", allocationVersion: 1, allocationStatus: "reserved", items: [{ inventoryId: "b1", quantity: 2 }] },
  ],
  inventory: [{ id: "b1", quantity: 50, reservedQuantity: 6 }],
  alerts: [{ id: "al1", orderId: "gone" }],
  invoices: [],
  ...over,
});
const planFor = () => buildCleanupPlan({ orders: report.orders.filter((o) => o.id !== "invoiced") }, noDecisions);

test("the dry run passes when live data matches the audit", () => {
  assert.deepEqual(verifyPlanAgainstLive(planFor(), live()), []);
});

test("the dry run refuses on drift, stock shortfall or a new related record", () => {
  const drift = live();
  drift.orders[0] = { ...drift.orders[0], status: "delivered", allocationStatus: "consumed" };
  assert.ok(verifyPlanAgainstLive(planFor(), drift).some((p) => p.includes("status changed")));

  assert.ok(
    verifyPlanAgainstLive(planFor(), live({ inventory: [{ id: "b1", quantity: 50, reservedQuantity: 3 }] }))
      .some((p) => p.includes("does not cover"))
  );
  assert.ok(
    verifyPlanAgainstLive(planFor(), live({ invoices: [{ id: "i9", orderId: "gone" }] }))
      .some((p) => p.includes("would be orphaned"))
  );
  assert.ok(
    verifyPlanAgainstLive(planFor(), live({ alerts: [{ id: "al1", orderId: "gone" }, { id: "al2", orderId: "held" }] }))
      .some((p) => p.includes("al2"))
  );
});

test("the cleanup script is dry-run only, staging-guarded, and cannot write", () => {
  const src = readFileSync(new URL("../scripts/cleanupStagingData.mjs", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  for (const w of ["setDoc", "updateDoc", "deleteDoc", "addDoc", "writeBatch", "runTransaction", "httpsCallable", "child_process", "execSync", "spawn"]) {
    assert.ok(!code.includes(w), `must not use ${w}`);
  }
  assert.match(code, /assertStagingTarget\(/);
  assert.match(code, /--execute is disabled/);
  assert.match(code, /Pass --dry-run explicitly/);
});
