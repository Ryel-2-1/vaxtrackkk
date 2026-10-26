"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  buildCancellationCustodyDiagnostic,
  formatCancellationCustodyDiagnostic,
} = require("../src/cancellationCustodyDiagnostic");

const TS = { _seconds: 1760000000, _nanoseconds: 0 };
const res = (status, items, extra = {}) => ({ status, items, ...extra });

function fixture() {
  return {
    orders: [
      // The old bug: cancelled In Transit, reservation released.
      { id: "away", data: { orderNumber: "VT-AWAY", status: "cancelled", allocationVersion: 2, dispatchedAt: TS, startedAt: TS, loadedAt: TS, loadedByUid: "d1" } },
      // Confirmed as loaded, never dispatched, released.
      { id: "loaded", data: { orderNumber: "VT-LOADED", status: "cancelled", allocationVersion: 2, isLoaded: true } },
      // Released with nothing on record: counted, never cleared.
      { id: "hub", data: { orderNumber: "VT-HUB", status: "cancelled", allocationVersion: 2 } },
      // Settled correctly under the fixed behaviour.
      { id: "fixed", data: { orderNumber: "VT-FIXED", status: "cancelled", allocationVersion: 2, dispatchedAt: TS, allocationStatus: "returned", pendingReturnId: "fixed_cancel" } },
      // Cancelled but still reserved.
      { id: "leak", data: { orderNumber: "VT-LEAK", status: "cancelled", allocationVersion: 1 } },
      // Marked returned, return missing.
      { id: "orphan", data: { orderNumber: "VT-ORPHAN", status: "cancelled", allocationStatus: "returned", pendingReturnId: "orphan_cancel" } },
      // Not cancelled at all: ignored.
      { id: "live", data: { status: "in_transit", dispatchedAt: TS } },
    ],
    reservations: [
      { id: "away", data: res("released", [{ inventoryId: "b1", quantity: 5 }, { inventoryId: "b2", quantity: 3 }, { inventoryId: "b1", quantity: 1 }], { settlementType: "cancelled" }) },
      { id: "loaded", data: res("released", [{ inventoryId: "b1", quantity: 2 }]) },
      { id: "hub", data: res("released", [{ inventoryId: "b1", quantity: 4 }]) },
      { id: "fixed", data: res("returned", [{ inventoryId: "b1", quantity: 7 }]) },
      { id: "leak", data: res("reserved", [{ inventoryId: "b3", quantity: 9 }]) },
      { id: "live", data: res("reserved", [{ inventoryId: "b1", quantity: 1 }]) },
    ],
    returns: [
      { id: "fixed_cancel", data: { orderId: "fixed", source: "cancelled_after_dispatch", status: "pending" } },
      { id: "stray_cancel", data: { orderId: "live", source: "cancelled_after_dispatch", status: "pending" } },
    ],
  };
}

test("finds releases after dispatch and after loading, leaks and broken pairs — and proposes nothing", () => {
  const report = buildCancellationCustodyDiagnostic(fixture());
  assert.deepEqual(report.summary, {
    cancelledOrders: 6,
    releasedAfterDispatch: 1,
    releasedAfterDispatchUnits: 9,
    releasedAfterLoading: 1,
    releasedAfterLoadingUnits: 2,
    releasedWithoutEvidence: 1,
    leakedReservations: 1,
    brokenReturnPairs: 2,
  });
  const [away] = report.releasedAfterDispatch;
  assert.equal(away.orderId, "away");
  assert.deepEqual(away.units, [{ inventoryId: "b1", quantity: 6 }, { inventoryId: "b2", quantity: 3 }], "per-batch provenance, slices summed");
  assert.deepEqual(away.evidence, ["dispatchedAt", "startedAt", "loadedAt", "loadedByUid"]);
  assert.equal(report.releasedAfterLoading[0].orderId, "loaded");
  assert.deepEqual(report.releasedAfterLoading[0].evidence, ["isLoaded"]);
  assert.equal(report.leakedReservations[0].orderId, "leak");
  assert.deepEqual(report.brokenReturnPairs.map((b) => b.kind).sort(), ["cancellation-return-without-cancelled-order", "order-without-return"]);
  assert.deepEqual(report.proposedWrites, [], "never proposes a correction");
});

test("the text report states its limitations", () => {
  const text = formatCancellationCustodyDiagnostic(buildCancellationCustodyDiagnostic(fixture()));
  assert.match(text, /read-only — proposes no writes/);
  assert.match(text, /VT-AWAY \[away\] b1×6, b2×3/);
  assert.match(text, /not proof the vials stayed at the hub/);
  assert.match(text, /No stock is corrected here/);
});

test("empty or partial input is safe", () => {
  assert.equal(buildCancellationCustodyDiagnostic().summary.cancelledOrders, 0);
  assert.equal(buildCancellationCustodyDiagnostic({ orders: [{ id: "x", data: { status: "cancelled" } }] }).summary.releasedWithoutEvidence, 0);
});

test("the runner cannot contact a project: no Admin SDK, no credentials, no network", () => {
  const src = readFileSync(path.join(__dirname, "../scripts/diagnoseCancellationCustody.mjs"), "utf8");
  for (const forbidden of ["firebase-admin", "initializeApp", "GOOGLE_APPLICATION_CREDENTIALS", "fetch(", "http", "--apply"]) {
    assert.equal(src.includes(forbidden), false, forbidden);
  }
});
