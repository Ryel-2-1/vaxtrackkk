import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDispatcherNotificationFeed } from "../src/services/dispatcherNotificationFeed.js";
import { presentAlert } from "../src/services/alertPresentation.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MIN = 60_000;
const start = 1_800_000_000_000;
const order = {
  id: "order-a", orderNumber: "VT-ORD-1800000000000-ABCD", status: "in_transit",
  assignedRiderId: "rider-a", assignedRiderName: "Rider A", clinicName: "Clinic A",
};
// The server's arrivalProximity document (functions/src/arrivalProximityOps.js).
const nearDoc = (over = {}) => ({
  orderId: order.id, riderUid: "rider-a", firstFixMs: start, lastFixMs: start + 2 * MIN,
  confirmedAtMs: start + 2 * MIN, radiusM: 300, distanceM: 40, ...over,
});

test("near-destination is decided on the server; the browser only presents it", () => {
  const feed = read("src/services/dispatcherNotificationFeed.js");
  assert.doesNotMatch(feed, /advanceNearDestinations|distanceMeters|NEAR_WAIT_MS|near-wait/);
  const layout = read("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.match(layout, /subscribeArrivalProximity\(/);
  assert.match(layout, /subscribeNotificationOrders\(/);
  assert.doesNotMatch(layout, /subscribeAllRiderLocations|subscribeDeliveries\(/, "never every Rider's location or every order");
});

test("Dispatcher feed separates operational work from recent shipment updates", () => {
  const now = start + 3 * MIN;
  const near = { [order.id]: nearDoc({ lastFixMs: now }) };
  const delivered = { ...order, id: "order-b", orderNumber: "VT-ORD-1800000000000-WXYZ", status: "delivered", deliveredAt: now - 30_000 };
  const failed = { ...order, id: "order-c", status: "delivery_failed", deliveryFailedAt: now - 30_000 };
  const feed = buildDispatcherNotificationFeed({ alerts: [], orders: [order, delivered, failed], near, nowMs: now });
  assert.deepEqual(feed.actions.map((entry) => entry.title), ["Delivery failed"]);
  assert.deepEqual(feed.updates.map((entry) => entry.title), ["Delivery completed", "Rider near destination"]);
  assert.match(feed.updates.find((entry) => entry.title === "Rider near destination").message, /within 300 m of Clinic A.*arrival and handoff are not confirmed/i);
  assert.equal(feed.actions.find((entry) => entry.title === "Delivery failed").path, "/dispatcher/shipments?order=order-c");
  assert.equal(buildDispatcherNotificationFeed({ alerts: [], orders: [order], near, nowMs: now + 4 * MIN }).updates.length, 0,
    "a stale last fix cannot keep claiming the Rider is nearby");
  assert.equal(buildDispatcherNotificationFeed({ alerts: [], orders: [order], near: { [order.id]: nearDoc({ confirmedAtMs: null, lastFixMs: now }) }, nowMs: now }).updates.length, 0,
    "unconfirmed proximity is not announced");
  assert.equal(buildDispatcherNotificationFeed({ alerts: [], orders: [{ ...order, assignedRiderId: "rider-b" }], near, nowMs: now }).updates.length, 0,
    "proximity of a previous Rider does not carry over");
});

test("the 15-minute follow-up is the server's alert, presented like the other order alerts", () => {
  const alert = {
    id: `awaiting_completion_${order.id}_${start}`, type: "delivery_awaiting_completion", status: "active",
    orderId: order.id, orderNumber: order.orderNumber, riderName: "Rider A", createdAt: start + 17 * MIN,
    message: "Rider A has been within 300 m of Clinic A for 15 minutes, but Order VT-ORD-1800000000000-ABCD has not been completed. Check with the rider.",
    path: `/dispatcher/shipments?order=${order.id}`,
  };
  const feed = buildDispatcherNotificationFeed({ alerts: [alert], orders: [order], near: {}, nowMs: start + 18 * MIN });
  assert.deepEqual(feed.actions.map((entry) => entry.title), ["Delivery still awaiting completion"]);
  assert.equal(feed.actions[0].path, `/dispatcher/shipments?order=${order.id}`);
  const admin = presentAlert(alert, { role: "admin" });
  assert.equal(admin.path, `/admin/deliveries?order=${order.id}`);
  assert.match(presentAlert({ ...alert, status: "resolved", resolutionReason: "delivered" }).message, /was delivered/);
  assert.match(presentAlert({ ...alert, status: "resolved", resolutionReason: "reassigned" }).message, /no longer waiting at the destination/);
});

test("an existing late alert is not duplicated by the delayed order status", () => {
  const late = { ...order, status: "delayed", statusUpdatedAt: start };
  const alert = { id: "late-a", type: "delivery_delay", status: "active", orderId: order.id, orderNumber: order.orderNumber, createdAt: start };
  const feed = buildDispatcherNotificationFeed({ alerts: [alert], orders: [late], near: {}, nowMs: start });
  assert.equal(feed.actions.length, 1);
  assert.equal(feed.actions[0].id, "late-a");
});
