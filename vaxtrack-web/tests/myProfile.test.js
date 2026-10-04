import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SELF_EDITABLE_FIELDS,
  buildProfileUpdate,
  hasProfileChanges,
  initialsOf,
  readProfile,
  roleLabelOf,
  validateProfileEdit,
} from "../src/services/profileModel.js";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

/**
 * "My profile" — one page for Admin, Sales Rep and Dispatcher.
 *
 * The Dispatcher page used to be fully local: a hardcoded profile every
 * dispatcher saw, an editable Role field, an invented hub and four toggles,
 * "saved" only to localStorage. Now every role reads and writes its OWN
 * users/{uid} record, may change only its name and phone, and sees email,
 * role, status, employee ID and organization read-only. The rules suite
 * (SELF1–SELF5) proves the server enforces the same split.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** Source without comments, so an explanation of what was removed is not a hit. */
const code = (p) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");

// ------------------------------------------------------------- the model

test("readProfile shows the stored values, whatever spelling the record uses", () => {
  const rider = readProfile(
    { fullName: "Juan Dela Cruz", contactNumber: "0917 000 0000", role: "rider", status: "approved" },
    { authEmail: "juan@vaxtrack.com" }
  );
  assert.equal(rider.name, "Juan Dela Cruz");
  assert.equal(rider.phone, "0917 000 0000");
  assert.equal(rider.email, "juan@vaxtrack.com", "the sign-in email is the authority");
  assert.equal(rider.roleLabel, "Rider");
  assert.equal(rider.statusLabel, "Active");

  const rep = readProfile({ name: "Ana", role: "Sales Rep", status: "Rejected", company: "3MGS", employeeId: " E-7 ", email: "a@x.com" });
  assert.equal(rep.roleLabel, "—", "an unrecognised role is never invented");
  assert.equal(rep.statusLabel, "Rejected");
  assert.equal(rep.organization, "3MGS");
  assert.equal(rep.employeeId, "E-7");
  assert.equal(rep.email, "a@x.com");

  assert.equal(readProfile(null).name, "");
  assert.equal(roleLabelOf("dispatcher"), "Dispatcher");
  assert.equal(roleLabelOf("salesrep"), "Med Rep");
  assert.equal(roleLabelOf("admin"), "Administrator");
});

test("validateProfileEdit requires a real name and accepts an optional valid phone", () => {
  assert.deepEqual(validateProfileEdit({ name: "  Ana   Reyes ", phone: " +63 917 123 4567 " }), {
    ok: true,
    errors: {},
    value: { name: "Ana Reyes", phone: "+63 917 123 4567" },
  });
  assert.equal(validateProfileEdit({ name: "Ana", phone: "" }).ok, true, "phone is optional");
  for (const name of ["", " ", "A", "12345", "x".repeat(81)]) {
    assert.equal(validateProfileEdit({ name, phone: "" }).errors.name !== undefined, true, JSON.stringify(name));
  }
  for (const phone of ["abc", "123", "+63 917 123 4567 8901 2345", "0917-123-4567; drop"]) {
    assert.equal(validateProfileEdit({ name: "Ana", phone }).errors.phone !== undefined, true, phone);
  }
  for (const phone of ["09171234567", "(02) 8123-4567", "+63.917.123.4567"]) {
    assert.equal(validateProfileEdit({ name: "Ana", phone }).ok, true, phone);
  }
});

test("buildProfileUpdate writes only self-editable fields, mirroring legacy spellings", () => {
  const value = { name: "New Name", phone: "0917 123 4567" };
  assert.deepEqual(buildProfileUpdate({ name: "Old", phone: "" }, value), value);
  // A rider-style record keeps fullName/contactNumber in step too.
  assert.deepEqual(buildProfileUpdate({ fullName: "Old", contactNumber: "" }, value), {
    name: "New Name", phone: "0917 123 4567", fullName: "New Name", contactNumber: "0917 123 4567",
  });
  for (const key of Object.keys(buildProfileUpdate({ fullName: "x", contactNumber: "y", role: "admin" }, value))) {
    assert.ok(SELF_EDITABLE_FIELDS.includes(key), key);
  }
  assert.deepEqual([...SELF_EDITABLE_FIELDS], ["name", "fullName", "phone", "contactNumber"]);
});

test("hasProfileChanges ignores whitespace-only differences", () => {
  const raw = { name: "Ana Reyes", phone: "0917" };
  assert.equal(hasProfileChanges(raw, { name: " Ana  Reyes ", phone: "0917 " }), false);
  assert.equal(hasProfileChanges(raw, { name: "Ana R", phone: "0917" }), true);
  assert.equal(initialsOf("ana reyes cruz"), "AR");
  assert.equal(initialsOf(""), "?");
});

test("the rules allow exactly the same self-editable fields", () => {
  const rules = read("firestore.rules");
  const block = /function selfProfileFields\(\) \{\s*return \[([^\]]*)\]/.exec(rules);
  assert.ok(block, "selfProfileFields() must exist");
  const ruleFields = [...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ruleFields.filter((f) => f !== "updatedAt").sort(), [...SELF_EDITABLE_FIELDS].sort());
  // The self branch is the allowlist, not a role/status-only check.
  assert.match(rules, /&& request\.auth\.uid == uid\s*\n\s*&& changedKeys\(\)\.hasOnly\(selfEditableUserFields\(\)\)/);
});

// ------------------------------------------------------------- the service

const loader = createServiceLoader();
const userService = await loader.load("userService.js");

test("updateUserProfile drops every administrator-managed field", async () => {
  const store = installStore(
    createStore({
      users: {
        me: { role: "dispatcher", status: "approved", name: "Old", employeeId: "EMP-1", organization: "3MGS", email: "me@x.com" },
      },
    }),
    { uid: "me" }
  );
  await userService.updateUserProfile("me", {
    name: "New Name",
    phone: "0917 123 4567",
    role: "admin",
    status: "approved",
    employeeId: "EMP-999",
    organization: "Elsewhere",
    email: "other@x.com",
    company: "X",
    clinic: "Y",
  });
  const saved = store.collections.users.me.data;
  assert.equal(saved.name, "New Name");
  assert.equal(saved.phone, "0917 123 4567");
  assert.equal(saved.role, "dispatcher");
  assert.equal(saved.employeeId, "EMP-1");
  assert.equal(saved.organization, "3MGS");
  assert.equal(saved.email, "me@x.com");
  assert.equal(saved.company, undefined);
  assert.equal(saved.clinic, undefined);
  // Nothing editable at all is refused rather than sent as an empty write.
  await assert.rejects(userService.updateUserProfile("me", { role: "admin" }), /No editable fields/);
});

// ------------------------------------------------------------- the pages

test("the Dispatcher page is no longer a local fake with an editable role", () => {
  const page = code("src/pages/dispatcher/DispatcherSettings.jsx");
  assert.match(page, /return <MyProfile \/>;/);
  for (const gone of [
    "localStorage",
    "dispatcherProfile",
    "dispatcherPreferences",
    'handleProfileChange("role"',
    "Assigned Hub",
    "Main Distribution Hub-A",
    "Dispatcher User",
    "SettingToggle",
    "Critical route override approval",
    "Geofence deviation alerts",
  ]) {
    assert.equal(page.includes(gone), false, `${gone} must be gone`);
  }
});

test("every role's settings page renders the same My profile", () => {
  assert.match(read("src/pages/salesRep/SalesRepSettings.jsx"), /return <MyProfile \/>;/);
  const admin = read("src/pages/admin/Settings.jsx");
  assert.match(admin, /onClick=\{\(\) => setActiveTab\("profile"\)\}\s*\n\s*>\s*\n\s*My Profile/);
  assert.match(admin, /activeTab === "profile" \? \(\s*\n\s*<MyProfile \/>/);
});

test("My profile edits only name and phone, and shows the rest read-only", () => {
  const page = read("src/components/profile/MyProfile.jsx");
  const inputs = page.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 2, "exactly two editable inputs");
  assert.match(page, /id="my-profile-name"/);
  assert.match(page, /id="my-profile-phone"/);
  // Read-only details are text, not inputs.
  for (const label of ["Email", "Role", "Account status", "Employee ID", "Organization"]) {
    assert.match(page, new RegExp(`<dt>[\\s\\S]{0,40}${label}\\s*</dt>`), label);
  }
  // It writes the user's own record, through the allowlisted service only.
  assert.match(page, /await updateUserProfile\(uid, buildProfileUpdate\(raw, check\.value\)\);/);
  assert.equal(/localStorage|setDoc|updateDoc/.test(code("src/components/profile/MyProfile.jsx")), false);
  // Password changes go through the existing reset flow.
  assert.match(page, /requestPasswordReset\(\{[\s\S]*?send: \(email\) => sendPasswordResetEmail\(auth, email\)/);
  assert.doesNotMatch(page, /eslint-disable/);
});

test("the sidebar cards show the signed-in user, not a hardcoded hub", () => {
  // One shared card renders the signed-in user's own record for every role.
  const card = read("src/components/shell/SidebarProfile.jsx");
  assert.match(card, /const \{ profile \} = useOwnProfile\(\);/);
  assert.match(card, /initialsOf\(me\.name\)/);

  for (const [file, gone, role] of [
    ["src/components/admin/AdminSidebar.jsx", ["Logistics Admin", "Manila Central Hub", '<div className="avatar">LA</div>'], "Administrator"],
    ["src/pages/salesRep/SalesRepShell.jsx", ["Manila Central Hub", '<div className="salesrep-profile-icon">SR</div>'], "Med Rep"],
    // Dispatcher had no profile card at all before; it gets the same one.
    ["src/pages/dispatcher/DispatcherLayout.jsx", [], "Dispatcher"],
  ]) {
    const src = read(file);
    for (const text of gone) assert.equal(src.includes(text), false, `${file}: ${text}`);
    assert.ok(src.includes(`<SidebarProfile fallbackRole="${role}" />`), file);
  }
});
