"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deriveStatusEvent } = require("../src/statusEvents");

// Order status history: which writes produce an event, and what it records.

test("a status change produces one event with from, to, actor and rider", () => {
  const event = deriveStatusEvent({
    before: { status: "assigned", assignedRiderId: "r1" },
    after: { status: "loading", assignedRiderId: "r1", statusUpdatedByUid: "d1" },
  });
  assert.deepEqual(event, { from: "assigned", to: "loading", actorUid: "d1", riderId: "r1", reason: null });
});

test("writes that do not change the status record nothing", () => {
  // Location ticks, loading checkboxes, route saves and the trigger's own
  // firstDispatchedAt stamp all keep the status — no event, so no loop.
  assert.equal(deriveStatusEvent({ before: { status: "in_transit" }, after: { status: "in_transit", lastLocation: {} } }), null);
  assert.equal(deriveStatusEvent({ before: { status: "In_Transit " }, after: { status: "in_transit" } }), null);
  assert.equal(deriveStatusEvent({ before: { status: "assigned" }, after: null }), null, "deletion");
  assert.equal(deriveStatusEvent({ before: null, after: {} }), null, "no status");
});

test("a new order is recorded as created by its creator", () => {
  const event = deriveStatusEvent({ before: null, after: { status: "pending_dispatch", createdByUid: "rep1" } });
  assert.deepEqual(event, { from: null, to: "pending_dispatch", actorUid: "rep1", riderId: null, reason: null });
});

test("delay, failure and cancellation carry their reason", () => {
  const base = { before: { status: "in_transit" } };
  assert.equal(deriveStatusEvent({ ...base, after: { status: "delayed", delayReason: " Flat tyre " } }).reason, "Flat tyre");
  assert.equal(
    deriveStatusEvent({ ...base, after: { status: "delivery_failed", deliveryFailureReason: "Clinic closed" } }).reason,
    "Clinic closed"
  );
  assert.equal(deriveStatusEvent({ ...base, after: { status: "cancelled", cancelReason: "Duplicate" } }).reason, "Duplicate");
  // A reason left over from an earlier status is not attached to an unrelated one.
  assert.equal(deriveStatusEvent({ before: { status: "delayed" }, after: { status: "in_transit", delayReason: "Flat tyre" } }).reason, null);
  assert.equal(deriveStatusEvent({ ...base, after: { status: "delayed", delayReason: "x".repeat(900) } }).reason.length, 500);
});

test("an actor is never guessed on an update that did not record one", () => {
  const event = deriveStatusEvent({ before: { status: "in_transit", createdByUid: "rep1" }, after: { status: "delayed", createdByUid: "rep1" } });
  assert.equal(event.actorUid, null);
});

test("index.js wires the trigger to every order write, with retries on", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /exports\.recordOrderStatusEvent = onDocumentWritten\(/);
  assert.match(src, /\{ document: "orders\/\{orderId\}", retry: true \}/);
  assert.match(src, /eventId: event\.id/);
  assert.match(src, /at: event\.data\.after\.updateTime/);
});
