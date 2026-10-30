import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDoctorDestinationOptions,
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

test("checkout options contain only active verified Home and linked Clinics", () => {
  const options = buildDoctorDestinationOptions(
    [
      {
        id: "home",
        homeAddress: true,
        kind: "home",
        active: true,
        addressLine: "10 Mabini Street, Manila",
        areaId: "area-manila",
        area: "Manila",
        latitude: 14.5995,
        longitude: 120.9842,
      },
      {
        id: "clinic-good",
        destinationType: "clinic",
        clinicDocId: "clinic-good",
        active: true,
      },
      {
        id: "clinic-retired",
        destinationType: "clinic",
        clinicDocId: "clinic-retired",
        active: false,
      },
      {
        id: "legacy",
        legacyIndependentAddress: true,
        active: true,
      },
    ],
    [
      {
        id: "clinic-good",
        name: "Northside Clinic",
        location: "45 Mabini Avenue, Manila",
        areaId: "area-manila",
        area: "Manila",
        locationVerified: true,
        latitude: 14.61,
        longitude: 120.99,
        geofenceRadiusM: 200,
      },
      {
        id: "clinic-retired",
        name: "Retired Clinic",
        location: "99 Old Road, Manila",
        areaId: "area-manila",
        area: "Manila",
        locationVerified: true,
        latitude: 14.62,
        longitude: 120.98,
      },
    ]
  );

  assert.deepEqual(options.map(({ id, type }) => ({ id, type })), [
    { id: "home", type: "home" },
    { id: "clinic-good", type: "clinic" },
  ]);
  assert.equal(options[1].address, "45 Mabini Avenue, Manila");
  assert.equal(options[1].geofenceRadiusM, 200);
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

test("Sales Rep checkout is Doctor-first and sends only stable destination ids", () => {
  const checkout = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  const callable = read("src/services/inventoryCallables.js");
  assert.match(checkout, /subscribeDoctors/);
  // Destinations come from the territory-filtered server lookup, never a
  // direct read of doctor addresses (audit finding 2).
  assert.match(checkout, /fetchMedRepDoctorAddresses\(\)/);
  assert.doesNotMatch(checkout, /subscribeDoctorAddresses/);
  // Options are built by buildDoctorDestinationOptions, then narrowed to the
  // Med Rep's territory (src/services/territory.js).
  assert.match(checkout, /territoryDestinationOptions\(doctorAddresses, clinics, territory\)/);
  assert.match(read("src/services/territory.js"), /buildDoctorDestinationOptions\(addresses \|\| \[\], clinics \|\| \[\]\)/);
  assert.match(checkout, /doctorId: selectedDoctor\.id/);
  assert.match(checkout, /doctorAddressId: selectedDestination\.id/);
  assert.doesNotMatch(callable, /clinicName|clinicAddress|latitude|longitude/);
});

test("changing the checkout doctor clears its destination without an effect reset", () => {
  const checkout = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");

  // 1. The effect only fetches: no setState runs before the request.
  const effect = /useEffect\(\(\) => \{\s*\n\s*if \(!activeDoctorKey\) return undefined;([\s\S]*?)fetchMedRepDoctorAddresses\(\)/.exec(checkout);
  assert.ok(effect, "the destination fetch effect must exist");
  assert.doesNotMatch(effect[1], /\bset[A-Z]\w*\(/, "no synchronous setState in the effect body");

  // 2. Both callbacks tag the result with the doctor list it was fetched for,
  //    and a superseded request never lands.
  const tagged = checkout.match(/setDestinationBook\(\{ key: activeDoctorKey, byDoctor(: \{\})? \}\)/g) ?? [];
  assert.equal(tagged.length, 2, "success and error callbacks both record their key");
  assert.ok((checkout.match(/if \(!current\) return;/g) ?? []).length >= 2);

  // 3. What the page shows is derived: loading until the fetch for THIS
  //    doctor list has arrived, then only the selected doctor's rows.
  assert.match(checkout, /const territoryAddressesReady = !activeDoctorKey \|\| destinationBook\.key === activeDoctorKey;/);
  assert.match(checkout, /const addressesReady = !!selectedDoctorId && territoryAddressesReady;/);
  assert.match(checkout, /addressesByDoctor\[selectedDoctorId\] \?\? EMPTY_ADDRESSES/);
  assert.match(checkout, /const addressesLoading = !!selectedDoctorId && !addressesReady;/);

  // 4. The doctor changes in ONE place, which also clears the old destination
  //    and drops any destination still waiting to be restored.
  const handler = /const handleDoctorChange = \(doctorId\) => \{([\s\S]*?)\n {2}\};/.exec(checkout);
  assert.ok(handler, "the doctor change handler must exist");
  assert.match(handler[1], /setSelectedDoctorId\(doctorId\);/);
  assert.match(handler[1], /setSelectedDestinationId\(""\);/);
  assert.match(handler[1], /setPendingRestore\(null\);/);
  assert.match(checkout, /onChange=\{\(event\) => handleDoctorChange\(event\.target\.value\)\}/);
  assert.equal(
    (checkout.match(/setSelectedDoctorId\(/g) ?? []).length,
    1,
    "no other code path changes the doctor without clearing the destination"
  );

  // 5. The success callback records the result and clears its own error; it
  //    never applies a restored destination (tests/checkoutDraftRestore.test.js).
  assert.match(checkout, /setDestinationBook\(\{ key: activeDoctorKey, byDoctor \}\);\s*\n\s*setSourceError\("addresses", ""\);/);
  assert.doesNotMatch(checkout, /pendingDestinationRef/);

  // 6. Fixed, not silenced.
  assert.doesNotMatch(checkout, /eslint-disable/);
});
