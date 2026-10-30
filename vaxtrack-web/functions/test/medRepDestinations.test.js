"use strict";
/**
 * A Med Rep sees only the doctor destinations inside their territory — never
 * another area's private Home address (audit finding 2).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { listMedRepDoctorAddresses, MAX_DOCTORS } = require("../src/medRepDestinations");

function fakeDb({ users = {}, doctors = {} }) {
  const reads = [];
  const doctorDoc = (id) => ({
    id,
    ref: {
      collection(name) {
        assert.equal(name, "deliveryAddresses");
        return {
          async get() {
            reads.push(`doctors/${id}/deliveryAddresses`);
            const links = doctors[id]?.links ?? {};
            return { docs: Object.entries(links).map(([linkId, data]) => ({ id: linkId, data: () => data })) };
          },
        };
      },
    },
  });
  return {
    reads,
    collection(name) {
      if (name === "users") {
        return {
          doc: (id) => ({ async get() { return { exists: id in users, data: () => users[id] }; } }),
        };
      }
      assert.equal(name, "doctors");
      return {
        where(field, op, value) {
          assert.deepEqual([field, op, value], ["active", "==", true]);
          return {
            limit(n) {
              return {
                async get() {
                  const docs = Object.keys(doctors).filter((id) => doctors[id].active === true).slice(0, n).map(doctorDoc);
                  return { size: docs.length, docs };
                },
              };
            },
          };
        },
      };
    },
  };
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error.code; }
}

const home = (areaId, extra = {}) => ({
  kind: "home", active: true, addressLine: "12 Private St", areaId, area: areaId,
  latitude: 14.6, longitude: 121.0, geofenceRadiusM: 150, createdAt: "ts", updatedByUid: "admin", ...extra,
});

const roster = {
  dManila: { active: true, links: { home: home("manila"), cm1: { active: true, createdAt: "ts" }, cl1: { active: true } } },
  dLaguna: { active: true, links: { home: home("laguna") } },
  dOff: { active: true, links: { home: home("manila", { active: false }), cm2: { active: false } } },
  dLegacy: { active: true, links: { old: { label: "Old", addressLine: "Somewhere", active: true } } },
  dRetired: { active: false, links: { home: home("manila") } },
};
const rep = { role: "salesrep", status: "approved", assignedAreaIds: ["manila"], assignedClinicIds: ["cm1"] };

test("only links inside the territory come back, with only the destination fields", async () => {
  const db = fakeDb({ users: { rep }, doctors: roster });
  const { addressesByDoctor } = await listMedRepDoctorAddresses({ db, uid: "rep", payload: {} });
  assert.deepEqual(Object.keys(addressesByDoctor).sort(), ["dManila"]);
  assert.deepEqual(addressesByDoctor.dManila, [
    { id: "home", kind: "home", active: true, addressLine: "12 Private St", areaId: "manila", area: "manila", latitude: 14.6, longitude: 121.0, geofenceRadiusM: 150 },
    { id: "cm1", active: true },
  ]);
  // Another area's Home, an unassigned clinic, inactive links, legacy
  // addresses and retired doctors never leave the server.
  assert.equal(JSON.stringify(addressesByDoctor).includes("laguna"), false);
  assert.equal(db.reads.includes("doctors/dRetired/deliveryAddresses"), false);
});

test("no territory → nothing, without reading any doctor", async () => {
  const db = fakeDb({ users: { rep: { role: "salesrep", status: "approved" } }, doctors: roster });
  assert.deepEqual(await listMedRepDoctorAddresses({ db, uid: "rep", payload: {} }), { addressesByDoctor: {} });
  assert.deepEqual(db.reads, []);
});

test("only an approved Med Rep may call it, with no input", async () => {
  const users = {
    rep,
    admin: { role: "admin", status: "approved" },
    rider: { role: "rider", status: "approved" },
    pending: { ...rep, status: "pending" },
  };
  const db = fakeDb({ users, doctors: roster });
  assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "admin", payload: {} })), "wrong-role");
  assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "rider", payload: {} })), "wrong-role");
  assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "pending", payload: {} })), "not-approved");
  assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "nobody", payload: {} })), "profile-missing");
  for (const payload of [{ doctorId: "dLaguna" }, ["x"], "x"]) {
    assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "rep", payload })), "unknown-field");
  }
  assert.deepEqual(db.reads, []);
  assert.ok(await listMedRepDoctorAddresses({ db, uid: "rep", payload: null }));
});

test("a roster above the cap is refused rather than silently truncated", async () => {
  const doctors = Object.fromEntries(Array.from({ length: MAX_DOCTORS + 1 }, (_, i) => [`d${i}`, { active: true, links: {} }]));
  const db = fakeDb({ users: { rep }, doctors });
  assert.equal(await codeOf(listMedRepDoctorAddresses({ db, uid: "rep", payload: {} })), "too-many-doctors");
});
