import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { orderArrivalNote } from "../src/services/requestedArrival.js";
import { buildAssignmentQueue } from "../src/services/assignmentQueue.js";
import { historyRow } from "../src/services/orderHistory.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const order = {
  id: "qa", status: "pending_dispatch", requestedDeliveryDate: "2026-10-28",
  requestedArrival: { version: 1, mode: "window", start: "10:00", end: "11:00" },
};

test("every arrival mode uses destination-request wording and explicit Philippine time", () => {
  const cases = [
    [{ mode: "window", start: "10:00", end: "11:00" }, "Within 10:00 AM–11:00 AM"],
    [{ mode: "before", time: "09:00" }, "Before 9:00 AM"],
    [{ mode: "exact", time: "12:00" }, "Exactly 12:00 noon"],
    [{ mode: "any_time" }, "Within the requested day"],
  ];
  for (const [requestedArrival, label] of cases) {
    assert.equal(orderArrivalNote({ ...order, requestedArrival }), `Requested arrival: Oct 28, 2026 · ${label} (PHT)`);
  }
});

test("different orders retain their own windows; no global or current-order preference leaks", () => {
  const second = { ...order, id: "other", requestedArrival: { mode: "window", start: "14:00", end: "15:30" } };
  assert.match(orderArrivalNote(order), /10:00 AM–11:00 AM/);
  assert.match(orderArrivalNote(second), /2:00 PM–3:30 PM/);
  assert.match(orderArrivalNote(order), /10:00 AM–11:00 AM/);
});

test("older orders never inherit a timed window or invent a midnight arrival", () => {
  assert.equal(orderArrivalNote({}), "Requested arrival: not specified");
  assert.equal(orderArrivalNote(null), "Requested arrival: not specified");
  assert.equal(orderArrivalNote({ requestedDeliveryDate: "2026-10-28" }), "Requested arrival: Oct 28, 2026 · Within the requested day (PHT)");
});

test("a malformed stored preference is visible as unavailable, not silently changed to any time", () => {
  for (const requestedArrival of ["10:00", { mode: "unknown" }, { mode: "window", start: "11:00", end: "10:00" }, { version: 2, mode: "exact", time: "10:00" }]) {
    assert.equal(orderArrivalNote({ ...order, requestedArrival }), "Requested arrival: unavailable — check order");
  }
});

test("historical requests still display after their day/cutoff; midnight never moves the date", () => {
  assert.equal(orderArrivalNote({ ...order, requestedDeliveryDate: "2020-01-01", requestedArrival: { mode: "exact", time: "00:00" } }),
    "Requested arrival: Jan 1, 2020 · Exactly 12:00 midnight (PHT)");
});

test("an Admin's new schedule and route ETA cannot rewrite the original arrival request", () => {
  const scheduled = { ...order, originalRequestedDeliveryDate: "2026-10-27", requestedDeliveryDate: "2026-10-30", scheduledDeliveryTime: "15:00", routeEtaText: "4:00 PM", timingStatus: "delayed" };
  const before = JSON.stringify(scheduled);
  assert.equal(orderArrivalNote(scheduled), "Requested arrival: Oct 27, 2026 · Within 10:00 AM–11:00 AM (PHT)");
  assert.equal(JSON.stringify(scheduled), before, "presentation never writes timing or lifecycle fields");
});

test("Admin Deliveries normalization retains arrival fields for the list and detail drawer", () => {
  const page = read("src/pages/admin/Deliveries.jsx");
  const fn = page.slice(page.indexOf("function normalizeDelivery("), page.indexOf("function formatDateTime("));
  const normalized = runInNewContext(`${fn}\nnormalizeDelivery(raw)`, { raw: order });
  assert.equal(normalized.requestedArrival.start, "10:00");
  assert.equal(normalized.requestedDeliveryDate, "2026-10-28");
  assert.equal((page.match(/<RequestedArrivalNote order=\{delivery\} \/>/g) ?? []).length, 2);
});

test("assignment queue and shared order history retain each order's request without extra reads", () => {
  const queue = buildAssignmentQueue({ orders: [order], now: new Date("2026-10-28T00:00:00Z") });
  assert.equal(queue[0].requestedArrival, order.requestedArrival);
  assert.equal(historyRow(order).order.requestedArrival, order.requestedArrival);
});

test("all newly covered web rows use one shared, wrapping arrival note", () => {
  const surfaces = {
    "src/pages/admin/AdminDashboard.jsx": "o",
    "src/pages/admin/Deliveries.jsx": "delivery",
    "src/pages/admin/AdminAllocation.jsx": "order",
    "src/pages/salesRep/SalesRepDashboard.jsx": "o",
    "src/pages/salesRep/SalesRepOrderTracking.jsx": "order",
    "src/pages/dispatcher/DispatcherAssignRider.jsx": "o",
    "src/pages/dispatcher/DispatcherShipments.jsx": "order",
    "src/components/history/OrderHistoryView.jsx": "row.order",
  };
  for (const [path, value] of Object.entries(surfaces)) {
    assert.ok(read(path).includes(`<RequestedArrivalNote order={${value}} />`), path);
  }
  for (const path of ["src/pages/admin/AdminDashboard.jsx", "src/pages/salesRep/SalesRepDashboard.jsx"]) {
    const page = read(path);
    for (const field of ["requestedArrival", "requestedDeliveryDate", "originalRequestedDeliveryDate"]) assert.ok(page.includes(`${field}: o.${field}`), `${path}: ${field}`);
  }
  const component = read("src/components/schedule/RequestedArrivalNote.jsx");
  assert.match(component, /orderArrivalNote\(order\)/);
  assert.match(component, /not a guaranteed ETA/);
  assert.doesNotMatch(component, /fetch\(|subscribe|updateDoc|setDoc|httpsCallable/);
  const css = read("src/components/schedule/RequestedArrivalNote.css");
  assert.match(css, /white-space: normal/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /(?:^|\n)\s*(?:position|min-width|height):/);
});

test("Geofence routing is time-aware and says what it does with requested arrival times", () => {
  const page = read("src/pages/dispatcher/DispatcherGeofence.jsx");
  // Single route: the arrival is checked against the request (with the traffic buffer).
  assert.match(page, /the arrival is checked against the requested time/);
  assert.match(page, /arrivalCheck\(selected, new Date\(genAt\.getTime\(\) \+ buffered \* 60000\)\)/);
  // Re-optimize: the shared time-aware planner, from the live position, departure = now.
  assert.match(page, /Re-optimize plans from the rider's live position now, ordering stops to meet requested arrival times, and replaces the saved trip/);
  assert.match(page, /const result = planTrip\(\{[\s\S]*fixedDeparture: clock\.minute,[\s\S]*slackMinutes: DEADLINE_SLACK_MINUTES,/);
  assert.equal(/optimizeTrip\(/.test(page), false, "the shortest-ride-only optimizer is no longer used here");
  assert.equal((page.match(/\{ROUTE_TIMING_NOTICE\}/g) ?? []).length, 1);
  assert.equal((page.match(/\{TRIP_TIMING_NOTICE\}/g) ?? []).length, 1);
});
