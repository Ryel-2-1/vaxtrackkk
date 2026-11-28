import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const origin = "http://127.0.0.1:5193";
const endpoint = `${origin}/__system-explorer`;
const health = await fetch(`${endpoint}/health`).then((r) => r.json());
assert.equal(health.project, "demo-vaxtrack-explorer");
assert.equal(health.connected, true, "Start the Firestore emulator and the explorer first.");

function scenario(scenario) {
  const runId = randomUUID();
  const request = async (action, body = {}, role = "dispatcher") => {
    const res = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ runId, action, role, ...body }), signal: AbortSignal.timeout(90000),
    });
    return { status: res.status, data: await res.json() };
  };
  const send = async (...args) => {
    const { status, data } = await request(...args);
    assert.equal(status, 200, `${args[0]}: ${JSON.stringify(data)}`);
    return data;
  };
  const initial = () => send("init", { scenario });
  const eventually = async (check) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await initial();
      if (check(snapshot)) return snapshot;
      await wait(120);
    }
    assert.fail(`Timed out waiting for ${scenario} state.`);
  };
  return { runId, send, request, initial, eventually };
}

const fleet = scenario("fleet");
const r1 = { rider: "r1" };
await fleet.initial();
const stream = await fetch(`${endpoint}/events?runId=${fleet.runId}`);
assert.match(stream.headers.get("content-type"), /text\/event-stream/);
const reader = stream.body.getReader();
assert.match(new TextDecoder().decode((await reader.read()).value), /event: history/);
await reader.cancel();

await fleet.send("seed");
await fleet.eventually(({ orders, stock }) => orders.length === 10 && stock.reserved === 20);
const denied = await fleet.request("optimize", r1, "rider");
assert.equal(denied.status, 400);
await fleet.send("optimize", r1);
const planned = await fleet.eventually(({ routes, orders, riders }) =>
  routes.r1?.saved && riders[0].canDepart && orders.every((o) => o.status === "assigned")
);
assert.equal(planned.routes.r1.orderIds.length, 10);
assert.equal(new Set(planned.routes.r1.orderIds).size, 10);
assert.equal(planned.routes.r1.exact, false);

await fleet.send("depart", r1);
await fleet.eventually(({ orders, riders }) => orders.every((o) => o.status === "in_transit") && riders[0].custody === "on_trip");
await fleet.send("tick", r1, "rider");
const first = await fleet.eventually(({ riders }) => riders[0].location !== null);
const early = await fleet.request("checkIn", r1, "rider");
assert.equal(early.data.code, "delivery-outside-geofence");
await fleet.send("offline", r1, "rider");
await fleet.send("tick", r1, "rider");
await fleet.send("tick", r1, "rider");
const offline = await fleet.eventually(({ riders }) => riders[0].cached);
assert.deepEqual(offline.riders[0].location, first.riders[0].location);
await fleet.send("offline", r1, "rider");
await fleet.eventually(({ riders }) => !riders[0].cached && riders[0].location &&
  JSON.stringify(riders[0].location.capturedAt) !== JSON.stringify(first.riders[0].location.capturedAt)
);

await fleet.send("temperature", r1, "admin");
await fleet.eventually(({ alerts }) => alerts.some(({ type, status }) => type === "temperature_simulation" && status === "active"));
await fleet.send("temperature", r1, "admin");
await fleet.send("detour", r1, "rider");
for (let i = 0; i < 7; i++) await fleet.send("tick", r1, "rider");
await fleet.eventually(({ alerts }) => alerts.some(({ type, status }) => type === "route_deviation" && status === "active"));
await fleet.send("detour", r1, "rider");
for (let i = 0; i < 5; i++) await fleet.send("tick", r1, "rider");
await fleet.eventually(({ alerts }) => alerts.some(({ type, status }) => type === "route_deviation" && status === "resolved"));
await fleet.send("checkIn", r1, "rider");
await fleet.send("complete", r1, "rider");
const settled = await fleet.eventually(({ orders, stock }) => {
  const delivered = orders.find(({ status }) => status === "delivered");
  return delivered && stock.onHand === 24 - delivered.quantity && stock.reserved === 20 - delivered.quantity;
});
const delivered = settled.orders.find(({ status }) => status === "delivered");
assert.equal(settled.stock.onHand, 24 - delivered.quantity);
assert.equal(settled.stock.reserved, 20 - delivered.quantity);
assert.notEqual(settled.riders[0].activeOrderId, delivered.id);
console.log("Fleet: ten-stop trip, role separation, GPS stream, reconnect, temperature simulation, deviation/recovery, and delivery settlement passed.");

const shortage = scenario("shortage");
await shortage.initial();
await shortage.send("seed");
await shortage.eventually(({ orders, stock }) => stock.available === 0 && orders.some((order) => order.allocationState !== "fully_reserved"));
await shortage.send("stock", { quantity: 12 }, "admin");
await shortage.eventually(({ orders, stock }) => orders.every((order) => order.allocationState === "fully_reserved") && stock.reserved === 20);
await shortage.send("optimize", { rider: "fleet" });
const balanced = await shortage.eventually(({ orders, routes }) =>
  orders.length === 10 && orders.every((order) => order.assignedRiderId) && Object.keys(routes).length >= 2
);
assert.ok(new Set(balanced.orders.map((order) => order.assignedRiderId)).size >= 2);
console.log("Shortage: replenishment filled backorders and the lab assigned the restored load across riders.");

const windows = scenario("windows");
await windows.initial();
await windows.send("seed");
await windows.send("optimize", r1);
const conflict = await windows.eventually(({ routes }) => routes.r1?.allMet === false);
assert.equal(conflict.routes.r1.saved, false);
await windows.send("optimize", { ...r1, acceptConflicts: true });
await windows.eventually(({ routes, riders }) => routes.r1?.saved && riders[0].canDepart);
console.log("Arrival windows: the planner surfaced conflicting deadlines and saved the plan only after explicit approval.");
