import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTOR_DISPATCHER,
  ACTOR_RIDER,
  ACTORS,
  DISPATCHER_TRANSITIONS,
  ORDER_STATUSES,
  RIDER_TRANSITIONS,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  WorkflowError,
  allowedTransitions,
  assertTransition,
  canTransition,
  canUpdateLoadingMetadata,
  isAwaitingDispatcher,
  isKnownStatus,
  isTerminalStatus,
  normalizeStatus,
  statusLabel,
  validateReason,
  MAX_REASON_LENGTH,
} from "../src/services/orderWorkflow.js";

// The order lifecycle policy.
//
// The approved matrix, restated here independently of the implementation so a
// change to either side has to be deliberate:
//
//   Dispatcher: pending_dispatch → assigned, cancelled
//               assigned         → loading, cancelled
//               loading          → in_transit, cancelled
//               in_transit       → cancelled
//               delayed          → cancelled
//   Rider:      in_transit       → delayed, delivered
//               delayed          → in_transit, delivered
//
// Everything else, for every actor, is illegal.

const EXPECTED = {
  [ACTOR_DISPATCHER]: {
    pending_dispatch: ["assigned", "cancelled"],
    assigned: ["loading", "cancelled"],
    loading: ["in_transit", "cancelled"],
    in_transit: ["cancelled"],
    delayed: ["cancelled"],
    // Recovery: back to assigned (through Cargo Loading again), or cancelled.
    delivery_failed: ["assigned", "cancelled"],
    delivered: [],
    cancelled: [],
  },
  [ACTOR_RIDER]: {
    pending_dispatch: [],
    assigned: [],
    loading: [],
    in_transit: ["delayed", "delivered", "delivery_failed"],
    delayed: ["in_transit", "delivered", "delivery_failed"],
    // Reporting a failure is where the rider stops.
    delivery_failed: [],
    delivered: [],
    cancelled: [],
  },
};

// ---------------------------------------------------------------------------
// Exhaustive matrix — every actor × every from × every to
// ---------------------------------------------------------------------------

test("the full transition matrix matches the approved lifecycle exactly", () => {
  let allowedCount = 0;
  let deniedCount = 0;

  for (const actor of ACTORS) {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const shouldAllow = EXPECTED[actor][from].includes(to);
        const result = canTransition(actor, from, to);
        assert.equal(
          result.ok,
          shouldAllow,
          `${actor}: ${from} → ${to} should be ${shouldAllow ? "allowed" : "denied"}`
        );
        if (result.ok) allowedCount += 1;
        else deniedCount += 1;
      }
    }
  }

  // 2 actors × 8 × 8 = 128 combinations, of which exactly 16 are legal.
  assert.equal(allowedCount + deniedCount, 128, "every combination was checked");
  assert.equal(allowedCount, 16, "exactly sixteen legal transitions exist");
});

test("the exported tables agree with the matrix", () => {
  for (const from of ORDER_STATUSES) {
    assert.deepEqual([...DISPATCHER_TRANSITIONS[from]], EXPECTED[ACTOR_DISPATCHER][from]);
    assert.deepEqual([...RIDER_TRANSITIONS[from]], EXPECTED[ACTOR_RIDER][from]);
    assert.deepEqual([...allowedTransitions(ACTOR_DISPATCHER, from)], EXPECTED[ACTOR_DISPATCHER][from]);
    assert.deepEqual([...allowedTransitions(ACTOR_RIDER, from)], EXPECTED[ACTOR_RIDER][from]);
  }
});

// ---------------------------------------------------------------------------
// Role separation
// ---------------------------------------------------------------------------

test("a dispatcher cannot perform any rider transition", () => {
  for (const [from, targets] of Object.entries(EXPECTED[ACTOR_RIDER])) {
    for (const to of targets) {
      const result = canTransition(ACTOR_DISPATCHER, from, to);
      assert.equal(result.ok, false, `dispatcher must not do ${from} → ${to}`);
      assert.equal(result.code, "transition-not-allowed");
    }
  }
});

test("a rider cannot perform any dispatcher transition", () => {
  for (const [from, targets] of Object.entries(EXPECTED[ACTOR_DISPATCHER])) {
    for (const to of targets) {
      assert.equal(
        canTransition(ACTOR_RIDER, from, to).ok,
        false,
        `rider must not do ${from} → ${to}`
      );
    }
  }
});

test("specifically: dispatcher cannot deliver, delay or resume", () => {
  for (const [from, to] of [
    ["in_transit", "delivered"],
    ["in_transit", "delayed"],
    ["delayed", "in_transit"],
    ["delayed", "delivered"],
  ]) {
    assert.equal(canTransition(ACTOR_DISPATCHER, from, to).ok, false);
  }
});

test("specifically: rider cannot load, dispatch, assign or cancel", () => {
  for (const [from, to] of [
    ["assigned", "loading"],
    ["loading", "in_transit"],
    ["pending_dispatch", "assigned"],
    ["in_transit", "cancelled"],
    ["delayed", "cancelled"],
    ["delivery_failed", "cancelled"],
  ]) {
    assert.equal(canTransition(ACTOR_RIDER, from, to).ok, false);
  }
});

// ---------------------------------------------------------------------------
// Failed delivery + recovery
// ---------------------------------------------------------------------------

test("a rider may report failure only from in_transit or delayed", () => {
  assert.equal(canTransition(ACTOR_RIDER, "in_transit", "delivery_failed").ok, true);
  assert.equal(canTransition(ACTOR_RIDER, "delayed", "delivery_failed").ok, true);
  for (const from of ["pending_dispatch", "assigned", "loading", "delivered", "cancelled"]) {
    assert.equal(
      canTransition(ACTOR_RIDER, from, "delivery_failed").ok,
      false,
      `a delivery cannot fail from ${from}`
    );
  }
});

test("a dispatcher can never report a failure", () => {
  for (const from of ORDER_STATUSES) {
    assert.equal(canTransition(ACTOR_DISPATCHER, from, "delivery_failed").ok, false);
  }
});

test("a failed delivery recovers only to assigned or cancelled", () => {
  assert.equal(canTransition(ACTOR_DISPATCHER, "delivery_failed", "assigned").ok, true);
  assert.equal(canTransition(ACTOR_DISPATCHER, "delivery_failed", "cancelled").ok, true);
  // Never straight back into the field — it re-enters through Cargo Loading.
  for (const to of ["loading", "in_transit", "delayed", "delivered"]) {
    assert.equal(
      canTransition(ACTOR_DISPATCHER, "delivery_failed", to).ok,
      false,
      `delivery_failed must not jump to ${to}`
    );
  }
});

test("a rider cannot retry or reassign a failed delivery themselves", () => {
  for (const to of ORDER_STATUSES) {
    assert.equal(
      canTransition(ACTOR_RIDER, "delivery_failed", to).ok,
      false,
      `rider must not move delivery_failed to ${to}`
    );
  }
  assert.deepEqual([...allowedTransitions(ACTOR_RIDER, "delivery_failed")], []);
});

test("delivery_failed is non-terminal but parked, not progressing", () => {
  assert.equal(isTerminalStatus("delivery_failed"), false, "it can still move");
  assert.equal(isAwaitingDispatcher("delivery_failed"), true);
  for (const other of ["in_transit", "delayed", "delivered", "cancelled"]) {
    assert.equal(isAwaitingDispatcher(other), false);
  }
});

test("nobody may skip a stage", () => {
  for (const actor of ACTORS) {
    for (const [from, to] of [
      ["pending_dispatch", "loading"],
      ["pending_dispatch", "in_transit"],
      ["pending_dispatch", "delivered"],
      ["assigned", "in_transit"],
      ["assigned", "delivered"],
      ["loading", "delivered"],
    ]) {
      assert.equal(canTransition(actor, from, to).ok, false, `${actor}: ${from} → ${to}`);
    }
  }
});

test("nobody may move an order backwards", () => {
  for (const actor of ACTORS) {
    for (const [from, to] of [
      ["assigned", "pending_dispatch"],
      ["loading", "assigned"],
      ["in_transit", "loading"],
      ["in_transit", "assigned"],
      ["delayed", "assigned"],
      ["delivered", "in_transit"],
    ]) {
      assert.equal(canTransition(actor, from, to).ok, false, `${actor}: ${from} → ${to}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

test("terminal orders can never move again, for any actor", () => {
  for (const actor of ACTORS) {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const result = canTransition(actor, from, to);
        assert.equal(result.ok, false, `${actor}: ${from} → ${to} must be denied`);
        // from === to reports same-status; everything else reports terminal.
        assert.ok(["terminal-status", "same-status"].includes(result.code));
      }
    }
  }
  assert.deepEqual([...TERMINAL_STATUSES], ["delivered", "cancelled"]);
  assert.equal(isTerminalStatus("delivered"), true);
  assert.equal(isTerminalStatus("cancelled"), true);
  assert.equal(isTerminalStatus("in_transit"), false);
});

test("same-status writes are rejected as non-events", () => {
  for (const actor of ACTORS) {
    for (const status of ORDER_STATUSES) {
      const result = canTransition(actor, status, status);
      assert.equal(result.ok, false);
      assert.ok(["same-status", "terminal-status"].includes(result.code));
    }
  }
});

// ---------------------------------------------------------------------------
// Unknown input
// ---------------------------------------------------------------------------

test("unknown statuses are rejected, never guessed at", () => {
  // `delivery_failed` used to sit in this list; it is a canonical status now.
  const bogus = [
    "picked_up", "arrived", "failed", "delivery-failure", "completed", "canceled",
    "DELIVERED!", "", "   ", null, undefined, 42, {}, [],
  ];
  for (const value of bogus) {
    assert.equal(normalizeStatus(value), null, `${String(value)} is not canonical`);
    assert.equal(isKnownStatus(value), false);
    assert.equal(canTransition(ACTOR_DISPATCHER, "assigned", value).ok, false);
    assert.equal(canTransition(ACTOR_DISPATCHER, value, "cancelled").ok, false);
  }
});

test("legacy read aliases are NOT silently promoted to canonical statuses", () => {
  // deliveryService still labels these for display on historical orders; the
  // write policy must not accept them, or it would become the escape hatch.
  for (const legacy of ["completed", "canceled"]) {
    assert.equal(normalizeStatus(legacy), null);
    assert.equal(canTransition(ACTOR_RIDER, "in_transit", legacy).ok, false);
  }
});

test("only harmless formatting is normalized", () => {
  assert.equal(normalizeStatus("  IN_TRANSIT "), "in_transit");
  assert.equal(normalizeStatus("in-transit"), "in_transit");
  assert.equal(normalizeStatus("In Transit"), "in_transit");
  assert.equal(normalizeStatus("Pending-Dispatch"), "pending_dispatch");
  // Formatting only — never a value mapping.
  assert.equal(normalizeStatus("in_transitt"), null);
});

test("an unknown actor is rejected", () => {
  for (const actor of ["admin", "salesrep", "", null, undefined]) {
    const result = canTransition(actor, "in_transit", "delivered");
    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown-actor");
    assert.deepEqual(allowedTransitions(actor, "in_transit"), []);
  }
});

// ---------------------------------------------------------------------------
// Assertion form + metadata escape
// ---------------------------------------------------------------------------

test("assertTransition throws a typed, displayable error", () => {
  assert.equal(assertTransition(ACTOR_RIDER, "in_transit", "delivered"), "delivered");
  assert.throws(
    () => assertTransition(ACTOR_RIDER, "assigned", "loading"),
    (err) => {
      assert.ok(err instanceof WorkflowError);
      assert.equal(err.code, "transition-not-allowed");
      assert.ok(err.message.length > 0);
      return true;
    }
  );
});

test("loading metadata may be written only while assigned or loading", () => {
  assert.equal(canUpdateLoadingMetadata("assigned").ok, true);
  assert.equal(canUpdateLoadingMetadata("loading").ok, true);
  for (const status of ["pending_dispatch", "in_transit", "delayed", "delivered", "cancelled"]) {
    const result = canUpdateLoadingMetadata(status);
    assert.equal(result.ok, false, `${status} must not accept loading metadata`);
    assert.equal(result.code, "not-loadable");
  }
  assert.equal(canUpdateLoadingMetadata("nonsense").code, "unknown-from-status");
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("every canonical status has a distinct human label", () => {
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...ORDER_STATUSES].sort());
  assert.equal(statusLabel("pending_dispatch"), "Pending Dispatch");
  assert.equal(statusLabel("assigned"), "Assigned");
  assert.equal(statusLabel("loading"), "Loading");
  assert.equal(statusLabel("in_transit"), "In Transit");
  assert.equal(statusLabel("delayed"), "Delayed");
  assert.equal(statusLabel("delivery_failed"), "Delivery Failed");
  assert.equal(statusLabel("delivered"), "Delivered");
  assert.equal(statusLabel("cancelled"), "Cancelled");

  const labels = Object.values(STATUS_LABELS);
  assert.equal(new Set(labels).size, labels.length, "no two statuses share a label");
});

test("stored keys are never renamed by the label layer", () => {
  for (const status of ORDER_STATUSES) {
    assert.notEqual(STATUS_LABELS[status], status, "label differs from the key");
    assert.equal(normalizeStatus(status), status, "the key itself is unchanged");
  }
});

// ---------------------------------------------------------------------------
// Shared reason validation
// ---------------------------------------------------------------------------

test("a reason must be present, meaningful and bounded", () => {
  assert.deepEqual(validateReason('  Clinic closed  '), { ok: true, value: 'Clinic closed' });
  for (const bad of ["", "   ", "\n\t ", null, undefined, 42, {}]) {
    const r = validateReason(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'reason-required');
  }
  const tooLong = validateReason('x'.repeat(MAX_REASON_LENGTH + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'reason-too-long');
  assert.equal(validateReason('x'.repeat(MAX_REASON_LENGTH)).ok, true, 'the limit itself is allowed');
  assert.equal(MAX_REASON_LENGTH, 500);
});
