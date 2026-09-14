import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDoctorAddress } from "../src/services/doctorAddressModel.js";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a doctor destination accepts one stable clinic document id", () => {
  assert.deepEqual(validateDoctorAddress({ clinicDocId: "  clinic-123  " }), {
    ok: true,
    errors: {},
    value: { clinicDocId: "clinic-123" },
  });
});

test("a missing or path-like clinic document id is rejected", () => {
  assert.deepEqual(validateDoctorAddress({ clinicDocId: "" }), {
    ok: false,
    errors: {
      clinicDocId: "Select a registered clinic with a verified location.",
    },
    value: null,
  });
  assert.equal(
    validateDoctorAddress({ clinicDocId: "clinics/other" }).ok,
    false
  );
});

test("the clinic document id is also the unique nested destination id", () => {
  const service = read("src/services/doctorAddressService.js");
  assert.match(
    service,
    /doc\(\s*db,\s*DOCTORS,\s*stableDoctorId,\s*ADDRESSES,\s*check\.value\.clinicDocId\s*\)/
  );
  assert.match(
    service,
    /\.\.\.data,[\s\S]*?clinicDocId: address\.id,[\s\S]*?id: address\.id/
  );
  assert.doesNotMatch(service, /doc\(collection\(db, DOCTORS/);
});

test("destination writes re-read doctor, clinic, location and area master data", () => {
  const service = read("src/services/doctorAddressService.js");
  assert.match(service, /readActiveRelationships/);
  assert.match(service, /transaction\.get\(doctorRef\)/);
  assert.match(service, /transaction\.get\(clinicRef\)/);
  assert.match(service, /transaction\.get\(areaRef\)/);
  assert.match(service, /clinic\.locationVerified !== true/);
  assert.match(service, /validateClinicLocation\(clinic\)/);
  assert.match(service, /Number\.isFinite\(clinic\.latitude\)/);
  assert.match(service, /Number\.isFinite\(clinic\.longitude\)/);
  assert.match(service, /Number\.isInteger\(clinic\.geofenceRadiusM\)/);
  assert.match(service, /!validText\(clinic\.area, 2\)/);
  assert.match(service, /clinic\.areaId !== areaId/);
  assert.match(service, /areaSnapshot\.data\(\)\.active !== true/);
});

test("destination documents never duplicate clinic address or coordinate fields", () => {
  const service = read("src/services/doctorAddressService.js");
  const createPayload = service.match(
    /transaction\.set\(addressRef, \{([\s\S]*?)\}\);/
  )?.[1];
  assert.ok(createPayload);
  assert.match(createPayload, /active: true/);
  assert.match(createPayload, /createdAt: serverTimestamp\(\)/);
  assert.doesNotMatch(
    createPayload,
    /clinicDocId|clinicName|addressLine|areaId|latitude|longitude|geofenceRadiusM/
  );
});

test("the Firestore subscription is the only source of destination-list state", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const calls = panel.match(/setAddresses\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(panel, /subscribeDoctorAddresses\([\s\S]*?setAddresses\(docs\)/);
});

test("Admin selects an existing verified clinic instead of retyping a location", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  assert.match(page, />\s*Manage addresses\s*</);
  assert.match(panel, /Registered clinic destination/);
  assert.match(panel, /clinic\.firestoreId/);
  assert.match(page, /destinationLocationValid:[\s\S]*?validateClinicLocation\(raw\)\.ok/);
  assert.match(page, /Number\.isFinite\(raw\.latitude\)/);
  assert.match(page, /Number\.isFinite\(raw\.longitude\)/);
  assert.match(page, /Number\.isInteger\(raw\.geofenceRadiusM\)/);
  assert.match(panel, /clinic\.destinationLocationValid === true/);
  assert.match(panel, /location\.locationVerified === true/);
  assert.match(panel, /activeAreaById\.get\(clinic\.areaId\)/);
  assert.match(panel, /area\?\.name\?\.trim\(\) === clinic\.area\.trim\(\)/);
  assert.match(panel, /Add Clinic Destination/);
  assert.doesNotMatch(panel, /ClinicLocationSection/);
  assert.doesNotMatch(panel, /Full delivery address|Address label/);
});

test("already-linked clinics are excluded and several distinct clinics remain possible", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const service = read("src/services/doctorAddressService.js");
  assert.match(panel, /linkedClinicIds\.has\(clinic\.firestoreId\)/);
  assert.match(panel, /Reactivate an inactive destination/);
  assert.match(service, /existingSnapshot\.exists\(\)/);
  assert.match(service, /already linked to this doctor/);
});

test("destinations are immutable links that can only be retired or reactivated", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const service = read("src/services/doctorAddressService.js");
  assert.match(panel, /setDoctorAddressActive/);
  assert.match(panel, /doctor\.active !== true/);
  assert.match(panel, /Existing destinations can still be deactivated/);
  assert.doesNotMatch(service, /updateDoctorAddress/);
  assert.doesNotMatch(panel, />\s*Edit\s*</);
});

test("only retired standalone-address records expose one-way cleanup", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const service = read("src/services/doctorAddressService.js");
  const rules = read("firestore.rules");
  assert.match(service, /legacyIndependentAddress:/);
  assert.match(service, /removeLegacyDoctorAddress/);
  assert.match(panel, /Remove legacy/);
  assert.match(rules, /isLegacyIndependentDoctorAddress/);
  assert.match(
    rules,
    /allow delete: if isAdmin\(\) && isLegacyIndependentDoctorAddress\(\)/
  );
});

test("this checkpoint still leaves Med Rep order wiring unchanged", () => {
  const checkout = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.doesNotMatch(checkout, /doctorId|doctorName|doctorAddressId/);
});
