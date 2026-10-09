import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServiceLoader,
  createStore,
  installStore,
  SERVER_TIMESTAMP,
} from "./serviceHarness.js";
import {
  AWAITING_DISPATCHER_STATUSES,
  ORDER_STATUSES,
} from "../src/services/orderWorkflow.js";

// Failed-delivery recovery.
//
// A rider's failure report (server callable reportDeliveryFailure) moves the
// order's reserved stock to return-pending, so the order no longer holds any
// stock. Recovery therefore cannot send it straight back out to a rider: the
// dispatcher returns it to the dispatch QUEUE through the server callable
// `requeueFailedOrder`, it is reserved again in its priority position, and it
// is assigned through the normal Assign Rider flow once fully reserved.
//
// The old client-side `reassignFailedOrder` transaction (delivery_failed →
// assigned) was removed: firestore.rules now refuse any client write out of
// delivery_failed. The server behaviour is covered by
// functions/test/integration/allocation.test.js (13–15, requeue).

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
// The two entry points stay narrow
// ---------------------------------------------------------------------------

test("the client-side failed-order reassignment no longer exists", () => {
  assert.equal(orders.reassignFailedOrder, undefined);
});

test("normal assignment was NOT widened to accept failed orders", async () => {
  const store = installStore(seed({ o1: failedOrder() }), DISPATCHER);
  await expectRejection(orders.assignRiderToOrder("o1", RIDER), "order-not-pending");
  assert.equal(data(store, "o1").status, "delivery_failed", "untouched");
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
// Return-to-queue VISIBILITY on the Dispatcher Shipments page.
//
// Regression for the leak where a recovery button appeared on every
// `pending_dispatch` order (the whole unassigned queue). The button runs the
// failed-recovery callable `requeueFailedOrder`, which accepts `delivery_failed`
// and nothing else ("order-not-failed").
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
    assert.equal(qualifies(hidden), false, `${hidden} must NOT show Return to queue`);
    assert.ok(ORDER_STATUSES.includes(hidden), `${hidden} is a real lifecycle status`);
  }
  assert.equal(qualifies("delivery_failed"), true, "delivery_failed must show Return to queue");
});

test("the Return-to-queue button is gated by the recovery set, not the assign transition", () => {
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
  // The row computes `reassignable` from that gate and renders the button only
  // then. It is not schedule-gated: it only returns the order to the queue, and
  // the assignment that follows is held to the schedule and to full stock.
  assert.match(SHIPMENTS, /const reassignable = canReassign\(sKey\) && !legacyReturned;/);
  // A version-1 order whose stock already went to return-pending cannot be
  // re-reserved (the server refuses legacy-order-not-requeueable), so the
  // control is replaced by an instruction to cancel — no knowingly dead button.
  assert.match(SHIPMENTS, /return order\.allocationVersion === 1 && order\.allocationStatus === "returned";/);
  assert.match(SHIPMENTS, /const legacyReturned = canReassign\(sKey\) && isLegacyReturned\(order\);/);
  assert.match(SHIPMENTS, /Cancel it and place a new order\./);
  assert.match(SHIPMENTS, /\{reassignable && \(/);
  assert.match(SHIPMENTS, /Return to queue/);
});

test("the recovery control invokes the requeueFailedOrder callable; normal assignment stays separate", () => {
  assert.match(SHIPMENTS, /onConfirm=\{handleConfirmReassign\}/);
  assert.match(SHIPMENTS, /const result = await requeueFailedOrder\(order\.id\)/);
  assert.equal(/reassignFailedOrder/.test(SHIPMENTS), false, "the removed client path is not used");
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
