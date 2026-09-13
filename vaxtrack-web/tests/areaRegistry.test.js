import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  areaDocumentId,
  normalizeAreaName,
  validateAreaName,
} from "../src/services/areaModel.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("area names normalize case, spacing and Unicode consistently", () => {
  assert.equal(normalizeAreaName("  Metro   Manila  "), "metro manila");
  assert.equal(normalizeAreaName("ＭＥＴＲＯ Manila"), "metro manila");
  assert.equal(normalizeAreaName(null), "");
});

test("area document ids are deterministic and path-safe", () => {
  const normalized = normalizeAreaName("District 1 / North");
  assert.equal(areaDocumentId(normalized), "district%201%20%2F%20north");
  assert.equal(areaDocumentId(normalized).includes("/"), false);
  assert.equal(
    areaDocumentId(normalizeAreaName(" METRO  MANILA ")),
    areaDocumentId(normalizeAreaName("metro manila"))
  );
});

test("area validation preserves a clean display name", () => {
  assert.deepEqual(validateAreaName("  Metro   Manila  "), {
    ok: true,
    value: {
      name: "Metro Manila",
      nameNormalized: "metro manila",
      key: "metro%20manila",
    },
  });
});

test("area validation rejects unusable names", () => {
  for (const value of ["", " ", ".", "-", "x".repeat(81), "\ud800x", null, []]) {
    assert.equal(validateAreaName(value).ok, false, String(value));
  }
});

test("the service uses a transaction and document identity is authoritative", () => {
  const service = read("src/services/areaService.js");
  assert.match(service, /runTransaction\(/);
  assert.match(service, /transaction\.get\(ref\)/);
  assert.match(service, /area-already-exists/);
  assert.match(service, /\{ \.\.\.area\.data\(\), id: area\.id \}/);
  assert.doesNotMatch(service, /\{\s*id: area\.id,\s*\.\.\.area\.data\(\)/);
});

test("Firestore snapshots are the only source of area list state", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  const calls = page.match(/setAreas\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(page, /subscribeAreas\([\s\S]*?setAreas\(docs\)/);
});

test("Admin Clinics uses active area document ids and keeps the name snapshot", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  const service = read("src/services/clinicService.js");

  assert.match(page, />\s*Manage Areas\s*</);
  assert.match(page, /function AreasModal\(/);
  assert.match(page, /area\.active === true/);
  assert.match(page, /value=\{newClinic\.areaId\}/);
  assert.match(page, /<option key=\{area\.id\} value=\{area\.id\}>/);
  assert.match(page, /areaId: selectedArea\.id/);
  assert.match(page, /area: selectedArea\.name/);
  assert.doesNotMatch(
    page,
    /<option>\s*(Metro Manila|Laguna|Cavite|Batangas)\s*<\/option>/
  );

  assert.match(service, /areaId: stableAreaId/);
  assert.match(service, /area: areaName/);
});

test("areas are deactivated rather than deleted", () => {
  const service = read("src/services/areaService.js");
  const rules = read("firestore.rules");
  assert.match(service, /setAreaActive/);
  assert.doesNotMatch(service, /deleteDoc/);
  assert.match(rules, /match \/areas\/\{areaId\}[\s\S]*?allow delete: if false;/);
});

test("new clinic writes must reference the matching active area", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /function validActiveClinicArea\(\)/);
  assert.match(rules, /documents\/areas\/\$\(d\.areaId\)/);
  assert.match(rules, /data\.active == true/);
  assert.match(rules, /data\.name == d\.area/);
  assert.match(
    rules,
    /match \/clinics\/\{id\}[\s\S]*?allow create: if isAdmin\(\) && validActiveClinicArea\(\);/
  );
});
