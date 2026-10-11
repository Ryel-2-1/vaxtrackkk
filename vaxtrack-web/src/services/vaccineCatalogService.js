import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
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

/**
 * LIVE view of just the named vaccine products — the ones a Med Rep's cart
 * holds — for the final price review (full SKU and current VAT class). Same
 * grouping rule as subscribeInventoryBatches: document-id `in` queries of at
 * most 30, one callback once every group has reported, one error report.
 */
export function subscribeVaccinesByIds(ids, callback, onError) {
  const unique = [...new Set((ids || []).filter((id) => typeof id === "string" && id))];
  const groups = [];
  for (let i = 0; i < unique.length; i += 30) groups.push(unique.slice(i, i + 30));
  const results = new Array(groups.length).fill(null);
  let failed = false;
  const stops = groups.map((group, index) =>
    onSnapshot(
      query(collection(db, VACCINES), where(documentId(), "in", group)),
      (snap) => {
        results[index] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        if (!failed && results.every(Boolean)) callback(results.flat());
      },
      (error) => {
        console.error("subscribeVaccinesByIds error:", error?.code || error);
        if (failed) return;
        failed = true;
        if (onError) onError(error);
      }
    )
  );
  return () => stops.forEach((stop) => stop());
}
