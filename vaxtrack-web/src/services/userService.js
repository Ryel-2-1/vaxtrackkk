import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";

const USERS_COLLECTION = "users";

const VALID_STATUSES = ["approved", "pending", "pending_approval", "rejected", "disabled"];
const VALID_ROLES = ["admin", "dispatcher", "salesrep", "rider"];

export function subscribeUsers(callback) {
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
  });
}

export async function updateUserStatus(uid, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return updateDoc(doc(db, USERS_COLLECTION, uid), { status, updatedAt: serverTimestamp() });
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

const PROFILE_EDITABLE_FIELDS = ["name", "phone", "contactNumber", "organization", "company", "clinic"];

export async function updateUserProfile(uid, profileData) {
  const clean = {};
  for (const key of PROFILE_EDITABLE_FIELDS) {
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
