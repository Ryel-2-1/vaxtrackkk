import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Admin Riders is a read + approve surface, not an onboarding surface.
//
// Riders create their own accounts in the Flutter app; Admin only displays
// them and moves them through the approval lifecycle. These guard that the
// page does not drift back into pretending it can create accounts, and that
// the parts it genuinely owns — the Firestore subscription, the document-id
// mapping and the status actions — stay intact.
//
// Source-shape assertions: this repo has no jsdom/RTL and adding one would be
// a dependency change, matching the other suites here.

const here = dirname(fileURLToPath(import.meta.url));
const ridersPage = readFileSync(
  join(here, "..", "src", "pages", "admin", "Riders.jsx"),
  "utf8"
);
const ridersCss = readFileSync(
  join(here, "..", "src", "pages", "admin", "Riders.css"),
  "utf8"
);
const riderService = readFileSync(
  join(here, "..", "src", "services", "riderService.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// No pretend account creation
// ---------------------------------------------------------------------------

test("there is no New Rider button", () => {
  assert.ok(!ridersPage.includes("New Rider"), "the button label must be gone");
  assert.ok(
    !ridersPage.includes("riders-new-btn"),
    "the button class must be gone"
  );
});

test("there is no registration modal", () => {
  for (const marker of [
    "NewRiderModal",
    "showNewRiderModal",
    "riders-form-modal",
    "riders-form-grid",
    "Create Rider",
    "Vehicle Type",
  ]) {
    assert.ok(!ridersPage.includes(marker), `${marker} must be gone`);
  }
});

test("there is no no-op creation handler or draft state", () => {
  for (const marker of [
    "handleCreateRider",
    "newRider",
    "setNewRider",
    "createEmptyNewRider",
    "buildNewRiderPayload",
  ]) {
    assert.ok(!ridersPage.includes(marker), `${marker} must be gone`);
  }
});

test("the page never writes a user or rider document", () => {
  for (const forbidden of [
    "addDoc",
    "setDoc",
    "createUserWithEmailAndPassword",
  ]) {
    assert.ok(
      !ridersPage.includes(forbidden),
      `${forbidden} must not appear in the Riders page`
    );
  }
});

test("the page explains where rider accounts actually come from", () => {
  assert.match(
    ridersPage,
    /Riders register through the VaxTrack mobile app\./,
    "the onboarding note must be present"
  );
  assert.match(ridersPage, /New accounts\s+appear here for approval\./);
});

test("CSS used only by the removed modal is gone", () => {
  for (const orphan of [
    ".riders-new-btn",
    ".riders-form-grid",
    ".riders-form-label",
    ".riders-field-note",
  ]) {
    assert.ok(!ridersCss.includes(orphan), `${orphan} must be removed`);
  }
});

test("CSS still shared with the rider details modal is kept", () => {
  // These are used by RiderDetailsModal and must survive the cleanup.
  for (const kept of [
    ".riders-modal-backdrop",
    ".riders-modal-close",
    ".riders-modal-actions",
    ".riders-primary-action",
    ".riders-light-action",
    ".riders-danger-action",
  ]) {
    assert.ok(ridersCss.includes(kept), `${kept} must be kept`);
  }
});

// ---------------------------------------------------------------------------
// What the page does own, unchanged
// ---------------------------------------------------------------------------

test("riders still come from the Firestore subscription", () => {
  assert.match(ridersPage, /subscribeRiders\(/);
  assert.match(riderService, /onSnapshot\(/);
  assert.match(riderService, /where\("role", "==", "rider"\)/);

  // onSnapshot stays the only source of list state.
  const calls = ridersPage.match(/setRiders\(/g) ?? [];
  assert.equal(calls.length, 1, "setRiders must be called exactly once");
  assert.match(
    ridersPage,
    /subscribeRiders\([\s\S]*?setRiders\(raw\.map\(normalizeRider\)\)/,
    "the single call must be the subscription mapping"
  );
});

test("rider.uid remains the Firestore document id", () => {
  // Spread first, id last: a stray `uid` field inside the document must never
  // shadow the real document id, because the status actions write to
  // users/{uid}.
  assert.match(
    riderService,
    /\.map\(\(d\) => \(\{ \.\.\.d\.data\(\), uid: d\.id \}\)\)/,
    "document id must be assigned after the spread"
  );
  assert.doesNotMatch(
    riderService,
    /\{\s*uid: d\.id,\s*\.\.\.d\.data\(\)\s*\}/,
    "the shadowable ordering must not return"
  );
  assert.match(ridersPage, /uid: raw\.uid/, "normalizeRider must carry it through");
  assert.match(
    ridersPage,
    /updateRiderStatus\(rider\.uid,/,
    "status actions must target the document id"
  );
});

test("the approval lifecycle is unchanged", () => {
  for (const status of ["approved", "pending", "disabled", "rejected"]) {
    assert.match(
      ridersPage,
      new RegExp(`${status}:`),
      `${status} must remain mapped for display`
    );
    assert.ok(
      riderService.includes(`"${status}"`),
      `${status} must remain a valid service status`
    );
  }
  assert.match(riderService, /VALID_STATUSES/);
  assert.match(
    riderService,
    /updateDoc\(doc\(db, "users", uid\), \{ status \}\)/,
    "the status writer must be unchanged"
  );
});

test("the existing rider list mapping is unchanged", () => {
  // Riders already recorded with any vehicle keep displaying it.
  assert.match(ridersPage, /raw\.vehiclePlate/);
  assert.match(ridersPage, /raw\.motorcycle\b/);
  assert.match(ridersPage, /raw\.motorcycleId/);
  assert.match(ridersPage, /raw\.vehicle\b/);
});

test("the rider details modal survives", () => {
  assert.match(ridersPage, /function RiderDetailsModal\(/);
  assert.match(ridersPage, /riders-modal-backdrop/);
});
