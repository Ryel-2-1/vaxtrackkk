import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServiceLoader,
  createStore,
  injectCompetingWrite,
  installStore,
  SERVER_TIMESTAMP,
} from "./serviceHarness.js";
import {
  AWAITING_DISPATCHER_STATUSES,
  ORDER_STATUSES,
} from "../src/services/orderWorkflow.js";

// Failed-delivery recovery, executed against the in-memory Firestore stand-in.
//
// `reassignFailedOrder` is a DEDICATED entry point, not a relaxed mode of
// `assignRiderToOrder` — that one still only ever accepts `pending_dispatch`.
// Widening it would have meant one function with two meanings and a weaker
// precondition, which is how a failed order starts being treated as a fresh one.

const loader = createServiceLoader();
const orders = await loader.load("orderService.js");
const { AssignmentError } = orders;

const RIDER = "RiderUid1";
const OTHER_RIDER = "RiderUid2";
const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };

const failedOrder = (over = {}) => ({
  orderNumber: "VT-ORD-8001",
  status: "delivery_failed",
  assignedRiderId: RIDER,
  assignedRiderName: "QA Rider",
  deliveryFailureReason: "Clinic permanently closed",
  deliveryFailedAt: SERVER_TIMESTAMP,
  deliveryFailedByUid: RIDER,
  isLoaded: true,
  createdByUid: "salesRepUid",
  clinicDocId: "clinicAbc",
  clinicLat: 14.5995,
  clinicLocationVerified: true,
  // Recovery re-enters dispatch, so it needs a valid, reached delivery date
  // (an undated order fails closed — see tests/dispatchEligibility.test.js).
  requestedDeliveryDate: "2026-01-01",
  ...over,
});

const seed = (docs, users) =>
  createStore({
    orders: docs,
    users: users ?? {
      [RIDER]: { role: "rider", status: "approved", fullName: "QA Rider", phone: "0917" },
      [OTHER_RIDER]: { role: "rider", status: "approved", fullName: "Other Rider" },
    },
  });

const data = (store, id) => store.collections.orders[id].data;

async function expectRejection(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AssignmentError, `expected AssignmentError, got ${err?.name}`);
    assert.equal(err.code, code);
    assert.ok(err.message.length > 0, "must carry a displayable message");
    return true;
  });
}

// ---------------------------------------------------------------------------
// The two legal recoveries
// ---------------------------------------------------------------------------

test("recovery refuses an order with no delivery date, a bad one, or a future one", async () => {
  for (const [over, code] of [
    [{ requestedDeliveryDate: undefined }, "scheduled-date-missing"],
    [{ requestedDeliveryDate: null }, "scheduled-date-invalid"],
    [{ requestedDeliveryDate: "2026-02-31" }, "scheduled-date-invalid"],
    [{ requestedDeliveryDate: "2999-01-01" }, "scheduled-date-not-reached"],
  ]) {
    const order = failedOrder(over);
    // A legacy order has no field at all, not one holding undefined.
    if (over.requestedDeliveryDate === undefined) delete order.requestedDeliveryDate;
    const store = installStore(seed({ o1: order }), DISPATCHER);
    await expectRejection(orders.reassignFailedOrder("o1", OTHER_RIDER), code);
    assert.equal(data(store, "o1").status, "delivery_failed", "nothing was written");
    assert.equal(data(store, "o1").assignedRiderId, RIDER, "the rider was not changed");
  }
});

test("a failed order is retried with the same rider", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  const result = await orders.reassignFailedOrder("o1", RIDER);
  const o = data(store, "o1");

  assert.equal(o.status, "assigned", "it re-enters through Cargo Loading, not transit");
  assert.equal(o.assignedRiderId, RIDER);
  assert.equal(result.previousAssignedRiderId, RIDER);
  assert.equal(o.isLoaded, false, "the previous run's load confirmation does not carry over");
});

test("a failed order is reassigned to a different approved rider", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  const result = await orders.reassignFailedOrder("o1", OTHER_RIDER);
  const o = data(store, "o1");

  assert.equal(o.status, "assigned");
  assert.equal(o.assignedRiderId, OTHER_RIDER);
  assert.equal(o.assignedRiderName, "Other Rider", "name comes from the user document");
  assert.equal(o.previousAssignedRiderId, RIDER);
  assert.equal(result.assignedRiderName, "Other Rider");
});

test("recovery is server-stamped and attributed to the dispatcher", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await orders.reassignFailedOrder("o1", OTHER_RIDER);
  const o = data(store, "o1");

  assert.equal(o.reassignedAt, SERVER_TIMESTAMP);
  assert.equal(o.assignedAt, SERVER_TIMESTAMP);
  assert.equal(o.updatedAt, SERVER_TIMESTAMP);
  assert.equal(o.reassignedByUid, DISPATCHER.uid);
  assert.equal(o.assignedByUid, DISPATCHER.uid);
  assert.equal(o.statusUpdatedByUid, DISPATCHER.uid);
});

// ---------------------------------------------------------------------------
// The failure record is preserved
// ---------------------------------------------------------------------------

test("the failure record survives recovery untouched", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await orders.reassignFailedOrder("o1", OTHER_RIDER);
  const o = data(store, "o1");

  // Clearing these would make a twice-attempted order look like a fresh one.
  assert.equal(o.deliveryFailureReason, "Clinic permanently closed");
  assert.equal(o.deliveryFailedAt, SERVER_TIMESTAMP);
  assert.equal(o.deliveryFailedByUid, RIDER);

  const written = store.writes.at(-1).data;
  for (const key of ["deliveryFailureReason", "deliveryFailedAt", "deliveryFailedByUid"]) {
    assert.ok(!(key in written), `${key} must not be rewritten during recovery`);
  }
});

test("recovery leaves the clinic snapshot and order payload alone", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await orders.reassignFailedOrder("o1", OTHER_RIDER);
  const o = data(store, "o1");

  assert.equal(o.clinicDocId, "clinicAbc");
  assert.equal(o.clinicLat, 14.5995);
  assert.equal(o.clinicLocationVerified, true);
  assert.equal(o.createdByUid, "salesRepUid");
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

test("only a failed order may be recovered", async () => {
  for (const status of [
    "pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivered", "cancelled",
  ]) {
    const store = installStore(seed({ o1: failedOrder({ status }) }), DISPATCHER);
    await expectRejection(orders.reassignFailedOrder("o1", RIDER), "order-not-failed");
    assert.equal(data(store, "o1").status, status, "untouched");
    assert.equal(store.writes.length, 0, "no write escaped");
  }
});

test("recovery refuses a missing user or an employee id", async () => {
  installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await expectRejection(orders.reassignFailedOrder("o1", "noSuchUser"), "rider-not-found");
  // A display identifier is not a document id.
  await expectRejection(orders.reassignFailedOrder("o1", "EMP-4432"), "rider-not-found");
});

test("recovery refuses a non-rider account", async () => {
  for (const role of ["admin", "dispatcher", "salesrep"]) {
    const store = installStore(
      seed({ o1: failedOrder() }, { [RIDER]: { role, status: "approved" } }),
      DISPATCHER
    );
    await expectRejection(orders.reassignFailedOrder("o1", RIDER), "not-a-rider");
    assert.equal(store.writes.length, 0);
  }
});

test("recovery refuses a rider who is not approved", async () => {
  for (const status of ["pending", "pending_approval", "disabled", "rejected"]) {
    const store = installStore(
      seed({ o1: failedOrder() }, { [RIDER]: { role: "rider", status } }),
      DISPATCHER
    );
    await expectRejection(orders.reassignFailedOrder("o1", RIDER), "rider-not-approved");
    assert.equal(store.writes.length, 0);
  }
});

test("recovery rejects bad identities and an unauthenticated caller", async () => {
  installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await expectRejection(orders.reassignFailedOrder("", RIDER), "order-id-required");
  await expectRejection(orders.reassignFailedOrder("o1", ""), "rider-uid-required");
  await expectRejection(orders.reassignFailedOrder("missing", RIDER), "order-not-found");

  installStore(seed({ o1: failedOrder() }), null);
  await expectRejection(orders.reassignFailedOrder("o1", RIDER), "not-signed-in");
});

// ---------------------------------------------------------------------------
// Identity cannot be forged; races cannot overwrite
// ---------------------------------------------------------------------------

test("caller metadata cannot forge the new rider's identity", async () => {
  assert.equal(orders.reassignFailedOrder.length, 2, "orderId and riderUid only");

  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await orders.reassignFailedOrder("o1", OTHER_RIDER, {
    name: "Fake Rider",
    phone: "0000000000",
    employeeId: "EMP-FORGED",
  });
  const o = data(store, "o1");

  assert.equal(o.assignedRiderName, "Other Rider");
  assert.ok(!JSON.stringify(o).includes("EMP-FORGED"));
  assert.ok(!JSON.stringify(o).includes("Fake Rider"));
});

test("competing recovery attempts cannot overwrite one another", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);

  // Another dispatcher commits between this attempt's reads and its commit.
  injectCompetingWrite(async () => {
    const rec = store.collections.orders.o1;
    rec.data = { ...rec.data, status: "assigned", assignedRiderId: OTHER_RIDER };
    rec.version += 1;
  });

  await expectRejection(orders.reassignFailedOrder("o1", RIDER), "order-not-failed");
  assert.equal(data(store, "o1").assignedRiderId, OTHER_RIDER, "the winner's recovery survives");
  assert.ok(store.transactionAttempts >= 2, "the loser retried rather than clobbering");
});

test("recovery still allows one rider to hold multiple orders", async () => {
  const store = createStore({
    orders: { o1: failedOrder(), o2: failedOrder({ orderNumber: "VT-ORD-8009" }) },
    users: { [RIDER]: { role: "rider", status: "approved", fullName: "QA Rider" } },
  });
  installStore(store, DISPATCHER);

  await orders.reassignFailedOrder("o1", RIDER);
  await orders.reassignFailedOrder("o2", RIDER);

  assert.equal(store.collections.orders.o1.data.assignedRiderId, RIDER);
  assert.equal(store.collections.orders.o2.data.assignedRiderId, RIDER);
});

// ---------------------------------------------------------------------------
// The two entry points stay narrow
// ---------------------------------------------------------------------------

test("normal assignment was NOT widened to accept failed orders", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await expectRejection(orders.assignRiderToOrder("o1", RIDER), "order-not-pending");
  assert.equal(data(store, "o1").status, "delivery_failed", "untouched");
});

test("recovery does not accept a merely pending order", async () => {
  const store = installStore(
    seed({ o1: failedOrder({ status: "pending_dispatch", assignedRiderId: null }) }),
    DISPATCHER
  );
  await expectRejection(orders.reassignFailedOrder("o1", RIDER), "order-not-failed");
  assert.equal(data(store, "o1").status, "pending_dispatch");
});

// ---------------------------------------------------------------------------
// The other recovery option
// ---------------------------------------------------------------------------

test("a failed order can still be cancelled, preserving the failure record", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await orders.cancelOrderByDispatcher("o1", "Clinic will not reopen");
  const o = data(store, "o1");

  assert.equal(o.status, "cancelled");
  assert.equal(o.cancelReason, "Clinic will not reopen");
  assert.equal(o.deliveryFailureReason, "Clinic permanently closed", "failure detail survives");
  assert.equal(o.deliveryFailedByUid, RIDER);
});

// ---------------------------------------------------------------------------
// Retry/Reassign VISIBILITY on the Dispatcher Shipments page.
//
// Regression for the leak where a "Retry / Reassign" button appeared on every
// `pending_dispatch` order (the whole unassigned queue). The button runs the
// failed-recovery callable `reassignFailedOrder`, which accepts `delivery_failed`
// and nothing else, so on a pending order it failed server-side with "That order
// is no longer awaiting recovery."
//
// The visibility gate `canReassign` lives inside a React page that imports
// Firebase and lucide, so it cannot be imported into this Node runner (there is
// no jsdom/RTL and no JSX transform here). The coverage is therefore split into
// (a) a BEHAVIORAL proof against the real, importable policy set that drives the
// gate, and (b) narrow SOURCE-CONTRACT assertions pinning that the button is
// wired to exactly that gate and callable — so the two together prove per-status
// visibility without a DOM.
const SHIPMENTS = readFileSync(
  new URL("../src/pages/dispatcher/DispatcherShipments.jsx", import.meta.url),
  "utf8"
);

test("only a failed delivery qualifies for recovery; every other status does not", () => {
  // The authoritative set is exactly one status.
  assert.deepEqual([...AWAITING_DISPATCHER_STATUSES], ["delivery_failed"]);

  // Behavioral: the gate is membership in that set (pinned to the source below),
  // so applying it to each lifecycle status is the visibility decision.
  const qualifies = (statusKey) => AWAITING_DISPATCHER_STATUSES.includes(statusKey);
  for (const hidden of [
    "pending_dispatch",
    "assigned",
    "loading",
    "in_transit",
    "delayed",
    "delivered",
    "cancelled",
  ]) {
    assert.equal(qualifies(hidden), false, `${hidden} must NOT show Retry / Reassign`);
    assert.ok(ORDER_STATUSES.includes(hidden), `${hidden} is a real lifecycle status`);
  }
  assert.equal(qualifies("delivery_failed"), true, "delivery_failed must show Retry / Reassign");
});

test("the Retry/Reassign button is gated by the recovery set, not the assign transition", () => {
  // canReassign is EXACTLY membership in AWAITING_DISPATCHER_STATUSES …
  assert.match(
    SHIPMENTS,
    /function canReassign\(statusKey\)\s*\{\s*return AWAITING_DISPATCHER_STATUSES\.includes\(statusKey\);\s*\}/,
    "canReassign must gate on the failed-recovery set"
  );
  // … not the old leaky test that was also true for pending_dispatch.
  assert.equal(
    /canTransition\([^)]*,\s*statusKey,\s*"assigned"\)/.test(SHIPMENTS),
    false,
    "reassign must not be gated on the pending→assigned transition"
  );
  // The row computes `reassignable` from that gate — and, since recovery
  // re-enters dispatch, from the order's scheduled date as well — and renders
  // the button only then.
  assert.match(SHIPMENTS, /const reassignable = canReassign\(sKey\) && schedule\.eligible;/);
  assert.match(SHIPMENTS, /\{reassignable && \(/);
  assert.match(SHIPMENTS, /Retry \/ Reassign/);
});

test("the recovery control invokes reassignFailedOrder; normal assignment stays separate", () => {
  assert.match(SHIPMENTS, /onConfirm=\{handleConfirmReassign\}/);
  assert.match(SHIPMENTS, /const result = await reassignFailedOrder\(order\.id, riderUid\)/);
  // Pending-dispatch assignment is the Assign Rider page's job — never performed
  // here — so the normal assignment service is not even reachable from Shipments.
  assert.equal(
    /assignRiderToOrder/.test(SHIPMENTS),
    false,
    "Shipments must not perform normal pending assignment"
  );
});

test("Request change and Cancel order actions are not accidentally removed", () => {
  // Each remaining action keeps its own independent gate.
  assert.match(SHIPMENTS, /const cancellable = canCancel\(sKey\);/);
  assert.match(SHIPMENTS, /const correctable = canCorrectDestination\(order\);/);
  assert.match(SHIPMENTS, /\{correctable && \(/);
  assert.match(SHIPMENTS, /Request change/);
  assert.match(SHIPMENTS, /\{cancellable && \(/);
  assert.match(SHIPMENTS, /Cancel order/);
  // Cancel still routes through the trusted inventory-release callable.
  assert.match(SHIPMENTS, /cancelOrderWithInventoryRelease/);
});
