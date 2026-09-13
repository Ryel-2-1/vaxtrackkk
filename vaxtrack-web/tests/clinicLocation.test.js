// Pure validation/normalization tests for clinic location + geofence radius.
// Run: node --test tests/clinicLocation.test.js
//
// Mirrors tests/invoiceModel.test.js — no Firebase, no emulator.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GEOFENCE_RADIUS_M,
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
  readClinicLocation,
  toFiniteNumber,
  validateClinicLocation,
} from "../src/services/clinicLocation.js";

const valid = { latitude: 14.5995, longitude: 120.9842 };

test("toFiniteNumber accepts finite numbers and numeric strings", () => {
  assert.equal(toFiniteNumber(14.5995), 14.5995);
  assert.equal(toFiniteNumber("14.5995"), 14.5995);
  assert.equal(toFiniteNumber("  120.98  "), 120.98);
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber("-33.5"), -33.5);
});

test("toFiniteNumber rejects everything that is not a real number", () => {
  // Empty string must NOT become 0 — 0,0 is a real coordinate in the Atlantic.
  assert.equal(toFiniteNumber(""), null);
  assert.equal(toFiniteNumber("   "), null);
  assert.equal(toFiniteNumber("abc"), null);
  assert.equal(toFiniteNumber("12abc"), null);
  assert.equal(toFiniteNumber(NaN), null);
  assert.equal(toFiniteNumber(Infinity), null);
  assert.equal(toFiniteNumber(-Infinity), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(true), null);
  assert.equal(toFiniteNumber({}), null);
  assert.equal(toFiniteNumber([]), null);
});

test("valid coordinates normalize to numbers with the default radius", () => {
  const result = validateClinicLocation(valid);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.latitude, 14.5995);
  assert.equal(result.value.longitude, 120.9842);
  assert.equal(result.value.geofenceRadiusM, DEFAULT_GEOFENCE_RADIUS_M);
  assert.equal(typeof result.value.latitude, "number");
  assert.equal(typeof result.value.longitude, "number");
});

test("numeric strings from form inputs are stored as numbers", () => {
  const result = validateClinicLocation({
    latitude: "14.5995",
    longitude: "120.9842",
    geofenceRadiusM: "450",
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.value.latitude, "number");
  assert.equal(typeof result.value.geofenceRadiusM, "number");
  assert.equal(result.value.geofenceRadiusM, 450);
});

test("latitude bounds are enforced", () => {
  assert.equal(validateClinicLocation({ ...valid, latitude: 90 }).ok, true);
  assert.equal(validateClinicLocation({ ...valid, latitude: -90 }).ok, true);
  assert.equal(validateClinicLocation({ ...valid, latitude: 90.1 }).ok, false);
  assert.equal(validateClinicLocation({ ...valid, latitude: -90.1 }).ok, false);
  assert.ok(validateClinicLocation({ ...valid, latitude: 91 }).errors.latitude);
});

test("longitude bounds are enforced", () => {
  assert.equal(validateClinicLocation({ ...valid, longitude: 180 }).ok, true);
  assert.equal(validateClinicLocation({ ...valid, longitude: -180 }).ok, true);
  assert.equal(validateClinicLocation({ ...valid, longitude: 180.1 }).ok, false);
  assert.ok(validateClinicLocation({ ...valid, longitude: -181 }).errors.longitude);
});

test("NaN, Infinity and text coordinates are rejected, never coerced", () => {
  for (const bad of [NaN, Infinity, -Infinity, "abc", "", null, undefined, true]) {
    const result = validateClinicLocation({ ...valid, latitude: bad });
    assert.equal(result.ok, false, `latitude ${String(bad)} should be rejected`);
    assert.equal(result.value, null);
  }
});

// ---------------------------------------------------------------------------
// Radius contract: REJECT out of range, never clamp. An admin's chosen service
// area must never be silently changed.
// ---------------------------------------------------------------------------

test("radius 49 is REJECTED, not clamped up to 50", () => {
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 49 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.geofenceRadiusM);
});

test("radius 49.9 is REJECTED — range is checked before rounding", () => {
  // Rounding first would turn 49.9 into 50 and silently accept it.
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 49.9 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
});

test("radius 50 is accepted (lower bound, inclusive)", () => {
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.value.geofenceRadiusM, 50);
});

test("radius 300 is accepted", () => {
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.value.geofenceRadiusM, 300);
});

test("radius 1000 is accepted (upper bound, inclusive)", () => {
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.value.geofenceRadiusM, 1000);
});

test("radius 1000.1 is REJECTED, not clamped down to 1000", () => {
  const result = validateClinicLocation({ ...valid, geofenceRadiusM: 1000.1 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
});

test("a blank radius falls back to the default instead of failing", () => {
  for (const blank of [undefined, null, "", "  "]) {
    const result = validateClinicLocation({ ...valid, geofenceRadiusM: blank });
    assert.equal(result.ok, true);
    assert.equal(result.value.geofenceRadiusM, DEFAULT_GEOFENCE_RADIUS_M);
  }
});

test("invalid radius TYPES are rejected at the service boundary", () => {
  for (const bad of [NaN, Infinity, -Infinity, "abc", "50m", true, false, {}, []]) {
    const result = validateClinicLocation({ ...valid, geofenceRadiusM: bad });
    assert.equal(
      result.ok,
      false,
      `radius ${JSON.stringify(String(bad))} should be rejected`,
    );
    assert.equal(result.value, null);
  }
});

test("an in-range decimal rounds to an integer AFTER validation", () => {
  assert.equal(
    validateClinicLocation({ ...valid, geofenceRadiusM: 300.6 }).value.geofenceRadiusM,
    301,
  );
  assert.equal(
    validateClinicLocation({ ...valid, geofenceRadiusM: 50.4 }).value.geofenceRadiusM,
    50,
  );
  assert.equal(
    validateClinicLocation({ ...valid, geofenceRadiusM: "999.5" }).value.geofenceRadiusM,
    1000,
  );
});

test("a rejected radius never produces a written value", () => {
  // Guards the whole contract: nothing reaches Firestore for an invalid radius.
  for (const bad of [0, 49, 1001, -300, "abc"]) {
    assert.equal(validateClinicLocation({ ...valid, geofenceRadiusM: bad }).value, null);
  }
});

test("bounds constants are the approved contract", () => {
  assert.equal(MIN_GEOFENCE_RADIUS_M, 50);
  assert.equal(MAX_GEOFENCE_RADIUS_M, 1000);
  assert.equal(DEFAULT_GEOFENCE_RADIUS_M, 300);
});

test("readClinicLocation exposes the RAW stored radius for the editor", () => {
  // An out-of-range stored value must be visible to the admin (and then
  // rejected on save), not silently displayed as the default.
  const read = readClinicLocation({
    latitude: 14.6,
    longitude: 121,
    geofenceRadiusM: 9999,
  });
  assert.equal(read.geofenceRadiusMStored, 9999); // shown in the input
  assert.equal(read.geofenceRadiusM, DEFAULT_GEOFENCE_RADIUS_M); // safe for consumers
  assert.equal(validateClinicLocation({ latitude: 14.6, longitude: 121, geofenceRadiusM: 9999 }).ok, false);
});

test("a location is never valid without both coordinates", () => {
  assert.equal(validateClinicLocation({ latitude: 14.6 }).ok, false);
  assert.equal(validateClinicLocation({ longitude: 120.9 }).ok, false);
  assert.equal(validateClinicLocation({}).ok, false);
  assert.equal(validateClinicLocation({}).value, null);
});

test("readClinicLocation reports a clinic with no coordinates honestly", () => {
  const read = readClinicLocation({ name: "Clinic without a pin" });
  assert.equal(read.hasCoordinates, false);
  assert.equal(read.latitude, null);
  assert.equal(read.longitude, null);
  assert.equal(read.locationVerified, false);
  // Missing radius still reads as the 300 m default.
  assert.equal(read.geofenceRadiusM, DEFAULT_GEOFENCE_RADIUS_M);
});

test("readClinicLocation is backward compatible with pre-radius clinics", () => {
  const read = readClinicLocation({ latitude: 14.6, longitude: 121.0 });
  assert.equal(read.hasCoordinates, true);
  assert.equal(read.latitude, 14.6);
  assert.equal(read.geofenceRadiusM, DEFAULT_GEOFENCE_RADIUS_M);
  // No stored flag -> not explicitly verified, but coordinates are usable.
  assert.equal(read.locationVerified, false);
});

test("readClinicLocation honours a stored radius and verified flag", () => {
  const read = readClinicLocation({
    latitude: 14.6,
    longitude: 121.0,
    geofenceRadiusM: 500,
    locationVerified: true,
  });
  assert.equal(read.geofenceRadiusM, 500);
  assert.equal(read.locationVerified, true);
});

test("readClinicLocation never reports verified without valid coordinates", () => {
  const read = readClinicLocation({ locationVerified: true });
  assert.equal(read.hasCoordinates, false);
  assert.equal(read.locationVerified, false);
});

test("readClinicLocation ignores an out-of-range stored radius", () => {
  assert.equal(
    readClinicLocation({ latitude: 14.6, longitude: 121, geofenceRadiusM: 99999 })
      .geofenceRadiusM,
    DEFAULT_GEOFENCE_RADIUS_M,
  );
});

test("readClinicLocation rejects out-of-range stored coordinates", () => {
  const read = readClinicLocation({ latitude: 999, longitude: 121 });
  assert.equal(read.hasCoordinates, false);
  assert.equal(read.latitude, null);
});
