"use strict";

// Med Rep territory — the server's pure decision (functions/src/policy.js).
// The emulator suite proves it runs inside the reservation transaction and
// leaves nothing behind; these cases pin the decision itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const { territoryOf, linkWithinTerritory, assertOrderWithinTerritory } = require("../src/policy");

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return e.code; }
};

const T = territoryOf({ assignedAreaIds: ["a1"], assignedClinicIds: ["c1"] });
const links = [
  { id: "home", areaId: "a1", active: true },
  { id: "c1", active: true },
  { id: "c2", active: true },
];

test("territoryOf normalises: trims, drops junk and duplicates, needs an area", () => {
  assert.deepEqual(
    territoryOf({ assignedAreaIds: [" a1 ", "a1", "", 7, "x/y"], assignedClinicIds: ["c1", "c1"] }),
    { areaIds: ["a1"], clinicIds: ["c1"], assigned: true }
  );
  assert.equal(territoryOf({}).assigned, false);
  assert.equal(territoryOf(null).assigned, false);
  assert.equal(territoryOf({ assignedClinicIds: ["c1"] }).assigned, false, "clinics without an area are no territory");
});

test("a link is reachable only when active and inside the territory", () => {
  assert.equal(linkWithinTerritory({ id: "home", areaId: "a1", active: true }, T), true);
  assert.equal(linkWithinTerritory({ id: "home", areaId: "a2", active: true }, T), false);
  assert.equal(linkWithinTerritory({ id: "home", areaId: "a1", active: false }, T), false);
  assert.equal(linkWithinTerritory({ id: "c1", active: true }, T), true);
  assert.equal(linkWithinTerritory({ id: "c2", active: true }, T), false);
});

test("permitted destinations pass", () => {
  assert.equal(codeOf(() => assertOrderWithinTerritory({ territory: T, doctorLinks: links, destination: { type: "home", areaId: "a1" } })), null);
  assert.equal(codeOf(() => assertOrderWithinTerritory({ territory: T, doctorLinks: links, destination: { type: "clinic", areaId: "a1", clinicDocId: "c1" } })), null);
});

test("each refusal carries its stable code", () => {
  assert.equal(
    codeOf(() => assertOrderWithinTerritory({ territory: territoryOf({}), doctorLinks: links, destination: { type: "home", areaId: "a1" } })),
    "territory-not-assigned"
  );
  assert.equal(
    codeOf(() => assertOrderWithinTerritory({ territory: T, doctorLinks: [{ id: "home", areaId: "a2", active: true }, { id: "c2", active: true }], destination: { type: "clinic", areaId: "a2", clinicDocId: "c2" } })),
    "doctor-outside-territory"
  );
  assert.equal(
    codeOf(() => assertOrderWithinTerritory({ territory: T, doctorLinks: links, destination: { type: "clinic", areaId: "a2", clinicDocId: "c2" } })),
    "destination-outside-territory"
  );
  // Assigned clinic, but its area is not: still outside.
  const clinicOnly = territoryOf({ assignedAreaIds: ["a1"], assignedClinicIds: ["c1", "c2"] });
  assert.equal(
    codeOf(() => assertOrderWithinTerritory({ territory: clinicOnly, doctorLinks: links, destination: { type: "clinic", areaId: "a2", clinicDocId: "c2" } })),
    "destination-outside-territory"
  );
  // Area assigned, clinic not: an area alone never opens its clinics.
  assert.equal(
    codeOf(() => assertOrderWithinTerritory({ territory: territoryOf({ assignedAreaIds: ["a1"] }), doctorLinks: links, destination: { type: "clinic", areaId: "a1", clinicDocId: "c1" } })),
    "destination-outside-territory"
  );
});
