import test from "node:test";
import assert from "node:assert/strict";
import { activeAlertCountOfType, filterAdminAlerts } from "../src/services/adminAlertCategories.js";

const alerts = [
  { typeKey: "route_deviation", type: "Route Deviation", searchText: "Rider A", status: "active", severity: "critical" },
  { typeKey: "route_deviation", type: "Route Deviation", searchText: "Rider B", status: "resolved", severity: "critical" },
  { typeKey: "delivery_delay", type: "Delayed Delivery", searchText: "Order C", status: "active", severity: "warning" },
  { typeKey: "rider_location_stale", type: "Location Not Updating", searchText: "Rider D", status: "active", severity: "warning" },
];

test("category counts include only active records of the stored type", () => {
  assert.equal(activeAlertCountOfType(alerts, "route_deviation"), 1);
  assert.equal(activeAlertCountOfType(alerts, "delivery_delay"), 1);
  assert.equal(activeAlertCountOfType(alerts, "rider_location_stale"), 1);
  assert.equal(activeAlertCountOfType(alerts, "low_stock"), 0);
});

test("selecting a category shows its active records even when a resolved record shares its label", () => {
  assert.deepEqual(filterAdminAlerts(alerts, { typeFilter: "route_deviation" }), [alerts[0]]);
  assert.deepEqual(filterAdminAlerts(alerts, { typeFilter: "delivery_delay" }), [alerts[2]]);
  assert.deepEqual(filterAdminAlerts(alerts, { typeFilter: "rider_location_stale" }), [alerts[3]]);
  assert.deepEqual(filterAdminAlerts(alerts, { typeFilter: "low_stock" }), []);
});

test("search and severity still combine with category selection", () => {
  assert.deepEqual(filterAdminAlerts(alerts, { searchTerm: "rider a", severityFilter: "critical", typeFilter: "route_deviation" }), [alerts[0]]);
  assert.deepEqual(filterAdminAlerts(alerts, { severityFilter: "resolved", typeFilter: "route_deviation" }), []);
  assert.deepEqual(filterAdminAlerts(alerts, { severityFilter: "resolved" }), [alerts[1]]);
});
