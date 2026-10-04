import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STAFF_STATUS,
  canChangeStaffStatus,
  staffActionsFor,
  staffStatusOf,
} from "../src/services/staffAccount.js";
import {
  LOGIN_PATH,
  ROLES,
  resolveAccess,
  resolveLoginDestination,
} from "../src/services/authorization.js";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

/**
 * BG-001 — a rejected application must stay rejected.
 *
 * The Staff Directory displayed a stored `rejected` as Inactive, which put
 * Reactivate on it; Reactivate wrote `approved` with no check, and the account
 * could then sign in. These prove the state is kept, shown, refused at the
 * service, and denied at sign-in and at every route guard. The same
 * transitions are enforced by firestore.rules (ACC1–ACC6 in the rules suite).
 */

const loader = createServiceLoader();
const userService = await loader.load("userService.js");

const ADMIN = { uid: "adminUid", email: "admin@vaxtrack.com" };
const seedUser = (status) =>
  installStore(
    createStore({ users: { u1: { role: "salesrep", status, name: "Applicant", email: "a@x.com" } } }),
    ADMIN
  );
const statusIn = (store) => store.collections.users.u1.data.status;

async function expectRefused(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.name, "UserStatusError");
    assert.equal(err.code, code);
    assert.ok(err.message.length > 0);
    return true;
  });
}

// ------------------------------------------------------------- the service

test("1 + 2. Reject stores the canonical `rejected` — never `disabled`/inactive", async () => {
  for (const pending of ["pending", "pending_approval"]) {
    const store = seedUser(pending);
    await userService.updateUserStatus("u1", "rejected");
    assert.equal(statusIn(store), "rejected");
    assert.notEqual(statusIn(store), "disabled");
    assert.notEqual(statusIn(store), "inactive");
  }
});

test("10. the ordinary Activate operation refuses a rejected account and writes nothing", async () => {
  for (const stored of ["rejected", "Rejected", " REJECTED "]) {
    const store = seedUser(stored);
    await expectRefused(userService.updateUserStatus("u1", "approved"), "account-rejected");
    assert.equal(statusIn(store), stored, `${JSON.stringify(stored)} is left exactly as it was`);
  }
});

test("a rejected account cannot be converted to inactive or sent back to pending", async () => {
  for (const next of ["disabled", "pending", "pending_approval"]) {
    const store = seedUser("rejected");
    await expectRefused(userService.updateUserStatus("u1", next), "account-rejected");
    assert.equal(statusIn(store), "rejected");
  }
});

test("only an application awaiting a decision can be rejected", async () => {
  for (const stored of ["approved", "disabled"]) {
    const store = seedUser(stored);
    await expectRefused(userService.updateUserStatus("u1", "rejected"), "status-change-not-allowed");
    assert.equal(statusIn(store), stored);
  }
});

test("11. a failed rejection leaves the stored status unchanged (no false Rejected)", async () => {
  // The account vanished between the row rendering and the click.
  const store = installStore(createStore({ users: {} }), ADMIN);
  await expectRefused(userService.updateUserStatus("u1", "rejected"), "user-not-found");
  assert.equal(store.collections.users.u1, undefined, "nothing was created or written");
  // And a refused change on an existing account writes nothing either.
  const active = seedUser("approved");
  await assert.rejects(userService.updateUserStatus("u1", "rejected"));
  assert.equal(statusIn(active), "approved");
});

test("14. pending approval, deactivation and reactivation still work", async () => {
  const store = seedUser("pending");
  await userService.updateUserStatus("u1", "approved");
  assert.equal(statusIn(store), "approved");
  await userService.updateUserStatus("u1", "disabled");
  assert.equal(statusIn(store), "disabled");
  await userService.updateUserStatus("u1", "approved");
  assert.equal(statusIn(store), "approved");
  // A profile with no status keeps its existing in-app approval repair path.
  const missing = installStore(createStore({ users: { u1: { role: "admin" } } }), ADMIN);
  await userService.updateUserStatus("u1", "approved");
  assert.equal(missing.collections.users.u1.data.status, "approved");
});

// ------------------------------------------------------- display + actions

test("3 + 13. the directory shows Rejected, distinct from Inactive, for every spelling", () => {
  for (const stored of ["rejected", "Rejected", " REJECTED "]) {
    assert.deepEqual(staffStatusOf(stored), { key: STAFF_STATUS.REJECTED, label: "Rejected" });
  }
  assert.deepEqual(staffStatusOf("disabled"), { key: STAFF_STATUS.INACTIVE, label: "Inactive" });
  assert.deepEqual(staffStatusOf("approved"), { key: STAFF_STATUS.ACTIVE, label: "Active" });
  assert.deepEqual(staffStatusOf("pending_approval"), { key: STAFF_STATUS.PENDING, label: "Pending" });
  // A legacy capitalised value no longer falls through to Pending (with Approve).
  assert.notEqual(staffStatusOf("Rejected").key, STAFF_STATUS.PENDING);
  // Missing still reads Pending — the existing repair path for an undated profile.
  assert.equal(staffStatusOf(undefined).key, STAFF_STATUS.PENDING);
});

test("4. a rejected account offers no Activate, no second Reject and no role change", () => {
  const actions = staffActionsFor(STAFF_STATUS.REJECTED);
  assert.deepEqual(actions, ["view"]);
  for (const forbidden of ["reactivate", "approve", "reject", "deactivate", "changeRole"]) {
    assert.equal(actions.includes(forbidden), false, forbidden);
  }
});

test("5 + 6. inactive keeps Reactivate; pending keeps Approve and Reject", () => {
  assert.deepEqual(staffActionsFor(STAFF_STATUS.INACTIVE), ["view", "reactivate", "changeRole"]);
  assert.deepEqual(staffActionsFor(STAFF_STATUS.PENDING), ["view", "approve", "reject", "changeRole"]);
  assert.deepEqual(staffActionsFor(STAFF_STATUS.ACTIVE), ["view", "deactivate", "changeRole"]);
  // An admin still cannot change their own role.
  assert.equal(staffActionsFor(STAFF_STATUS.ACTIVE, { isSelf: true }).includes("changeRole"), false);
});

test("the transition matrix matches the required behaviour", () => {
  const allowed = [
    ["pending", "approved"], ["pending", "rejected"],
    ["pending_approval", "approved"], ["pending_approval", "rejected"],
    ["approved", "disabled"], ["disabled", "approved"],
    [undefined, "approved"],
  ];
  const refused = [
    ["rejected", "approved"], ["rejected", "disabled"], ["rejected", "pending"],
    ["Rejected", "approved"], ["approved", "rejected"], ["disabled", "rejected"],
  ];
  for (const [from, to] of allowed) assert.equal(canChangeStaffStatus(from, to), true, `${from} -> ${to}`);
  for (const [from, to] of refused) assert.equal(canChangeStaffStatus(from, to), false, `${from} -> ${to}`);
});

// ------------------------------------------------------------ access

const WEB_ROUTES = [ROLES.ADMIN, ROLES.DISPATCHER, ROLES.SALES_REP];

test("7 + 9. a rejected profile is denied by the shared resolver, for every role", () => {
  for (const role of ["admin", "dispatcher", "salesrep", "sales_rep", "rider"]) {
    for (const status of ["rejected", "Rejected", " REJECTED "]) {
      const profile = { role, status };
      for (const requiredRole of WEB_ROUTES) {
        const decision = resolveAccess({ profile, requiredRole });
        assert.equal(decision.allowed, false, `${role}/${status} at ${requiredRole}`);
        assert.equal(decision.reason, "rejected");
        assert.equal(decision.redirectTo, LOGIN_PATH);
      }
      // And straight after sign-in.
      const login = resolveLoginDestination(profile);
      assert.equal(login.allowed, false);
      assert.equal(login.reason, "rejected");
    }
  }
});

test("8. every protected route re-reads the profile and applies the resolver", () => {
  // A direct URL or a refresh mounts the guard, which reads users/{auth.uid}
  // fresh and asks the same resolver — so a rejected profile is turned away
  // however the page is reached.
  for (const [file, role] of [
    ["AdminRoute.jsx", "ROLES.ADMIN"],
    ["DispatcherRoute.jsx", "ROLES.DISPATCHER"],
    ["SalesRepRoute.jsx", "ROLES.SALES_REP"],
  ]) {
    const src = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.match(src, /onAuthStateChanged\(auth,/, file);
    assert.match(src, /getDoc\(doc\(db, "users", user\.uid\)\)/, file);
    assert.match(src, new RegExp(`resolveAccess\\(\\{[\\s\\S]*?requiredRole: ${role.replace(".", "\\.")}`), file);
    assert.match(src, /<Navigate to=\{redirectTo\} replace \/>/, file);
  }
  // Login shows a safe message and ends the session.
  const login = readFileSync(new URL("../src/pages/Login.jsx", import.meta.url), "utf8");
  assert.match(login, /case "rejected":\s*\n\s*showError\("Your account was rejected\. Please contact the administrator\."\);/);
  assert.match(login, /await signOut\(auth\);\s*\n\s*switch \(decision\.reason\)/);
});

// ------------------------------------------------------------ page wiring

const page = readFileSync(new URL("../src/pages/admin/Settings.jsx", import.meta.url), "utf8");

test("the page reads status and actions from the shared module, not a local map", () => {
  assert.match(page, /const uiStatus = staffStatusOf\(raw\.status\);/);
  assert.equal(/UI_STATUS/.test(page), false, "the map that folded rejected into inactive is gone");
  assert.equal(/rejected: \{ status: "inactive"/.test(page), false);
  assert.match(page, /const actions = staffActionsFor\(person\.status, \{\s*\n\s*isSelf: person\.uid === currentAdminUid,/);
  assert.match(page, /const actions = staffActionsFor\(person\.status, \{ isSelf \}\);/);
  assert.equal(/person\.status === "inactive" &&/.test(page), false, "no hard-coded Reactivate gate remains");
});

test("12. Reject is confirmed first, and cancelling writes nothing", () => {
  // The only write of `rejected` is behind the confirmation.
  assert.equal((page.match(/updateStatus\([^)]*"rejected"\)/g) ?? []).length, 1);
  assert.match(page, /const confirmReject = async \(\) => \{[\s\S]*?if \(target\) await updateStatus\(target\.uid, "rejected"\);/);
  // Both Reject buttons only open the dialog.
  assert.match(page, /onClick=\{\(\) => \{\s*\n\s*setRejectTarget\(person\);/);
  assert.match(page, /onReject=\{\(\) => \{\s*\n\s*setRejectTarget\(selectedStaff\);/);
  // Cancel only closes it.
  assert.match(page, /onCancel=\{\(\) => setRejectTarget\(null\)\}/);
  assert.match(page, /Normal activation will no longer be available for this account\./);
});

test("11. no optimistic status: rows change only from the Firestore subscription", () => {
  const handler = /const updateStatus = async \(uid, firestoreStatus\) => \{([\s\S]*?)\n {2}\};/.exec(page)[1];
  assert.equal(/setStaff\(/.test(handler), false, "the status handler never edits rows locally");
  assert.match(handler, /error\?\.name === "UserStatusError"/);
});

test("the Rejected badge is red, distinct from the grey Inactive one", () => {
  const css = readFileSync(new URL("../src/pages/admin/Settings.css", import.meta.url), "utf8");
  assert.match(css, /\.staff-status\.rejected \{\s*\n\s*background: var\(--danger-bg\);\s*\n\s*color: var\(--danger-text\);/);
  assert.match(css, /\.staff-status\.inactive \{\s*\n\s*background: var\(--gray-100\);/);
  assert.doesNotMatch(page, /eslint-disable/);
});
