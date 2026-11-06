"use strict";

/**
 * Staff accounts — created and changed only here, on the server.
 *
 *   createStaffAccount    an approved Admin adds a Dispatcher, Med Rep or Admin.
 *                         Firebase Auth gets an account with NO password; the
 *                         person sets their own through Firebase's reset email
 *                         or a one-time setup link. Nobody else ever knows it.
 *   createStaffSetupLink  a new one-time "set your password" link, only for an
 *                         account that has never signed in.
 *   setStaffStatus        approve / reject / deactivate / reactivate, along the
 *   setStaffRole          same transitions as the Staff Directory; neither may
 *                         leave the system without an approved Admin, and an
 *                         Admin never changes their own account here.
 *   bootstrapFirstAdmin   the installer's one-time setup script
 *                         (scripts/createFirstAdmin.js): refuses once any
 *                         approved Admin exists.
 *
 * Every change writes one staffAccountEvents record (who, what, when).
 * Riders still apply in the app; firestore.rules stops browsers creating user
 * profiles or changing a role, and lets them change status only on riders
 * (the Riders page), so staff access can change only through these functions.
 *
 * `authAdmin` is the Firebase Admin Auth client (getAuth()), injected so the
 * rules here are testable without a live Auth service.
 */

const { PolicyError } = require("./policy");
const { loadUser, requireRole } = require("./operations");

const USERS = "users";
const EVENTS = "staffAccountEvents";

/** Roles an Admin may create. Riders apply in the rider app instead. */
const STAFF_ROLES = Object.freeze(["admin", "dispatcher", "salesrep"]);
/** Roles an existing account may be changed to. */
const ASSIGNABLE_ROLES = Object.freeze(["admin", "dispatcher", "salesrep", "rider"]);

const ROLE_LABELS = Object.freeze({ admin: "Admin", dispatcher: "Dispatcher", salesrep: "Med Rep", rider: "Rider" });

/** Mirrors src/services/staffAccount.js TRANSITIONS (and firestore.rules adminStatusChangeAllowed). */
const TRANSITIONS = Object.freeze({
  pending: ["approved", "rejected"],
  pending_approval: ["approved", "rejected"],
  approved: ["disabled"],
  disabled: ["approved"],
  rejected: [],
});
const UNRECOGNISED_FROM = Object.freeze(["approved", "rejected"]);

const clean = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const normalizeStatus = (raw) => (Object.prototype.hasOwnProperty.call(TRANSITIONS, clean(raw)) ? clean(raw) : null);

function canChangeStatus(fromRaw, to) {
  const from = normalizeStatus(fromRaw);
  return (from === null ? UNRECOGNISED_FROM : TRANSITIONS[from]).includes(to);
}

const isApprovedAdmin = (user) => clean(user?.role) === "admin" && clean(user?.status) === "approved";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const invalid = (message) => new PolicyError("invalid-staff", message);

/** { name, email, role } — the only fields an Admin sends to create staff. */
function parseNewStaff(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("Enter the person's name, email and role.");
  if (Object.keys(payload).some((k) => !["name", "email", "role"].includes(k))) {
    throw invalid("Only a name, an email and a role may be sent.");
  }
  const name = typeof payload.name === "string" ? payload.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 80) throw invalid("Enter the person's full name (2 to 80 characters).");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) throw invalid("Enter a valid work email address.");
  if (!STAFF_ROLES.includes(payload.role)) throw invalid("Choose Admin, Dispatcher or Med Rep.");
  return { name, email, role: payload.role };
}

function targetUidOf(payload, extraKeys) {
  if (!payload || typeof payload !== "object" || Object.keys(payload).some((k) => !["targetUid", ...extraKeys].includes(k))) {
    throw new PolicyError("invalid-payload", "That account could not be identified.");
  }
  const { targetUid } = payload;
  if (typeof targetUid !== "string" || targetUid.trim() === "" || targetUid.includes("/")) {
    throw new PolicyError("invalid-payload", "That account could not be identified.");
  }
  return targetUid;
}

async function requireAdmin(db, uid) {
  requireRole(await loadUser(db, uid), "admin");
}

function eventRecord({ FieldValue, now, action, actorUid, actorEmail, targetUid, target, extra = {} }) {
  return {
    action,
    targetUid,
    targetEmail: target?.email ?? null,
    targetName: target?.name ?? target?.fullName ?? null,
    actorUid,
    actorEmail: actorEmail ?? null,
    atMs: now.getTime(),
    at: FieldValue.serverTimestamp(),
    ...extra,
  };
}

/** Approved Admins, read inside the transaction so two changes cannot both remove "the other" Admin. */
async function approvedAdminUids(tx, db) {
  const snap = await tx.get(db.collection(USERS).where("role", "==", "admin"));
  return snap.docs.filter((d) => isApprovedAdmin(d.data())).map((d) => d.id);
}

const LAST_ADMIN = () =>
  new PolicyError("last-admin", "This is the only active Admin. Add or activate another Admin first, so the system is never left without one.");

async function setupLinkFor(authAdmin, email) {
  try {
    return await authAdmin.generatePasswordResetLink(email);
  } catch {
    return null; // The account exists; the Admin can make a new link later.
  }
}

/**
 * Create a staff account. Returns { uid, email, role, setupLink }; setupLink
 * is null if Firebase could not make one right now (the account still exists).
 */
async function createStaffAccount({ db, authAdmin, FieldValue, uid, email: actorEmail = null, payload, now = new Date() }) {
  await requireAdmin(db, uid);
  const staff = parseNewStaff(payload);

  let created;
  try {
    created = await authAdmin.createUser({ email: staff.email, displayName: staff.name, emailVerified: false, disabled: false });
  } catch (error) {
    if (error?.code === "auth/email-already-exists") {
      throw new PolicyError("email-in-use", "This email already has a VaxTrack account. Find it in the Staff Directory instead.");
    }
    if (error?.code === "auth/invalid-email") throw invalid("Enter a valid work email address.");
    throw error;
  }

  const userRef = db.collection(USERS).doc(created.uid);
  try {
    await db.runTransaction(async (tx) => {
      // Re-checked inside: the caller may have been demoted meanwhile.
      const actor = await tx.get(db.collection(USERS).doc(uid));
      requireRole(actor.exists ? actor.data() : null, "admin");
      tx.create(userRef, {
        name: staff.name,
        email: staff.email,
        role: staff.role,
        status: "approved",
        createdVia: "admin",
        createdByUid: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.collection(EVENTS).doc(), eventRecord({
        FieldValue, now, action: "created", actorUid: uid, actorEmail, targetUid: created.uid, target: staff,
        extra: { toRole: staff.role, toStatus: "approved" },
      }));
    });
  } catch (error) {
    // Never leave a sign-in account without its profile.
    try {
      await authAdmin.deleteUser(created.uid);
    } catch {
      // Logged by the caller's error handler; nothing else to undo.
    }
    throw error;
  }

  return { uid: created.uid, email: staff.email, role: staff.role, setupLink: await setupLinkFor(authAdmin, staff.email) };
}

/** A new one-time password-setup link, for an account that has never signed in. */
async function createStaffSetupLink({ db, authAdmin, FieldValue, uid, email: actorEmail = null, payload, now = new Date() }) {
  await requireAdmin(db, uid);
  const targetUid = targetUidOf(payload, []);
  const snap = await db.collection(USERS).doc(targetUid).get();
  if (!snap.exists) throw new PolicyError("staff-not-found", "That account no longer exists.");
  const target = snap.data();
  if (clean(target.status) !== "approved") {
    throw new PolicyError("staff-not-active", "Only an active account can be sent a setup link.");
  }
  let record;
  try {
    record = await authAdmin.getUser(targetUid);
  } catch {
    throw new PolicyError("staff-not-found", "That account has no sign-in record.");
  }
  if (record.metadata?.lastSignInTime) {
    throw new PolicyError(
      "already-signed-in",
      "This person has already signed in. If they forgot their password, they can use Forgot password on the sign-in page.",
    );
  }
  if (!record.email) throw new PolicyError("staff-not-found", "That account has no email address.");
  const link = await authAdmin.generatePasswordResetLink(record.email);
  await db.collection(EVENTS).add(eventRecord({
    FieldValue, now, action: "setup_link_created", actorUid: uid, actorEmail, targetUid, target,
  }));
  return { uid: targetUid, email: record.email, setupLink: link };
}

/** Approve / reject / deactivate / reactivate. { targetUid, status }. */
async function setStaffStatus({ db, FieldValue, uid, email: actorEmail = null, payload, now = new Date() }) {
  await requireAdmin(db, uid);
  const targetUid = targetUidOf(payload, ["status"]);
  const { status } = payload;
  if (!["approved", "rejected", "disabled"].includes(status)) {
    throw new PolicyError("invalid-payload", "Choose approve, reject, deactivate or reactivate.");
  }
  if (targetUid === uid) {
    throw new PolicyError("self-change", "You cannot change your own account status. Ask another Admin.");
  }
  const ref = db.collection(USERS).doc(targetUid);
  return db.runTransaction(async (tx) => {
    const actor = await tx.get(db.collection(USERS).doc(uid));
    requireRole(actor.exists ? actor.data() : null, "admin");
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("staff-not-found", "That account no longer exists.");
    const target = snap.data();
    if (!canChangeStatus(target.status, status)) {
      throw normalizeStatus(target.status) === "rejected"
        ? new PolicyError("account-rejected", "This application was rejected. A rejected account cannot be activated.")
        : new PolicyError("status-change-not-allowed", "That status change is not allowed for this account's current status. The list shows its current status.");
    }
    if (isApprovedAdmin(target) && status !== "approved") {
      const admins = await approvedAdminUids(tx, db);
      if (admins.filter((id) => id !== targetUid).length === 0) throw LAST_ADMIN();
    }
    tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp(), statusUpdatedByUid: uid });
    tx.create(db.collection(EVENTS).doc(), eventRecord({
      FieldValue, now, action: "status_changed", actorUid: uid, actorEmail, targetUid, target,
      extra: { fromStatus: target.status ?? null, toStatus: status, role: target.role ?? null },
    }));
    return { uid: targetUid, status };
  });
}

/** Change an account's role. { targetUid, role }. */
async function setStaffRole({ db, FieldValue, uid, email: actorEmail = null, payload, now = new Date() }) {
  await requireAdmin(db, uid);
  const targetUid = targetUidOf(payload, ["role"]);
  const { role } = payload;
  if (!ASSIGNABLE_ROLES.includes(role)) throw new PolicyError("invalid-payload", "Choose Admin, Dispatcher, Med Rep or Rider.");
  if (targetUid === uid) throw new PolicyError("self-change", "You cannot change your own role. Ask another Admin.");
  const ref = db.collection(USERS).doc(targetUid);
  return db.runTransaction(async (tx) => {
    const actor = await tx.get(db.collection(USERS).doc(uid));
    requireRole(actor.exists ? actor.data() : null, "admin");
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("staff-not-found", "That account no longer exists.");
    const target = snap.data();
    if (normalizeStatus(target.status) === "rejected") {
      throw new PolicyError("account-rejected", "This application was rejected. Its role cannot be changed.");
    }
    if (clean(target.role) === role) throw new PolicyError("role-unchanged", `This account is already ${ROLE_LABELS[role]}.`);
    if (isApprovedAdmin(target)) {
      const admins = await approvedAdminUids(tx, db);
      if (admins.filter((id) => id !== targetUid).length === 0) throw LAST_ADMIN();
    }
    tx.update(ref, { role, updatedAt: FieldValue.serverTimestamp(), roleUpdatedByUid: uid });
    tx.create(db.collection(EVENTS).doc(), eventRecord({
      FieldValue, now, action: "role_changed", actorUid: uid, actorEmail, targetUid, target,
      extra: { fromRole: target.role ?? null, toRole: role, status: target.status ?? null },
    }));
    return { uid: targetUid, role };
  });
}

/**
 * The installer's first Admin (scripts/createFirstAdmin.js). Refuses when an
 * approved Admin already exists, so it can never add a second one.
 * Returns { uid, email, setupLink }.
 */
async function bootstrapFirstAdmin({ db, authAdmin, FieldValue, name, email, now = new Date() }) {
  const staff = parseNewStaff({ name, email, role: "admin" });
  const adminsExist = async () => {
    const snap = await db.collection(USERS).where("role", "==", "admin").get();
    return snap.docs.some((d) => isApprovedAdmin(d.data()));
  };
  const EXISTS = () => new PolicyError("admin-exists", "An approved Admin already exists. Add staff from Admin → Settings → User Management instead.");
  if (await adminsExist()) throw EXISTS();

  let created;
  try {
    created = await authAdmin.createUser({ email: staff.email, displayName: staff.name, emailVerified: false, disabled: false });
  } catch (error) {
    if (error?.code === "auth/email-already-exists") {
      throw new PolicyError("email-in-use", "This email already has a sign-in account. Use another email address.");
    }
    throw error;
  }
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection(USERS).where("role", "==", "admin"));
      if (snap.docs.some((d) => isApprovedAdmin(d.data()))) throw EXISTS();
      tx.create(db.collection(USERS).doc(created.uid), {
        name: staff.name,
        email: staff.email,
        role: "admin",
        status: "approved",
        createdVia: "setup-script",
        createdByUid: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.collection(EVENTS).doc(), eventRecord({
        FieldValue, now, action: "created", actorUid: null, actorEmail: "setup-script", targetUid: created.uid, target: staff,
        extra: { toRole: "admin", toStatus: "approved" },
      }));
    });
  } catch (error) {
    try {
      await authAdmin.deleteUser(created.uid);
    } catch {
      // Nothing else to undo.
    }
    throw error;
  }
  return { uid: created.uid, email: staff.email, setupLink: await setupLinkFor(authAdmin, staff.email) };
}

module.exports = {
  STAFF_ROLES,
  ASSIGNABLE_ROLES,
  EVENTS_COLLECTION: EVENTS,
  parseNewStaff,
  canChangeStatus,
  createStaffAccount,
  createStaffSetupLink,
  setStaffStatus,
  setStaffRole,
  bootstrapFirstAdmin,
};
