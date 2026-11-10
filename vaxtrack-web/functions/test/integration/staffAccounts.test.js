"use strict";

/**
 * Staff accounts against a REAL Firestore (emulator) with a fake Firebase Auth:
 * an Admin creates staff, sets up passwords, changes status and role, and the
 * system is never left without an approved Admin. Run: npm run test:emulator.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-staff-accounts" }, "staff-accounts-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;
const S = require("../../src/staffAccounts");

const NOW = new Date("2026-11-03T08:00:00.000Z");
const ADMIN = "stAdmin";

/** Firebase Auth, in memory: what createUser / getUser / links / deleteUser need. */
function fakeAuth({ failLinks = false } = {}) {
  const users = new Map();
  let next = 1;
  return {
    users,
    async createUser({ email }) {
      if ([...users.values()].some((u) => u.email === email)) {
        throw Object.assign(new Error("exists"), { code: "auth/email-already-exists" });
      }
      const uid = `auth${next++}`;
      users.set(uid, { uid, email, metadata: { lastSignInTime: null } });
      return { uid };
    },
    async getUser(uid) {
      if (!users.has(uid)) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return users.get(uid);
    },
    async deleteUser(uid) {
      users.delete(uid);
    },
    async generatePasswordResetLink(email) {
      if (failLinks) throw new Error("quota");
      return `https://example.test/reset?for=${encodeURIComponent(email)}`;
    },
  };
}

const user = async (id) => {
  const s = await db.collection("users").doc(id).get();
  return s.exists ? s.data() : null;
};
const events = async () => (await db.collection(S.EVENTS_COLLECTION).get()).docs.map((d) => d.data());

async function wipe() {
  for (const c of ["users", S.EVENTS_COLLECTION]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function world(extra = {}) {
  await wipe();
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved", name: "Maria", email: "maria@x.ph" });
  for (const [id, data] of Object.entries(extra)) await db.collection("users").doc(id).set(data);
}

const create = (authAdmin, payload, uid = ADMIN) =>
  S.createStaffAccount({ db, authAdmin, FieldValue, uid, email: "maria@x.ph", payload, now: NOW });
const setStatus = (targetUid, status, uid = ADMIN) =>
  S.setStaffStatus({ db, FieldValue, uid, email: "maria@x.ph", payload: { targetUid, status }, now: NOW });
const reopen = (targetUid, reason, uid = ADMIN) =>
  S.setStaffStatus({ db, FieldValue, uid, payload: { targetUid, status: "pending_approval", reason }, now: NOW });
const setRole = (targetUid, role, uid = ADMIN) =>
  S.setStaffRole({ db, FieldValue, uid, email: "maria@x.ph", payload: { targetUid, role }, now: NOW });
const code = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};

test("an Admin creates a Dispatcher: sign-in account with no password, approved profile, audit entry, setup link", async () => {
  await world();
  const auth = fakeAuth();
  const r = await create(auth, { name: "  Juan   Dela Cruz ", email: " Juan@Clinic.PH ", role: "dispatcher" });
  assert.equal(r.email, "juan@clinic.ph");
  assert.match(r.setupLink, /^https:\/\/example\.test\/reset/);
  const profile = await user(r.uid);
  assert.equal(profile.name, "Juan Dela Cruz");
  assert.equal(profile.email, "juan@clinic.ph");
  assert.equal(profile.role, "dispatcher");
  assert.equal(profile.status, "approved");
  assert.equal(profile.createdVia, "admin");
  assert.equal(profile.createdByUid, ADMIN);
  const [ev] = await events();
  assert.deepEqual([ev.action, ev.targetUid, ev.actorUid, ev.toRole], ["created", r.uid, ADMIN, "dispatcher"]);
});

test("only an approved Admin may create staff, and only Admin / Dispatcher / Med Rep", async () => {
  await world({
    disp: { role: "dispatcher", status: "approved" },
    offAdmin: { role: "admin", status: "disabled" },
  });
  const auth = fakeAuth();
  assert.equal(await code(create(auth, { name: "Ana", email: "a@x.ph", role: "salesrep" }, "disp")), "wrong-role");
  assert.equal(await code(create(auth, { name: "Ana", email: "a@x.ph", role: "salesrep" }, "offAdmin")), "not-approved");
  assert.equal(await code(create(auth, { name: "Ana", email: "a@x.ph", role: "rider" })), "invalid-staff");
  assert.equal(await code(create(auth, { name: "Ana", email: "not-an-email", role: "salesrep" })), "invalid-staff");
  assert.equal(await code(create(auth, { name: "A", email: "a@x.ph", role: "salesrep" })), "invalid-staff");
  assert.equal(await code(create(auth, { name: "Ana", email: "a@x.ph", role: "salesrep", status: "approved" })), "invalid-staff");
  assert.equal(auth.users.size, 0, "no sign-in account was made for any refusal");
});

test("an email that already has an account is refused", async () => {
  await world();
  const auth = fakeAuth();
  await create(auth, { name: "Ana Reyes", email: "ana@x.ph", role: "salesrep" });
  assert.equal(await code(create(auth, { name: "Ana Again", email: "ANA@x.ph", role: "dispatcher" })), "email-in-use");
});

test("no setup link right now still creates the account (a new link can be made later)", async () => {
  await world();
  const r = await create(fakeAuth({ failLinks: true }), { name: "Ana Reyes", email: "ana@x.ph", role: "salesrep" });
  assert.equal(r.setupLink, null);
  assert.equal((await user(r.uid)).status, "approved");
});

test("a setup link only for an active account that has never signed in", async () => {
  await world();
  const auth = fakeAuth();
  const r = await create(auth, { name: "Ana Reyes", email: "ana@x.ph", role: "salesrep" });
  const link = (uid) => S.createStaffSetupLink({ db, authAdmin: auth, FieldValue, uid: ADMIN, payload: { targetUid: uid }, now: NOW });
  assert.match((await link(r.uid)).setupLink, /reset/);
  auth.users.get(r.uid).metadata.lastSignInTime = "Mon, 03 Nov 2026 09:00:00 GMT";
  assert.equal(await code(link(r.uid)), "already-signed-in");
  assert.equal(await code(link("nobody")), "staff-not-found");
  assert.ok((await events()).some((e) => e.action === "setup_link_created"));
});

test("status changes follow the Staff Directory transitions and are recorded", async () => {
  await world({
    pend: { role: "dispatcher", status: "pending", email: "p@x.ph" },
    rej: { role: "salesrep", status: "rejected" },
    act: { role: "salesrep", status: "approved" },
  });
  await setStatus("pend", "approved");
  assert.equal((await user("pend")).status, "approved");
  await setStatus("act", "disabled");
  await setStatus("act", "approved");
  assert.equal(await code(setStatus("rej", "approved")), "account-rejected");
  assert.equal(await code(setStatus("act", "rejected")), "status-change-not-allowed");
  assert.equal(await code(setStatus(ADMIN, "disabled")), "self-change");
  const changes = (await events()).filter((e) => e.action === "status_changed");
  assert.equal(changes.length, 3);
  assert.ok(changes.every((e) => e.actorUid === ADMIN));
});

test("reopening preserves the account and rejection history and requires a separate approval", async () => {
  const applicant = { role: "salesrep", status: "pending", email: "rep@example.test", name: "Sample applicant" };
  await world({ applicant });
  await setStatus("applicant", "rejected");
  assert.equal(await code(setStatus("applicant", "approved")), "account-rejected");

  await reopen("applicant", "  Confirmed the applicant’s role  ");
  const reopened = await user("applicant");
  assert.equal(reopened.status, "pending_approval");
  assert.equal(reopened.email, applicant.email);
  assert.equal(reopened.role, applicant.role);
  assert.equal(await code(reopen("applicant", "Second review")), "status-change-not-allowed");

  await setStatus("applicant", "approved");
  assert.equal((await user("applicant")).status, "approved");
  const history = await events();
  assert.equal(history.length, 3);
  const reopening = history.find((event) => event.toStatus === "pending_approval");
  assert.deepEqual(
    [reopening.action, reopening.fromStatus, reopening.reason, reopening.actorUid, reopening.targetUid],
    ["status_changed", "rejected", "Confirmed the applicant’s role", ADMIN, "applicant"],
  );
  assert.ok(history.some((event) => event.toStatus === "rejected" && event.fromStatus === "pending"));
  assert.ok(history.some((event) => event.toStatus === "approved" && event.fromStatus === "pending_approval"));
});

test("only an approved Admin can reopen a currently rejected application with a reason", async () => {
  await world({
    rejected: { role: "salesrep", status: " Rejected " },
    pending: { role: "salesrep", status: "pending" },
    disabled: { role: "salesrep", status: "disabled" },
    dispatcher: { role: "dispatcher", status: "approved" },
    disabledAdmin: { role: "admin", status: "disabled" },
  });
  for (const reason of [null, "  ", "x".repeat(301)]) {
    assert.equal(await code(reopen("rejected", reason)), "invalid-staff");
  }
  assert.equal(await code(reopen("rejected", "Review", "dispatcher")), "wrong-role");
  assert.equal(await code(reopen("rejected", "Review", "disabledAdmin")), "not-approved");
  assert.equal(await code(reopen(ADMIN, "Review")), "self-change");
  for (const target of ["pending", "disabled", "dispatcher"]) {
    assert.equal(await code(reopen(target, "Review")), "status-change-not-allowed");
  }
  assert.equal((await user("rejected")).status, " Rejected ");
  assert.deepEqual(await events(), []);
  await reopen("rejected", "Review confirmed");
  assert.equal((await user("rejected")).status, "pending_approval");
});

test("there is always an approved Admin: no self-change, and a removed Admin cannot act", async () => {
  await world({ boss: { role: "admin", status: "approved" } });
  assert.equal(await code(setStatus(ADMIN, "disabled")), "self-change");
  assert.equal(await code(setRole(ADMIN, "dispatcher")), "self-change");
  await setStatus("boss", "disabled");
  // Boss is out; Boss can no longer remove Maria, the one Admin left.
  assert.equal(await code(setStatus(ADMIN, "disabled", "boss")), "not-approved");
  assert.equal(await code(setRole(ADMIN, "salesrep", "boss")), "not-approved");
  assert.equal((await user(ADMIN)).status, "approved");
});

test("two Admins removing each other at the same moment: exactly one wins, one Admin remains", async () => {
  await world({ boss: { role: "admin", status: "approved" } });
  const results = await Promise.allSettled([setStatus("boss", "disabled", ADMIN), setStatus(ADMIN, "disabled", "boss")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const approved = (await db.collection("users").where("role", "==", "admin").get()).docs.filter((d) => d.get("status") === "approved");
  assert.equal(approved.length, 1);
});

test("role changes: allowed between roles, refused for rejected accounts, recorded", async () => {
  await world({
    rep: { role: "salesrep", status: "approved" },
    rej: { role: "salesrep", status: "rejected" },
  });
  await setRole("rep", "admin");
  assert.equal((await user("rep")).role, "admin");
  assert.equal(await code(setRole("rep", "admin")), "role-unchanged");
  assert.equal(await code(setRole("rej", "dispatcher")), "account-rejected");
  assert.equal(await code(setRole("rep", "wizard")), "invalid-payload");
  const [ev] = (await events()).filter((e) => e.action === "role_changed");
  assert.deepEqual([ev.fromRole, ev.toRole], ["salesrep", "admin"]);
});

test("the first-Admin setup creates exactly one Admin and then refuses", async () => {
  await wipe();
  const auth = fakeAuth();
  const boot = (email) => S.bootstrapFirstAdmin({ db, authAdmin: auth, FieldValue, name: "Owner Name", email, now: NOW });
  const r = await boot("owner@client.ph");
  const profile = await user(r.uid);
  assert.deepEqual([profile.role, profile.status, profile.createdVia], ["admin", "approved", "setup-script"]);
  assert.match(r.setupLink, /reset/);
  assert.equal(await code(boot("second@client.ph")), "admin-exists");
  assert.equal(auth.users.size, 1, "the refused run made no sign-in account");
});

test("the first-Admin setup ignores disabled or pending Admins, but not approved ones", async () => {
  await wipe();
  await db.collection("users").doc("old").set({ role: "admin", status: "disabled" });
  const auth = fakeAuth();
  const r = await S.bootstrapFirstAdmin({ db, authAdmin: auth, FieldValue, name: "Owner Name", email: "o@c.ph", now: NOW });
  assert.ok(r.uid);
});
