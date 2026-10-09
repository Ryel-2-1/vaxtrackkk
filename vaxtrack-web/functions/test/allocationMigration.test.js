const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { buildAllocationDiagnostic, formatAllocationDiagnostic } = require("../src/allocationMigration");

// The migration diagnostic is pure and read-only: it explains every held unit
// or reports that it cannot, and PROPOSES writes without performing any.

const batch = (over = {}) => ({
  vaccineId: "arv",
  vaccineName: "Anti-Rabies Vaccine",
  batchId: "ARV-001",
  quantity: 20,
  reservedQuantity: 0,
  ...over,
});

test("the '2 reserved' case: a v1 failed order still holding stock is found and explained", () => {
  const report = buildAllocationDiagnostic({
    inventory: [{ id: "invArv", data: batch({ reservedQuantity: 2 }) }],
    orders: [
      {
        id: "o1",
        data: {
          orderNumber: "VT-ORD-1",
          status: "delivery_failed",
          allocationVersion: 1,
          deliveryFailureReason: "Clinic closed",
          deliveryFailedByUid: "rider1",
        },
      },
    ],
    reservations: [
      { id: "o1", data: { status: "reserved", allocationVersion: 1, items: [{ inventoryId: "invArv", batchId: "ARV-001", quantity: 2 }] } },
    ],
  });

  // The counter reconciles exactly — it is not a counter bug.
  assert.equal(report.batches[0].reconciled, true);
  assert.equal(report.batches[0].explainedReserved, 2);

  const finding = report.findings.find((f) => f.kind === "v1-failed-order-still-reserved");
  assert.ok(finding);
  assert.equal(finding.units, 2);

  const proposal = report.proposals.find((p) => p.kind === "convert-v1-failure-to-return-pending");
  assert.equal(proposal.safe, false);
  assert.equal(proposal.requiresAdminReview, true);
  assert.deepEqual(proposal.writes[0], {
    collection: "inventory",
    doc: "invArv",
    increment: { reservedQuantity: -2, returnPendingQuantity: 2 },
  });
  assert.equal(proposal.writes.find((w) => w.collection === "inventoryReturns").create.status, "pending");
  assert.equal(report.summary.v1FailedStillReserved, 1);
});

test("a healthy v1 reservation only gets the safe index backfill", () => {
  const report = buildAllocationDiagnostic({
    inventory: [{ id: "b1", data: batch({ reservedQuantity: 5 }) }],
    orders: [{ id: "o1", data: { status: "assigned", allocationVersion: 1 } }],
    reservations: [{ id: "o1", data: { status: "reserved", allocationVersion: 1, items: [{ inventoryId: "b1", quantity: 5 }] } }],
  });
  assert.deepEqual(report.proposals.map((p) => [p.kind, p.safe]), [["index-v1-reservation", true]]);
  assert.deepEqual(report.proposals[0].write.merge, { inventoryIds: ["b1"] });
  assert.equal(report.batches[0].reconciled, true);
});

test("mismatches, leaks, unlinked batches and pre-reservation orders are reported, never fixed", () => {
  const report = buildAllocationDiagnostic({
    inventory: [
      { id: "b1", data: batch({ reservedQuantity: 9 }) }, // only 3 explained
      { id: "b2", data: batch({ vaccineId: undefined, quantity: "12" }) },
      { id: "b3", data: batch({ quantity: 500000000 }) },
    ],
    orders: [
      { id: "o1", data: { status: "pending_dispatch", allocationVersion: 2 } },
      { id: "o2", data: { status: "delivered", allocationVersion: 2, orderNumber: "VT-2" } },
      { id: "o3", data: { status: "in_transit", orderNumber: "VT-3" } },
    ],
    reservations: [
      { id: "o1", data: { status: "reserved", allocationVersion: 2, items: [{ inventoryId: "b1", quantity: 3 }], inventoryIds: ["b1"] } },
      { id: "o2", data: { status: "reserved", allocationVersion: 2, items: [{ inventoryId: "b1", quantity: 1 }], inventoryIds: ["b1"] } },
    ],
  });
  const b1 = report.batches.find((b) => b.inventoryId === "b1");
  assert.equal(b1.reconciled, false, "9 reserved, 4 explained (3 + the leaked 1)");
  assert.equal(b1.explainedReserved, 4);
  assert.ok(report.findings.some((f) => f.kind === "reservation-leak-on-terminal-order" && f.orderId === "o2"));
  assert.ok(report.findings.some((f) => f.kind === "order-without-allocation" && f.orderId === "o3"));
  const b2 = report.batches.find((b) => b.inventoryId === "b2");
  assert.ok(b2.problems.includes("quantity is not a whole number"));
  assert.ok(b2.problems.includes("no vaccineId — cannot be allocated per product"));
  assert.ok(report.batches.find((b) => b.inventoryId === "b3").problems.some((p) => p.startsWith("quantity is implausibly large")));
  // None of these produce a proposed write.
  assert.equal(report.proposals.length, 0);
  assert.match(formatAllocationDiagnostic(report), /DOES NOT RECONCILE/);
});

test("pending returns explain return-pending units", () => {
  const report = buildAllocationDiagnostic({
    inventory: [{ id: "b1", data: batch({ returnPendingQuantity: 4 }) }],
    returns: [{ id: "o9_1", data: { status: "pending", items: [{ inventoryId: "b1", quantity: 4 }] } }],
  });
  assert.equal(report.batches[0].reconciled, true);
});

test("the module and its runner can never write", () => {
  const src = readFileSync(join(__dirname, "..", "src", "allocationMigration.js"), "utf8");
  const runner = readFileSync(join(__dirname, "..", "scripts", "diagnoseAllocation.mjs"), "utf8");
  for (const code of [src, runner]) {
    const live = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // No Firebase SDK, no Firestore handle, no network. (Map.set is fine.)
    assert.doesNotMatch(live, /firebase-admin|firebase\/|initializeApp|getFirestore|\.collection\(|\.doc\(|runTransaction|writeBatch|fetch\(|https?:/);
  }
});

test("an open future order the paged queue cannot see is reported", () => {
  const report = buildAllocationDiagnostic({
    orders: [
      { id: "o1", data: { status: "pending_dispatch", allocationVersion: 2, allocationOpen: true, backorderedProductKeys: ["p"] } },
      { id: "o2", data: { status: "pending_dispatch", allocationVersion: 2, allocationOpen: true, backorderedProductKeys: ["p"], allocationPriorityKey: "1|k" } },
    ],
  });
  assert.deepEqual(report.findings.filter((f) => f.kind === "order-not-queueable").map((f) => f.orderId), ["o1"]);
  assert.equal(report.summary.ordersNotQueueable, 1);
  assert.equal(report.proposals.length, 0, "reported, never fixed");
});
