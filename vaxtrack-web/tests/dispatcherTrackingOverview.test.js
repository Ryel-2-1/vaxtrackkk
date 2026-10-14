import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "../src/services/riderTracking.js";

/**
 * Dispatcher dashboard › "Active delivery overview" (DispatcherTrackingOverview).
 *
 * The repo has no DOM test renderer, so behaviour is proven on the pure
 * view-model the component renders from (services/riderTracking.js — the same
 * rules as Live Tracking), and the markup / CSS contract by source shape.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DASH = strip(read("src/pages/dispatcher/DispatcherDashboard.jsx"));
const VIEW = strip(read("src/components/tracking/DispatcherTrackingOverview.jsx"));
const CSS = read("src/components/tracking/DispatcherTrackingOverview.css");
const FEEDS = strip(read("src/components/tracking/useRiderTrackingFeeds.js"));
const MAP = strip(read("src/components/tracking/FleetMap.jsx"));

const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);
const MIN = 60 * 1000;
const loc = (ageMs, over = {}) => ({
  riderUid: "x", latitude: 14.6, longitude: 121.0, accuracyMeters: 9,
  capturedAt: NOW - ageMs, updatedAt: NOW - ageMs, trackingState: "active", ...over,
});
const order = (id, rider, status = "in_transit", extra = {}) => ({ id, orderNumber: `VT-ORD-${id}`, assignedRiderId: rider, status, ...extra });
const fleetOf = (orders, locations, deviations = {}, riders = {}) => T.buildFleet({ orders, locations, deviations, riders, nowMs: NOW });

// ---------------------------------------------------------------- obsolete content

test("the obsolete 'not yet active' content is gone — no placeholder replaces it", () => {
  for (const text of ["not yet active", "Route and geofence map tracking will activate", "Live map view", "Delayed Routes", "delayed routes"]) {
    assert.equal(DASH.includes(text), false, text);
    assert.equal(VIEW.includes(text), false, text);
  }
  assert.equal(/monitor-note|MonitorInfo/.test(DASH), false);
  assert.equal(/dispatcher-dash-(monitor-note|monitor-footer|monitor-info|map)\b/.test(read("src/pages/dispatcher/Dispatcher.css")), false, "dead CSS removed");
});

// ---------------------------------------------------------------- states

test("overview state: permission and errors are never shown as empty; loading shows no counts", () => {
  const live = fleetOf([order("a", "r1")], { r1: loc(30000) });
  const s = (over) => T.trackingOverviewState({ error: null, orders: [], locations: {}, fleet: [], ...over });
  assert.equal(s({ error: "permission", orders: null, locations: null }), "permission");
  assert.equal(s({ error: "error" }), "error");
  assert.equal(s({ orders: null }), "loading");
  assert.equal(s({ locations: null }), "loading");
  assert.equal(s({}), "empty");
  assert.equal(s({ fleet: fleetOf([order("a", "r1")], {}) }), "waiting", "active order, no location");
  assert.equal(s({ fleet: live }), "live");
  // The component renders the loading line, not zeros, while loading.
  assert.match(VIEW, /view === "loading"[\s\S]*Loading live locations…/);
});

test("each state renders its exact message, compactly; the map mounts only when there are positions", () => {
  assert.match(VIEW, /You do not have permission to view live Rider locations\./);
  assert.match(VIEW, /Live Rider locations could not be loaded\.[\s\S]*onClick=\{retry\}[\s\S]*Try again/);
  assert.match(VIEW, /No riders are currently on delivery\./);
  assert.match(VIEW, /Waiting for Rider location updates\.[\s\S]*keep location sharing active/);
  assert.match(VIEW, /view === "live" \? \(\s*<FleetMap riders=\{mapRiders\}/);
  assert.match(VIEW, /const mapRiders = useMemo\(\(\) => fleet\.filter\(\(r\) => r\.latLng\)/);
  // No map, and no list, in the empty / loading / error states.
  assert.match(VIEW, /\(view === "waiting" \|\| view === "live"\) && \(\s*<div className="dto-grid">/);
  // The error does not leak Firebase internals.
  assert.equal(/err\.message|error\.message|\{error\}/.test(VIEW), false);
});

// ---------------------------------------------------------------- rows

test("only the first 3 riders render, most urgent first, then '+ N more riders'", () => {
  const orders = ["a", "b", "c", "d", "e"].map((id, i) => order(id, `r${i}`));
  const locations = { r0: loc(30000), r1: loc(30000), r2: loc(5 * MIN), r3: loc(30000), r4: loc(30000) };
  const deviations = { r3: { sessionState: "navigating", routeStatus: "available", phase: "deviating" } };
  const riders = { r0: { fullName: "Ana" }, r1: { fullName: "Ben" }, r2: { fullName: "Cy" }, r3: { fullName: "Dee" }, r4: { fullName: "Eve" } };
  const { rows, moreCount, moreLabel } = T.trackingOverviewRows(fleetOf(orders, locations, deviations, riders), NOW);
  assert.equal(T.OVERVIEW_RIDER_LIMIT, 3);
  assert.deepEqual(rows.map((r) => [r.name, r.state]), [["Dee", "deviating"], ["Ana", "fresh"], ["Ben", "fresh"]]);
  assert.equal(moreCount, 2);
  assert.equal(moreLabel, "+ 2 more riders");
  assert.equal(T.trackingOverviewRows(fleetOf(orders.slice(0, 4), locations), NOW).moreLabel, "+ 1 more rider");
  assert.equal(T.trackingOverviewRows(fleetOf(orders.slice(0, 3), locations), NOW).moreLabel, null);
  assert.match(VIEW, /\{moreLabel && <p className="dto-more tnum">\{moreLabel\}<\/p>\}/);
});

test("a row carries the name, delivery count, order ids, state badge and last update", () => {
  const fleet = fleetOf(
    [order("1", "r1"), order("2", "r1", "assigned")],
    { r1: loc(4 * MIN) },
    {},
    { r1: { fullName: "Maria Clara Santos-Dela Cruz y Villanueva of Quezon City" } },
  );
  const [row] = T.trackingOverviewRows(fleet, NOW).rows;
  assert.deepEqual(
    { name: row.name, state: row.state, label: row.label, deliveryLabel: row.deliveryLabel, orderNumbers: row.orderNumbers, age: row.age },
    { name: "Maria Clara Santos-Dela Cruz y Villanueva of Quezon City", state: "stale", label: "Stale", deliveryLabel: "2 deliveries", orderNumbers: "VT-ORD-1, VT-ORD-2", age: "4m ago" },
  );
  const [one] = T.trackingOverviewRows(fleetOf([order("9", "r9")], { r9: loc(1000) }), NOW).rows;
  assert.equal(one.deliveryLabel, "1 delivery");
  assert.match(VIEW, /<TrackingStateBadge state=\{r\.state\} \/>/);
  assert.match(VIEW, /r\.age \? `Updated \$\{r\.age\}` : "No update yet"/);
});

test("all five badges, with the unchanged 3-minute and 10-minute boundaries", () => {
  const stateAt = (location, deviation) => fleetOf([order("a", "r1")], location ? { r1: location } : {}, deviation ? { r1: deviation } : {})[0].state;
  assert.equal(stateAt(loc(3 * MIN)), "fresh", "exactly 3 min");
  assert.equal(stateAt(loc(3 * MIN + 1)), "stale", "3 min + 1 ms");
  assert.equal(stateAt(loc(10 * MIN)), "stale", "exactly 10 min");
  assert.equal(stateAt(loc(10 * MIN + 1)), "offline", "10 min + 1 ms");
  assert.equal(stateAt(loc(1000, { trackingState: "ended", latitude: null, longitude: null })), "offline", "sharing stopped");
  assert.equal(stateAt(null), "unavailable");
  assert.equal(stateAt(loc(1000), { sessionState: "navigating", routeStatus: "available", phase: "deviating" }), "deviating");
  assert.deepEqual(T.FRESHNESS, { freshMs: 3 * MIN, offlineMs: 10 * MIN });
  assert.deepEqual(
    ["fresh", "stale", "offline", "unavailable", "deviating"].map((s) => T.MARKER_LABELS[s]),
    ["Fresh", "Stale", "Offline", "Location Unavailable", "Route Deviating"],
  );
  // The overview never re-implements thresholds or labels.
  for (const src of [VIEW, MAP]) {
    assert.equal(/freshMs|offlineMs|60 \* 1000|180000|600000|"Fresh"|"Stale"|"Offline"/.test(src), false);
  }
});

// ---------------------------------------------------------------- counts

test("riders available = approved riders not carrying an active delivery (not from locations)", () => {
  const riders = [
    { uid: "a", status: "approved" },
    { uid: "b", status: "approved" },
    { uid: "c", status: "approved" },
    { uid: "d", status: "disabled" },
    { uid: "e", status: "pending" },
  ];
  const orders = [order("1", "a", "in_transit"), order("2", "b", "delayed"), order("3", "c", "delivered"), order("4", "d", "assigned")];
  assert.equal(T.availableRiderCount(riders, orders), 1, "only c: a and b are delivering, d/e are not approved");
  assert.deepEqual([...T.riderUidsOnDelivery(orders)].sort(), ["a", "b", "d"]);
  assert.equal(T.availableRiderCount(riders, []), 3);
  assert.equal(T.availableRiderCount.length, 2, "takes riders and orders — never locations");
  assert.match(DASH, /const availableRiders = useMemo\(\(\) => availableRiderCount\(riders, allOrders\), \[riders, allOrders\]\);/);
});

test("header chips and summary cells use the dashboard's real counts and wording", () => {
  // The same counts, shown as "—" when their source listener failed.
  assert.match(DASH, /<DispatcherTrackingOverview\s+orders=\{allOrders\}\s+riders=\{riders\}\s+activeCount=\{activeShown\}\s+delayedCount=\{delayedShown\}\s+pendingCount=\{pendingShown\}\s+availableCount=\{availableShown\}/);
  assert.match(DASH, /const activeShown = shown\(\["all"\], activeDeliveries\);/);
  assert.match(DASH, /const delayedShown = shown\(\["all"\], delayedDeliveries\);/);
  assert.match(DASH, /const availableShown = shown\(\["riders", "all"\], availableRiders\);/);
  assert.match(VIEW, /<span className="green tnum">\{activeCount\} active<\/span>/);
  assert.match(VIEW, /\{delayedCount > 0 && <span className="red tnum">\{delayedCount\} delayed<\/span>\}/, "delayed chip hidden at zero");
  assert.match(VIEW, /<dt>Pending orders<\/dt>\s*<dd className="tnum">\{pendingCount\} waiting for dispatch<\/dd>/);
  assert.match(VIEW, /<dt>Riders available<\/dt>[\s\S]*title="Approved riders not currently on a delivery"[\s\S]*\{availableCount\} free to assign/);
  assert.match(VIEW, /<dt>Delayed deliveries<\/dt>/);
  assert.match(DASH, /delayed \$\{delayedDeliveries === 1 \? "delivery" : "deliveries"\}/);
});

test("Open Live Tracking links to the existing, role-guarded Dispatcher route", () => {
  assert.match(VIEW, /export const LIVE_TRACKING_ROUTE = "\/dispatcher\/live-tracking";/);
  assert.equal((VIEW.match(/<Link className="dto-open" to=\{LIVE_TRACKING_ROUTE\}>/g) || []).length, 2, "in the empty and the live/waiting states");
  assert.match(read("src/App.jsx"), /<Route path="\/dispatcher\/live-tracking" element=\{<DispatcherLiveTracking \/>\} \/>/);
});

// ---------------------------------------------------------------- layout

test("content-driven height: no fixed or minimum card height; the grid no longer stretches it", () => {
  assert.match(CSS, /\.dispatcher-dash-main-grid > \.dispatcher-dash-monitor-card\.dto \{\s*align-self: start;/);
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  // Whole property names only (not line-height).
  const heights = [...noComments.matchAll(/(?<![\w-])((?:min-|max-)?height):\s*([^;]+);/g)].map((m) => `${m[1]}: ${m[2]};`);
  assert.deepEqual(heights, ["height: 300px;", "min-height: 40px;", "min-height: 36px !important;", "height: 260px;"], "only the map preview, the button and the retry control have heights");
  assert.match(noComments, /\.dto-map \{[^}]*height: 300px;/);
});

test("responsive: two columns, stacked under 760px, summary stacks, nothing forces horizontal overflow", () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.dto-grid \{[^}]*grid-template-columns: minmax\(0, 1\.25fr\) minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.dto-grid \{\s*grid-template-columns: minmax\(0, 1fr\);[\s\S]*\.dto-summary \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  // Long names / order ids truncate instead of widening the card.
  assert.match(css, /\.dto-name \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.dto-orders \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.dto-cell dd \{[^}]*overflow-wrap: anywhere;/);
  // No fixed widths, no viewport units, no negative margins.
  assert.equal(/(^|[^-])width:\s*\d+px|\d+vw|margin:\s*-/.test(css), false);
  assert.match(VIEW, /title=\{r\.name\}/, "full name available on hover");
});

test("tokens, no gradients or heavy shadows, semantic colours", () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/gradient|box-shadow/.test(css), false);
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(hex)], ["#ffffff"], "only the documented surface white");
  assert.match(css, /\.dto-cell \.dto-dd-danger \{\s*color: var\(--danger-text\);/);
});

// ---------------------------------------------------------------- data + security

test("read-only: the overview and its feeds never write and use only the authorized tracking reads", () => {
  for (const [name, src] of [["overview", VIEW], ["feeds", FEEDS], ["map", MAP], ["badge", strip(read("src/components/tracking/TrackingStateBadge.jsx"))]]) {
    assert.equal(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction|firebase\/firestore/.test(src), false, name);
  }
  assert.match(FEEDS, /import \{ subscribeAllDeviationStates, subscribeAllRiderLocations \} from "\.\.\/\.\.\/services\/riderTrackingService";/);
  // The dashboard reuses the Live Tracking subscriptions — Live Tracking itself uses the same hook.
  assert.match(VIEW, /useRiderTrackingFeeds\(\)/);
  assert.match(strip(read("src/components/tracking/LiveTrackingPanel.jsx")), /useRiderTrackingFeeds\(\)[\s\S]*<FleetMap /);
  assert.equal(/import L from "leaflet"/.test(strip(read("src/components/tracking/LiveTrackingPanel.jsx"))), false, "the map is not duplicated");
});
