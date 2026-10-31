import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Dispatcher Geofence: route planning needs a fresh rider fix (audit finding
 * 3), and the shipment drawer keeps the Dispatcher's styles (finding 9).
 */
const page = readFileSync(new URL("../src/pages/dispatcher/DispatcherGeofence.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Generate route and Re-optimize refuse a stale or undated rider fix", () => {
  // Fresh means a position, a timestamp, and within the shared staleness window.
  assert.match(page, /function hasFreshFix\(location, ts\) \{\s*return !!getLatLng\(location\) && !!ts && !isLocationStale\(ts\);\s*\}/);
  assert.match(page, /const STALE_LOCATION_MS = FRESHNESS\.freshMs;/);
  // The buttons are disabled with the reason shown…
  assert.match(page, /const canOptimize = fixIsFresh && riderStops\.length >= 2;/);
  assert.match(page, /const canGenerate = !!clinicLL && fixIsFresh;/);
  assert.equal((page.match(/\{STALE_FIX_REASON\}|\? STALE_FIX_REASON/g) || []).length, 2);
  // …and each handler re-checks at click time (a fix can age on screen),
  // before any routing request or save.
  for (const [name, call] of [["handleOptimizeTrip", "fetchTravelMatrix"], ["handleGenerateRoute", "fetchRoute"]]) {
    const body = new RegExp(`async function ${name}\\(\\) \\{([\\s\\S]*?)\\n {2}\\}\\n`).exec(page)?.[1] ?? "";
    const guard = body.indexOf("hasFreshFix(selected.lastLocation, selected.lastLocationUpdate)");
    assert.ok(guard > 0, `${name} checks freshness`);
    assert.ok(guard < body.indexOf(call), `${name} checks before routing`);
    assert.match(body, /message: STALE_FIX_REASON \}\);\s*return;/);
  }
});

test("shipment details render in place beside the list — no pop-up drawer", () => {
  // Master-detail (2026-10-31): selecting a shipment updates the right column;
  // the drawer (and its dialog layer) is gone.
  assert.doesNotMatch(page, /ShipmentDrawer|geo3-drawer|drawerOrderId|<DialogLayer\b|DispatcherDialogLayer/);
  assert.match(page, /<div className="geo3-split">\s*<div className="geo3-card geo3-split-list">/);
  assert.match(page, /\{pageShipments\.map\(\(order\) => \{/);
  assert.match(page, /aria-pressed=\{isActive\}\s*onClick=\{\(\) => setSelectedId\(order\.id\)\}/);
  assert.match(page, /<PageNav page=\{currentListPage\} total=\{activeOrders\.length\} onPageChange=\{setListPage\} label="Active shipment pages" \/>/);
  assert.match(page, /<div className="geo3-split-detail" aria-label="Selected shipment">[\s\S]*?<TripProgress[\s\S]*?Shipment overview/);
});
