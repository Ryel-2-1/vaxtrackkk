import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { canChangeStaffStatus, statusChangeRefusal } from "./staffAccount";
import { SELF_EDITABLE_FIELDS } from "./profileModel";
import { validateTerritoryAssignment } from "./territory";

const USERS_COLLECTION = "users";

const VALID_STATUSES = ["approved", "pending", "pending_approval", "rejected", "disabled"];
const VALID_ROLES = ["admin", "dispatcher", "salesrep", "rider"];

export function subscribeUsers(callback, onError) {
  return onSnapshot(collection(db, USERS_COLLECTION), (snapshot) => {
    const users = snapshot.docs
      // Document id LAST so it always wins.
      //
      // This was `{ id: d.id, ...d.data() }`, which let a stored `id` field
      // SHADOW the real document id. Admin Settings turns that value into the
      // uid it approves, rejects, disables and re-roles — so a user document
      // carrying an `id` field would have sent an admin's action to a different
      // account than the row they clicked. The identical shadowing bug was
      // already fixed in inventoryService, vaccineService, clinicService,
      // invoiceService and riderService; `users` was the one that was missed,
      // and it is the collection where it mattered most.
      .map((d) => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    callback(users);
  }, (error) => {
    // Optional: existing callers pass no handler and keep their behaviour.
    console.error("subscribeUsers error:", error);
    if (onError) onError(error);
  });
}

/** A refused status change. `code` is stable; `message` is written for the admin. */
export class UserStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UserStatusError";
    this.code = code;
  }
}

/**
 * Change a staff account's status — only along the allowed transitions
 * (staffAccount.js). The stored status is re-read inside a transaction, so a
 * stale Staff Directory row cannot drive a change: in particular a REJECTED
 * application can never be activated, deactivated or sent back to pending.
 * firestore.rules refuses the same writes independently.
 */
export async function updateUserStatus(uid, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const ref = doc(db, USERS_COLLECTION, uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new UserStatusError("user-not-found", "That account no longer exists.");
    }
    const current = snap.data().status;
    if (!canChangeStaffStatus(current, status)) {
      const refusal = statusChangeRefusal(current);
      throw new UserStatusError(refusal.code, refusal.message);
    }
    tx.update(ref, { status, updatedAt: serverTimestamp() });
    return { uid, status };
  });
}

export async function updateUserRole(uid, role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  return updateDoc(doc(db, USERS_COLLECTION, uid), { role, updatedAt: serverTimestamp() });
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, USERS_COLLECTION, uid));
  if (!snap.exists()) return null;
  // Document id LAST so it always wins. Every caller today writes with the
  // AUTH uid rather than this field, so nothing is currently redirected — but
  // `users` is the collection where identity decides access, and returning a
  // shadowable `id` is a trap for the next caller who reaches for it.
  return { ...snap.data(), id: snap.id };
}

/**
 * Live view of the signed-in user's OWN users/{uid} document, for "My profile"
 * and the sidebar profile card. `onData` receives the document (document id
 * last, so it always wins) or null when it does not exist.
 */
export function subscribeOwnProfile(uid, onData, onError) {
  return onSnapshot(
    doc(db, USERS_COLLECTION, uid),
    (snap) => onData(snap.exists() ? { ...snap.data(), id: snap.id } : null),
    (error) => {
      if (onError) onError(error);
    }
  );
}

/**
 * A user's own profile edit. Only SELF_EDITABLE_FIELDS (name, phone and their
 * legacy spellings) ever leave here — organization, employee ID, email, role
 * and status are an administrator's to change. firestore.rules enforces the
 * same allowlist on the user's own document.
 */
export async function updateUserProfile(uid, profileData) {
  const clean = {};
  for (const key of SELF_EDITABLE_FIELDS) {
    if (key in profileData) {
      clean[key] = profileData[key];
    }
  }
  if (Object.keys(clean).length === 0) {
    throw new Error("No editable fields provided.");
  }
  clean.updatedAt = serverTimestamp();
  return updateDoc(doc(db, USERS_COLLECTION, uid), clean);
}

/** A territory change that was refused, with every reason found. */
export class TerritoryAssignmentError extends Error {
  constructor(messages) {
    super(messages.join(" "));
    this.name = "TerritoryAssignmentError";
    this.messages = messages;
  }
}

/**
 * Admin: set a Med Rep's territory. Writes ONLY the territory fields — never
 * role or status — inside a transaction that re-reads the Med Rep and every
 * area and clinic involved, so the check and the write see the same data.
 * Duplicates are normalised away; inactive or missing areas, unverified or
 * missing clinics, and clinics outside a selected area are refused.
 * Firestore rules enforce the admin-only, Med-Rep-only boundary; order creation
 * re-checks the territory itself.
 */
export async function updateMedRepTerritory(uid, { areaIds, clinicIds }) {
  const adminUid = auth.currentUser?.uid;
  if (!adminUid) throw new TerritoryAssignmentError(["Your session has expired. Please sign in again."]);
  const userRef = doc(db, USERS_COLLECTION, uid);

  return runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists()) throw new TerritoryAssignmentError(["That account no longer exists."]);
    const user = userSnap.data();
    if (String(user.role || "").trim().toLowerCase() !== "salesrep") {
      throw new TerritoryAssignmentError(["Territory can only be assigned to a Med Rep."]);
    }

    const wantedAreas = [...new Set((areaIds || []).filter((id) => typeof id === "string" && id.trim()))];
    const wantedClinics = [...new Set((clinicIds || []).filter((id) => typeof id === "string" && id.trim()))];
    const areas = [];
    for (const id of wantedAreas) {
      const snap = await transaction.get(doc(db, "areas", id));
      if (snap.exists()) areas.push({ ...snap.data(), id: snap.id });
    }
    const clinics = [];
    for (const id of wantedClinics) {
      const snap = await transaction.get(doc(db, "clinics", id));
      if (snap.exists()) clinics.push({ ...snap.data(), id: snap.id });
    }

    const check = validateTerritoryAssignment({
      areaIds: wantedAreas,
      clinicIds: wantedClinics,
      areas,
      clinics,
      previous: user,
    });
    if (!check.ok) throw new TerritoryAssignmentError(check.errors);

    transaction.update(userRef, {
      assignedAreaIds: check.value.areaIds,
      assignedClinicIds: check.value.clinicIds,
      territoryUpdatedAt: serverTimestamp(),
      territoryUpdatedByUid: adminUid,
    });
    return check.value;
  });
}
