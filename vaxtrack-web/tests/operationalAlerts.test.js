// Operational alerts on every notification surface (Admin Alerts, its detail
// dialog, the Dispatcher bell and dashboard): the stale-location incident and
// the late-delivery alert's resolution. Pure presentation + source contracts;
// the server decisions are tested in functions/test (unit + emulator).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { presentAlert, staleLocationText } from "../src/services/alertPresentation.js";

const require = createRequire(import.meta.url);
const server = require("../functions/src/riderLocationStale.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const NOW = Date.parse("2026-10-27T03:00:00Z");
const ms = (m) => ({ toMillis: () => m });
const RIDER_UID = "Xq9LmN2pQr7sTu4vWx1yZa3bCd5e";
const TRIP_ID = "Ab12Cd34Ef56Gh78Ij90";
const stale = (over = {}) => ({
  id: `rider_location_stale_${RIDER_UID}_${TRIP_ID}`,
  type: "rider_location_stale",
  status: "active",
  read: false,
  severity: "warning",
  riderId: RIDER_UID,
  riderName: "Ana Cruz",
  tripId: TRIP_ID,
  orderCount: 3,
  staleMinutesAtDetection: 12,
  lastFixAt: ms(NOW - 15 * 60000),
  createdAt: ms(NOW - 3 * 60000),
  // A stored message is never shown raw for this type.
  message: `rider ${RIDER_UID} at 14.59951, 120.98421 trip ${TRIP_ID}`,
  path: `/dispatcher/live-tracking?rider=${RIDER_UID}`,
  ...over,
});

test("a stale-location alert reads as a person would say it — no id, coordinate or place", () => {
  const view = presentAlert(stale(), { role: "admin", nowMs: NOW });
  assert.equal(view.title, "Rider location not updating");
  assert.equal(view.message, "Ana Cruz's location hasn't updated for 12 minutes during a delivery trip. Check that the rider app is open and has signal.");
  assert.equal(view.statusLabel, "Active");
  assert.deepEqual(view.meta, ["Rider: Ana Cruz", "3 minutes ago"]);
  assert.deepEqual(view.details, [
    { label: "Rider", value: "Ana Cruz" },
    { label: "Orders on the trip", value: "3" },
    { label: "Last location update", value: "15 minutes ago" },
    { label: "Detected", value: "3 minutes ago" },
  ]);
  const shown = [view.title, view.message, view.metaText, ...view.details.map((d) => d.value)].join(" ");
  assert.doesNotMatch(shown, new RegExp(`${RIDER_UID}|${TRIP_ID}|14\\.59|120\\.98`));
  const noFix = presentAlert(stale({ lastFixAt: null }), { nowMs: NOW });
  assert.equal(noFix.details.find((d) => d.label === "Last location update").value, "None since the trip left");
});

test("resolved stale alerts say why; the deep link opens Live Tracking on that rider, per role", () => {
  const back = presentAlert(stale({ status: "resolved", resolutionReason: "location_updating", resolvedAt: ms(NOW - 60000) }), { nowMs: NOW });
  assert.deepEqual([back.title, back.message, back.statusLabel], ["Rider location updating again", "Ana Cruz's location is updating again.", "Resolved"]);
  const ended = presentAlert(stale({ status: "resolved", resolutionReason: "trip_ended" }), { nowMs: NOW });
  assert.equal(ended.message, "Ana Cruz's trip has ended, so location monitoring stopped.");
  assert.equal(presentAlert(stale(), { role: "admin" }).path, `/admin/live-tracking?rider=${RIDER_UID}`);
  assert.equal(presentAlert(stale(), { role: "dispatcher" }).path, `/dispatcher/live-tracking?rider=${RIDER_UID}`);
  assert.equal(presentAlert(stale({ riderId: "bad/../id" }), { role: "dispatcher" }).path, "/dispatcher/live-tracking");
});

test("client and server word the stale incident identically", () => {
  for (const input of [
    { status: "active", riderName: "Ana Cruz", minutes: 14.7 },
    { status: "active", riderName: "", minutes: 3 },
    { status: "resolved", riderName: "Ana", resolutionReason: "location_updating" },
    { status: "resolved", riderName: null, resolutionReason: "trip_superseded" },
  ]) {
    assert.equal(staleLocationText(input), server.staleAlertText(input), JSON.stringify(input));
  }
});

test("a resolved late-delivery alert says how its delivery ended", () => {
  const late = (over) => ({ type: "delivery_delay", status: "resolved", orderNumber: "VT-ORD-1793000000000-K7QZ", orderId: "k7qzOrderDocId1234567", riderName: "Ana", ...over });
  assert.equal(presentAlert(late({ resolutionReason: "delivered" })).message, "Order K7QZ was delivered.");
  assert.equal(presentAlert(late({ resolutionReason: "delivery_failed" })).message, "Order K7QZ was reported as a failed delivery.");
  assert.equal(presentAlert(late({ resolutionReason: "cancelled" })).message, "Order K7QZ was cancelled.");
  assert.equal(presentAlert(late({})).message, "The late delivery alert for Order K7QZ was resolved.", "an Admin's own resolve");
  assert.equal(presentAlert(late({ orderNumber: null, resolutionReason: "delivered" })).message, "This order was delivered.");
});

test("Admin Alerts counts open stale-location alerts in their own category", () => {
  const page = read("src/pages/admin/Alerts.jsx");
  assert.match(page, /rider_location_stale: \{\s*display: "Location Not Updating",/);
  assert.match(page, /location: kpi\(activeOfType\("Location Not Updating"\)\),/);
  assert.match(page, /title="Location Not Updating"\s*count=\{`\$\{categoryCounts\.location\} active`\}/);
});

test("Live Tracking opens on the linked rider, accepting only an id-shaped value", () => {
  const panel = read("src/components/tracking/LiveTrackingPanel.jsx");
  assert.match(panel, /const linked = searchParams\.get\("rider"\);/);
  assert.match(panel, /\/\^\[A-Za-z0-9_-\]\{1,128\}\$\/\.test\(linked\) \? linked : null/);
});

test("the alert writes a client may make stay read/resolve only", () => {
  const svc = read("src/services/alertService.js");
  assert.match(svc, /updateDoc\(doc\(db, ALERTS_COLLECTION, alertId\), \{\s*status: "resolved",\s*\}\)/);
  assert.match(svc, /updateDoc\(doc\(db, ALERTS_COLLECTION, alertId\), \{\s*read: true,\s*\}\)/);
  const rules = read("firestore.rules");
  assert.match(rules, /return \['route_deviation', 'delivery_delay', 'rider_location_stale'\];/);
  assert.match(rules, /match \/riderLocationWatches\/\{riderUid\} \{\s*allow read, write: if false;/);
});
