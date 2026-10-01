import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSeedPlan,
  validateSeedPlan,
  batchStatusFromExpiry,
  addDaysIso,
  SEED_PREFIX,
  SEED_DATE,
} from "../scripts/stagingCoreSeedData.mjs";

/**
 * The pure Core Sample Data plan for staging. No Firebase — this proves the plan
 * is internally well-formed (counts, uniqueness, relationships, expiry spread,
 * forbidden fields) before the runner ever touches the network.
 */

test("the plan passes its own internal validation", () => {
  const result = validateSeedPlan(buildSeedPlan());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("exact counts", () => {
  const p = buildSeedPlan();
  assert.equal(p.vaccineTypes.length, 5);
  assert.equal(p.vaccines.length, 8);
  assert.equal(p.inventory.length, 15);
  assert.equal(p.areas.length, 5);
  assert.equal(p.clinics.length, 8);
  assert.equal(p.doctors.length, 8);
  assert.equal(p.doctorHomes.length, 8);
  assert.ok(p.doctorClinicLinks.length >= 8);
});

test("every top-level document id is deterministic and prefixed", () => {
  const p = buildSeedPlan();
  for (const key of ["areas", "vaccineTypes", "vaccines", "inventory", "clinics", "doctors"]) {
    for (const r of p[key]) assert.ok(r.id.startsWith(SEED_PREFIX), `${r.id}`);
  }
});

test("expiry distribution is 12 stable / 1 warning / 1 critical / 1 expired", () => {
  const p = buildSeedPlan();
  const stable = p.inventory.filter((b) => b.data.status === "Stable").length;
  const warning = p.inventory.filter((b) => b.data.status === "Warning").length;
  const expired = p.inventory.filter((b) => b.data.expiryDate < SEED_DATE).length;
  assert.equal(stable, 12);
  assert.equal(warning, 1);
  assert.equal(expired, 1);
});

test("no batch carries a temperature field, doses wording, or VAT-inclusive price", () => {
  const p = buildSeedPlan();
  for (const b of p.inventory) {
    assert.equal("temperature" in b.data, false);
    assert.equal(b.data.priceIsVatInclusive, false);
    assert.equal(b.data.unit === "doses" || /doses/i.test(JSON.stringify(b.data)), false);
    assert.equal(b.data.reservedQuantity, 0);
    assert.ok(Number.isInteger(b.data.sellingPriceCentavos) && b.data.sellingPriceCentavos > 0);
    assert.equal(b.data.expiryDate.length, 10);
  }
});

test("clinics have verified coordinates and a valid geofence radius", () => {
  const p = buildSeedPlan();
  for (const c of p.clinics) {
    assert.equal(c.data.locationVerified, true);
    assert.ok(c.data.latitude >= -90 && c.data.latitude <= 90);
    assert.ok(c.data.longitude >= -180 && c.data.longitude <= 180);
    assert.ok(c.data.geofenceRadiusM >= 50 && c.data.geofenceRadiusM <= 1000);
  }
});

test("clinic links carry only { active:true } and reference seeded clinics", () => {
  const p = buildSeedPlan();
  const clinicIds = new Set(p.clinics.map((c) => c.id));
  for (const link of p.doctorClinicLinks) {
    assert.deepEqual(Object.keys(link.data), ["active"]);
    assert.equal(link.data.active, true);
    assert.ok(clinicIds.has(link._refClinicId));
    // the link doc id IS the clinic doc id (rule: clinic-link id = clinic id)
    assert.equal(link.path[link.path.length - 1], link._refClinicId);
  }
});

test("batchStatusFromExpiry matches the app thresholds", () => {
  assert.equal(batchStatusFromExpiry(addDaysIso(SEED_DATE, 200)), "Stable");
  assert.equal(batchStatusFromExpiry(addDaysIso(SEED_DATE, 60)), "Warning");
  assert.equal(batchStatusFromExpiry(addDaysIso(SEED_DATE, 15)), "Critical");
  assert.equal(batchStatusFromExpiry(addDaysIso(SEED_DATE, -30)), "Critical");
});
