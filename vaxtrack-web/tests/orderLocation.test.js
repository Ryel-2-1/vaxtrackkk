import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildClinicLocationSnapshot } from "../src/services/orderLocation.js";

// Phase 02A — order-time clinic location snapshot.
//
// The builder is pure, so these run without a Firestore mock. Firestore rules
// re-verify the same guarantees server-side (tests/firestore.rules.test.js);
// these cover the client-side derivation.

const DOC_ID = "E7dOIaxZVH9bpt3Hy48W"; // Firestore document id
const BUSINESS_ID = "CLN-9123"; // business/display id — a DIFFERENT identifier

/** A fully verified clinic, as stored by Admin → Manage location. */
function verifiedClinic(overrides = {}) {
  return {
    clinicId: BUSINESS_ID,
    name: "OSM QA Test Clinic",
    latitude: 14.5995,
    longitude: 120.9842,
    geofenceRadiusM: 300,
    locationVerified: true,
    locationUpdatedAt: { seconds: 1788000000, nanoseconds: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Eligible snapshots
// ---------------------------------------------------------------------------

test("verified clinic produces every approved snapshot field", () => {
  const { fields, eligible, reason } = buildClinicLocationSnapshot(
    DOC_ID,
    verifiedClinic()
  );

  assert.equal(eligible, true);
  assert.equal(reason, null);
  assert.deepEqual(Object.keys(fields).sort(), [
    "clinicDocId",
    "clinicGeofenceRadiusM",
    "clinicId",
    "clinicLat",
    "clinicLng",
    "clinicLocationUpdatedAt",
    "clinicLocationVerified",
  ]);
  assert.equal(fields.clinicLat, 14.5995);
  assert.equal(fields.clinicLng, 120.9842);
  assert.equal(fields.clinicLocationVerified, true);
});

test("the Firestore document id is authoritative and never inferred", () => {
  const { fields } = buildClinicLocationSnapshot(DOC_ID, verifiedClinic());
  assert.equal(fields.clinicDocId, DOC_ID);

  // Even when the record carries a conflicting `id`, the explicit argument wins:
  // the builder is told the document id rather than sniffing for it.
  const { fields: f2 } = buildClinicLocationSnapshot(
    DOC_ID,
    verifiedClinic({ id: "some-other-doc-id" })
  );
  assert.equal(f2.clinicDocId, DOC_ID);
});

test("business clinic id stays distinct from the document id", () => {
  const { fields } = buildClinicLocationSnapshot(DOC_ID, verifiedClinic());
  assert.equal(fields.clinicId, BUSINESS_ID);
  assert.notEqual(fields.clinicId, fields.clinicDocId);
});

test("a clinic with no stored radius inherits the validated 300 m default", () => {
  const clinic = verifiedClinic();
  delete clinic.geofenceRadiusM;

  const { fields, eligible } = buildClinicLocationSnapshot(DOC_ID, clinic);
  assert.equal(eligible, true);
  assert.equal(fields.clinicGeofenceRadiusM, 300);
});

test("a valid non-default clinic radius is carried through unchanged", () => {
  const { fields, eligible } = buildClinicLocationSnapshot(
    DOC_ID,
    verifiedClinic({ geofenceRadiusM: 150 })
  );
  assert.equal(eligible, true);
  assert.equal(fields.clinicGeofenceRadiusM, 150);
});

test("boundary radii 50 and 1000 are accepted", () => {
  for (const radius of [50, 1000]) {
    const { fields, eligible } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ geofenceRadiusM: radius })
    );
    assert.equal(eligible, true, `radius ${radius} should be eligible`);
    assert.equal(fields.clinicGeofenceRadiusM, radius);
  }
});

// ---------------------------------------------------------------------------
// Ineligible snapshots — the order is still created, but carries no geofence
// ---------------------------------------------------------------------------

/** Every rejection must look the same: reference kept, location absent. */
function assertNoUsableLocation(fields) {
  assert.equal(fields.clinicLocationVerified, false);
  assert.equal(fields.clinicDocId, DOC_ID);
  for (const key of [
    "clinicLat",
    "clinicLng",
    "clinicGeofenceRadiusM",
    "clinicLocationUpdatedAt",
  ]) {
    assert.ok(
      !(key in fields),
      `${key} must be omitted, not defaulted or zeroed`
    );
  }
  // Explicitly not the 0,0 null-island fallback.
  assert.notEqual(fields.clinicLat, 0);
  assert.notEqual(fields.clinicLng, 0);
}

test("an unverified clinic yields no coordinates and no radius", () => {
  // Real case: clinics pinned before Phase 01 have coordinates but no
  // locationVerified flag. Coordinates alone are not consent to geofence.
  const clinic = verifiedClinic();
  delete clinic.locationVerified;

  const { fields, eligible, reason } = buildClinicLocationSnapshot(
    DOC_ID,
    clinic
  );
  assert.equal(eligible, false);
  assert.equal(reason, "clinic-location-not-verified");
  assertNoUsableLocation(fields);
});

test("locationVerified must be exactly true, not merely truthy", () => {
  for (const value of ["true", 1, {}, "yes"]) {
    const { fields, eligible } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ locationVerified: value })
    );
    assert.equal(eligible, false, `${JSON.stringify(value)} must not verify`);
    assertNoUsableLocation(fields);
  }
});

test("missing coordinates yield no usable location", () => {
  const clinic = verifiedClinic();
  delete clinic.latitude;
  delete clinic.longitude;

  const { fields, eligible } = buildClinicLocationSnapshot(DOC_ID, clinic);
  assert.equal(eligible, false);
  assertNoUsableLocation(fields);
});

test("non-numeric coordinates yield no usable location", () => {
  for (const bad of ["abc", {}, [], true, NaN, Infinity]) {
    const { fields, eligible } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ latitude: bad })
    );
    assert.equal(eligible, false, `${JSON.stringify(bad)} must be rejected`);
    assertNoUsableLocation(fields);
  }
});

test("out-of-range latitude and longitude yield no usable location", () => {
  const cases = [
    { latitude: 91 },
    { latitude: -91 },
    { longitude: 181 },
    { longitude: -181 },
  ];
  for (const override of cases) {
    const { fields, eligible } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic(override)
    );
    assert.equal(
      eligible,
      false,
      `${JSON.stringify(override)} must be rejected`
    );
    assertNoUsableLocation(fields);
  }
});

test("a stored radius outside 50-1000 is rejected, never silently 300", () => {
  for (const radius of [49, 1001, 5000, -1, 0]) {
    const { fields, eligible, reason } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ geofenceRadiusM: radius })
    );
    assert.equal(eligible, false, `radius ${radius} must be rejected`);
    assert.equal(reason, "radius-out-of-range");
    assertNoUsableLocation(fields);
    // The specific failure this guards: quietly inheriting the default.
    assert.ok(!("clinicGeofenceRadiusM" in fields));
  }
});

test("a non-numeric stored radius is rejected rather than treated as absent", () => {
  for (const radius of ["wide", {}, []]) {
    const { eligible } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ geofenceRadiusM: radius })
    );
    assert.equal(
      eligible,
      false,
      `${JSON.stringify(radius)} must not fall back to 300`
    );
  }
});

// ---------------------------------------------------------------------------
// Identifiers and trust boundary
// ---------------------------------------------------------------------------

test("a missing business clinic id is omitted, never fabricated", () => {
  // Live staging has clinics with no business id at all.
  const clinic = verifiedClinic();
  delete clinic.clinicId;

  const { fields } = buildClinicLocationSnapshot(DOC_ID, clinic);
  assert.ok(!("clinicId" in fields), "must not invent a business id");
  assert.equal(fields.clinicDocId, DOC_ID, "document id still stored");
});

test("a blank business clinic id is treated as absent", () => {
  for (const blank of ["", "   ", null, 12345, {}]) {
    const { fields } = buildClinicLocationSnapshot(
      DOC_ID,
      verifiedClinic({ clinicId: blank })
    );
    assert.ok(
      !("clinicId" in fields),
      `${JSON.stringify(blank)} must not become a business id`
    );
  }
});

test("neither identifier is ever derived from the other or from the name", () => {
  const clinic = verifiedClinic();
  delete clinic.clinicId;
  const { fields } = buildClinicLocationSnapshot(DOC_ID, clinic);

  assert.notEqual(fields.clinicDocId, clinic.name);
  assert.ok(!("clinicId" in fields));
  // The document id must not be copied into the business id slot as a fallback.
  assert.notEqual(fields.clinicId, DOC_ID);
});

test("a stored `id` field cannot shadow the Firestore document id", () => {
  // subscribeClinics turns each snapshot into a plain object. If the document
  // DATA were spread AFTER the id, a clinic carrying a field named `id` would
  // overwrite the real document id — and that value becomes `clinicDocId`, an
  // order's only stable reference to its destination clinic.
  const snapshot = {
    id: "realDocId",
    data: () => ({ id: "forgedDocId", clinicId: BUSINESS_ID }),
  };

  const safe = { ...snapshot.data(), id: snapshot.id }; // current mapping
  const unsafe = { id: snapshot.id, ...snapshot.data() }; // previous mapping

  assert.equal(safe.id, "realDocId", "the document id must win");
  assert.equal(
    unsafe.id,
    "forgedDocId",
    "sanity check: this is the shadowing the new ordering prevents"
  );

  // The snapshot built from the safe mapping carries the REAL document id.
  const { fields } = buildClinicLocationSnapshot(safe.id, safe);
  assert.equal(fields.clinicDocId, "realDocId");
  assert.notEqual(fields.clinicDocId, "forgedDocId");
});

test("subscribeClinics places the document id last", () => {
  const clinicService = readFileSync(
    join(here, "..", "src", "services", "clinicService.js"),
    "utf8"
  );
  assert.match(
    clinicService,
    /\.\.\.d\.data\(\),\s*id: d\.id/,
    "the document id must be assigned after the spread"
  );
  assert.doesNotMatch(
    clinicService,
    /\{\s*id: d\.id,\s*\.\.\.d\.data\(\)\s*\}/,
    "the shadowable ordering must not return"
  );
});

test("a missing document id is a hard error, not a silent drop", () => {
  // The bug this replaces: the caller supplied a reference and it vanished.
  for (const bad of [undefined, null, "", "   ", 123, {}]) {
    assert.throws(
      () => buildClinicLocationSnapshot(bad, verifiedClinic()),
      /clinic document id is required/i
    );
  }
});

test("no arbitrary clinic fields are copied onto the order", () => {
  const { fields } = buildClinicLocationSnapshot(
    DOC_ID,
    verifiedClinic({
      contact: "QA Tester",
      phone: "09000000000",
      email: "qa@example.test",
      deliveryNotes: "Back entrance",
      status: "active",
      area: "Metro Manila",
    })
  );

  for (const leaked of [
    "contact",
    "phone",
    "email",
    "deliveryNotes",
    "status",
    "area",
    "name",
  ]) {
    assert.ok(!(leaked in fields), `${leaked} must not reach the order`);
  }
});

test("caller-supplied snapshot values cannot override the clinic", () => {
  // A record carrying order-shaped keys must not have them believed: the
  // builder reads clinic-shaped fields only (latitude/longitude/...).
  const forged = {
    clinicId: BUSINESS_ID,
    // No real latitude/longitude at all — only forged order-shaped keys.
    clinicLat: 1.234,
    clinicLng: 5.678,
    clinicGeofenceRadiusM: 5000,
    clinicLocationVerified: true,
  };

  const { fields, eligible } = buildClinicLocationSnapshot(DOC_ID, forged);
  assert.equal(eligible, false, "forged order-shaped keys must not verify");
  assertNoUsableLocation(fields);
  assert.notEqual(fields.clinicLat, 1.234);
});

test("a non-object clinic record degrades safely", () => {
  for (const bad of [null, undefined, "clinic", 42]) {
    const { fields, eligible } = buildClinicLocationSnapshot(DOC_ID, bad);
    assert.equal(eligible, false);
    assertNoUsableLocation(fields);
  }
});

// ---------------------------------------------------------------------------
// Order creation wiring — source-shape guards
//
// createSalesRepOrder writes through Firestore, and this repo has no Firestore
// mock (adding one would be a dependency change). What can be pinned cheaply is
// that the creation path keeps its existing fields, uses the builder, and no
// longer trusts caller-supplied coordinates.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const orderService = readFileSync(
  join(here, "..", "src", "services", "orderService.js"),
  "utf8"
);
const placeOrder = readFileSync(
  join(here, "..", "src", "pages", "salesRep", "SalesRepPlaceOrder.jsx"),
  "utf8"
);

/** Slice createSalesRepOrder out of the service source. */
function createOrderSource() {
  const start = orderService.indexOf("export async function createSalesRepOrder");
  assert.notEqual(start, -1);
  const rest = orderService.slice(start + 1);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("order creation still writes every pre-existing field", () => {
  const src = createOrderSource();
  for (const field of [
    "orderNumber",
    "clinicName",
    "clinicAddress",
    "vaccineName",
    "vaccineType",
    "quantity",
    "unit",
    "storageTemp",
    "priority",
    "status",
    "assignedRiderId",
    "assignedRiderName",
    "createdByRole",
    "createdByUid",
    "createdByEmail",
    "createdAt",
    "updatedAt",
    "region",
    "deliveryInstructions",
    "items",
  ]) {
    assert.match(
      src,
      new RegExp("\\b" + field + "\\b"),
      `createSalesRepOrder no longer references ${field}`
    );
  }
  assert.match(src, /status: "pending_dispatch"/, "initial status unchanged");
});

test("the clinic reference is no longer silently dropped", () => {
  const src = createOrderSource();
  assert.match(
    src,
    /buildClinicLocationSnapshot\(\s*orderData\.clinicDocId,\s*orderData\.clinic\s*\)/,
    "creation must derive the snapshot from the clinic reference"
  );
  assert.match(
    src,
    /doc\.clinicLocationSnapshotAt = serverTimestamp\(\)/,
    "the snapshot must be server-stamped"
  );
  assert.match(
    placeOrder,
    /clinicDocId: verifiedClinic\.id/,
    "the caller must pass the Firestore document id"
  );
});

test("order creation no longer trusts caller-supplied coordinates", () => {
  const src = createOrderSource();
  assert.doesNotMatch(
    src,
    /orderData\.clinicLat|orderData\.clinicLng/,
    "coordinates must come from the clinic record, not the caller"
  );
  assert.doesNotMatch(
    placeOrder,
    /orderPayload\.clinicLat|orderPayload\.clinicLng/,
    "the page must not assemble coordinates itself any more"
  );
});

test("order creation does not touch status, arrival or route state", () => {
  const src = createOrderSource();
  for (const forbidden of ["arrivedAt", "routePolyline", "deliveredAt"]) {
    assert.ok(!src.includes(forbidden), `${forbidden} must not appear`);
  }
});
