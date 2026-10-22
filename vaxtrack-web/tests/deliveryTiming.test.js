import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  deliveryTiming, dispatchEtaCheck, HOLD_LABEL, lateAlertLiveText, manilaTime, missingEtaWarning, NO_ETA_DETAIL, TIMING_LABELS,
} from "../src/services/deliveryTiming.js";
import { EVENT_LABELS, SOURCE_LABELS } from "../src/services/orderHistory.js";

/**
 * The web's display of the server's automatic delivery timing. The server
 * contract is functions/src/deliveryTiming.js (its own unit + emulator tests);
 * here: the indicator is secondary, never merges the Rider-reported hold with
 * automatic lateness, is honest about unknowns, and agrees with the server.
 */

const require = createRequire(import.meta.url);
const server = require("../functions/src/deliveryTiming.js");
const serverHistory = require("../functions/src/orderHistory.js");
const { routeForOrder } = require("../functions/src/riderTracking.js");
const { encode } = require("../functions/test/helpers/polyline.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const T0 = Date.parse("2026-10-17T10:00:00Z"); // 6:00 PM Manila
const MIN = 60000;
const ts = (ms) => ({ toMillis: () => ms });
const order = (over = {}) => ({
  statusKey: "in_transit",
  timingStatus: "on_time",
  expectedArrivalAt: ts(T0 + 30 * MIN),
  automaticDelayedAt: ts(T0 + 40 * MIN),
  ...over,
});

test("the status names match the server's", () => {
  assert.deepEqual(Object.keys(TIMING_LABELS).sort(), [...server.TIMING_STATUSES].sort());
});

test("in transit: expected by / grace ends at / automatically delayed by N minutes, in Manila time", () => {
  assert.equal(manilaTime(T0 + 30 * MIN), "6:30 PM");
  const onTime = deliveryTiming(order(), T0);
  assert.deepEqual([onTime.label, onTime.detail, onTime.combinedLabel, onTime.tone, onTime.onHold], ["On time", "Expected by 6:30 PM", "In Transit", "ok", false]);
  const risk = deliveryTiming(order({ timingStatus: "at_risk" }), T0 + 33 * MIN);
  assert.deepEqual([risk.label, risk.detail, risk.combinedLabel], ["At risk", "At risk — grace period ends at 6:40 PM", "In Transit — At Risk"]);
  const late = deliveryTiming(order({ timingStatus: "delayed" }), T0 + 42 * MIN);
  assert.deepEqual(
    [late.label, late.detail, late.combinedLabel, late.tone],
    ["Automatically delayed", "Delayed by 12 minutes (expected by 6:30 PM)", "In Transit — Automatically delayed", "late"]
  );
  assert.equal(deliveryTiming(order({ timingStatus: "delayed" }), T0 + 31 * MIN).detail, "Delayed by 1 minute (expected by 6:30 PM)");
});

test("the Rider-reported hold and automatic lateness are never one ambiguous badge", () => {
  const hold = deliveryTiming(order({ statusKey: "delayed" }), T0);
  assert.deepEqual([hold.onHold, hold.combinedLabel, hold.label], [true, `Delayed — ${HOLD_LABEL}`, "On time"], "on hold, still on schedule");
  assert.equal(HOLD_LABEL, "Rider-reported hold");
  const holdRisk = deliveryTiming(order({ statusKey: "delayed", timingStatus: "at_risk" }), T0 + 35 * MIN);
  assert.equal(holdRisk.combinedLabel, "Delayed — Rider-reported hold");
  assert.equal(holdRisk.label, "At risk");
  const both = deliveryTiming(order({ statusKey: "delayed", timingStatus: "delayed" }), T0 + 45 * MIN);
  assert.deepEqual([both.onHold, both.combinedLabel, both.label], [true, "Delayed — Rider-reported hold · also behind schedule", "Automatically delayed"]);
  // Automatic lateness alone never says "hold".
  assert.doesNotMatch(deliveryTiming(order({ timingStatus: "delayed" }), T0 + 45 * MIN).combinedLabel, /hold/i);
});

test("the SERVER's recorded condition is shown — the viewer's clock never upgrades or downgrades it", () => {
  assert.equal(deliveryTiming(order(), T0 + 999 * MIN).label, "On time");
  assert.equal(deliveryTiming(order({ timingStatus: "delayed" }), T0).label, "Automatically delayed");
});

test("nothing is shown when there is no timing to show — and the lifecycle is never replaced", () => {
  for (const statusKey of ["delivered", "delivery_failed", "cancelled", "assigned", "loading", "pending_dispatch"]) {
    assert.equal(deliveryTiming(order({ statusKey }), T0), null, statusKey);
  }
  assert.equal(deliveryTiming({ statusKey: "in_transit" }, T0), null, "legacy order");
  assert.equal(deliveryTiming({ statusKey: "delayed" }, T0), null, "legacy order on hold");
  assert.equal(deliveryTiming(order({ timingStatus: "bogus" }), T0), null);
  assert.equal(deliveryTiming(null, T0), null);
  assert.equal(deliveryTiming({ ...order(), statusKey: undefined, status: "In Transit" }, T0).label, "On time");
});

test("no route ETA at dispatch: a neutral 'Timing unavailable' — no invented arrival time, nothing to act on", () => {
  const u = deliveryTiming(order({ timingStatus: "unknown", expectedArrivalAt: undefined, automaticDelayedAt: undefined }), T0);
  assert.deepEqual([u.label, u.detail, u.combinedLabel, u.tone], ["Timing unavailable", "No route ETA at dispatch", "In Transit", "none"]);
  assert.equal(NO_ETA_DETAIL, "No route ETA at dispatch");
  assert.doesNotMatch(u.detail, /\d:\d\d/);
  assert.equal("recoverable" in u, false, "no recovery is offered");
  const held = deliveryTiming(order({ statusKey: "delayed", timingStatus: "unknown", expectedArrivalAt: undefined, automaticDelayedAt: undefined }), T0);
  assert.deepEqual([held.combinedLabel, held.label], ["Delayed — Rider-reported hold", "Timing unavailable"]);
  const half = deliveryTiming(order({ timingStatus: "at_risk", automaticDelayedAt: null }), T0);
  assert.deepEqual([half.status, half.label, half.tone, half.combinedLabel], ["unknown", "Timing unavailable", "none", "In Transit"]);
});

// ---- the Finalize Dispatch warning mirrors the server's dispatch-time decision ----

const ROUTE = encode([{ lat: 14.6, lng: 121.0 }, { lat: 14.61, lng: 121.01 }]);
const routed = (over = {}) => ({
  id: "o1", orderNumber: "VT-1", assignedAt: ts(T0 - 3600000), routePolyline: ROUTE,
  routeGeneratedAt: ts(T0 - 600000), routeDurationSeconds: 1800, ...over,
});

test("dispatchEtaCheck agrees with the server on every case that decides timing at dispatch", () => {
  const cases = [
    routed(),
    routed({ routeDurationSeconds: 0 }), routed({ routeDurationSeconds: -5 }), routed({ routeDurationSeconds: "1800" }),
    routed({ routeDurationSeconds: NaN }), routed({ routeDurationSeconds: null }), routed({ routeDurationSeconds: 25 * 3600 }),
    routed({ routeDurationSeconds: 24 * 3600 }), routed({ routePolyline: null }), routed({ routePolyline: "" }),
    routed({ routePolyline: "%%%" }), routed({ routePolyline: "??" }),
    routed({ routeGeneratedAt: ts(T0 - 7200000) }), routed({ routeGeneratedAt: null }), routed({ assignedAt: null }),
    routed({ destinationRevision: 2, routeDestinationRevision: 1 }), routed({ destinationRevision: 2, routeDestinationRevision: 2 }),
    routed({ tripId: "t", stopSequence: 2, tripPolyline: ROUTE, tripGeneratedAt: ts(T0 - 300000), stopEtaSeconds: 2700 }),
    routed({ tripId: "t", stopSequence: 2, tripPolyline: ROUTE, tripGeneratedAt: ts(T0 - 300000), stopEtaSeconds: 0 }),
    routed({ tripId: "t", stopSequence: 0, tripPolyline: ROUTE, tripGeneratedAt: ts(T0), stopEtaSeconds: 99 }),
    routed({ tripId: "t", stopSequence: 1, tripPolyline: ROUTE, tripGeneratedAt: ts(T0 - 300000), destinationCorrectedAt: ts(T0), stopEtaSeconds: 600 }),
    routed({ tripId: "", stopSequence: 1, tripPolyline: ROUTE }),
    {},
  ];
  for (const o of cases) {
    const web = dispatchEtaCheck(o);
    const srv = server.plannedEta(o, routeForOrder);
    assert.deepEqual(
      web.ok ? { ok: true, etaSeconds: web.etaSeconds, source: web.source } : { ok: false, reason: web.reason },
      srv.ok ? { ok: true, etaSeconds: srv.etaSeconds, source: srv.source } : { ok: false, reason: srv.reason },
      JSON.stringify(o)
    );
  }
});

test("the Finalize Dispatch warning names the orders without an ETA and never blocks", () => {
  assert.equal(missingEtaWarning([routed(), routed({ id: "o2" })]), null, "every order has an ETA: no warning");
  const one = missingEtaWarning([routed(), routed({ id: "o2", orderNumber: "VT-2", routePolyline: null })]);
  assert.deepEqual([one.count, one.orderLabels], [1, ["VT-2"]]);
  assert.match(one.text, /^1 order has no valid route ETA\. Automatic arrival timing will be unavailable for it on this dispatch\. You can still dispatch/);
  const two = missingEtaWarning([routed({ routePolyline: null }), routed({ id: "o3", orderNumber: undefined, routeDurationSeconds: 0 })]);
  assert.deepEqual([two.count, two.orderLabels], [2, ["VT-1", "o3"]]);
  assert.match(two.text, /^2 orders have no valid route ETA\. Automatic arrival timing will be unavailable for them/);
  assert.equal(missingEtaWarning([]), null);
});

test("the Dispatcher notification shows how late the delivery is NOW", () => {
  const alert = { type: "delivery_delay", expectedArrivalAt: ts(T0), automaticDelayedAt: ts(T0 + 10 * MIN) };
  assert.equal(lateAlertLiveText(alert, T0 + 18 * MIN), "Now 18 minutes past expected arrival");
  assert.equal(lateAlertLiveText(alert, T0 + MIN), "Now 1 minute past expected arrival");
  assert.equal(lateAlertLiveText({ type: "route_deviation", expectedArrivalAt: ts(T0) }, T0 + MIN), null);
  assert.equal(lateAlertLiveText({ type: "delivery_delay" }, T0), null);
  assert.equal(lateAlertLiveText(null, T0), null);
});

test("the order history labels every timing event the server writes", () => {
  const timingTypes = Object.values(serverHistory.EVENT_TYPES).filter((t) => t.startsWith("delivery_"));
  assert.deepEqual(timingTypes, ["delivery_running_late"]);
  for (const type of timingTypes) assert.ok(EVENT_LABELS[type], type);
  assert.ok(SOURCE_LABELS.evaluateDeliveryTiming);
  // No recovery event or source remains.
  assert.equal("delivery_timing_initialized" in EVENT_LABELS, false);
  assert.equal("initializeDeliveryTiming" in SOURCE_LABELS, false);
});

test("wiring the browser cannot run here (no DOM in this suite): the bell and the deep link", () => {
  // The notification bell navigates to the alert's path as presented
  // (src/services/alertPresentation.js: the server-provided Dispatcher path,
  // else the Shipments deep link); the late alert's path is that deep link.
  const layout = read("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.match(layout, /const \{ path \} = presentAlert\(notification, \{ role: "dispatcher" \}\);\s*if \(path\) \{\s*navigate\(path\);/);
  assert.match(layout, /lateAlertLiveText\(notification, minuteNow\)/);
  const ops = read("functions/src/deliveryTimingOps.js");
  assert.match(ops, /const SHIPMENT_PATH = \(orderId\) => `\/dispatcher\/shipments\?order=\$\{encodeURIComponent\(orderId\)\}`;/);
  const shipments = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(shipments, /const focusOrderId = searchParams\.get\("order"\) \|\| "";/);
  assert.match(shipments, /focused=\{order\.id === focusOrderId\}/);
  // No timing action remains on Shipments; the page never computes a deadline.
  assert.doesNotMatch(shipments, /initializeDeliveryTiming|Set arrival time from route/);
  assert.doesNotMatch(shipments, /expectedArrivalAt\s*[:=]|automaticDelayedAt\s*[:=]/);
  assert.doesNotMatch(read("src/services/inventoryCallables.js"), /initializeDeliveryTiming/);
  // The Finalize Dispatch dialog shows the warning as a note — the confirm stays enabled.
  const cargo = read("src/pages/dispatcher/DispatcherCargoLoading.jsx");
  assert.match(cargo, /const warning = missingEtaWarning\(confirmGroup\.orders\);/);
  assert.match(cargo, /<p className="m-dialog-warning" role="note">/);
});

test("the due query and its composite index agree", () => {
  const ops = read("functions/src/deliveryTimingOps.js");
  assert.match(ops, /\.where\("timingActive", "==", true\)\s*\.where\(DUE_FIELD, "<=", dueBy\)\s*\.orderBy\(DUE_FIELD\)\s*\.orderBy\("__name__"\)/);
  const indexes = JSON.parse(read("firestore.indexes.json")).indexes;
  const match = indexes.filter((i) => i.collectionGroup === "orders" && i.queryScope === "COLLECTION"
    && JSON.stringify(i.fields) === JSON.stringify([
      { fieldPath: "timingActive", order: "ASCENDING" },
      { fieldPath: "timingNextCheckAt", order: "ASCENDING" },
    ]));
  assert.equal(match.length, 1);
});
