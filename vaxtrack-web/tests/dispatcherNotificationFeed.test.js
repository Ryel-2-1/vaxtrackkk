import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceNearDestinations,
  buildDispatcherNotificationFeed,
  NEAR_DWELL_MS,
  NEAR_WAIT_MS,
} from "../src/services/dispatcherNotificationFeed.js";

const start = 1_800_000_000_000;
const order = {
  id: "order-a", orderNumber: "VT-ORD-1800000000000-ABCD", status: "in_transit",
  assignedRiderId: "rider-a", assignedRiderName: "Rider A", clinicName: "Clinic A",
  clinicLat: 14.5, clinicLng: 121, destinationGeofenceRadiusM: 300,
};
const fix = (at, extra = {}) => ({
  latitude: 14.5, longitude: 121, accuracyMeters: 20,
  capturedAt: at, updatedAt: at, ...extra,
});

test("near-destination update needs two fresh accurate fixes over a continuous dwell", () => {
  const first = advanceNearDestinations({}, [order], { "rider-a": fix(start) }, start);
  assert.equal(first[order.id].confirmedAtMs, null);
  const second = advanceNearDestinations(first, [order], { "rider-a": fix(start + NEAR_DWELL_MS) }, start + NEAR_DWELL_MS);
  assert.equal(second[order.id].confirmedAtMs, start + NEAR_DWELL_MS);
  const replay = advanceNearDestinations(second, [order], { "rider-a": fix(start + NEAR_DWELL_MS) }, start + NEAR_DWELL_MS);
  assert.equal(replay[order.id].confirmedAtMs, second[order.id].confirmedAtMs);
  assert.deepEqual(advanceNearDestinations(first, [order], { "rider-a": fix(start + NEAR_DWELL_MS, { longitude: 121.01 }) }, start + NEAR_DWELL_MS), {});
  assert.deepEqual(advanceNearDestinations(first, [order], { "rider-a": fix(start + NEAR_DWELL_MS, { accuracyMeters: 180 }) }, start + NEAR_DWELL_MS), {});
  assert.deepEqual(advanceNearDestinations(first, [{ ...order, status: "delivered" }], { "rider-a": fix(start + NEAR_DWELL_MS) }, start + NEAR_DWELL_MS), {});
  const gap = advanceNearDestinations(first, [order], { "rider-a": fix(start + 6 * 60_000) }, start + 6 * 60_000);
  assert.equal(gap[order.id].confirmedAtMs, null, "a location gap restarts the dwell");
});

test("Dispatcher feed separates operational work from recent shipment updates", () => {
  const now = start + NEAR_DWELL_MS + NEAR_WAIT_MS;
  const near = { [order.id]: { riderUid: "rider-a", firstFixMs: start, lastFixMs: now, confirmedAtMs: now - NEAR_WAIT_MS } };
  const delivered = { ...order, id: "order-b", orderNumber: "VT-ORD-1800000000000-WXYZ", status: "delivered", deliveredAt: now - 60_000 };
  const failed = { ...order, id: "order-c", status: "delivery_failed", deliveryFailedAt: now - 30_000 };
  const feed = buildDispatcherNotificationFeed({ alerts: [], orders: [order, delivered, failed], near, nowMs: now });
  assert.deepEqual(feed.actions.map((entry) => entry.title), ["Delivery still awaiting completion", "Delivery failed"]);
  assert.deepEqual(feed.updates.map((entry) => entry.title), ["Delivery completed", "Rider near destination"]);
  assert.match(feed.updates.find((entry) => entry.title === "Rider near destination").message, /arrival and handoff are not confirmed/i);
  assert.equal(feed.actions.find((entry) => entry.title === "Delivery failed").path, "/dispatcher/shipments?order=order-c");
  assert.equal(buildDispatcherNotificationFeed({ alerts: [], orders: [order], near, nowMs: now + 4 * 60_000 }).updates.length, 0,
    "a stale last fix cannot keep claiming the Rider is nearby");
});

test("an existing late alert is not duplicated by the delayed order status", () => {
  const late = { ...order, status: "delayed", statusUpdatedAt: start };
  const alert = { id: "late-a", type: "delivery_delay", status: "active", orderId: order.id, orderNumber: order.orderNumber, createdAt: start };
  const feed = buildDispatcherNotificationFeed({ alerts: [alert], orders: [late], near: {}, nowMs: start });
  assert.equal(feed.actions.length, 1);
  assert.equal(feed.actions[0].id, "late-a");
});
