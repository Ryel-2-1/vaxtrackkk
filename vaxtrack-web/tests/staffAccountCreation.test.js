import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Admin → Settings → Add staff, and the move of staff role/status changes to
// the server (functions/src/staffAccounts.js). Behaviour is covered by the
// functions emulator suite (staffAccounts.test.js) and the rules suite
// (P1, Prole1, ACC7); these pin the page wiring.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("src/pages/admin/Settings.jsx");
const dialog = read("src/pages/admin/AddStaffDialog.jsx");
const service = read("src/services/staffAccountCallables.js");

test("staff status and role change only through the server callables", () => {
  assert.match(page, /await setStaffStatus\(uid, firestoreStatus\);/);
  assert.match(page, /await setStaffRole\(uid, newRole\);/);
  assert.equal(/updateUserStatus|updateUserRole/.test(page), false, "no direct Firestore write of a staff status or role");
  for (const name of ["createStaffAccount", "createStaffSetupLink", "setStaffStatus", "setStaffRole"]) {
    assert.match(service, new RegExp(`run\\("${name}"`), name);
  }
});

test("Add staff never asks for or sets a password, and offers no Rider role", () => {
  assert.equal(/type="password"|password:/i.test(dialog), false);
  assert.match(dialog, /createStaffAccount\(\{ name: form\.name, email: form\.email, role: form\.role \}\)/);
  assert.match(dialog, /sendStaffSetupEmail\(result\.email\)/);
  const roles = /const NEW_STAFF_ROLES = \[([\s\S]*?)\];/.exec(dialog)[1];
  assert.match(roles, /"dispatcher"/);
  assert.match(roles, /"salesrep"/);
  assert.match(roles, /"admin"/);
  assert.equal(/"rider"/.test(roles), false);
});

test("the set-password email is Firebase's own reset email, not a password the Admin chooses", () => {
  assert.match(service, /sendPasswordResetEmail\(auth, email\)/);
});

test("the setup link is shown only on request, for accounts made by an Admin or the setup script", () => {
  assert.match(page, /canSetUp: raw\.createdVia === "admin" \|\| raw\.createdVia === "setup-script"/);
  assert.match(page, /person\.canSetUp && person\.status === "active" && !isSelf/);
});
