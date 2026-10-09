import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

const VACCINES = "vaccines";

/**
 * Live vaccine catalog (product-level data such as the VAT classification).
 * One listener for the whole catalog — readable by every approved user.
 * Document id LAST, so a stored `id` field can never shadow the real id that
 * inventory batches reference as `vaccineId`.
 */
export function subscribeVaccines(callback, onError) {
  return onSnapshot(
    collection(db, VACCINES),
    (snap) => callback(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
    (error) => {
      console.error("subscribeVaccines error:", error);
      if (onError) onError(error);
    }
  );
}
