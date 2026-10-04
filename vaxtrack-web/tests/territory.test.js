import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NO_TERRITORY_MESSAGE,
  TERRITORY_FIELDS,
  canManageTerritory,
  clinicsOutsideAreas,
  isDestinationPermitted,
  openOrdersLosingTerritory,
  permittedDoctors,
  readTerritory,
  territoryDestinationOptions,
  validateTerritoryAssignment,
} from "../src/services/territory.js";
import { resolveRestoredDestination } from "../src/services/orderDraftRequest.js";
import { SELF_EDITABLE_FIELDS, buildProfileUpdate } from "../src/services/profileModel.js";

// Med Rep territory on the web side: the Admin assignment rules, the checkout
// filtering, and saved-checkout restoration. The server enforces the same rule
// at order time (functions/test/territory.test.js + the emulator suite), so
// these tests are about what the UI offers, not about what is permitted.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------- fixtures

const areas = [
  { id: "manila", name: "Manila", active: true },
  { id: "laguna", name: "Laguna", active: true },
  { id: "closed", name: "Closed Area", active: false },
];
const clinic = (id, areaId, area, over = {}) => ({
  id, name: `Clinic ${id}`, location: `${id} Main Street`, areaId, area,
  locationVerified: true, latitude: 14.5, longitude: 121.0, geofenceRadiusM: 300, ...over,
});
const clinics = [
  clinic("cm1", "manila", "Manila"),
  clinic("cm2", "manila", "Manila"),
  clinic("cl1", "laguna", "Laguna"),
  clinic("cmUnverified", "manila", "Manila", { locationVerified: false }),
];
const home = (areaId, area) => ({
  id: "home", homeAddress: true, kind: "home", active: true,
  addressLine: "25 Rizal Avenue", areaId, area, latitude: 14.6, longitude: 120.98,
});
const link = (clinicDocId, active = true) => ({ id: clinicDocId, destinationType: "clinic", clinicDocId, active });

const doctors = [
  { id: "dBoth", name: "Dr. Both", active: true },
  { id: "dLaguna", name: "Dr. Laguna", active: true },
  { id: "dInactive", name: "Dr. Inactive", active: false },
];
const addressesByDoctor = {
  // One Manila clinic (allowed) and one Laguna clinic (not allowed).
  dBoth: [link("cm1"), link("cl1")],
  // Only Laguna: Home in Laguna and a Laguna clinic.
  dLaguna: [home("laguna", "Laguna"), link("cl1")],
  dInactive: [link("cm1")],
};
const manilaRep = readTerritory({ assignedAreaIds: ["manila"], assignedClinicIds: ["cm1"] });

// ---------------------------------------------------------------- Admin assignment

test("1 · Admin can assign valid areas and clinics", () => {
  const r = validateTerritoryAssignment({ areaIds: ["manila", "laguna"], clinicIds: ["cm1", "cl1"], areas, clinics });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { areaIds: ["manila", "laguna"], clinicIds: ["cm1", "cl1"] });
});

test("3 · a clinic outside the selected areas is rejected", () => {
  const r = validateTerritoryAssignment({ areaIds: ["manila"], clinicIds: ["cl1"], areas, clinics });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /not inside a selected area/);
});

test("4 · inactive or missing areas and unverified or missing clinics cannot be newly assigned", () => {
  assert.equal(validateTerritoryAssignment({ areaIds: ["closed"], clinicIds: [], areas, clinics }).ok, false);
  assert.equal(validateTerritoryAssignment({ areaIds: ["gone"], clinicIds: [], areas, clinics }).ok, false);
  assert.equal(validateTerritoryAssignment({ areaIds: ["manila"], clinicIds: ["cmUnverified"], areas, clinics }).ok, false);
  assert.equal(validateTerritoryAssignment({ areaIds: ["manila"], clinicIds: ["ghost"], areas, clinics }).ok, false);
  // Already-assigned records that were later deactivated may stay until removed.
  const previous = { assignedAreaIds: ["closed", "manila"], assignedClinicIds: ["cmUnverified"] };
  assert.equal(validateTerritoryAssignment({ areaIds: ["closed", "manila"], clinicIds: ["cmUnverified"], areas, clinics, previous }).ok, true);
});

test("5 · duplicate ids are normalised away", () => {
  const r = validateTerritoryAssignment({ areaIds: ["manila", " manila ", "manila"], clinicIds: ["cm1", "cm1"], areas, clinics });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { areaIds: ["manila"], clinicIds: ["cm1"] });
  assert.deepEqual(readTerritory({ assignedAreaIds: ["a", "a", 3, "", "x/y"] }).areaIds, ["a"]);
});

test("removing an area drops its clinics from the selection", () => {
  assert.deepEqual(clinicsOutsideAreas(["cm1", "cl1"], ["manila"], clinics), ["cl1"]);
});

test("2/17 · territory controls exist only for Active or Inactive Med Reps", () => {
  assert.equal(canManageTerritory({ rawRole: "salesrep", status: "active" }), true);
  assert.equal(canManageTerritory({ rawRole: "salesrep", status: "inactive" }), true);
  assert.equal(canManageTerritory({ rawRole: "salesrep", status: "pending" }), false);
  assert.equal(canManageTerritory({ rawRole: "salesrep", status: "rejected" }), false);
  for (const rawRole of ["admin", "dispatcher", "rider"]) {
    assert.equal(canManageTerritory({ rawRole, status: "active" }), false, rawRole);
  }
  const settings = code("src/pages/admin/Settings.jsx");
  assert.equal(settings.split("canManageTerritory(person) && (").length - 1, 3, "row menu, details field, details button");
});

test("the Admin save writes only the territory fields, never role or status", () => {
  const svc = code("src/services/userService.js");
  const fn = svc.slice(svc.indexOf("export async function updateMedRepTerritory"));
  assert.match(fn, /transaction\.update\(userRef, \{\s*assignedAreaIds: check\.value\.areaIds,\s*assignedClinicIds: check\.value\.clinicIds,\s*territoryUpdatedAt: serverTimestamp\(\),\s*territoryUpdatedByUid: adminUid,\s*\}\);/);
  assert.match(fn, /Territory can only be assigned to a Med Rep\./);
  assert.doesNotMatch(fn, /role:|status:/);
});

// ---------------------------------------------------------------- checkout filtering

test("6 · checkout lists only doctors with a permitted active destination", () => {
  assert.deepEqual(permittedDoctors(doctors, addressesByDoctor, clinics, manilaRep).map((d) => d.id), ["dBoth"]);
  const lagunaRep = readTerritory({ assignedAreaIds: ["laguna"], assignedClinicIds: [] });
  // Home in Laguna is enough; the inactive doctor never appears.
  assert.deepEqual(permittedDoctors(doctors, addressesByDoctor, clinics, lagunaRep).map((d) => d.id), ["dLaguna"]);
});

test("7 · checkout offers only destinations inside the territory", () => {
  const options = territoryDestinationOptions(addressesByDoctor.dLaguna, clinics, readTerritory({ assignedAreaIds: ["laguna"], assignedClinicIds: ["cl1"] }));
  assert.deepEqual(options.map((o) => o.id).sort(), ["cl1", "home"]);
  // An area alone permits Home, not the clinics inside it.
  const areaOnly = territoryDestinationOptions(addressesByDoctor.dLaguna, clinics, readTerritory({ assignedAreaIds: ["laguna"] }));
  assert.deepEqual(areaOnly.map((o) => o.id), ["home"]);
});

test("8 · a doctor with one allowed and one disallowed clinic shows only the allowed one", () => {
  const options = territoryDestinationOptions(addressesByDoctor.dBoth, clinics, manilaRep);
  assert.deepEqual(options.map((o) => o.id), ["cm1"]);
  assert.equal(isDestinationPermitted({ type: "clinic", areaId: "laguna", clinicDocId: "cl1" }, manilaRep), false);
  // An assigned clinic whose area is not assigned is still outside.
  const odd = readTerritory({ assignedAreaIds: ["manila"], assignedClinicIds: ["cm1", "cl1"] });
  assert.equal(isDestinationPermitted({ type: "clinic", areaId: "laguna", clinicDocId: "cl1" }, odd), false);
});

test("9 · no assignment: no doctors, the agreed message, and no submission", () => {
  const none = readTerritory({});
  assert.equal(none.assigned, false);
  assert.deepEqual(permittedDoctors(doctors, addressesByDoctor, clinics, none), []);
  assert.equal(NO_TERRITORY_MESSAGE, "No territory has been assigned to your account. Contact an administrator.");
  const checkout = code("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(checkout, /!territory\.assigned \? \(\s*<p className="checkout-territory-empty" role="status">\s*\{NO_TERRITORY_MESSAGE\}/);
  assert.match(checkout, /if \(!territory\.assigned\) \{\s*submittingRef\.current = false;\s*setMessage\(NO_TERRITORY_MESSAGE\);\s*return;/);
  assert.match(checkout, /doctorListLoading \|\|\s*!territory\.assigned \|\|/);
});

test("10 · order history is not filtered by territory", () => {
  for (const page of ["SalesRepOrderTracking.jsx", "SalesRepDashboard.jsx", "SalesRepAlerts.jsx"]) {
    assert.doesNotMatch(read(`src/pages/salesRep/${page}`), /territory/i, page);
  }
});

// ---------------------------------------------------------------- saved checkout

test("11/12 · a saved destination is restored only while it stays inside the territory", () => {
  const optionIds = territoryDestinationOptions(addressesByDoctor.dBoth, clinics, manilaRep).map((o) => o.id);
  assert.deepEqual(
    resolveRestoredDestination({ pending: { doctorId: "dBoth", destinationId: "cm1" }, doctorId: "dBoth", ready: true, optionIds }),
    { status: "restored", destinationId: "cm1" }
  );
  // cl1 was linked and saved, but is no longer inside the territory.
  assert.deepEqual(
    resolveRestoredDestination({ pending: { doctorId: "dBoth", destinationId: "cl1" }, doctorId: "dBoth", ready: true, optionIds }),
    { status: "rejected", destinationId: "" }
  );
  const checkout = code("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  // The restore check runs against the territory-filtered options...
  assert.match(checkout, /territoryDestinationOptions\(doctorAddresses, clinics, territory\)/);
  assert.match(checkout, /optionIds: destinationOptions\.map\(\(destination\) => destination\.id\)/);
  // ...an unpermitted saved doctor is not restored, and the rep is told why.
  assert.match(checkout, /const doctorSelectValue = doctorListLoading \|\| selectedDoctor \? selectedDoctorId : "";/);
  assert.match(checkout, /Select the doctor and\s+delivery address again\./);
  // Cart items and the requested date are untouched by any of this.
  assert.match(checkout, /requestedDeliveryDate: requestedDate,/);
});

// ---------------------------------------------------------------- history + self-edit

test("15 · removing assignments only warns about open orders; it never rewrites them", () => {
  const orders = [
    { id: "o1", createdByUid: "rep", status: "assigned", destinationType: "clinic", destinationAreaId: "laguna", clinicDocId: "cl1" },
    { id: "o2", createdByUid: "rep", status: "delivered", destinationType: "clinic", destinationAreaId: "laguna", clinicDocId: "cl1" },
    { id: "o3", createdByUid: "rep", status: "pending_dispatch", destinationType: "home", destinationAreaId: "manila" },
    { id: "o4", createdByUid: "other", status: "assigned", destinationType: "clinic", destinationAreaId: "laguna", clinicDocId: "cl1" },
    { id: "o5", createdByUid: "rep", status: "in_transit" },
  ];
  const affected = openOrdersLosingTerritory(orders, "rep", { areaIds: ["manila"], clinicIds: ["cm1"] });
  assert.deepEqual(affected.map((o) => o.id), ["o1"]);
  const dialog = code("src/pages/admin/MedRepTerritoryDialog.jsx");
  assert.doesNotMatch(dialog, /updateDoc|setDoc|orders\//);
  assert.match(dialog, /will not be changed or cancelled/);
});

test("16 · My Profile cannot write any territory field", () => {
  for (const f of TERRITORY_FIELDS) assert.equal(SELF_EDITABLE_FIELDS.includes(f), false, f);
  const update = buildProfileUpdate({}, { name: "Ana Reyes", phone: "", assignedAreaIds: ["x"], assignedClinicIds: ["y"] });
  for (const f of TERRITORY_FIELDS) assert.equal(f in update, false, f);
});
