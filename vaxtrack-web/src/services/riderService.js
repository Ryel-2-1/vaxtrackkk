import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { db } from "../firebase";

const VALID_STATUSES = ["approved", "pending", "disabled", "rejected"];

export function subscribeRiders(callback, onError) {
  // Subscribe to the whole users collection and filter client-side with
  // normalization. A server-side where("role", "==", "rider") is exact-match
  // and silently misses docs whose role has case/whitespace variants
  // (e.g. "Rider"), which the Flutter app accepts because it normalizes
  // on read. Normalizing here keeps web and mobile consistent.
  return onSnapshot(
    collection(db, "users"),
    (snap) => {
      const getName = (r) =>
        r.fullName || r.name || r.displayName || r.email || r.id;
      const riders = snap.docs
        .map((d) => ({ uid: d.id, ...d.data() }))
        .filter((r) => (r.role || "").trim().toLowerCase() === "rider")
        .sort((a, b) => getName(a).localeCompare(getName(b)));
      callback(riders);
    },
    (error) => {
      console.error("subscribeRiders error:", error);
      if (onError) onError(error);
    }
  );
}

export async function updateRiderStatus(uid, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid rider status: ${status}`);
  }
  return updateDoc(doc(db, "users", uid), { status });
}
