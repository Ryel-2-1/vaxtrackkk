import {
  collection,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const VALID_STATUSES = ["approved", "pending", "disabled", "rejected"];

export function subscribeRiders(callback, onError) {
  // Production hardening (2026-07-24): server-filter to role == "rider" so
  // Firestore rules can restrict `users` reads instead of shipping the whole
  // collection to the client.
  //
  // This is exact-match, so in principle it would miss a rider doc whose role
  // has a case/whitespace variant (e.g. "Rider"). A live audit of all 13 user
  // docs confirmed ZERO such variants — every rider is exactly "rider" — so
  // this returns the identical list the old client-side normalization did.
  // The client-side normalization filter below is kept as a harmless defensive
  // layer; if a future dirty rider doc ever appears, fix it at the source (the
  // exact-match query won't return it for the client filter to recover).
  const ridersQuery = query(
    collection(db, "users"),
    where("role", "==", "rider")
  );
  return onSnapshot(
    ridersQuery,
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
