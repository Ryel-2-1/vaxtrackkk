import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HOME_ADDRESS_ID,
  validateDoctorClinicDestination,
  validateDoctorHomeAddress,
} from "../src/services/doctorAddressModel.js";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a doctor clinic destination accepts one stable clinic document id", () => {
  assert.deepEqual(
    validateDoctorClinicDestination({ clinicDocId: "  clinic-123  " }),
    {
      ok: true,
      errors: {},
      value: { clinicDocId: "clinic-123" },
    }
  );
});

test("missing, path-like, and reserved Home clinic ids are rejected", () => {
  for (const clinicDocId of ["", "clinics/other", HOME_ADDRESS_ID]) {
    assert.equal(
      validateDoctorClinicDestination({ clinicDocId }).ok,
      false,
      clinicDocId
    );
  }
});

test("one Home address is normalized with a routable location", () => {
  assert.deepEqual(
    validateDoctorHomeAddress({
      addressLine: "  10   Mabini Street, Manila  ",
      areaId: " seed-area ",
      latitude: "14.5995",
      longitude: "120.9842",
      geofenceRadiusM: "",
    }),
    {
      ok: true,
      errors: {},
      value: {
        addressLine: "10 Mabini Street, Manila",
        areaId: "seed-area",
        latitude: 14.5995,
        longitude: 120.9842,
        geofenceRadiusM: 300,
      },
    }
  );
});

test("Home requires an address, active-area id, coordinates and valid radius", () => {
  const check = validateDoctorHomeAddress({
    addressLine: "x",
    areaId: "",
    latitude: "",
    longitude: "181",
    geofenceRadiusM: "49",
  });
  assert.equal(check.ok, false);
  assert.ok(check.errors.addressLine);
  assert.ok(check.errors.areaId);
  assert.ok(check.errors.latitude);
  assert.ok(check.errors.longitude);
  assert.ok(check.errors.geofenceRadiusM);
});

test("clinic id and reserved Home id are authoritative document paths", () => {
  const service = read("src/services/doctorAddressService.js");
  assert.match(
    service,
    /doc\(\s*db,\s*DOCTORS,\s*stableDoctorId,\s*ADDRESSES,\s*check\.value\.clinicDocId\s*\)/
  );
  assert.match(
    service,
    /doc\(\s*db,\s*DOCTORS,\s*stableDoctorId,\s*ADDRESSES,\s*HOME_ADDRESS_ID\s*\)/
  );
  assert.match(service, /clinicDocId:[\s\S]*?address\.id/);
  assert.match(service, /id: address\.id/);
  assert.doesNotMatch(service, /doc\(collection\(db, DOCTORS/);
});

test("clinic and Home writes re-read their active master relationships", () => {
  const service = read("src/services/doctorAddressService.js");
  assert.match(service, /readActiveClinicRelationships/);
  assert.match(service, /readActiveHomeRelationships/);
  assert.match(service, /transaction\.get\(doctorRef\)/);
  assert.match(service, /transaction\.get\(clinicRef\)/);
  assert.match(service, /transaction\.get\(areaRef\)/);
  assert.match(service, /clinic\.locationVerified !== true/);
  assert.match(service, /validateClinicLocation\(clinic\)/);
  assert.match(service, /areaSnapshot\.data\(\)\.active !== true/);
});

test("clinic relationship records do not duplicate clinic location fields", () => {
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

test("Home is one editable record that preserves status and creation time", () => {
  const service = read("src/services/doctorAddressService.js");
  assert.match(service, /export async function saveDoctorHomeAddress/);
  assert.match(service, /kind: HOME_ADDRESS_ID/);
  assert.match(service, /if \(existingSnapshot\.exists\(\)\)[\s\S]*?transaction\.update\(homeRef, values\)/);
  assert.match(service, /active: true,[\s\S]*?createdAt: serverTimestamp\(\)/);
  assert.match(service, /setDoctorHomeAddressActive/);
  assert.match(service, /Home destination can be deactivated but not deleted/);
});

test("Firestore subscriptions remain the destination and doctor-list sources of truth", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const page = read("src/pages/admin/Clinics.jsx");
  assert.equal((panel.match(/setAddresses\(/g) ?? []).length, 1);
  assert.match(panel, /subscribeDoctorAddresses\([\s\S]*?setAddresses\(docs\)/);
  assert.equal((page.match(/setDoctors\(/g) ?? []).length, 1);
});

test("Admin Doctor splits one Home editor from registered clinic links", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  assert.match(panel, /Home \/ doorstep/);
  assert.match(panel, /Add Home Address/);
  assert.match(panel, /saveDoctorHomeAddress/);
  assert.match(panel, /ClinicLocationSection/);
  assert.match(panel, /Linked clinics/);
  assert.match(panel, /Registered clinic destination/);
  assert.match(panel, /Add Clinic Destination/);
  assert.match(panel, /clinic\.destinationLocationValid === true/);
});

test("already-linked clinics are excluded and several clinics remain possible", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const service = read("src/services/doctorAddressService.js");
  assert.match(panel, /linkedClinicIds\.has\(clinic\.firestoreId\)/);
  assert.match(panel, /Reactivate an inactive destination/);
  assert.match(service, /existingSnapshot\.exists\(\)/);
  assert.match(service, /already linked to this doctor/);
});

test("clinic links can only be retired/reactivated and legacy cleanup is one-way", () => {
  const panel = read("src/pages/admin/DoctorAddressesPanel.jsx");
  const service = read("src/services/doctorAddressService.js");
  const rules = read("firestore.rules");
  assert.match(panel, /setDoctorAddressActive/);
  assert.doesNotMatch(service, /updateDoctorClinicDestination/);
  assert.match(service, /const legacyIndependentAddress/);
  assert.match(panel, /Remove legacy/);
  assert.match(rules, /addressId != 'home'[\s\S]*?isLegacyIndependentDoctorAddress/);
});

test("Clinic Details lists only active clinic links and never Home data", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  assert.match(page, /useLinkedDoctorsForClinic/);
  assert.match(page, /destination\.destinationType === "clinic"/);
  assert.match(page, /destination\.clinicDocId === clinicDocId/);
  assert.match(page, /destination\.active === true/);
  assert.match(page, />Linked doctors</);
  assert.doesNotMatch(
    page.match(/function ClinicDetailsModal\([\s\S]*?function AreasModal/)?.[0] || "",
    /addressLine|Home \/ Doorstep/
  );
});

test("this Admin checkpoint still leaves Sales Rep order wiring unchanged", () => {
  const checkout = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.doesNotMatch(checkout, /doctorId|doctorName|doctorAddressId/);
});
