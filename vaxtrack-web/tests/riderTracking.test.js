import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as web from "../src/services/riderTracking.js";

/**
 * Rider live tracking — one contract in three places.
 *
 * The server (functions/src/riderTracking.js) decides; the rider app
 * (vaxtrack_mobile/lib/tracking/tracking_contract.dart) reports; the web
 * (src/services/riderTracking.js) displays. These tests fail the moment any of
 * the three disagree on statuses, thresholds, collection names or labels, and
 * pin the web's display rules: no invented positions, a late write shown as
 * old, and a server-confirmed deviation outranking freshness.
 */

const require = createRequire(import.meta.url);
const server = require("../functions/src/riderTracking.js");
const serverOps = require("../functions/src/riderTrackingOps.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const DART = read("../vaxtrack_mobile/lib/tracking/tracking_contract.dart");
const RULES = read("firestore.rules");

function dartList(name) {
  const m = DART.match(new RegExp(`const List<String> ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} is declared in tracking_contract.dart`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
function dartConst(name) {
  const m = DART.match(new RegExp(`const (?:int|String) ${name} = ([^;]+);`));
  assert.ok(m, `${name} is declared in tracking_contract.dart`);
  const raw = m[1].trim();
  if (raw.startsWith("'")) return raw.slice(1, -1);
  // Only literal integer products like 2 * 60 * 1000.
  assert.match(raw, /^[\d\s*]+$/, `${name} is a literal`);
  return raw.split("*").reduce((acc, n) => acc * Number(n.trim()), 1);
}

// ---------------------------------------------------------------- contract

test("tracked and navigable statuses agree across server, rider app and web", () => {
  assert.deepEqual([...server.TRACKED_ORDER_STATUSES], dartList("kTrackedOrderStatuses"));
  assert.deepEqual([...server.TRACKED_ORDER_STATUSES], [...web.TRACKED_ORDER_STATUSES]);
  assert.deepEqual([...server.NAVIGABLE_STATUSES], dartList("kNavigableOrderStatuses"));
  // Terminal and parked states never keep a rider tracked.
  for (const s of ["delivered", "cancelled", "delivery_failed", "pending_dispatch"]) {
    assert.equal(server.TRACKED_ORDER_STATUSES.includes(s), false, s);
  }
});

test("freshness: Fresh <= 3 min, Offline > 10 min; the web owns the Fresh display boundary", () => {
  assert.deepEqual({ ...web.FRESHNESS }, { freshMs: 3 * 60 * 1000, offlineMs: 10 * 60 * 1000 });
  // The Offline boundary agrees everywhere.
  assert.equal(dartConst("kOfflineMs"), web.FRESHNESS.offlineMs);
  assert.equal(server.FRESHNESS.offlineMs, web.FRESHNESS.offlineMs);
  // Fresh must outlast the rider app's stationary heartbeat, or a locked,
  // stationary phone reads Stale before its next write can arrive.
  const policy = read("../vaxtrack_mobile/lib/tracking/location_write_policy.dart");
  const heartbeat = policy.match(/TrackingMode\.tracking: WriteCadence\([\s\S]*?heartbeat: Duration\(minutes: (\d+)\)/);
  assert.ok(heartbeat, "tracking heartbeat found");
  assert.ok(web.FRESHNESS.freshMs >= Number(heartbeat[1]) * 60 * 1000 + 60 * 1000, "at least a minute of margin over the heartbeat");
  // The server and rider-app copies of freshMs (still 2 min) are reference
  // mirrors with NO runtime consumer, so they cannot change what anyone sees.
  // Align them in the next backend / app change.
  const fnRuntime = strip(read("functions/src/riderTrackingOps.js")) + strip(read("functions/index.js"));
  assert.equal(/locationFreshness|FRESHNESS/.test(fnRuntime), false, "no Function decides freshness");
  for (const dart of ["services/rider_tracking_service.dart", "tracking/rider_tracking_controller.dart", "widgets/tracking_status_banner.dart", "screens/route_monitoring_screen.dart"]) {
    assert.equal(read(`../vaxtrack_mobile/lib/${dart}`).includes("kFreshMs"), false, dart);
  }
});

test("exact freshness boundaries (earlier of capture and server time)", () => {
  const MIN = 60 * 1000;
  const aged = (ageMs) => loc({ capturedAt: NOW - ageMs, updatedAt: NOW - ageMs });
  assert.equal(web.locationFreshness(aged(3 * MIN), NOW), "fresh", "exactly 3 min");
  assert.equal(web.locationFreshness(aged(3 * MIN + 1), NOW), "stale", "3 min + 1 ms");
  assert.equal(web.locationFreshness(aged(10 * MIN), NOW), "stale", "exactly 10 min");
  assert.equal(web.locationFreshness(aged(10 * MIN + 1), NOW), "offline", "10 min + 1 ms");
  // The earlier timestamp decides: a late upload of an old fix is old.
  assert.equal(web.locationFreshness(loc({ capturedAt: NOW - 3 * MIN - 1, updatedAt: NOW }), NOW), "stale");
  // ...and a phone clock ahead of the server cannot make a fix look newer.
  assert.equal(web.locationFreshness(loc({ capturedAt: NOW, updatedAt: NOW - 3 * MIN - 1 }), NOW), "stale");
  // Explicitly stopped = Offline regardless of timestamp or coordinates.
  const ended = { trackingState: "ended", latitude: null, longitude: null, accuracyMeters: null };
  for (const ts of [NOW, NOW - 1000, NOW - 60 * MIN, null]) {
    assert.equal(web.locationFreshness({ ...ended, capturedAt: ts, updatedAt: ts }, NOW), "offline", String(ts));
  }
  assert.equal(web.locationFreshness(loc({ trackingState: "ended" }), NOW), "offline");
  // Offline wins over a still-open deviation state.
  const deviating = { sessionState: "navigating", routeStatus: "available", phase: "deviating" };
  assert.equal(web.riderMarkerState({ location: { ...ended, capturedAt: NOW, updatedAt: NOW }, deviation: deviating, nowMs: NOW }), "offline");
  // Never reported is still Unavailable, not Offline.
  assert.equal(web.locationFreshness(null, NOW), "unavailable");
});

test("the 500 m / 3 minute deviation rule agrees (with 400 m / 2 minute recovery)", () => {
  const r = server.DEVIATION_RULES;
  assert.equal(r.offRouteMeters, 500);
  assert.equal(r.confirmDeviationMs, 3 * 60 * 1000);
  assert.ok(r.returnMeters < r.offRouteMeters, "hysteresis band");
  assert.equal(dartConst("kDeviationOffRouteMeters"), r.offRouteMeters);
  assert.equal(dartConst("kDeviationReturnMeters"), r.returnMeters);
  assert.equal(dartConst("kDeviationConfirmSeconds") * 1000, r.confirmDeviationMs);
  assert.equal(dartConst("kDeviationReturnConfirmSeconds") * 1000, r.confirmReturnMs);
  assert.equal(dartConst("kDeviationMaxAccuracyMeters"), r.maxAccuracyMeters);
  for (const k of ["offRouteMeters", "returnMeters", "confirmDeviationMs", "confirmReturnMs", "maxAccuracyMeters"]) {
    assert.equal(web.DEVIATION_RULES[k], r[k], k);
  }
});

test("collection names, schema version and source agree with the rules", () => {
  const C = serverOps.TRACKING_COLLECTIONS;
  assert.equal(dartConst("kRiderLocationsCollection"), C.LOCATIONS);
  assert.equal(dartConst("kNavigationSessionsCollection"), C.SESSIONS);
  assert.equal(dartConst("kDeviationStatesCollection"), C.STATES);
  assert.equal(web.TRACKING_COLLECTIONS.LOCATIONS, C.LOCATIONS);
  assert.equal(web.TRACKING_COLLECTIONS.DEVIATION_STATES, C.STATES);
  for (const name of Object.values(C).filter((n) => n !== "alerts" && n !== "orders")) {
    assert.match(RULES, new RegExp(`match /${name}/\\{`), `rules cover ${name}`);
  }
  assert.equal(dartConst("kLocationSchemaVersion"), server.LOCATION_SCHEMA_VERSION);
  assert.match(RULES, new RegExp(`d\\.schemaVersion == ${server.LOCATION_SCHEMA_VERSION}`));
  assert.match(RULES, new RegExp(`d\\.source == '${dartConst("kLocationSource")}'`));
});

test("every end reason the rider app sends is one the rules accept", () => {
  const allowed = RULES.match(/d\.endReason in \[([^\]]+)\]/);
  assert.ok(allowed);
  const rules = [...allowed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const dart = ["kEndReasonRiderStopped", "kEndReasonSignedOut", "kEndReasonTrackingStopped"].map(dartConst).sort();
  assert.deepEqual(dart, rules);
});

// ---------------------------------------------------------------- display rules

const NOW = Date.UTC(2026, 9, 1, 8, 0, 0);
const loc = (over = {}) => ({
  riderUid: "r1",
  latitude: 14.6,
  longitude: 121.0,
  accuracyMeters: 12,
  capturedAt: NOW - 30_000,
  updatedAt: NOW - 29_000,
  trackingState: "active",
  ...over,
});

test("web freshness applies the server's timestamp rule (outside the 2–3 min window the copies still differ on)", () => {
  // Cases chosen away from the Fresh boundary (web 3 min, unused server copy
  // 2 min) and without an ended doc (the web reports it Offline, the unused
  // server copy Unavailable); both are pinned by the exact-boundary test above.
  const lateUpload = loc({ capturedAt: NOW - 15 * 60_000, updatedAt: NOW - 1000 });
  const cases = [
    null,
    loc(),
    loc({ capturedAt: NOW - 5 * 60_000, updatedAt: NOW - 5 * 60_000 }),
    loc({ capturedAt: NOW - 11 * 60_000, updatedAt: NOW - 11 * 60_000 }),
    loc({ trackingState: "ended" }),
    loc({ latitude: 0, longitude: 0 }),
    loc({ capturedAt: null, updatedAt: null }),
    // Written late: captured 15 min ago, accepted just now → shown as OLD.
    lateUpload,
    // Device clock ahead: capture after the server write → server time wins.
    loc({ capturedAt: NOW + 5 * 60_000, updatedAt: NOW - 5 * 60_000 }),
  ];
  for (const c of cases) {
    assert.equal(web.locationFreshness(c, NOW), server.locationFreshness(c, NOW), JSON.stringify(c));
  }
  assert.equal(web.locationFreshness(lateUpload, NOW), "offline", "a late offline write is never shown as live");
});

test("web deviation display matches the server", () => {
  const states = [
    null,
    { sessionState: "ended", routeStatus: "available", phase: "deviating" },
    { sessionState: "navigating", routeStatus: "unavailable", phase: "deviating" },
    { sessionState: "navigating", routeStatus: "available", phase: "on_route", pendingOffSinceMs: null },
    { sessionState: "navigating", routeStatus: "available", phase: "on_route", pendingOffSinceMs: 5 },
    { sessionState: "navigating", routeStatus: "available", phase: "deviating" },
  ];
  for (const s of states) assert.equal(web.deviationDisplayState(s), server.deviationDisplayState(s));
  assert.equal(web.DEVIATION_LABELS.route_unavailable, "Route not available");
});

test("UI labels are exactly the five marker states", () => {
  assert.deepEqual(web.MARKER_LABELS, {
    fresh: "Fresh",
    stale: "Stale",
    offline: "Offline",
    deviating: "Route Deviating",
    unavailable: "Location Unavailable",
  });
  assert.deepEqual([...web.MARKER_STATES].sort(), Object.keys(web.MARKER_LABELS).sort());
});

test("marker state: deviation outranks freshness but never invents a position", () => {
  const deviating = { sessionState: "navigating", routeStatus: "available", phase: "deviating" };
  assert.equal(web.riderMarkerState({ location: loc(), deviation: deviating, nowMs: NOW }), "deviating");
  assert.equal(web.riderMarkerState({ location: null, deviation: deviating, nowMs: NOW }), "unavailable");
  assert.equal(web.riderMarkerState({ location: loc(), deviation: null, nowMs: NOW }), "fresh");
  // No route → never a deviation, whatever phase a stale doc carries.
  const noRoute = { ...deviating, routeStatus: "unavailable" };
  assert.equal(web.riderMarkerState({ location: loc(), deviation: noRoute, nowMs: NOW }), "fresh");
  // An ended doc has no position to draw.
  assert.equal(web.locationLatLng(loc({ trackingState: "ended" })), null);
});

// ---------------------------------------------------------------- fleet

const order = (id, status, rider, extra = {}) => ({ id, status, assignedRiderId: rider, orderNumber: `VT-${id}`, ...extra });

test("fleet: only riders with an active delivery, grouped, most urgent first", () => {
  const fleet = web.buildFleet({
    orders: [
      order("a", "in_transit", "r1"),
      order("b", "assigned", "r1"),
      order("c", "delivered", "r2"),
      order("d", "delivery_failed", "r3"),
      order("e", "loading", "r4"),
      order("f", "In Transit", "r5"),
      order("g", "pending_dispatch", null),
    ],
    locations: {
      r1: loc(),
      r2: loc(),
      r4: loc({ capturedAt: NOW - 5 * 60_000, updatedAt: NOW - 5 * 60_000 }),
      r5: loc(),
    },
    deviations: { r5: { sessionState: "navigating", routeStatus: "available", phase: "deviating", orderId: "f", distanceAtTransitionMeters: 720 } },
    riders: { r1: { fullName: "Ana" }, r4: { name: "Ben" }, r5: { fullName: "Cy" } },
    nowMs: NOW,
  });
  assert.deepEqual(fleet.map((r) => r.uid), ["r5", "r1", "r4"], "delivered/failed/unassigned riders are not shown");
  assert.deepEqual(fleet.map((r) => r.state), ["deviating", "fresh", "stale"]);
  assert.deepEqual(fleet[1].orders.map((o) => o.id), ["a", "b"], "multiple active orders stay on one rider");
  assert.equal(fleet[0].navigatingOrderId, "f");
  assert.equal(fleet[0].deviationDistanceMeters, 720);
});

test("fleet: a rider with an active order but no position is listed as unavailable", () => {
  const [r] = web.buildFleet({ orders: [order("a", "assigned", "r1")], locations: {}, deviations: {}, riders: {}, nowMs: NOW });
  assert.equal(r.state, "unavailable");
  assert.equal(r.latLng, null);
  assert.equal(r.name, "Unnamed rider");
});

test("fleet: reassignment moves the rider entry", () => {
  const before = web.buildFleet({ orders: [order("a", "in_transit", "r1")], locations: { r1: loc(), r2: loc() }, nowMs: NOW });
  const after = web.buildFleet({ orders: [order("a", "in_transit", "r2")], locations: { r1: loc(), r2: loc() }, nowMs: NOW });
  assert.deepEqual(before.map((r) => r.uid), ["r1"]);
  assert.deepEqual(after.map((r) => r.uid), ["r2"]);
});

// ---------------------------------------------------------------- wiring

test("the web never writes tracking data", () => {
  for (const file of ["src/services/riderTrackingService.js", "src/services/riderTracking.js", "src/components/useRiderLiveLocation.js", "src/components/tracking/LiveTrackingPanel.jsx"]) {
    const code = strip(read(file));
    for (const w of ["setDoc", "updateDoc", "addDoc", "deleteDoc", "writeBatch", "runTransaction"]) {
      assert.equal(code.includes(w), false, `${file} must not call ${w}`);
    }
  }
});

test("maps read riderLocations, not the order-level location copy", () => {
  for (const file of ["src/components/LiveDeliveryMap.jsx", "src/pages/admin/Deliveries.jsx", "src/pages/salesRep/SalesRepOrderTracking.jsx"]) {
    assert.equal(strip(read(file)).includes("lastLocation"), false, `${file} reads no order lastLocation`);
  }
  const ldm = strip(read("src/components/LiveDeliveryMap.jsx"));
  assert.match(ldm, /useRiderLiveLocation\(order\?\.assignedRiderId/);
  // Geofence overlays the live doc in the shape its verified map code reads.
  const geo = strip(read("src/pages/dispatcher/DispatcherGeofence.jsx"));
  assert.match(geo, /useRiderLiveLocation\(selectedOrder\?\.assignedRiderId/);
  assert.match(geo, /lastLocation: ll \? \{ latitude: ll\[0\], longitude: ll\[1\] \} : null/);
});

test("a Med Rep is never sent deviation state; Admin's drawer is", () => {
  const sr = strip(read("src/pages/salesRep/SalesRepOrderTracking.jsx"));
  assert.match(sr, /<LiveDeliveryMap order=\{selectedOrder\} \/>/);
  assert.equal(sr.includes("showDeviation"), false);
  assert.match(strip(read("src/pages/admin/Deliveries.jsx")), /<LiveDeliveryMap order=\{delivery\} tripStops=\{tripStops\} showDeviation \/>/);
});

test("a permission-denied read is a normal 'Location unavailable', not a crash", () => {
  const hook = strip(read("src/components/useRiderLiveLocation.js"));
  assert.match(hook, /err\?\.code === "permission-denied" \? "denied" : "error"/);
  const ldm = strip(read("src/components/LiveDeliveryMap.jsx"));
  assert.match(ldm, /live\.status === "denied"/);
  assert.match(ldm, /title = "Location unavailable"/);
});

test("Live Tracking routes, nav entries and titles exist for Admin and Dispatcher only", () => {
  const app = read("src/App.jsx");
  assert.match(app, /<Route path="\/admin\/live-tracking" element=\{<AdminLiveTracking \/>\} \/>/);
  assert.match(app, /<Route path="\/dispatcher\/live-tracking" element=\{<DispatcherLiveTracking \/>\} \/>/);
  assert.equal(/sales-rep\/live-tracking/.test(app), false);
  const shell = read("src/components/admin/AdminShell.jsx");
  assert.match(shell, /"\/admin\/live-tracking": "Live Tracking"/);
  const sidebar = read("src/components/admin/AdminSidebar.jsx");
  assert.match(sidebar, /to="\/admin\/live-tracking"/);
  assert.match(sidebar, /"\/admin\/live-tracking": "liveTracking"/);
  const disp = read("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.match(disp, /"\/dispatcher\/live-tracking": \{ key: "live-tracking", title: "Live Tracking" \}/);
  assert.match(disp, /to="\/dispatcher\/live-tracking"/);
});

test("the fleet panel handles loading, permission, error and empty states", () => {
  const panel = strip(read("src/components/tracking/LiveTrackingPanel.jsx"));
  assert.match(panel, /Loading live tracking/);
  assert.match(panel, /You do not have access to live tracking\./);
  assert.match(panel, /Live tracking could not be loaded\./);
  assert.match(panel, /No rider has an active delivery right now\./);
  assert.match(panel, /Route-deviation status could not be loaded; positions are still live\./);
});

// ---------------------------------------------------------------- pre-deployment review

test("route-unavailable reasons agree with the server and are shown to staff", () => {
  assert.deepEqual(Object.keys(web.ROUTE_UNAVAILABLE_LABELS).sort(), Object.values(server.ROUTE_UNAVAILABLE_REASONS).sort());
  const stale = { sessionState: "navigating", routeStatus: "unavailable", routeUnavailableReason: "generated_before_assignment" };
  assert.equal(web.deviationText(stale), "Route not available (saved before the current assignment — regenerate it)");
  assert.equal(web.deviationText({ sessionState: "navigating", routeStatus: "available", phase: "on_route" }), "On route");
  for (const file of ["src/components/tracking/LiveTrackingPanel.jsx", "src/components/LiveDeliveryMap.jsx", "src/pages/dispatcher/DispatcherGeofence.jsx"]) {
    assert.match(strip(read(file)), /deviationText/, file);
  }
});

test("Live Tracking routes sit inside the Admin and Dispatcher role guards", () => {
  const app = read("src/App.jsx");
  const block = (guard) => {
    const start = app.indexOf(`<Route element={<${guard} />}>`);
    assert.ok(start >= 0, guard);
    const end = app.indexOf("\n          </Route>", start);
    return app.slice(start, end);
  };
  assert.match(block("AdminRoute"), /path="\/admin\/live-tracking"/);
  assert.match(block("DispatcherRoute"), /path="\/dispatcher\/live-tracking"/);
  assert.equal(block("SalesRepRoute").includes("live-tracking"), false);
});

test("a Med Rep reads one known rider document — never the fleet or a broad query", () => {
  // Firestore rules are not filters: a collection query would be refused
  // outright, so the Med Rep path must only ever GET riderLocations/{uid}.
  const hook = strip(read("src/components/useRiderLiveLocation.js"));
  assert.equal(/subscribeAll(RiderLocations|DeviationStates)/.test(hook), false);
  assert.match(hook, /subscribeRiderLocation\(riderUid,/);
  const service = strip(read("src/services/riderTrackingService.js"));
  assert.match(service, /export function subscribeRiderLocation\(riderUid[\s\S]*?doc\(db, TRACKING_COLLECTIONS\.LOCATIONS, riderUid\)/);
  const ldm = strip(read("src/components/LiveDeliveryMap.jsx"));
  assert.equal(/LiveTrackingPanel|subscribeAll/.test(ldm), false);
  // Only the rider of an ACTIVE order is subscribed to.
  assert.match(ldm, /enabled: tracked/);
  for (const file of ["src/pages/salesRep/SalesRepOrderTracking.jsx", "src/pages/salesRep/SalesRepDashboard.jsx"]) {
    const code = strip(read(file));
    assert.equal(/LiveTrackingPanel|riderTrackingService|subscribeAll/.test(code), false, file);
  }
  // The fleet panel (broad reads) is used by the Admin and Dispatcher pages only.
  assert.match(read("src/pages/admin/AdminLiveTracking.jsx"), /LiveTrackingPanel/);
  assert.match(read("src/pages/dispatcher/DispatcherLiveTracking.jsx"), /LiveTrackingPanel/);
});

test("freshness boundaries use one timestamp rule; stale is never labelled live", () => {
  const at = (ageMs) => loc({ capturedAt: NOW - ageMs, updatedAt: NOW - ageMs });
  assert.equal(web.locationFreshness(at(web.FRESHNESS.freshMs), NOW), "fresh");
  assert.equal(web.locationFreshness(at(web.FRESHNESS.freshMs + 1), NOW), "stale");
  assert.equal(web.locationFreshness(at(web.FRESHNESS.offlineMs), NOW), "stale");
  assert.equal(web.locationFreshness(at(web.FRESHNESS.offlineMs + 1), NOW), "offline");
  // The age shown is the same min(capture, server write) the state uses.
  const [r] = web.buildFleet({
    orders: [order("a", "in_transit", "r1")],
    locations: { r1: loc({ capturedAt: NOW - 5 * 60_000, updatedAt: NOW - 1000 }) },
    nowMs: NOW,
  });
  assert.equal(r.locationAtMs, NOW - 5 * 60_000);
  assert.equal(r.state, "stale");
  assert.equal(web.formatAge(r.locationAtMs, NOW), "5m ago");
  // "Live"/"Fresh" wording appears only through the computed state.
  const ldm = strip(read("src/components/LiveDeliveryMap.jsx"));
  assert.equal(/>\s*Live\s*</.test(ldm), false);
  assert.match(ldm, /MARKER_LABELS\[markerState\]/);
});

test("route-field lists match across server, web and the rules allowlists", async () => {
  const serverFields = require("../functions/src/orderRouteFields.js");
  const webFields = await import("../src/services/orderRouteFields.js");
  assert.deepEqual([...webFields.ORDER_ROUTE_FIELDS], [...serverFields.ORDER_ROUTE_FIELDS]);
  assert.deepEqual([...webFields.TRIP_ROUTE_FIELDS], [...serverFields.TRIP_ROUTE_FIELDS]);
  const listOf = (fn) => {
    const m = RULES.match(new RegExp(String.raw`function ${fn}\(\) \{\s*return \[([\s\S]*?)\];`));
    assert.ok(m, fn);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((f) => f !== "updatedAt");
  };
  const ruleFields = new Set([...listOf("routeFields"), ...listOf("tripFields")]);
  assert.deepEqual([...serverFields.ALL_ROUTE_FIELDS].sort(), [...ruleFields].sort(), "every writable route field is cleared, and only those");
  // Every place that clears a stale route uses the shared list.
  const strip2 = (p) => strip(read(p));
  assert.match(strip2("functions/src/inventoryWorkflow.js"), /\.\.\.routeFieldDeletes\(order, FieldValue\)/);
  assert.match(strip2("functions/src/destinationOperations.js"), /\.\.\.routeFieldDeletes\(order, FieldValue\)/);
  assert.match(strip2("functions/src/destinationOperations.js"), /routeFieldDeletes\(sibling\.data\(\), FieldValue, TRIP_ROUTE_FIELDS\)/);
  assert.match(strip2("src/services/orderService.js"), /for \(const field of presentRouteFields\(order\)\) update\[field\] = deleteField\(\);/);
});
