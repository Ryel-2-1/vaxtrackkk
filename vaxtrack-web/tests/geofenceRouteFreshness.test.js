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

test("the shipment drawer renders through DispatcherDialogLayer", () => {
  assert.match(page, /import DispatcherDialogLayer from "\.\/DispatcherDialogLayer";/);
  assert.doesNotMatch(page, /geo3-drawer-scope|<DialogLayer\b/);
  assert.match(page, /return \(\s*<DispatcherDialogLayer>\s*<div className="geo3-drawer-overlay">/);
});
