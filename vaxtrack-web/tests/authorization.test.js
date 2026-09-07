import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOGIN_PATH,
  PENDING_PATH,
  ROLES,
  STATUSES,
  normalizeRole,
  normalizeStatus,
  resolveAccess,
  resolveLoginDestination,
} from "../src/services/authorization.js";

/**
 * The actor x status x area matrix, exhaustively.
 *
 * Every guard and the login redirect delegate to `resolveAccess`, so this file
 * IS the access-control specification. It is built as a full cross-product
 * rather than a list of interesting cases, because the defect this replaced —
 * a missing `status` defaulting to "approved" — lived in the gap between the
 * cases someone thought to write.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const AREAS = [
  { name: "Admin", requiredRole: ROLES.ADMIN, home: "/admin" },
  { name: "Sales Rep", requiredRole: ROLES.SALES_REP, home: "/sales-rep" },
  { name: "Dispatcher", requiredRole: ROLES.DISPATCHER, home: "/dispatcher" },
];

const WEB_ROLES = [ROLES.ADMIN, ROLES.SALES_REP, ROLES.DISPATCHER];
const ALL_ROLES = [...WEB_ROLES, ROLES.RIDER];

const HOME = {
  [ROLES.ADMIN]: "/admin",
  [ROLES.SALES_REP]: "/sales-rep",
  [ROLES.DISPATCHER]: "/dispatcher",
};

// ---------------------------------------------------------------- 1, 2, 3

test("an unauthenticated visitor reaches no protected area", () => {
  // The guards pass `profile: null` when onAuthStateChanged reports no user.
  for (const area of AREAS) {
    const d = resolveAccess({ profile: null, requiredRole: area.requiredRole });
    assert.equal(d.allowed, false, area.name);
    assert.equal(d.redirectTo, LOGIN_PATH, area.name);
    assert.equal(d.reason, "no-profile");
  }
});

test("a signed-in user with NO profile document is blocked", () => {
  // Authenticated is not authorized. A deleted or never-created users doc must
  // not fall through to any default.
  for (const area of AREAS) {
    const d = resolveAccess({ profile: null, requiredRole: area.requiredRole });
    assert.equal(d.allowed, false);
    assert.equal(d.redirectTo, LOGIN_PATH);
  }
  assert.equal(resolveLoginDestination(null).reason, "no-profile");
});

test("only an APPROVED user enters their own area", () => {
  for (const area of AREAS) {
    const d = resolveAccess({
      profile: { role: area.requiredRole, status: STATUSES.APPROVED },
      requiredRole: area.requiredRole,
    });
    assert.equal(d.allowed, true, area.name);
    assert.equal(d.redirectTo, null);
  }
});

test("every non-approved status is blocked, in every area, for every role", () => {
  // The full cross-product. 3 areas x 4 roles x 4 blocked statuses.
  const blocked = [
    [STATUSES.PENDING, PENDING_PATH, "pending"],
    [STATUSES.PENDING_APPROVAL, PENDING_PATH, "pending"],
    [STATUSES.REJECTED, LOGIN_PATH, "rejected"],
    [STATUSES.DISABLED, LOGIN_PATH, "disabled"],
  ];
  let checked = 0;
  for (const area of AREAS) {
    for (const role of ALL_ROLES) {
      for (const [status, expectedPath, expectedReason] of blocked) {
        const d = resolveAccess({ profile: { role, status }, requiredRole: area.requiredRole });
        assert.equal(d.allowed, false, `${role}/${status} -> ${area.name}`);
        assert.equal(d.redirectTo, expectedPath, `${role}/${status} -> ${area.name}`);
        assert.equal(d.reason, expectedReason);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 48, "the full status cross-product must be covered");
});

// ------------------------------------------------- REGRESSION: the D1 defect

test("a MISSING status is blocked — it must never default to approved", () => {
  // The defect this checkpoint found. All three guards and the login redirect
  // read `(data.status || "approved")`, so a user document with no status was
  // admitted. Production contains exactly such an account: role "admin" with
  // no status field.
  for (const area of AREAS) {
    for (const role of ALL_ROLES) {
      for (const absent of [undefined, null, "", "   "]) {
        const d = resolveAccess({ profile: { role, status: absent }, requiredRole: area.requiredRole });
        assert.equal(d.allowed, false, `${role}/${String(absent)} -> ${area.name}`);
        assert.equal(d.redirectTo, LOGIN_PATH);
        assert.equal(d.reason, "unknown-status");
      }
    }
  }
  // ...including the account shape that actually exists in production.
  assert.equal(
    resolveAccess({ profile: { role: "admin" }, requiredRole: ROLES.ADMIN }).allowed,
    false,
    "role:admin with no status must NOT reach the admin area"
  );
});

test("an UNKNOWN status is blocked, including the UI's display labels", () => {
  // "active"/"inactive" are labels Settings shows, never Firestore values. If
  // one were ever written, it must deny rather than sail past the known cases.
  for (const bogus of ["active", "inactive", "Approved ", "APPROVED", "approve", "ok", "true", "0"]) {
    const d = resolveAccess({ profile: { role: "admin", status: bogus }, requiredRole: ROLES.ADMIN });
    // "Approved " and "APPROVED" normalise to approved — trimming and casing
    // are deliberate. Everything else must fail closed.
    const shouldPass = bogus.trim().toLowerCase() === "approved";
    assert.equal(d.allowed, shouldPass, bogus);
  }
  for (const bogus of [5, true, {}, [], Symbol.iterator ? undefined : null]) {
    assert.equal(
      resolveAccess({ profile: { role: "admin", status: bogus }, requiredRole: ROLES.ADMIN }).allowed,
      false,
      String(bogus)
    );
  }
});

// ---------------------------------------------------------------- 4, 5, 6

test("an approved user of one role cannot enter another role's area", () => {
  // 3 areas x 2 other web roles = 6 crossings, each sent to its OWN home
  // rather than to login, so a mistyped URL is not mistaken for a sign-in
  // failure.
  let crossings = 0;
  for (const area of AREAS) {
    for (const role of WEB_ROLES) {
      if (role === area.requiredRole) continue;
      const d = resolveAccess({
        profile: { role, status: STATUSES.APPROVED },
        requiredRole: area.requiredRole,
      });
      assert.equal(d.allowed, false, `${role} -> ${area.name}`);
      assert.equal(d.reason, "wrong-role");
      assert.equal(d.redirectTo, HOME[role], `${role} -> ${area.name} lands on its own home`);
      crossings += 1;
    }
  }
  assert.equal(crossings, 6, "every cross-role pairing must be covered");
});

// ------------------------------------------------------------------- 7, 8

test("an approved RIDER reaches no web area at all", () => {
  for (const area of AREAS) {
    const d = resolveAccess({
      profile: { role: ROLES.RIDER, status: STATUSES.APPROVED },
      requiredRole: area.requiredRole,
    });
    assert.equal(d.allowed, false, area.name);
    // Not "their own dashboard" — there is no web home for a rider, and
    // inventing one would be a redirect to a page that cannot exist.
    assert.equal(d.redirectTo, LOGIN_PATH, area.name);
    assert.equal(d.reason, "rider-web-blocked");
  }
  assert.equal(resolveLoginDestination({ role: "rider", status: "approved" }).reason, "rider-web-blocked");
});

test("no React Rider route or page exists", () => {
  const app = read("src/App.jsx");
  // Anchored to a whole segment: `/riders` is the ADMIN page listing riders,
  // which is a legitimate admin route and not a rider portal.
  assert.equal(/path="\/rider(?:"|\/)/.test(app), false, "no /rider route may be registered");
  assert.equal(/pages\/rider\//.test(app), false, "no rider page may be imported");
  assert.match(app, /path="\/riders"/, "the Admin riders page is unaffected");
});

test("the dead self-registration page is gone", () => {
  // It was unrouted and unimported, but it wrote a USER-CHOSEN role to
  // users/{uid}. Unreachable is not the same as absent: a file like that gets
  // re-routed by someone who assumes it was safe.
  let exists = true;
  try {
    read("src/pages/Register.jsx");
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "src/pages/Register.jsx must not exist");

  const app = read("src/App.jsx");
  assert.equal(/path="\/register"/.test(app), false, "no /register route");
});

// ------------------------------------------------------------ 9, 10, 11

test("role identity comes from the profile alone — never from an identifier", () => {
  // A document carrying an elevated-looking employeeId, name, email or its own
  // uid/id field is still exactly the role its `role` says.
  const impostor = {
    role: "salesrep",
    status: "approved",
    employeeId: "ADMIN-0001",
    name: "Administrator",
    email: "admin@vaxtrack.com",
    uid: "some-admin-uid",
    id: "some-admin-uid",
    isAdmin: true,
    claims: { admin: true },
  };
  const d = resolveAccess({ profile: impostor, requiredRole: ROLES.ADMIN });
  assert.equal(d.allowed, false, "no identifier field may grant admin");
  assert.equal(d.reason, "wrong-role");
  assert.equal(d.redirectTo, "/sales-rep", "still routed by its real role");
});

test("the guards read users/{auth.uid} and nothing else", () => {
  // Structural: the lookup must be keyed on the AUTH uid, so no field inside
  // the document can redirect it.
  for (const guard of [
    "src/components/AdminRoute.jsx",
    "src/components/SalesRepRoute.jsx",
    "src/components/DispatcherRoute.jsx",
  ]) {
    const src = read(guard);
    assert.match(src, /getDoc\(doc\(db, "users", user\.uid\)\)/, guard);
    for (const forbidden of ["employeeId", "where(", "query(", "data.uid", "data().id"]) {
      assert.equal(src.includes(forbidden), false, `${guard} must not consult ${forbidden}`);
    }
  }
});

test("the document id is the authoritative uid in the users subscription", () => {
  // Regression for the shadowing defect: Admin Settings turns this value into
  // the uid it approves and re-roles, so a stored `id` field must not win.
  // Comments are stripped first: the fix carries a comment quoting the OLD
  // pattern to explain what went wrong, and asserting against raw source would
  // trip on that explanation rather than on any real code.
  const src = read("src/services/userService.js").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /\.map\(\(d\) => \(\{ \.\.\.d\.data\(\), id: d\.id \}\)\)/);
  assert.equal(
    /\{ id: d\.id, \.\.\.d\.data\(\) \}/.test(src),
    false,
    "the document id must be spread LAST so stored data cannot shadow it"
  );
});

test("unknown and malformed roles fail closed", () => {
  for (const bogus of ["wizard", "superuser", "ADMIN ", "Admin", "", "   ", null, undefined, 5, {}, []]) {
    const d = resolveAccess({ profile: { role: bogus, status: "approved" }, requiredRole: ROLES.ADMIN });
    // "ADMIN " and "Admin" normalise to admin; casing and padding are handled
    // deliberately. Nothing else may resolve to a role.
    const shouldPass = typeof bogus === "string" && bogus.trim().toLowerCase() === "admin";
    assert.equal(d.allowed, shouldPass, String(bogus));
    if (!shouldPass) assert.equal(d.redirectTo, LOGIN_PATH, String(bogus));
  }
});

test("normalizers accept only the documented vocabulary", () => {
  assert.equal(normalizeRole("sales-rep"), ROLES.SALES_REP);
  assert.equal(normalizeRole("Sales Representative"), ROLES.SALES_REP);
  assert.equal(normalizeRole("sales rep"), null, "an unlisted spelling is unknown, not a guess");
  assert.equal(normalizeRole("staff"), null, "a legacy corrupt role is unknown");
  assert.equal(normalizeRole("pending"), null, "a status in the role field is unknown");

  assert.equal(normalizeStatus("pending_approval"), STATUSES.PENDING_APPROVAL);
  assert.equal(normalizeStatus("active"), null);
  assert.equal(normalizeStatus(undefined), null);
});

// ------------------------------------------------------------- 12, 13, 14

test("login and the guards agree, so no redirect loop is possible", () => {
  // A loop needs the two to disagree: login sending a user somewhere a guard
  // immediately bounces back. Both call resolveAccess, and this asserts the
  // agreement for every role x status pair.
  for (const role of ALL_ROLES) {
    for (const status of [...Object.values(STATUSES), undefined, "bogus"]) {
      const profile = { role, status };
      const login = resolveLoginDestination(profile);
      if (!login.allowed) continue;

      // Login says "go here" — the guard for that area must then allow it.
      const area = AREAS.find((a) => a.home === login.redirectTo);
      assert.ok(area, `login sent ${role}/${status} to an area with no guard`);
      const guard = resolveAccess({ profile, requiredRole: area.requiredRole });
      assert.equal(guard.allowed, true, `${role}/${status}: login and guard disagree`);
    }
  }
});

test("a blocked account is never sent somewhere that bounces it back", () => {
  // Every refusal lands on /login or /pending, neither of which is guarded, so
  // a refusal cannot ping-pong.
  for (const role of ALL_ROLES) {
    for (const status of [undefined, "", "bogus", ...Object.values(STATUSES)]) {
      for (const area of AREAS) {
        const d = resolveAccess({ profile: { role, status }, requiredRole: area.requiredRole });
        if (d.allowed) continue;
        assert.ok(
          d.redirectTo === LOGIN_PATH || d.redirectTo === PENDING_PATH || Object.values(HOME).includes(d.redirectTo),
          `${role}/${status} -> ${d.redirectTo}`
        );
      }
    }
  }
});

test("protected content cannot paint before the decision resolves", () => {
  // Each guard must render nothing while loading — not a spinner containing
  // page content, and not the Outlet.
  for (const guard of [
    "src/components/AdminRoute.jsx",
    "src/components/SalesRepRoute.jsx",
    "src/components/DispatcherRoute.jsx",
  ]) {
    const src = read(guard);
    assert.match(src, /if \(state === "loading"\) return null;/, guard);
    // The Outlet must be the LAST thing, reachable only after both earlier
    // returns, so there is no ordering in which it renders first.
    const loadingAt = src.indexOf('state === "loading"');
    const redirectAt = src.indexOf('state === "redirect"');
    const outletAt = src.indexOf("<Outlet />");
    assert.ok(loadingAt < outletAt && redirectAt < outletAt, `${guard}: Outlet must render last`);
  }
});

test("every protected route sits inside a guard", () => {
  const app = read("src/App.jsx");
  // Pull each <Route path="..."> and check the protected prefixes are only
  // ever inside a guard element or a redirect to one.
  const guarded = /<Route element={<(Admin|SalesRep|Dispatcher)Route \/>}>([\s\S]*?)<\/Route>\s*\n/g;
  let insideGuards = "";
  let m;
  while ((m = guarded.exec(app)) !== null) insideGuards += m[2];

  const protectedPaths = [...app.matchAll(/path="(\/(?:admin|sales-rep|dispatcher)[^"]*)"/g)].map((x) => x[1]);
  assert.ok(protectedPaths.length >= 26, "the matrix must cover every protected route");
  for (const p of protectedPaths) {
    assert.ok(insideGuards.includes(`path="${p}"`), `${p} must be inside a route guard`);
  }
});

test("logout ends the Firebase session rather than only navigating", () => {
  // A logout that just navigates leaves the session alive, so back/forward or a
  // direct URL walks straight back in.
  const layout = read("src/components/admin/AdminLayout.jsx");
  assert.match(layout, /signOut\(auth\)/);
  assert.match(layout, /navigate\("\/login"\)|navigate\("\/"\)/);
  // And every page-level logout does the same.
  for (const page of ["src/pages/admin/Settings.jsx", "src/pages/admin/Riders.jsx"]) {
    assert.match(read(page), /signOut\(auth\)/, page);
  }
});

// ----------------------------------------------------------------- 15, 16, 17

test("the login screen never lets a user claim a role", () => {
  const login = read("src/pages/Login.jsx");
  // No portal/role picker: a role chosen in the UI could only contradict the
  // account, and offering one invites the attempt.
  assert.equal(/<select[^>]*role/i.test(login), false, "no role selector on login");
  assert.equal(/selectedRole|roleChoice|portalRole/.test(login), false);
  // The destination is decided from the stored profile only.
  assert.match(login, /resolveLoginDestination\(userSnap\.data\(\)\)/);
});

test("a rider is told which app to use, without being signed in", () => {
  // Clarity requirement: the screen must say what to do, and the session must
  // still end.
  const login = read("src/pages/Login.jsx");
  assert.match(login, /Rider accounts must use the VaxTrack mobile app/);
  const branch = /case "rider-web-blocked":([\s\S]*?)break;/.exec(login);
  assert.ok(branch, "the rider outcome must be handled explicitly");
  assert.match(login, /await signOut\(auth\);\s*\n\s*switch \(decision\.reason\)/);
});

test("role changes go through an explicit allowlist on both sides", () => {
  const service = read("src/services/userService.js");
  assert.match(service, /VALID_ROLES = \["admin", "dispatcher", "salesrep", "rider"\]/);
  assert.match(service, /VALID_STATUSES = \["approved", "pending", "pending_approval", "rejected", "disabled"\]/);
  assert.match(service, /if \(!VALID_ROLES\.includes\(role\)\)/);
  assert.match(service, /if \(!VALID_STATUSES\.includes\(status\)\)/);

  // ...and the same allowlist is enforced in the rules, so the client-side
  // check is a convenience rather than the control.
  const rules = read("firestore.rules");
  assert.match(rules, /function isKnownRole\(\)/);
  assert.match(rules, /function isKnownStatus\(\)/);
  assert.match(rules, /allow update: if \(isAdmin\(\) && isKnownRole\(\) && isKnownStatus\(\)\)/);
});

test("the three vocabularies cannot drift apart", () => {
  // authorization.js, userService.js and firestore.rules each list the roles
  // and statuses. If one gains a value the others do not have, an account can
  // be created that no guard will admit.
  const rules = read("firestore.rules");
  const service = read("src/services/userService.js");

  const rulesRoles = /isKnownRole\(\)\s*\{[\s\S]*?in \[([^\]]*)\]/.exec(rules)[1];
  const rulesStatuses = /isKnownStatus\(\)\s*\{[\s\S]*?in \[([^\]]*)\]/.exec(rules)[1];
  const roleList = [...rulesRoles.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const statusList = [...rulesStatuses.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(roleList, [...Object.values(ROLES)].sort(), "rules vs authorization.js roles");
  assert.deepEqual(statusList, [...Object.values(STATUSES)].sort(), "rules vs authorization.js statuses");

  const svcRoles = [...(/VALID_ROLES = \[([^\]]*)\]/.exec(service)[1]).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const svcStatuses = [...(/VALID_STATUSES = \[([^\]]*)\]/.exec(service)[1]).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(svcRoles, roleList, "userService vs rules roles");
  assert.deepEqual(svcStatuses, statusList, "userService vs rules statuses");
});
