import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEGACY_LOCATION_FIELDS,
  chunk,
  legacyFieldsIn,
  planLegacyLocationCleanup,
  summarizePlan,
} from "../scripts/legacyRiderLocationPlan.mjs";
import { assertStagingTarget } from "../scripts/stagingAuditAnalysis.mjs";

/**
 * The legacy-location cleanup removes the copies the old Rider app left on
 * orders and rider users — and nothing else. It is staging-only, dry-run by
 * default, and never prints a coordinate.
 */

const SCRIPT = readFileSync(new URL("../scripts/cleanupLegacyRiderLocations.mjs", import.meta.url), "utf8");
const OLD_SERVICE_FIELDS = ["lastLocation", "lastLocationUpdate", "locationAccuracy", "heading", "speed"];

test("targets exactly the fields the old LocationService wrote", () => {
  assert.deepEqual([...LEGACY_LOCATION_FIELDS], OLD_SERVICE_FIELDS);
});

test("orders lose every legacy field and keep everything else", () => {
  const fields = legacyFieldsIn("orders", { status: "in_transit", lastLocation: {}, lastLocationUpdate: 1, heading: 0, routePolyline: "x" });
  assert.deepEqual(fields, ["lastLocation", "lastLocationUpdate", "heading"]);
  assert.deepEqual(legacyFieldsIn("orders", { status: "delivered" }), []);
});

test("users: only riders, and heading/speed only alongside a location copy", () => {
  assert.deepEqual(legacyFieldsIn("users", { role: "rider", lastLocation: {}, speed: 2 }), ["lastLocation", "speed"]);
  assert.deepEqual(legacyFieldsIn("users", { role: "rider", heading: 90 }), [], "no copy → nothing assumed");
  assert.deepEqual(legacyFieldsIn("users", { role: "admin", lastLocation: {} }), []);
  assert.deepEqual(legacyFieldsIn("inventory", { lastLocation: {} }), [], "no other collection is touched");
});

test("plan is exact, ordered and summarised without values", () => {
  const ops = planLegacyLocationCleanup({
    orders: [{ id: "o2", lastLocation: { latitude: 14.6, longitude: 121 } }, { id: "o1", status: "x" }],
    users: [{ id: "u1", role: "rider", lastLocationUpdate: 5 }],
  });
  assert.deepEqual(ops, [
    { collection: "orders", id: "o2", fields: ["lastLocation"] },
    { collection: "users", id: "u1", fields: ["lastLocationUpdate"] },
  ]);
  const summary = summarizePlan(ops);
  assert.deepEqual(summary, { documents: 2, byCollection: { orders: 1, users: 1 }, byField: { lastLocation: 1, lastLocationUpdate: 1 } });
  assert.equal(JSON.stringify(summary).includes("14.6"), false);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the script refuses production and needs a second confirmation to write", () => {
  assert.equal(assertStagingTarget({ argv: ["--project", "vaxtrack-bef1b"], configuredProjectId: "vaxtrack-bef1b" }).ok, false);
  assert.equal(assertStagingTarget({ argv: [], configuredProjectId: "vaxtrack-staging" }).ok, false);
  assert.match(SCRIPT, /assertStagingTarget\(\{ argv: process\.argv/);
  assert.match(SCRIPT, /process\.env\.VAXTRACK_CLEANUP_CONFIRM !== REQUIRED_PROJECT_ID/);
  assert.match(SCRIPT, /const APPLY = process\.argv\.includes\("--apply"\);/);
  // Deletes fields only — never a document.
  assert.equal(/deleteDoc|batch\.delete|\.delete\(/.test(SCRIPT), false);
  assert.match(SCRIPT, /deleteField\(\)/);
  // Prints ids and field names, never the values it removes.
  assert.equal(/console\.log\([^)]*(latitude|longitude|op\.data|snap\.data\(\))/.test(SCRIPT), false);
});
