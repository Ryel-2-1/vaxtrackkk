import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clientIdOf,
  findExistingClients,
  matchingDoctor,
  normalizeClientId,
  validateClientId,
} from "../src/services/clientId.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("a client ID is 3MGS's own code, upper-cased, 2 to 20 letters and digits", () => {
  for (const id of ["AAC-030", "BLB-006", "MLQ-025", "A1", "HOSP2026", " aac-030 "]) {
    assert.equal(validateClientId(id).ok, true, id);
  }
  assert.equal(validateClientId(" aac-030 ").value, "AAC-030");
  assert.equal(normalizeClientId(null), "");
  assert.match(validateClientId("").error, /Enter the client ID/);
  for (const bad of ["A", "-AAC", "AAC-", "AAC--030", "AAC 030", "AAC/030", "A".repeat(21)]) {
    assert.equal(validateClientId(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(clientIdOf({ clinicId: "aac-030" }), "AAC-030");
  assert.equal(clientIdOf({}), "");
});

const clinics = [
  { id: "AAC-030", firestoreId: "c1", name: "Alonzo Clinic", contact: "Dr. Maria Alonzo" },
  { id: "AAC-031", firestoreId: "c2", name: "Bautista Medical", contact: "Dr. Jose Bautista" },
].map((c) => ({ ...c, clinicId: c.id }));
const doctors = [
  { id: "d1", name: "Dr. Maria Alonzo", nameNormalized: "dr. maria alonzo", areaId: "a1", area: "Laguna", active: true },
  { id: "d2", name: "Dr. Maria Alonzo", nameNormalized: "dr. maria alonzo", areaId: "a2", area: "Cavite", active: true },
  { id: "d3", name: "Dr. Old Name", nameNormalized: "dr. old name", areaId: "a1", active: false },
];

test("the search bar finds existing clinics by ID, name or doctor, and active doctors by name", () => {
  assert.deepEqual(findExistingClients("a", clinics, doctors), { clinics: [], doctors: [] }, "needs two characters");
  assert.deepEqual(findExistingClients("aac-031", clinics, doctors).clinics.map((c) => c.id), ["AAC-031"]);
  assert.deepEqual(findExistingClients("aac-03", clinics, doctors).clinics.map((c) => c.id), ["AAC-030", "AAC-031"]);
  assert.deepEqual(findExistingClients("bautista", clinics, doctors).clinics.map((c) => c.id), ["AAC-031"]);
  const alonzo = findExistingClients("alonzo", clinics, doctors);
  assert.deepEqual(alonzo.clinics.map((c) => c.id), ["AAC-030"], "found by its doctor too");
  assert.deepEqual(alonzo.doctors.map((d) => d.id), ["d1", "d2"]);
  assert.deepEqual(findExistingClients("old name", clinics, doctors).doctors, [], "inactive doctors are not offered");
  assert.deepEqual(findExistingClients("zzz", clinics, doctors), { clinics: [], doctors: [] });
});

test("the clinic's doctor is the same-named active doctor in the same area, else a new one", () => {
  assert.equal(matchingDoctor("  dr. MARIA   alonzo ", "a1", doctors).id, "d1");
  assert.equal(matchingDoctor("Dr. Maria Alonzo", "a2", doctors).id, "d2", "a same-named doctor elsewhere is someone else");
  assert.equal(matchingDoctor("Dr. Maria Alonzo", "a9", doctors), null);
  assert.equal(matchingDoctor("Dr. Old Name", "a1", doctors), null, "an inactive doctor is not reused");
  assert.equal(matchingDoctor("", "a1", doctors), null);
});

test("Register Clinic takes the client ID and doctor, and the ID flows to checkout and invoices", () => {
  const page = read("src/pages/admin/Clinics.jsx");
  assert.match(page, /const clinicId = clientIdCheck\.value;/, "the typed client ID is the clinic's ID");
  assert.doesNotMatch(page, /CLN-\$\{Math\.floor/, "no more random clinic IDs");
  assert.match(page, /if \(await clinicIdExists\(clientIdCheck\.value\)\) \{/);
  assert.match(page, /let clinicDoctor = matchingDoctor\(newClinic\.contact, selectedArea\.id, doctors\);/);
  assert.match(page, /await addDoctor\(\{ name: newClinic\.contact, areaId: selectedArea\.id \}\)/);
  assert.match(page, /Doctor \(contact person\)/);
  assert.match(page, /<ExistingClientSearch/);
  assert.match(read("src/services/doctorAddressModel.js"), /clientId: typeof clinic\.clinicId === "string" \? clinic\.clinicId\.trim\(\) : "",/);
  assert.match(read("src/pages/salesRep/SalesRepPlaceOrder.jsx"), /destination\.clientId \? `\$\{destination\.clientId\} · ` : ""/);
  const invoice = read("src/pages/admin/InvoiceEditor.jsx");
  assert.match(invoice, /getClinicClientId\(clinicDocIdForCode\)/);
  assert.match(invoice, /prev && !prev\.customerCode \? \{ \.\.\.prev, customerCode: id \} : prev/, "only into an empty field");
});
