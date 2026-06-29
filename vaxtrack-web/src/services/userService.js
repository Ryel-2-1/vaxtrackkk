import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";

const USERS_COLLECTION = "users";

const VALID_STATUSES = ["approved", "pending", "pending_approval", "rejected", "disabled"];

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
  return updateDoc(doc(db, USERS_COLLECTION, uid), { status });
}
