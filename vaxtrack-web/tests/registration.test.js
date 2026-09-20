import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPLICABLE_ROLES,
  MIN_PASSWORD_LENGTH,
  RIDER_VEHICLE_TYPE,
  buildApplicationProfile,
  isApplicableRole,
  mapRegistrationError,
  validateApplication,
} from "../src/services/registration.js";

/**
 * Public self-application: a visitor creates their own login and a PENDING
 * profile, and an admin approves / declines / re-roles it in User Management.
 * The security-critical invariant is that admin can never be self-applied and a
 * pending applicant can do nothing until approved. The Firestore rules are the
 * real boundary (tests/firestore.rules.test.js); this suite pins the client
 * logic and the page shape that feed them.
 */

// -------------------------------------------------------------- role allowlist

test("admin is never an applicable position", () => {
  const values = APPLICABLE_ROLES.map((r) => r.value);
  assert.deepEqual(values, ["salesrep", "dispatcher", "rider"]);
  assert.equal(values.includes("admin"), false);
  assert.equal(isApplicableRole("admin"), false);
  assert.equal(isApplicableRole("superadmin"), false);
  assert.equal(isApplicableRole("salesrep"), true);
  assert.equal(isApplicableRole("dispatcher"), true);
  assert.equal(isApplicableRole("rider"), true);
});

// ------------------------------------------------------------------ validation

test("validateApplication rejects incomplete or inconsistent input", () => {
  const base = {
    name: "Jane Cruz",
    email: "jane@x.co",
    password: "longenough1",
    confirmPassword: "longenough1",
    role: "salesrep",
  };
  assert.equal(validateApplication({ ...base, name: "  " }).ok, false);
  assert.equal(validateApplication({ ...base, email: "" }).ok, false);
  assert.equal(validateApplication({ ...base, email: "nope" }).ok, false);
  assert.equal(validateApplication({ ...base, role: "admin" }).ok, false);
  assert.equal(validateApplication({ ...base, role: "" }).ok, false);
  assert.equal(
    validateApplication({ ...base, password: "short", confirmPassword: "short" }).ok,
    false
  );
  assert.equal(validateApplication({ ...base, confirmPassword: "different1" }).ok, false);
});

test("validateApplication returns cleaned values on success", () => {
  const out = validateApplication({
    name: "  Jane   Cruz ",
    email: "  jane@x.co ",
    password: "longenough1",
    confirmPassword: "longenough1",
    role: "dispatcher",
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.name, "Jane Cruz");
  assert.equal(out.value.email, "jane@x.co");
  assert.equal(out.value.role, "dispatcher");
});

test("the password floor is enforced at the documented length", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const ok = "a".repeat(MIN_PASSWORD_LENGTH);
  assert.equal(
    validateApplication({
      name: "A B",
      email: "a@b.co",
      password: short,
      confirmPassword: short,
      role: "rider",
    }).ok,
    false
  );
  assert.equal(
    validateApplication({
      name: "A B",
      email: "a@b.co",
      password: ok,
      confirmPassword: ok,
      role: "rider",
    }).ok,
    true
  );
});

// -------------------------------------------------------- profile construction

test("buildApplicationProfile always produces a pending, non-admin account", () => {
  const rep = buildApplicationProfile({ name: "Rep One", email: "r@x.co", role: "salesrep" });
  assert.equal(rep.role, "salesrep");
  assert.equal(rep.status, "pending");
  assert.equal("vehicleType" in rep, false, "a non-rider carries no vehicle type");

  const disp = buildApplicationProfile({ name: "Disp", email: "d@x.co", role: "dispatcher" });
  assert.equal(disp.status, "pending");

  const rider = buildApplicationProfile({ name: "Rider", email: "rr@x.co", role: "rider" });
  assert.equal(rider.status, "pending");
  assert.equal(rider.vehicleType, RIDER_VEHICLE_TYPE, "a rider is pinned to the one vehicle type");
});

test("buildApplicationProfile refuses admin and unknown roles by throwing", () => {
  for (const role of ["admin", "superadmin", "wizard", "", undefined]) {
    assert.throws(
      () => buildApplicationProfile({ name: "X", email: "x@y.co", role }),
      /not an applicable position/,
      `role ${JSON.stringify(role)} must be refused`
    );
  }
});

test("buildApplicationProfile includes phone only when given, and trims text", () => {
  const withPhone = buildApplicationProfile({
    name: "  Ann  Lee ",
    email: "a@x.co",
    role: "salesrep",
    phone: "  0917 000 ",
  });
  assert.equal(withPhone.fullName, "Ann Lee");
  assert.equal(withPhone.phone, "0917 000");

  const noPhone = buildApplicationProfile({ name: "Ann", email: "a@x.co", role: "salesrep" });
  assert.equal("phone" in noPhone, false);
});

// ------------------------------------------------------------- error mapping

test("mapRegistrationError maps the codes that matter", () => {
  assert.match(mapRegistrationError("auth/email-already-in-use"), /already exists/i);
  assert.match(mapRegistrationError("auth/weak-password"), /at least/i);
  assert.match(mapRegistrationError("auth/network-request-failed"), /connect|connection/i);
  assert.match(mapRegistrationError("auth/too-many-requests"), /too many/i);
  assert.match(mapRegistrationError("something-else"), /went wrong/i);
});

// ============================================================ page source shape

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");

const PAGE = "src/pages/Register.jsx";

test("the apply page wires real Firebase account creation through the pure logic", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import \{[\s\S]*?createUserWithEmailAndPassword[\s\S]*?\} from "firebase\/auth"/,
    "must import createUserWithEmailAndPassword"
  );
  assert.match(src, /createUserWithEmailAndPassword\(\s*auth,/, "must create the account");
  assert.match(src, /buildApplicationProfile\(\{/, "must build the profile via the pure logic");
  assert.match(src, /setDoc\(doc\(db, "users",/, "must write the users/{uid} profile");
});

test("the position select offers only applicable roles and never admin", () => {
  const src = code(PAGE);
  assert.match(src, /APPLICABLE_ROLES\.map\(/, "the select must be driven by the allowlist");
  // No hardcoded admin option smuggled in beside it.
  assert.equal(
    /value="admin"|>Administrator</.test(src),
    false,
    "admin must not be selectable"
  );
});

test("the account is created pending, then signed out — never left signed in", () => {
  const src = read(PAGE);
  const handler = /const handleSubmit = async \(e\) => \{[\s\S]*?\n {2}\};/.exec(src);
  assert.ok(handler, "the submit handler must exist");
  const body = handler[0];

  const setDocAt = body.indexOf("setDoc(");
  const signOutAt = body.indexOf("signOut(auth)");
  const navigateAt = body.indexOf('navigate("/pending")');
  assert.ok(setDocAt !== -1, "profile must be written");
  assert.ok(signOutAt > setDocAt, "must sign out AFTER writing the pending profile");
  assert.ok(navigateAt > signOutAt, "must route to /pending after signing out");
});

test("a failed profile write deletes the orphaned auth account", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import \{[\s\S]*?deleteUser[\s\S]*?\} from "firebase\/auth"/,
    "must import deleteUser"
  );
  assert.match(src, /deleteUser\(credential\.user\)/, "must remove the orphaned account on write failure");
});

test("duplicate submissions are blocked by an in-flight guard", () => {
  const src = read(PAGE);
  const body = /const handleSubmit = async \(e\) => \{[\s\S]*?\n {2}\};/.exec(src)[0];
  assert.match(body, /if \(submitting\)\s*return;/, "a re-entrancy guard must exist");
  assert.match(body, /setSubmitting\(true\)/);
  assert.match(body, /setSubmitting\(false\)/);
  assert.match(body, /\}\s*finally\s*\{/, "the flag must be cleared in finally");
  assert.match(src, /type="submit"[\s\S]*?disabled=\{submitting\}/, "the button must disable while submitting");
});

test("login links to the apply page and App routes it", () => {
  assert.match(read("src/pages/Login.jsx"), /to="\/register"/, "login must link to /register");
  assert.match(read("src/App.jsx"), /path="\/register"/, "App must route /register");
});
