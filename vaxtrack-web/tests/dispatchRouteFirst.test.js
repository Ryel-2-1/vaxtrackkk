import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { missingEtaWarning } from "../src/services/deliveryTiming.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the dispatch warning names the orders without a route, by id for the link", () => {
  const w = missingEtaWarning([
    { id: "o1", orderNumber: "VT-ORD-1793376218955-4MJX" },
    { id: "o2", orderNumber: "VT-ORD-2", routeDurationSeconds: 900, routeGeneratedAt: { toMillis: () => 1 } },
  ]);
  assert.ok(w, "an order without a route is reported");
  assert.ok(w.orderIds.includes("o1"));
  assert.equal(w.orderIds.length, w.count);
  assert.equal(missingEtaWarning([]), null);
});

test("Finalize dispatch offers 'Generate route first' and says the rider's location must be on", () => {
  const page = read("src/pages/dispatcher/DispatcherCargoLoading.jsx");
  assert.match(page, /Generate route first/);
  assert.match(page, /navigate\(`\/dispatcher\/geofence\?order=\$\{encodeURIComponent\(warning\.orderIds\[0\]\)\}`\)/);
  assert.match(page, /setConfirmGroup\(null\);\s*navigate\(/, "the dialog closes before leaving");
  assert.match(page, /VaxTrack Rider app is open with location turned on/);
});

test("Delivery Monitoring opens on ?order= and explains a missing rider location", () => {
  const page = read("src/pages/dispatcher/DispatcherGeofence.jsx");
  assert.match(page, /const requestedOrderId = searchParams\.get\("order"\) \|\| "";/);
  assert.match(page, /useState\(requestedOrderId\)/);
  assert.match(page, /useState\(Boolean\(requestedOrderId\)\)/);
  assert.match(page, /\{selected && !getLatLng\(selected\.lastLocation\) && \(/);
  assert.match(page, /open the VaxTrack Rider app\s+with location turned on/);
  assert.match(page, /Plans from the rider&apos;s current location/);
});

test("the Dispatcher sidebar lists Delivery Monitoring before Cargo Loading", () => {
  const layout = read("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.ok(layout.indexOf("<span>Delivery Monitoring</span>") < layout.indexOf("<span>Cargo Loading</span>"));
});
