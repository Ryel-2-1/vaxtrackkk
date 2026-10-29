import test from "node:test";
import assert from "node:assert/strict";
import { shipmentProgress, tripProgress } from "../src/services/stopProgress.js";

const stop = (id, sequence, patch = {}) => ({
  id, stopSequence: sequence, tripId: "trip-a", assignedRiderId: "rider-a", status: "in_transit", ...patch,
});
const proof = (id) => ({
  proofSubmittedAt: new Date(), proofOfDeliveryUrl: "https://example.test/proof.jpg",
  proofOfDeliveryPath: `proof_of_delivery/${id}/proof.jpg`, proofRecipientName: "QA recipient",
  proofSubmittedByUid: "rider-a",
});

test("proof metadata updates progress without completing or advancing a stop", () => {
  const first = stop("one", 1), second = stop("two", 2);
  assert.equal(shipmentProgress(first).state, "pending");
  const uploaded = { ...first, ...proof(first.id) };
  const result = tripProgress([uploaded, second], second);
  assert.equal(result.stops[0].state, "proof");
  assert.equal(result.delivered, 0);
  assert.equal(result.proofRecorded, 1);
  assert.equal(result.nextUnfinished.order.id, "one");
  assert.equal(result.navigationTarget, null);
  assert.equal(first.status, "in_transit");
});

test("a bare URL, an incomplete upload, or proof for another order is not recorded proof", () => {
  for (const missing of ["proofSubmittedAt", "proofOfDeliveryUrl", "proofOfDeliveryPath", "proofRecipientName", "proofSubmittedByUid"]) {
    const order = stop("one", 1, proof("one"));
    delete order[missing];
    assert.equal(shipmentProgress(order).proofRecorded, false, missing);
  }
  assert.equal(shipmentProgress(stop("one", 1, proof("two"))).proofRecorded, false);
});

test("evidence left by a previous rider is explicitly flagged for review", () => {
  const order = stop("one", 1, { ...proof("one"), proofSubmittedByUid: "old-rider" });
  assert.equal(shipmentProgress(order).label, "Proof needs review");
});

test("completion retains the completed stop and advances only the unfinished suggestion", () => {
  const first = stop("one", 1, { ...proof("one"), status: "delivered" });
  const second = stop("two", 2);
  const result = tripProgress([second, first], second);
  assert.deepEqual(result.stops.map((s) => s.order.id), ["one", "two"]);
  assert.equal(result.delivered, 1);
  assert.equal(result.nextUnfinished.order.id, "two");
  assert.equal(result.navigationTarget, null);
});

test("navigation follows the reported session, not the selected details or visit order", () => {
  const first = stop("one", 1), second = stop("two", 2);
  const result = tripProgress([first, second], first, { sessionState: "navigating", orderId: "two" });
  assert.equal(result.navigationTarget.order.id, "two");
  assert.equal(result.nextUnfinished.order.id, "one");
  assert.equal(result.delivered, 0);
});

test("ended, foreign or terminal navigation sessions cannot mark an active target", () => {
  for (const status of ["delivered", "completed", "cancelled", "delivery_failed", "assigned", "loading"]) {
    assert.equal(shipmentProgress(stop("one", 1, { status }), "one").navigating, false, status);
  }
  const first = stop("one", 1);
  assert.equal(tripProgress([first], first, { sessionState: "ended", orderId: "one" }).navigationTarget, null);
  assert.equal(tripProgress([first], first, { sessionState: "navigating", orderId: "foreign" }).navigationTarget, null);
});

test("trip grouping excludes another rider/plan and invalid sequences but retains stops without coordinates", () => {
  const first = stop("one", 1);
  const orders = [first, stop("two", 2), stop("other", 3, { assignedRiderId: "rider-b" }),
    stop("old", 4, { tripId: "old-trip" }), stop("zero", 0), stop("fraction", 1.5)];
  const original = [...orders];
  assert.deepEqual(tripProgress(orders, first).stops.map((s) => s.order.id), ["one", "two"]);
  assert.deepEqual(orders, original);
  assert.equal(tripProgress(orders, { ...first, tripId: null }), null);
  assert.equal(tripProgress(orders, { ...first, assignedRiderId: null }), null);
});

test("failed/cancelled stops remain visible but never count as delivered", () => {
  const first = stop("one", 1, { status: "delivery_failed", ...proof("one") });
  const second = stop("two", 2, { status: "cancelled" });
  const result = tripProgress([first, second], first);
  assert.equal(result.delivered, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(result.nextUnfinished, null);
  assert.deepEqual(result.stops.map((s) => s.state), ["attention", "cancelled"]);
});

test("legacy completion is respected; unknown lifecycle is never presented as delivered", () => {
  assert.equal(shipmentProgress(stop("one", 1, { status: "Completed" })).delivered, true);
  assert.equal(shipmentProgress(stop("one", 1, { status: "mystery" })).state, "unknown");
});
