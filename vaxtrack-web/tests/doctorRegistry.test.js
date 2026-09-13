import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeDoctorName,
  validateDoctorName,
} from "../src/services/doctorModel.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("doctor names normalize spacing, case and Unicode consistently", () => {
  assert.equal(normalizeDoctorName("  Dr.  MARIA Santos "), "dr. maria santos");
  assert.equal(normalizeDoctorName("Ｄｒ． Ana Cruz"), "dr. ana cruz");
  assert.equal(normalizeDoctorName(null), "");
});

test("doctor validation preserves a clean display name", () => {
  assert.deepEqual(validateDoctorName("  Dr.   Maria Santos  "), {
    ok: true,
    value: {
      name: "Dr. Maria Santos",
      nameNormalized: "dr. maria santos",
    },
  });
});

test("doctor validation rejects unusable names", () => {
  for (const value of ["", " ", ".", "-", "x".repeat(121), null, []]) {
    assert.equal(validateDoctorName(value).ok, false, String(value));
  }
});

test("doctor identity is an auto Firestore id and stored id fields cannot override it", () => {
  const service = read("src/services/doctorService.js");
  assert.match(service, /doc\(collection\(db, DOCTORS\)\)/);
  assert.match(service, /\{ \.\.\.doctor\.data\(\), id: doctor\.id \}/);
  assert.doesNotMatch(service, /doc\(db, DOCTORS,.*nameNormalized/);
  assert.doesNotMatch(service, /\{\s*id: doctor\.id,\s*\.\.\.doctor\.data\(\)/);
});

test("doctor creation re-derives the active area snapshot in one transaction", () => {
  const service = read("src/services/doctorService.js");
  assert.match(service, /runTransaction\(db, async \(transaction\)/);
  assert.match(service, /transaction\.get\(areaRef\)/);
  assert.match(service, /areaSnapshot\.data\(\)\.active !== true/);
  assert.match(service, /area: areaName/);
  assert.match(service, /areaId: stableAreaId/);
});

test("Firestore snapshots are the only source of doctor list state", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  const calls = page.match(/setDoctors\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(page, /subscribeDoctors\([\s\S]*?setDoctors\(docs\)/);
});

test("Admin Clinics registers doctors under active area document ids", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  assert.match(page, />\s*Manage Doctors\s*</);
  assert.match(page, /function DoctorsModal\(/);
  assert.match(page, /areas\.filter\(\(area\) => area\.active === true\)/);
  assert.match(page, /onAdd\(\{ name, areaId \}\)/);
  assert.match(page, /<option key=\{area\.id\} value=\{area\.id\}>/);
  assert.match(page, /Delivery addresses will be[\s\S]*?next checkpoint/);
});

test("doctors are deactivated rather than deleted", () => {
  const service = read("src/services/doctorService.js");
  const rules = read("firestore.rules");
  assert.match(service, /setDoctorActive/);
  assert.doesNotMatch(service, /deleteDoc/);
  assert.match(
    rules,
    /match \/doctors\/\{doctorId\}[\s\S]*?allow delete: if false;/
  );
});

test("this checkpoint does not change Med Rep checkout or create doctor addresses", () => {
  const checkout = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  const service = read("src/services/doctorService.js");
  assert.doesNotMatch(checkout, /doctorId|doctorName|doctorAddress/);
  assert.doesNotMatch(service, /doctorLocations|deliveryLocations/);
});
