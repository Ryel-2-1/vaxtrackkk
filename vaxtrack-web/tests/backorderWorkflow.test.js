import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALLOCATION_STATE_LABELS,
  FUTURE_ORDER_LABEL,
  assignmentBlockReason,
  describeAllocation,
  estimateBackorders,
} from "../src/services/backorder.js";
import { buildConfirmationFromOrder } from "../src/services/orderConfirmation.js";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

// Future-order (backorder) workflow — the WEB half.
//
// The allocation itself is server-only and is executed in
// functions/test/allocation.test.js (pure planner) and
// functions/test/integration/allocation.test.js (emulator transactions). This
// file covers what the three web roles SEE and what the client refuses to do:
//   - Med Rep: requested / reserved / backordered, worded without a date promise
//   - Admin: provenance and returns surfaced from server data only
//   - Dispatcher: an incompletely reserved order cannot be assigned (UI + the
//     assignment transaction; firestore.rules ALLOC1/2 enforce it again)

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const v2 = (state, items, over = {}) => ({
  allocationVersion: 2,
  allocationState: state,
  allocationOpen: state !== "fully_reserved",
  items,
  ...over,
});

// ---------------------------------------------------------------- describeAllocation

test("a version-2 order is described from the server's per-line figures", () => {
  const info = describeAllocation(
    v2("partially_reserved", [
      { name: "Vaxigrip", quantity: 10, reservedQuantity: 4, backorderedQuantity: 6, productKey: "p1" },
      { name: "Fluarix", quantity: 5, reservedQuantity: 5, backorderedQuantity: 0, productKey: "p2" },
    ])
  );
  assert.equal(info.tracked, true);
  assert.equal(info.state, "partially_reserved");
  assert.equal(info.label, "Partially reserved");
  assert.equal(info.fullyReserved, false);
  assert.deepEqual([info.requested, info.reserved, info.backordered], [15, 9, 6]);
  assert.deepEqual(info.lines.map((l) => [l.name, l.requested, l.reserved, l.backordered]), [
    ["Vaxigrip", 10, 4, 6],
    ["Fluarix", 5, 5, 0],
  ]);
});

test("figures are never invented: corrupt counts read as zero, unknown states as unknown", () => {
  const info = describeAllocation(
    v2("bogus", [{ name: "X", quantity: 3, reservedQuantity: "3", backorderedQuantity: -1 }])
  );
  assert.equal(info.state, "unknown");
  assert.equal(info.fullyReserved, false, "an unknown state is never treated as dispatchable");
  assert.deepEqual([info.reserved, info.backordered], [0, 0]);
});

test("a legacy (version 1) order reserved everything at creation", () => {
  const info = describeAllocation({ allocationVersion: 1, items: [{ name: "A", quantity: 7 }] });
  assert.equal(info.fullyReserved, true);
  assert.deepEqual([info.requested, info.reserved, info.backordered], [7, 7, 0]);
});

test("an order with no allocation data is reported as not tracked", () => {
  const info = describeAllocation({ items: [{ quantity: 2 }] });
  assert.equal(info.tracked, false);
  assert.equal(info.label, "Not tracked");
});

test("the three allocation states have stable labels", () => {
  assert.deepEqual(ALLOCATION_STATE_LABELS, {
    awaiting_stock: "Awaiting stock",
    partially_reserved: "Partially reserved",
    fully_reserved: "Fully reserved",
  });
});

// ---------------------------------------------------------------- dispatcher gating

test("assignment is blocked, with the shortage in words, until fully reserved", () => {
  const awaiting = v2("awaiting_stock", [{ name: "Vaxigrip", quantity: 10, reservedQuantity: 0, backorderedQuantity: 10 }]);
  const reason = assignmentBlockReason(awaiting);
  assert.match(reason, /^Waiting for stock — 0 of 10 reserved \(Vaxigrip: 10 short\)\./);
  assert.match(reason, /once every item is fully reserved/);

  const partial = v2("partially_reserved", [{ name: "Vaxigrip", quantity: 10, reservedQuantity: 4, backorderedQuantity: 6 }]);
  assert.match(assignmentBlockReason(partial), /4 of 10 reserved \(Vaxigrip: 6 short\)/);

  assert.equal(assignmentBlockReason(v2("fully_reserved", [{ quantity: 10, reservedQuantity: 10, backorderedQuantity: 0 }])), null);
  // Legacy and untracked orders are not gated here (they predate allocation).
  assert.equal(assignmentBlockReason({ allocationVersion: 1, items: [] }), null);
  assert.equal(assignmentBlockReason({}), null);
});

const loader = createServiceLoader();
const { assignRiderToOrder, AssignmentError } = await loader.load("orderService.js");
const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };
const RIDER = "RiderUid";

function seedOrder(order) {
  return createStore({
    orders: {
      o1: {
        orderNumber: "VT-ORD-9001",
        status: "pending_dispatch",
        assignedRiderId: null,
        createdByUid: "salesRepUid",
        requestedDeliveryDate: "2026-01-01",
        ...order,
      },
    },
    users: { [RIDER]: { role: "rider", status: "approved", fullName: "QA Rider" } },
  });
}

test("the assignment transaction refuses an order that is not fully reserved", async () => {
  for (const state of ["awaiting_stock", "partially_reserved"]) {
    const store = installStore(
      seedOrder(v2(state, [{ name: "Vaxigrip", quantity: 10, reservedQuantity: state === "awaiting_stock" ? 0 : 4, backorderedQuantity: state === "awaiting_stock" ? 10 : 6 }])),
      DISPATCHER
    );
    await assert.rejects(assignRiderToOrder("o1", RIDER), (err) => {
      assert.ok(err instanceof AssignmentError);
      assert.equal(err.code, "order-not-fully-reserved");
      assert.match(err.message, /Waiting for stock/);
      return true;
    });
    const o = store.collections.orders.o1.data;
    assert.equal(o.status, "pending_dispatch", `${state}: nothing was written`);
    assert.equal(o.assignedRiderId, null);
  }
});

test("a fully reserved future order is assigned normally", async () => {
  const store = installStore(
    seedOrder(v2("fully_reserved", [{ name: "Vaxigrip", quantity: 10, reservedQuantity: 10, backorderedQuantity: 0 }])),
    DISPATCHER
  );
  await assignRiderToOrder("o1", RIDER);
  assert.equal(store.collections.orders.o1.data.status, "assigned");
  assert.equal(store.collections.orders.o1.data.assignedRiderId, RIDER);
});

test("Dispatcher pages disable assignment and explain the shortage", () => {
  const dash = read("src/pages/dispatcher/DispatcherDashboard.jsx");
  assert.match(dash, /const stockBlock = assignmentBlockReason\(order\);/);
  assert.match(dash, /disabled=\{Boolean\(stockBlock\)\}/);
  assert.match(dash, /\{stockBlock \? "Waiting for stock" : "Assign Rider"\}/);
  assert.match(dash, /className="dispatcher-stock-block"/);

  const assign = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  assert.match(assign, /const stockBlock = selectedOrder \? assignmentBlockReason\(selectedOrder\) : null;/);
  assert.match(assign, /\{stockBlock\}/);
});

// ---------------------------------------------------------------- Med Rep

test("the cart estimate pools a product's batches and shares them across lines", () => {
  const products = [
    { inventoryId: "b1", vaccineId: "p1", orderable: true, available: 3 },
    { inventoryId: "b2", vaccineId: "p1", orderable: true, available: 2 },
    { inventoryId: "b3", vaccineId: "p1", orderable: false, available: 50 }, // e.g. expired: not counted
    { inventoryId: "b4", vaccineId: "p2", orderable: true, available: 0 },
  ];
  const est = estimateBackorders(
    [
      { inventoryId: "b1", vaccineId: "p1", quantity: 4 },
      { inventoryId: "b2", vaccineId: "p1", quantity: 4 },
      { inventoryId: "b4", vaccineId: "p2", quantity: 2 },
    ],
    products
  );
  // Pool for p1 is 5: the first line takes 4, the second gets 1 and waits for 3.
  assert.equal(est.get("b1"), 0);
  assert.equal(est.get("b2"), 3);
  assert.equal(est.get("b4"), 2, "nothing free: the whole line is a future order");
});

test("the confirmation carries the server's reserved / backordered split", () => {
  const d = buildConfirmationFromOrder({
    id: "o1",
    orderNumber: "VT-1",
    ...v2("partially_reserved", [
      { name: "Vaxigrip", quantity: 10, reservedQuantity: 4, backorderedQuantity: 6 },
    ]),
  });
  assert.deepEqual(d.allocation, {
    state: "partially_reserved",
    label: "Partially reserved",
    fullyReserved: false,
    requested: 10,
    reserved: 4,
    backordered: 6,
  });
  assert.equal(d.items[0].reservedQuantity, 4);
  assert.equal(d.items[0].backorderedQuantity, 6);
  // A pre-allocation order has nothing to report — never a fabricated split.
  assert.equal(buildConfirmationFromOrder({ id: "o2", items: [] }).allocation, null);
});

test("Med Rep wording offers a future order and never promises a date", () => {
  assert.equal(FUTURE_ORDER_LABEL, "Out of stock — future order available");
  const summary = read("src/components/ui/AllocationSummary.jsx");
  assert.match(summary, /dispatched only once every item is fully reserved, so no delivery date is guaranteed/);
  for (const [name, src] of [
    ["AllocationSummary", summary],
    ["RequestOrder", read("src/pages/salesRep/SalesRepRequestOrder.jsx")],
    ["PlaceOrder", read("src/pages/salesRep/SalesRepPlaceOrder.jsx")],
    ["Confirmation", read("src/pages/salesRep/SalesRepOrderConfirmation.jsx")],
  ]) {
    assert.doesNotMatch(src, /expected (by|on)|will arrive (by|on)|guaranteed (by|on)/i, `${name} must not promise a date`);
  }
  // Requested / reserved / backordered all shown.
  assert.match(summary, /Requested<\/th>[\s\S]*Reserved<\/th>[\s\S]*Backordered<\/th>/);
  // The catalog no longer caps quantity at available stock.
  const req = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
  assert.doesNotMatch(req, /Math\.min\(item\.quantity \+ quantity, product\.stock\)/);
  assert.match(req, /const maxQty = MAX_LINE_QUANTITY;/);
  // Tracking shows the split for orders still waiting to be dispatched.
  const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.match(tracking, /allocation: statusKey === "pending_dispatch" \? describeAllocation\(raw\) : null/);
});

// ---------------------------------------------------------------- Admin

test("Admin provenance shows held units by order and reports a mismatch", () => {
  const prov = read("src/components/admin/ReservationProvenance.jsx");
  assert.match(prov, /getReservationProvenance\(inventoryId\)/);
  assert.match(prov, /d\.reconciled === false/);
  assert.match(prov, /Returned, awaiting decision/);
  assert.match(prov, /Quarantined/);
  assert.match(read("src/pages/admin/Inventory.jsx"), /<ReservationProvenance key=\{selectedVaccine\.id\} inventoryId=\{selectedVaccine\.id\} \/>/);
});

test("Admin inventory availability excludes return-pending and quarantined units", () => {
  const inv = read("src/pages/admin/Inventory.jsx");
  assert.match(inv, /raw\.quantity - reserved - returnPending - quarantined/);
  // And the stock-correction floor includes them, mirroring the rules.
  const corr = read("src/services/stockCorrection.js");
  assert.match(corr, /reserved \+ readReserved\(returnPendingQuantity\) \+ readReserved\(quarantinedQuantity\)/);
});

test("Admin return confirmation offers exactly the four dispositions and shows reallocations", () => {
  const page = read("src/pages/admin/AdminAllocation.jsx");
  for (const [value, label] of [
    ["usable", "Returned and usable"],
    ["damaged", "Damaged"],
    ["temperature_excursion", "Temperature excursion"],
    ["missing", "Missing"],
  ]) {
    assert.match(page, new RegExp(`value: "${value}", label: "${label}"`));
  }
  assert.match(page, /confirmReturnDisposition\(ret\.id, disposition, notes\[ret\.id\] \|\| ""\)/);
  assert.match(page, /Reallocated \{a\.units\.toLocaleString\(\)\} to/);
  // The queue is read in the server's own priority order.
  const svc = read("src/services/allocationService.js");
  assert.match(svc, /orderBy\("allocationPriorityKey", "asc"\)/);
  assert.match(svc, /where\("allocationState", "in", WAITING_STATES\)/);
});

test("the Stock Allocation page is registered inside the Admin shell", () => {
  assert.match(read("src/App.jsx"), /<Route path="\/admin\/allocation" element=\{<AdminAllocation \/>\} \/>/);
  assert.match(read("src/components/admin/AdminSidebar.jsx"), /to="\/admin\/allocation"/);
  assert.match(read("src/components/admin/AdminShell.jsx"), /"\/admin\/allocation": "Stock Allocation"/);
});

test("'On hand' is labelled as what it is: not yet delivered, including stock out with riders", () => {
  // `quantity` drops only at delivery (consumption), a missing write-off, or an
  // Admin correction — so a unit loaded onto a rider is still on hand (and reserved).
  const inv = read("src/pages/admin/Inventory.jsx");
  assert.match(inv, /On hand counts every unit not yet delivered, including stock reserved for orders, out with\s+riders/);
  assert.match(inv, /On hand \(not yet delivered\) \/ Reserved \/ Available/);
  assert.match(read("src/components/admin/ReservationProvenance.jsx"), /On hand \(not yet delivered\)/);
  // The Med Rep card's two figures add up: available + held = on hand.
  assert.match(read("src/pages/salesRep/SalesRepRequestOrder.jsx"), /\(product\.onHand \?\? 0\) - product\.available, 0\)\} reserved or on hold/);
  // And the server's consumption is the only automatic decrement of quantity.
  const policy = read("functions/src/policy.js");
  assert.match(policy, /if \(mode === "consume"\)/);
});
