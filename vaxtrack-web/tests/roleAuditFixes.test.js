import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quantityText } from "../src/services/quantityText.js";
import { orderVaccineNames } from "../src/services/orderLabel.js";
import { lateNotice } from "../src/services/deliveryTiming.js";
import { friendlyTime } from "../src/services/alertPresentation.js";
import { historyRow, fulfilmentStage } from "../src/services/orderHistory.js";
import { arrivalGeofence } from "../src/services/destinationFreshness.js";
import { evaluateBatchEligibility } from "../src/services/orderEligibility.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("one vial is singular, and other units are left alone", () => {
  assert.equal(quantityText(1), "1 vial");
  assert.equal(quantityText(1, "vials"), "1 vial");
  assert.equal(quantityText(2, "vial"), "2 vials");
  assert.equal(quantityText(1560), "1,560 vials");
  assert.equal(quantityText(0), "0 vials");
  assert.equal(quantityText(1, "boxes"), "1 boxes");
});

test("a batch expiring today can't be ordered; tomorrow still can", () => {
  const batch = { id: "b", quantity: 10, reservedQuantity: 0, status: "Stable", vatClassification: "vatable", sellingPriceCentavos: 50000, priceIsVatInclusive: true };
  const today = evaluateBatchEligibility({ ...batch, expiryDate: "2026-11-07" }, "2026-11-07");
  assert.equal(today.eligible, false);
  assert.equal(today.reasonCode, "expires-today");
  assert.equal(evaluateBatchEligibility({ ...batch, expiryDate: "2026-11-08" }, "2026-11-07").eligible, true);
});

test("the Analytics filter lists real vaccines, never an order's summary", () => {
  assert.deepEqual(orderVaccineNames({ vaccineName: "ARV +1 more", items: [{ name: "ARV" }, { name: "PCX" }, { name: "ARV" }] }), ["ARV", "PCX"]);
  assert.deepEqual(orderVaccineNames({ vaccineName: "ARV +3 more" }), ["ARV"]);
  assert.deepEqual(orderVaccineNames({}), []);
  assert.match(read("src/pages/admin/Analytics.jsx"), /allOrders\.flatMap\(orderVaccineNames\)/);
});

test("the Med Rep is told when an order is late, as a new update", () => {
  assert.equal(lateNotice({ status: "in_transit" }), null);
  assert.equal(lateNotice({ status: "in_transit", timingStatus: "delayed" }), "running_late");
  assert.equal(lateNotice({ status: "loading", requestedArrivalMissedAt: 1 }), "past_requested");
  assert.equal(lateNotice({ status: "delivered", requestedArrivalMissedAt: 1 }), null);
  const alert = read("src/services/salesRepOrderAlert.js");
  assert.match(alert, /tag = "NEEDS ATTENTION";\s+title = `\$\{late \? "Running Late"/);
  assert.match(alert, /notice \? ":late" : ""/);
});

test("Order Tracking keeps the order's real arrival radius", () => {
  const src = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  for (const field of ["destinationLat", "destinationLng", "destinationGeofenceRadiusM", "clinicGeofenceRadiusM"]) {
    assert.ok(src.includes(`${field}: raw.${field}`), field);
  }
  assert.deepEqual(arrivalGeofence({ destinationLat: 14, destinationLng: 121, destinationGeofenceRadiusM: 50 }), { latLng: [14, 121], radiusM: 50, defaultRadius: false });
});

test("In Transit is one word everywhere, and a failed order shows no percentage", () => {
  const src = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.doesNotMatch(src, /Out for Delivery/);
  assert.match(src, /case "delivery_failed":\s+return \{ progress: 0, indeterminate: false, text: "Failed" \};/);
});

test("Order History: a released order doesn't claim to be reserved, and a ready one reads Pending dispatch", () => {
  const cancelled = historyRow({ id: "o", status: "cancelled", allocationVersion: 2, allocationState: "fully_reserved", items: [] });
  assert.equal(cancelled.allocationLabel, "Released");
  assert.equal(cancelled.allocationReleased, true);
  assert.equal(fulfilmentStage({ status: "pending_dispatch", allocationVersion: 2, allocationState: "fully_reserved" }).label, "Pending dispatch");
});

test("yesterday means the previous calendar day in Manila", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(friendlyTime(at("2026-11-06T10:00:00+08:00"), at("2026-11-07T12:00:00+08:00")), "yesterday");
  assert.notEqual(friendlyTime(at("2026-11-05T04:00:00+08:00"), at("2026-11-07T03:00:00+08:00")), "yesterday");
});

test("Delayed counts automatic delays on Shipments, without double-counting Active", () => {
  const src = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(src, /const late = orders\.filter\(isRunningLate\);/);
  assert.match(src, /count: grouped\.late\.length/);
  assert.doesNotMatch(src, /grouped\.late\.length \+/);
});

test("the geofence panel never ticks a plan beside a late order, and the stale routing note is gone", () => {
  assert.match(read("src/pages/dispatcher/DispatcherGeofence.jsx"), /!selected\.requestedArrivalMissedAt && !isRunningLate\(selected\)/);
  assert.doesNotMatch(read("src/pages/dispatcher/DispatcherCargoLoading.jsx"), /Live route mapping/);
});

test("phones: Med Rep tables become labelled cards, and the side menu reaches every page", () => {
  for (const f of [
    "src/pages/salesRep/SalesRepDashboard.jsx",
    "src/pages/salesRep/SalesRepInventory.jsx",
    "src/pages/salesRep/SalesRepRequestOrder.jsx",
    "src/pages/salesRep/SalesRepOrderTracking.jsx",
    "src/components/history/OrderHistoryView.jsx",
    "src/pages/dispatcher/DispatcherShipments.jsx",
    "src/pages/dispatcher/DispatcherDashboard.jsx",
  ]) {
    const src = read(f);
    assert.match(src, /m-phone-cards/, f);
    assert.match(src, /data-label="/, f);
  }
  const shell = read("src/pages/salesRep/SalesRepShell.jsx");
  // Phones use the same off-canvas side menu as Admin and Dispatcher (2026-11-10):
  // every page and Logout live in it; the old bottom bar and More menu are gone.
  const menu = shell.slice(shell.indexOf('<aside'), shell.indexOf("</aside>"));
  for (const page of ["", "/inventory", "/request-order", "/order-tracking", "/live-monitoring", "/order-history", "/alerts", "/settings"]) {
    assert.ok(menu.includes(`to="/sales-rep${page}"`), page || "dashboard");
  }
  assert.match(menu, /className="salesrep-logout"/);
  assert.match(shell, /className="salesrep-nav-toggle"/);
  assert.match(shell, /nextNavState/);
  assert.doesNotMatch(shell, /salesrep-more|salesrep-nav-more/);
  const css = read("src/styles/shell-chrome.css");
  assert.match(css, /aside\.salesrep-sidebar\.salesrep-nav-open \{/);
  assert.doesNotMatch(css, /salesrep-more|salesrep-nav-more/);
  assert.match(css, /#root aside \.m-brand,[\s\S]{0,80}color: #ffffff !important;/, "white wordmark at every width");
});
