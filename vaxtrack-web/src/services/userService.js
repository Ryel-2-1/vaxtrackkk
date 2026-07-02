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
      .map((d) => ({ id: d.id, ...d.data() }))
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
  return { id: snap.id, ...snap.data() };
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
