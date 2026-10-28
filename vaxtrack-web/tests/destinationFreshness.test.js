import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  clinicPinDrift,
  clinicsById,
  orderArrival,
  routeNeedsRegenerating,
} from "../src/services/destinationFreshness.js";
import { MAX_ACCESS_NOTES_LENGTH, validateEntranceDetails } from "../src/services/clinicLocation.js";

/**
 * Destination pin and arrival accuracy:
 *   - an order's arrival point is its OWN copy, checked separately from the clinic;
 *   - a later clinic correction is detected and can be applied through the
 *     Med Rep-approved refresh;
 *   - a corrected destination flags that the route must be generated again;
 *   - a pin is saved only with the entrance confirmation.
 */

const require = createRequire(import.meta.url);
const policy = require("../functions/src/policy.js");
const { sameArrival } = require("../functions/src/destinationOperations.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const clinic = {
  id: "clinic1", clinicId: "C-1", name: "Staging Clinic", location: "10 Mabini Street, Manila",
  areaId: "area1", area: "Manila", latitude: 14.5, longitude: 120.9, geofenceRadiusM: 300,
  locationVerified: true, entranceConfirmed: true, accessNotes: "Side gate",
};
// The order's copy, exactly as the server builds it.
const snapshot = policy.buildOrderDestinationSnapshot({
  doctorId: "doctor1", doctorAddressId: "clinic1", doctor: { name: "Dr. Ana Reyes", active: true },
  relationship: { active: true }, clinic, area: { name: "Manila", active: true },
}).orderFields;
const order = (over = {}) => ({ id: "o1", ...snapshot, status: "assigned", statusKey: "assigned", ...over });

test("an order matching its clinic has no drift — web and server agree on 'the same arrival'", () => {
  assert.equal(clinicPinDrift(order(), clinic), null);
  assert.equal(sameArrival(order(), snapshot), true);
});

test("a corrected clinic pin, radius or entrance details are each detected", () => {
  const moved = clinicPinDrift(order(), { ...clinic, latitude: 14.5009 });
  assert.deepEqual(moved.changes, ["pin"]);
  assert.equal(moved.correctable, true);
  assert.match(moved.text, /The clinic's pin changed after this order was placed\. Request a change/);
  assert.deepEqual(clinicPinDrift(order(), { ...clinic, geofenceRadiusM: 150 }).changes, ["arrival radius"]);
  assert.deepEqual(clinicPinDrift(order(), { ...clinic, accessNotes: "Front door" }).changes, ["entrance details"]);
  assert.deepEqual(
    clinicPinDrift(order(), { ...clinic, latitude: 14.6, geofenceRadiusM: 150, entranceConfirmed: false }).changes,
    ["pin", "arrival radius", "entrance details"]
  );
  // Whitespace-only differences are not a change (same normalisation as the server).
  assert.equal(clinicPinDrift(order(), { ...clinic, accessNotes: "  Side   gate " }), null);
});

test("in transit: the drift is reported but not correctable — arrival stays the order's saved point", () => {
  const d = clinicPinDrift(order({ status: "in_transit", statusKey: "in_transit" }), { ...clinic, latitude: 14.51 });
  assert.equal(d.correctable, false);
  assert.match(d.text, /Arrival is still checked against the order's saved point/);
});

test("nothing is compared for a home destination, another clinic, or a clinic without a valid verified pin", () => {
  assert.equal(clinicPinDrift(order({ destinationType: "home" }), { ...clinic, latitude: 14.51 }), null);
  assert.equal(clinicPinDrift(order(), { ...clinic, id: "other", latitude: 14.51 }), null);
  assert.equal(clinicPinDrift(order(), { ...clinic, locationVerified: false, latitude: 14.51 }), null);
  assert.equal(clinicPinDrift(order(), { ...clinic, latitude: 95 }), null);
  assert.equal(clinicPinDrift(order(), undefined), null);
});

test("older orders without canonical fields are read from their clinic* copy", () => {
  const legacy = { id: "o", clinicDocId: "clinic1", clinicLat: 14.5, clinicLng: 120.9, clinicGeofenceRadiusM: 300, status: "assigned" };
  assert.deepEqual(orderArrival(legacy), { lat: 14.5, lng: 120.9, radius: 300, notes: "", entrance: false });
  assert.deepEqual(clinicPinDrift(legacy, clinic).changes, ["entrance details"]);
  assert.equal(clinicsById([clinic, { name: "no id" }]).size, 1);
});

test("a corrected destination without a route asks for one; a regenerated route or trip clears it", () => {
  const corrected = order({ destinationCorrectedAt: { seconds: 1 } });
  assert.equal(routeNeedsRegenerating(corrected), true);
  assert.equal(routeNeedsRegenerating({ ...corrected, routePolyline: "abc" }), false);
  assert.equal(routeNeedsRegenerating({ ...corrected, tripPolyline: "abc" }), false);
  assert.equal(routeNeedsRegenerating(order()), false, "never corrected");
  assert.equal(routeNeedsRegenerating({ ...corrected, status: "delivered", statusKey: "delivered" }), false);
});

test("a pin is saved only with the entrance confirmation; notes are optional and bounded", () => {
  assert.equal(MAX_ACCESS_NOTES_LENGTH, policy.MAX_ACCESS_NOTES_LENGTH, "web and server agree");
  assert.deepEqual(validateEntranceDetails({ entranceConfirmed: true, accessNotes: "  Gate \n on Rizal " }), {
    ok: true, errors: {}, value: { entranceConfirmed: true, accessNotes: "Gate on Rizal" },
  });
  assert.equal(validateEntranceDetails({ entranceConfirmed: true }).value.accessNotes, "");
  assert.match(validateEntranceDetails({}).errors.entranceConfirmed, /entrance riders use/);
  assert.ok(validateEntranceDetails({ entranceConfirmed: true, accessNotes: "x".repeat(301) }).errors.accessNotes);
});

test("wiring: saving a pin requires the confirmation; the picker resets it when the pin moves", () => {
  const svc = read("src/services/clinicService.js");
  assert.match(svc, /const entrance = validateEntranceDetails\(input\);\s*if \(!entrance\.ok\) throw/);
  assert.match(svc, /entranceConfirmed: true,\s*accessNotes: entrance\.value\.accessNotes,\s*entranceConfirmedAt: serverTimestamp\(\),/);
  assert.match(svc, /\/\/ A pin is only saved together with the entrance confirmation\./);
  const picker = read("src/pages/admin/ClinicLocationSection.jsx");
  assert.match(picker, /showEntrance && \("latitude" in patch \|\| "longitude" in patch\) \? onChange\(\{ \.\.\.patch, entranceConfirmed: false \}\)/);
  const page = read("src/pages/admin/Clinics.jsx");
  assert.equal((page.match(/showEntrance\r?\n/g) || []).length, 2, "Register and Manage location both ask");
  assert.match(page, /Entrance not confirmed/);
});

test("wiring: Dispatch sees the notes, can request the refresh, and the Med Rep sees it is a refresh", () => {
  for (const file of ["DispatcherShipments.jsx", "DispatcherGeofence.jsx", "DispatcherCargoLoading.jsx"]) {
    assert.match(read(`src/pages/dispatcher/${file}`), /<DestinationNotes order=\{/, file);
  }
  const dialog = read("src/pages/dispatcher/DestinationCorrectionDialog.jsx");
  assert.match(dialog, /\.filter\(\(item\) => item\.id !== order\.doctorAddressId \|\| drift\)/);
  assert.match(dialog, /Use the clinic's corrected pin/);
  assert.match(read("src/pages/salesRep/SalesRepOrderTracking.jsx"), /changeRequest\.refresh/);
});
