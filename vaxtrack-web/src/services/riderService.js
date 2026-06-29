import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";

export function subscribeRiders(callback, onError) {
  const q = query(collection(db, "users"), where("role", "==", "rider"));
  return onSnapshot(
    q,
    (snap) => {
      const riders = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      callback(riders);
    },
    (error) => {
      console.error("subscribeRiders error:", error);
      if (onError) onError(error);
    }
  );
}
