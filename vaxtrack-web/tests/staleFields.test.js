// Fields that used to read stale or permanently blank, now traced to their
// data: Rider activity (Admin Riders), clinic last delivery (Admin Clinics),
// order references in notification text, and ids in stored alert text.
//
// Behaviour of the pure helpers, plus source contracts for the page wiring
// (no DOM renderer is installed in this repo).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  capitalizedOrderPhrase,
  orderDestination,
  orderNumberPhrase,
  orderPhrase,
  orderReference,
} from "../src/services/orderLabel.js";
import {
  fleetOnTime,
  lastLocationText,
  onTimeText,
  ordersByRider,
  riderActivity,
} from "../src/services/riderActivity.js";
import {
  NO_DELIVERY_TEXT,
  lastDeliveryIndex,
  lastDeliveryMs,
  lastDeliveryText,
} from "../src/services/clinicDeliveries.js";
import { presentAlert, withoutIds } from "../src/services/alertPresentation.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ts = (ms) => ({ toMillis: () => ms });

// 2026-10-22 10:00 Manila = 02:00Z
const NOW = Date.parse("2026-10-22T02:00:00.000Z");
const DOC_ID = "Xcsdhfyu7Q2LmNpR4sTa"; // 20-char Firestore auto id
const RIDER_UID = "JhcalvLPzkXSZrJCeVDblBe4Dyh2"; // 28-char Auth uid

// ------------------------------------------------------------ order references

test("an order is named by its number, else its destination — never its document id", () => {
  const numbered = { id: DOC_ID, orderNumber: "VT-ORD-1791550071889-XCSD", clinicName: "Halang Clinic" };
  const bare = { id: DOC_ID, clinicName: "  Halang Clinic " };
  const nothing = { id: DOC_ID };

  assert.equal(orderReference(numbered), "VT-ORD-1791550071889-XCSD");
  assert.equal(orderReference(bare), "this order");
  assert.equal(orderReference(nothing, "No order number"), "No order number");
  assert.equal(orderDestination(bare), "Halang Clinic");
  assert.equal(orderDestination({ destinationName: "Dr. Cruz (home)" }), "Dr. Cruz (home)");

  assert.equal(orderPhrase(numbered), "Order VT-ORD-1791550071889-XCSD");
  assert.equal(orderPhrase(bare), "the order for Halang Clinic");
  assert.equal(orderPhrase(nothing), "this order");
  assert.equal(capitalizedOrderPhrase(bare), "The order for Halang Clinic");
  assert.equal(orderNumberPhrase(numbered), "Order VT-ORD-1791550071889-XCSD");
  assert.equal(orderNumberPhrase(nothing), "This order");

  for (const o of [numbered, bare, nothing]) {
    for (const text of [orderReference(o), orderPhrase(o), capitalizedOrderPhrase(o), orderNumberPhrase(o)]) {
      assert.equal(text.includes(DOC_ID), false, text);
    }
  }
});

test("notification surfaces use the shared reference, not `orderNumber || id`", () => {
  for (const f of [
    "src/pages/dispatcher/DispatcherShipments.jsx",
    "src/pages/salesRep/SalesRepAlerts.jsx",
    "src/components/schedule/DeliveryCalendar.jsx",
    "src/pages/admin/MedRepTerritoryDialog.jsx",
    "src/pages/dispatcher/DestinationCorrectionDialog.jsx",
    "src/services/deliveryTiming.js",
    "src/services/riderTracking.js",
  ]) {
    const src = read(f);
    assert.equal(/orderNumber \|\| (order|o)\.id\b/.test(src), false, `${f} falls back to the document id`);
    assert.match(src, /from "(\.\.\/)*(\.\/|\.\.\/services\/|\.\.\/\.\.\/services\/)orderLabel(\.js)?"/, `${f} uses orderLabel`);
  }
  const editor = read("src/pages/admin/InvoiceEditor.jsx");
  assert.equal(editor.includes("order?.orderNumber || orderId"), false, "invoice confirmations never name the document id");
});

// ------------------------------------------------------------ rider activity

const rider = { uid: "r1", statusRaw: "approved" };
const delivered = (over = {}) => ({ statusKey: "delivered", assignedRiderId: "r1", ...over });

test("delivered today, on-time rate and current orders come from the Rider's own orders", () => {
  const orders = [
    // today (Manila), on time
    delivered({ orderNumber: "VT-1", deliveredAt: ts(Date.parse("2026-10-22T01:00:00Z")), requestedDeliveryDate: "2026-10-22" }),
    // yesterday Manila (23:30 local), late
    delivered({ orderNumber: "VT-2", deliveredAt: ts(Date.parse("2026-10-21T15:30:00Z")), requestedDeliveryDate: "2026-10-20" }),
    // legacy: no requested date — delivered, but not measured
    delivered({ orderNumber: "VT-3", deliveredAt: ts(Date.parse("2026-10-22T00:30:00Z")) }),
    { statusKey: "in_transit", assignedRiderId: "r1", orderNumber: "VT-4" },
    { statusKey: "assigned", assignedRiderId: "r1", id: DOC_ID },
    { statusKey: "cancelled", assignedRiderId: "r1", orderNumber: "VT-6" },
  ];
  const a = riderActivity({ rider, orders, tripState: { state: "on_trip", orderIds: ["x"] }, nowMs: NOW });
  assert.equal(a.deliveredToday, 2, "VT-1 and VT-3 were delivered on 2026-10-22 Manila");
  assert.deepEqual([a.onTime.measured, a.onTime.onTime], [2, 1], "VT-3 has no requested date and is not measured");
  assert.equal(a.onTimeText, "50% (1 of 2)");
  assert.deepEqual(a.currentOrders, ["VT-4", "Order without a reference"], "never the document id");
  assert.equal(a.trip.label, "On a trip");
});

test("no data reads as no data — never a made-up zero or rate", () => {
  const a = riderActivity({ rider, orders: [], nowMs: NOW });
  assert.equal(a.deliveredToday, 0);
  assert.equal(a.onTime.rate, null);
  assert.equal(a.onTimeText, "No measured deliveries yet");
  assert.equal(a.lastLocation, "No location received yet");
  assert.equal(a.trip.label, "Trip status not confirmed yet", "an unclassified Rider is not claimed to be at the hub");
  assert.equal(onTimeText(null), "No measured deliveries yet");
  // Only approved Riders have a trip; others are described by their account status.
  assert.equal(riderActivity({ rider: { uid: "r2", statusRaw: "pending" }, nowMs: NOW }).trip, null);
});

test("the last location is the newest fix the rider app sent, labelled as such", () => {
  assert.equal(lastLocationText({ capturedAt: ts(NOW - 4 * 60000) }, NOW), "4m ago");
  // The OLDER of capture / write time, as on Live Tracking: a fix queued
  // offline and written late is shown as old, never as live.
  assert.equal(lastLocationText({ capturedAt: ts(NOW - 2 * 3600000), updatedAt: ts(NOW - 60000) }, NOW), "2h ago");
  assert.equal(lastLocationText({ capturedAt: ts(NOW - 5 * 60000), trackingState: "ended" }, NOW), "5m ago (tracking ended)");
  assert.equal(lastLocationText(undefined, NOW), "No location received yet");
});

test("orders are grouped by assigned Rider; the fleet rate counts only delivered orders that had a Rider", () => {
  const map = ordersByRider([{ assignedRiderId: "a" }, { assignedRiderId: "a" }, { assignedRiderId: "" }, {}, { assignedRiderId: "b" }]);
  assert.deepEqual([...map.keys()], ["a", "b"]);
  assert.equal(map.get("a").length, 2);
  const fleet = fleetOnTime([
    delivered({ deliveredAt: ts(Date.parse("2026-10-20T02:00:00Z")), requestedDeliveryDate: "2026-10-20" }),
    { statusKey: "delivered", deliveredAt: ts(Date.parse("2026-10-20T02:00:00Z")), requestedDeliveryDate: "2026-10-19" },
  ]);
  assert.deepEqual([fleet.measured, fleet.onTime], [1, 1], "an order without a Rider is not a Rider's delivery");
});

test("the Riders page shows the computed figures and no hard-coded placeholders", () => {
  const page = read("src/pages/admin/Riders.jsx");
  for (const stale of ['lastActive: "—"', 'onTimeRate: "—"', "deliveriesToday: 0", 'currentDelivery: "None"', '"Available at Hub"', "Last active:"]) {
    assert.equal(page.includes(stale), false, `${stale} is gone`);
  }
  assert.match(page, /subscribeDeliveries\(/);
  assert.match(page, /subscribeRiderDispatchStates\(/);
  assert.match(page, /subscribeAllRiderLocations\(/);
  assert.match(page, /riderActivity\(\{/);
  assert.match(page, /Last location update/);
  assert.match(page, /Not measured yet/, "route compliance says it is not measured");
});

// ------------------------------------------------------------ clinic last delivery

test("a clinic's last delivery is its newest delivered order, by clinic id or (legacy) exact name", () => {
  const orders = [
    { statusKey: "delivered", clinicDocId: "c1", clinicName: "Alpha", deliveredAt: ts(Date.parse("2026-10-01T02:00:00Z")) },
    { statusKey: "delivered", clinicDocId: "c1", clinicName: "Alpha", deliveredAt: ts(Date.parse("2026-10-15T02:00:00Z")) },
    { statusKey: "in_transit", clinicDocId: "c1", deliveredAt: ts(Date.parse("2026-10-20T02:00:00Z")) },
    // legacy order: name only
    { statusKey: "delivered", clinicName: " beta ", deliveredAt: ts(Date.parse("2026-09-30T02:00:00Z")) },
    // a home delivery with a clinic-like name is not a clinic delivery
    { statusKey: "delivered", destinationType: "home", clinicName: "Gamma", deliveredAt: ts(Date.parse("2026-10-10T02:00:00Z")) },
    { statusKey: "delivered", clinicDocId: "c4" }, // no deliveredAt: not counted
  ];
  const index = lastDeliveryIndex(orders);
  const at = (c) => lastDeliveryMs(index, c);
  assert.equal(at({ firestoreId: "c1", name: "Alpha" }), Date.parse("2026-10-15T02:00:00Z"), "the newest delivered one; in-transit ignored");
  assert.equal(at({ firestoreId: "c2", name: "Beta" }), Date.parse("2026-09-30T02:00:00Z"), "legacy name match");
  assert.equal(at({ firestoreId: "c3", name: "Gamma" }), null, "home deliveries are not clinic deliveries");
  assert.equal(at({ firestoreId: "c4", name: "Delta" }), null);
  assert.equal(lastDeliveryText(Date.parse("2026-10-15T02:00:00Z")), "Oct 15, 2026");
  assert.equal(lastDeliveryText(null), NO_DELIVERY_TEXT);
});

// ------------------------------------------------------------ ids in stored alert text

test("stored alert text never shows a document id or uid", () => {
  const raw = { id: "alertDoc0000000000001", orderId: DOC_ID, riderId: RIDER_UID, riderName: "Abdul Malik", orderNumber: "VT-ORD-1791550071889-XCSD" };
  assert.equal(
    withoutIds(`Order ${DOC_ID} with ${RIDER_UID} is late.`, raw),
    "Order XCSD with Abdul Malik is late."
  );
  assert.equal(withoutIds(`Order ${DOC_ID} is late.`, { orderId: DOC_ID }), "This order is late.");
  assert.equal(withoutIds(`Rider left the route for order ${DOC_ID}.`, { orderId: DOC_ID }), "Rider left the route for this order.");
  assert.equal(withoutIds("Batch ABCDEFGHIJ0123456789 needs review.", {}), "Batch a record needs review.");
  // Ordinary words, order numbers and short codes are untouched.
  const plain = "Order VT-ORD-1791550071889-XCSD to Halang Clinic is 12 minutes past its expected arrival.";
  assert.equal(withoutIds(plain, {}), plain);

  const late = presentAlert(
    { type: "delivery_delay", status: "active", orderId: DOC_ID, riderName: "Abdul Malik", message: `Order ${DOC_ID} with Abdul Malik to Halang Clinic was expected by 2:00 PM.` },
    { role: "dispatcher", nowMs: NOW }
  );
  assert.equal(late.message.includes(DOC_ID), false);
  const other = presentAlert({ type: "custom", title: `Check ${DOC_ID}`, message: `Rider ${RIDER_UID} paused.`, riderId: RIDER_UID }, { nowMs: NOW });
  assert.equal(`${other.title} ${other.message}`.includes(DOC_ID) || `${other.title} ${other.message}`.includes(RIDER_UID), false);
});

// ------------------------------------------------------------ Med Rep names

test("a Med Rep is named from a snapshot or the directory — never by uid", () => {
  const view = read("src/components/history/OrderHistoryView.jsx");
  assert.equal(view.includes("row.medRepUid || \"—\""), false, "the uid is no longer the fallback");
  assert.match(view, /medRepLabel\.get\(row\.medRepUid\)/);
  const svc = read("src/services/orderHistoryService.js");
  assert.equal(/\|\| u\.id \}\)/.test(svc), false, "the filter label never falls back to the uid");
  const invoices = read("src/pages/admin/Invoices.jsx");
  assert.match(invoices, /subscribeMedReps\(/);
  assert.match(invoices, /labels\.get\(r\.salesRepUid\)/);
});

// ------------------------------------------------------------ Alerts categories

test("Alerts category counts are of active alerts and say so when a category is not monitored", () => {
  const page = read("src/pages/admin/Alerts.jsx");
  assert.equal(page.includes('alert.type.includes("Delivery")'), false, "the delivery count no longer includes resolved alerts");
  assert.match(page, /delivery: kpi\(activeOfType\("Delayed Delivery"\)\)/);
  assert.match(page, /No automatic stock alerts yet/);
  assert.equal(page.includes("System areas being monitored"), false);
});
