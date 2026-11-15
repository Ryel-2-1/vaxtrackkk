import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveMapProvider } from "../src/services/mapProvider.js";

// Google Maps is the web map (2026-11-15); OpenStreetMap is only the safety
// net when there is no key, when forced, or when Google fails to load.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Google whenever a key is configured; OpenStreetMap only without one or when forced", () => {
  const key = "AIza-test";
  assert.equal(resolveMapProvider({ apiKey: key }), "google");
  assert.equal(resolveMapProvider({ apiKey: key, envProvider: "google" }), "google");
  assert.equal(resolveMapProvider({ apiKey: key, envProvider: "bing" }), "google", "unknown values ignored");
  assert.equal(resolveMapProvider({ apiKey: key, envProvider: "osm" }), "osm", "the emergency switch");
  assert.equal(resolveMapProvider({}), "osm", "no key: the safety net");
  assert.equal(resolveMapProvider({ apiKey: "   " }), "osm");
});

test("users are never offered a map choice", () => {
  const src = read("src/services/mapProvider.js");
  for (const gone of ["localStorage", "location.search", "switchMapProvider", "?maps="]) {
    assert.equal(src.includes(gone), false, gone);
  }
  for (const p of ["src/pages/admin/GooglePinPicker.jsx", "src/components/maps/GoogleRouteMap.jsx", "src/components/tracking/GoogleFleetMap.jsx", "src/components/LiveDeliveryMap.jsx", "src/components/tracking/FleetMap.jsx", "src/pages/admin/ClinicLocationSection.jsx", "src/pages/dispatcher/DispatcherGeofence.jsx"]) {
    assert.equal(/MapProviderNote|Switch to OpenStreetMap|Switch to Google/.test(read(p)), false, p);
  }
});

test("each map has a Google version and falls back to OpenStreetMap", () => {
  const picker = read("src/pages/admin/ClinicLocationSection.jsx");
  assert.match(picker, /const useGoogle = provider === "google" && !googleFailed;/);
  assert.match(picker, /onUnavailable=\{onGoogleUnavailable\}/);
  assert.match(picker, /if \(useGoogle \|\| !containerRef\.current \|\| mapRef\.current\) return;/);
  const fleet = read("src/components/tracking/FleetMap.jsx");
  assert.match(fleet, /if \(provider === "google" && !googleFailed\) return <GoogleFleetMap/);
  assert.match(fleet, /return <OsmFleetMap \{\.\.\.props\} \/>;/);
  for (const p of ["src/pages/admin/GooglePinPicker.jsx", "src/components/tracking/GoogleFleetMap.jsx"]) {
    assert.match(read(p), /if \(status === "failed"\) onUnavailable/, p);
  }
});

test("address search asks Places for basic fields only, in the Philippines", () => {
  const picker = read("src/pages/admin/GooglePinPicker.jsx");
  assert.match(picker, /fetchFields\(\{ fields: \["location", "formattedAddress"\] \}\)/);
  assert.match(picker, /includedRegionCodes: \["ph"\]/);
  // Register Clinic can take the found address; it never overwrites silently.
  assert.match(read("src/pages/admin/Clinics.jsx"), /onUseAddress=\{\(address\) => editField\("location", address\)\}/);
});

test("the Google Maps hosts are allowed by every content security policy", () => {
  const vite = read("vite.config.js");
  const netlify = read("../netlify.toml");
  for (const host of ["https://maps.googleapis.com", "https://maps.gstatic.com", "https://places.googleapis.com", "https://mapsresources-pa.googleapis.com"]) {
    assert.ok(netlify.includes(host), `netlify.toml: ${host}`);
    assert.equal(vite.split(host).length - 1 >= 2, true, `vite dev + preview: ${host}`);
  }
  // Only Google's own script host — no blanket wildcard, no new 'unsafe-eval'.
  const prodScript = /script-src [^;"]*/.exec(netlify)[0];
  assert.equal(prodScript.includes("unsafe-eval"), false);
  assert.equal(prodScript.includes("*"), false);
});

test("the key is read from the build env, never hard-coded", () => {
  const loader = read("src/components/maps/googleMapsLoader.js");
  assert.match(loader, /const key = googleMapsApiKey\(\);/);
  assert.equal(/AIza[0-9A-Za-z_-]{10,}/.test(loader + read("src/services/mapProvider.js")), false);
});

test("phase 2: the delivery map and the Geofence map have Google versions too", () => {
  const ldm = read("src/components/LiveDeliveryMap.jsx");
  assert.match(ldm, /const \[useGoogle, onUnavailable\] = useMapProvider\(\);/);
  assert.match(ldm, /if \(!useGoogle\) return <OsmMapCanvas \{\.\.\.props\} \/>;/);
  assert.match(ldm, /<GoogleRouteMap\s*\n\s*className="ldm-map"/);
  const geo = read("src/pages/dispatcher/DispatcherGeofence.jsx");
  assert.match(geo, /if \(!useGoogle\) return <OsmRiderLocationMap \{\.\.\.props\} \/>;/);
  assert.match(geo, /<GoogleRouteMap\s*\n\s*className="geo3-live-map"/);
  // One stop markup for both providers, so a stop looks the same on each.
  assert.match(geo, /html: numberedStopHtml\(n, state, navigating\),/);
  assert.match(geo, /html: numberedStopHtml\(s\.label, s\.state, s\.navigating\),/);
  const route = read("src/components/maps/GoogleRouteMap.jsx");
  assert.match(route, /if \(status === "failed"\) onUnavailable/);
  // Same colours as the OpenStreetMap layers: route green, arrival circle amber.
  assert.match(route, /strokeColor: "#047857"/);
  assert.match(route, /strokeColor: "#b45309"/);
  // Read-only: the Google maps never write to Firestore.
  for (const p of ["src/components/maps/GoogleRouteMap.jsx", "src/components/tracking/GoogleFleetMap.jsx"]) {
    assert.equal(/firebase\/firestore|updateDoc|setDoc|httpsCallable/.test(read(p)), false, p);
  }
});
