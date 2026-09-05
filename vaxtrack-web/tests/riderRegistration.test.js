import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RIDER_VEHICLE_TYPE,
  buildNewRiderPayload,
  createEmptyNewRider,
} from "../src/services/riderRegistration.js";

// Motorcycle-only rider registration.
//
// The pure cases below cover the payload boundary. The source-shape cases cover
// what a pure test cannot reach — that the form offers no other option, and
// that the rider list, status lifecycle and subscription were left alone. This
// repo has no jsdom/RTL and adding one would be a dependency change, so the
// rendered markup is asserted from source, as the other suites here do.

const here = dirname(fileURLToPath(import.meta.url));
const ridersPage = readFileSync(
  join(here, "..", "src", "pages", "admin", "Riders.jsx"),
  "utf8"
);
const riderService = readFileSync(
  join(here, "..", "src", "services", "riderService.js"),
  "utf8"
);

const RETIRED_VEHICLES = ["Van", "Truck", "Auto"];

// ---------------------------------------------------------------------------
// The canonical value
// ---------------------------------------------------------------------------

test("Motorcycle is the only supported new-registration vehicle type", () => {
  assert.equal(RIDER_VEHICLE_TYPE, "Motorcycle");
});

test("a fresh draft initializes to Motorcycle", () => {
  const draft = createEmptyNewRider();
  assert.equal(draft.vehicle, RIDER_VEHICLE_TYPE);
});

test("reset produces a new object, so a reopened form cannot inherit a draft", () => {
  const first = createEmptyNewRider();
  first.vehicle = "Van";
  first.name = "Left over";

  const second = createEmptyNewRider();
  assert.equal(second.vehicle, RIDER_VEHICLE_TYPE, "reset restores Motorcycle");
  assert.equal(second.name, "", "reset clears the previous draft");
  assert.notEqual(first, second, "must not hand back a shared object");
});

test("the draft keeps the existing hub and status defaults", () => {
  const draft = createEmptyNewRider();
  assert.equal(draft.hub, "Manila Central Hub");
  assert.equal(draft.status, "standby");
});

// ---------------------------------------------------------------------------
// The payload boundary
// ---------------------------------------------------------------------------

test("a conflicting vehicle type cannot reach the stored payload", () => {
  for (const vehicle of [...RETIRED_VEHICLES, "Bicycle", "", null, undefined, 42, {}]) {
    const payload = buildNewRiderPayload({
      name: "R",
      id: "MCV-1",
      phone: "0917",
      vehicle,
    });
    assert.equal(
      payload.vehicle,
      RIDER_VEHICLE_TYPE,
      `${JSON.stringify(vehicle)} must be overridden`
    );
  }
});

test("stale draft state cannot survive normalization", () => {
  // The exact failure mode this guards: a draft created before the restriction,
  // or mutated directly, still normalizes to Motorcycle.
  const stale = { ...createEmptyNewRider(), vehicle: "Truck" };
  assert.equal(buildNewRiderPayload(stale).vehicle, RIDER_VEHICLE_TYPE);
});

test("the payload preserves the operator's other fields untouched", () => {
  const payload = buildNewRiderPayload({
    name: "Juan Dela Cruz",
    id: "MCV-0042",
    phone: "0917-000-0000",
    hub: "Makati Cold Hub",
    status: "offduty",
    vehicle: "Van",
  });

  assert.equal(payload.name, "Juan Dela Cruz");
  assert.equal(payload.id, "MCV-0042");
  assert.equal(payload.phone, "0917-000-0000");
  assert.equal(payload.hub, "Makati Cold Hub");
  assert.equal(payload.status, "offduty");
  assert.equal(payload.vehicle, RIDER_VEHICLE_TYPE);
});

test("no rider, plate or motorcycle identifier is fabricated", () => {
  const payload = buildNewRiderPayload({});

  assert.equal(payload.id, "", "an absent rider id stays empty");
  assert.equal(payload.name, "");
  assert.equal(payload.phone, "");

  // Nothing resembling a generated identifier may appear.
  for (const invented of [
    "vehiclePlate",
    "plate",
    "plateNumber",
    "motorcycleId",
    "motorcycle",
    "riderId",
    "uid",
  ]) {
    assert.ok(!(invented in payload), `${invented} must not be invented`);
  }
  assert.deepEqual(Object.keys(payload).sort(), [
    "hub",
    "id",
    "name",
    "phone",
    "status",
    "vehicle",
  ]);
});

test("a non-object draft degrades safely", () => {
  for (const bad of [null, undefined, "draft", 7]) {
    assert.equal(buildNewRiderPayload(bad).vehicle, RIDER_VEHICLE_TYPE);
  }
});

// ---------------------------------------------------------------------------
// The form offers no other option
// ---------------------------------------------------------------------------

/** Slice the New Rider modal out of the page source. */
function newRiderModalSource() {
  const start = ridersPage.indexOf("function NewRiderModal(");
  assert.notEqual(start, -1, "NewRiderModal not found");
  const rest = ridersPage.slice(start + 1);
  const next = rest.search(/\nfunction [A-Z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("Van, Truck and Auto are not offered anywhere in the form", () => {
  const modal = newRiderModalSource();
  for (const vehicle of RETIRED_VEHICLES) {
    assert.doesNotMatch(
      modal,
      new RegExp(`<option[^>]*>\\s*${vehicle}\\s*<`),
      `${vehicle} must not be selectable`
    );
    assert.ok(
      !modal.includes(`>${vehicle}<`),
      `${vehicle} must not appear as an option label`
    );
  }
});

test("the vehicle field is a fixed value, not a dropdown", () => {
  const modal = newRiderModalSource();

  // A one-option <select> would still imply a choice and still submit whatever
  // the DOM holds, so the control itself must be gone.
  const vehicleBlock = modal.slice(
    modal.indexOf("Vehicle Type"),
    modal.indexOf("Assigned Hub")
  );
  assert.ok(vehicleBlock.length > 0, "vehicle field not found");
  assert.doesNotMatch(vehicleBlock, /<select/, "must not be a select");
  assert.match(vehicleBlock, /readOnly/, "must be read-only");
  assert.match(
    vehicleBlock,
    /value=\{RIDER_VEHICLE_TYPE\}/,
    "must render the canonical constant, not a literal or draft value"
  );
  // No onChange: the draft's vehicle cannot be altered from the UI at all.
  assert.doesNotMatch(vehicleBlock, /onChange/, "must not be editable");
});

test("the vehicle field stays labelled and described", () => {
  const modal = newRiderModalSource();
  const vehicleBlock = modal.slice(
    modal.indexOf("Vehicle Type"),
    modal.indexOf("Assigned Hub")
  );
  assert.match(vehicleBlock, /id="new-rider-vehicle"/);
  assert.match(vehicleBlock, /aria-describedby="new-rider-vehicle-note"/);
  assert.match(ridersPage, /htmlFor="new-rider-vehicle"/);
});

test("the page seeds and resets the draft through the registration module", () => {
  assert.match(
    ridersPage,
    /useState\(createEmptyNewRider\)/,
    "initial draft must come from the module"
  );
  assert.match(
    ridersPage,
    /buildNewRiderPayload\(newRider\)/,
    "submit must normalize through the payload boundary"
  );
  // Reset on both submit and close.
  const resets = ridersPage.match(/setNewRider\(createEmptyNewRider\(\)\)/g) ?? [];
  assert.ok(resets.length >= 2, "draft must reset on submit and on close");
});

test("the hub and status fields keep their existing choices", () => {
  // Scope check: this revision restricts vehicles only.
  const modal = newRiderModalSource();
  for (const option of [
    "Manila Central Hub",
    "Quezon City Sub-Hub",
    "Makati Cold Hub",
  ]) {
    assert.ok(modal.includes(option), `${option} must still be offered`);
  }
  for (const status of ["standby", "active", "offduty"]) {
    assert.match(
      modal,
      new RegExp(`value="${status}"`),
      `initial status ${status} must still be offered`
    );
  }
});

// ---------------------------------------------------------------------------
// Untouched: existing riders, list mapping, lifecycle, subscription
// ---------------------------------------------------------------------------

test("existing rider list mapping is unchanged", () => {
  // Riders already recorded with another vehicle keep showing it — the fallback
  // chain that reads their stored value must survive.
  assert.match(ridersPage, /raw\.vehiclePlate/);
  assert.match(ridersPage, /raw\.motorcycle\b/);
  assert.match(ridersPage, /raw\.motorcycleId/);
  assert.match(ridersPage, /raw\.vehicle\b/);
});

test("the rider status lifecycle is unchanged", () => {
  for (const status of ["approved", "pending", "disabled", "rejected"]) {
    assert.match(
      ridersPage,
      new RegExp(`${status}:`),
      `${status} must remain mapped in the page`
    );
    assert.ok(
      riderService.includes(`"${status}"`),
      `${status} must remain a valid service status`
    );
  }
  assert.match(riderService, /VALID_STATUSES/);
  assert.match(riderService, /updateDoc\(doc\(db, "users", uid\), \{ status \}\)/);
});

test("no local setRiders mutation is introduced", () => {
  // Firestore stays the source of truth: the only setRiders call is the one
  // inside the subscribeRiders snapshot callback.
  const calls = ridersPage.match(/setRiders\(/g) ?? [];
  assert.equal(calls.length, 1, "setRiders must be called exactly once");
  assert.match(
    ridersPage,
    /subscribeRiders\([\s\S]*?setRiders\(raw\.map\(normalizeRider\)\)/,
    "the single call must be the subscription mapping"
  );
});

test("registration writes nothing to Firestore", () => {
  // The Admin form explains that accounts come from Firebase Auth; it must not
  // start creating users or rider documents as part of this revision.
  assert.ok(!riderService.includes("addDoc"), "riderService must not create docs");
  assert.ok(
    !riderService.includes("setDoc"),
    "riderService must not write new docs"
  );
  for (const forbidden of [
    "createUserWithEmailAndPassword",
    "addDoc",
    "setDoc",
  ]) {
    assert.ok(
      !ridersPage.includes(forbidden),
      `${forbidden} must not appear in the Riders page`
    );
  }
});
