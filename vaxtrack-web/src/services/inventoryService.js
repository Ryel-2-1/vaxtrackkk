import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";

const INVENTORY_COLLECTION = "inventory";

export function subscribeInventory(callback, onError) {
  return onSnapshot(
    collection(db, INVENTORY_COLLECTION),
    (snapshot) => {
      const batches = snapshot.docs
        // Document id LAST so it always wins.
        //
        // This used to be `{ id: d.id, ...d.data() }`, which let a stored field
        // named `id` silently replace the real document id — and that id is now
        // the authoritative allocation identity carried all the way into the
        // reservation. The same ordering was already corrected in
        // orderService.getOrderById and vaccineService.getVaccines; inventory
        // was missed. The server re-derives the id from the snapshot anyway, so
        // this is the client half of a guarantee that holds on both sides.
        .map((d) => ({ ...d.data(), id: d.id }))
        .sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() ?? 0;
          const bTime = b.createdAt?.toMillis?.() ?? 0;
          return bTime - aTime;
        });
      callback(batches);
    },
    (err) => {
      console.error("Inventory subscription error:", err);
      if (onError) onError(err);
    }
  );
}

// Firestore's limit on the values of one `in` filter.
export const BATCH_IN_LIMIT = 30;

/**
 * LIVE view of just the named inventory batches — a Med Rep's cart, not the
 * whole collection. Ids are de-duplicated and queried by document id in
 * groups of BATCH_IN_LIMIT; `callback(batches)` fires once every group has
 * reported, and again on any change. A batch that no longer exists is simply
 * absent. One failing group reports through `onError` once.
 * Returns a single unsubscribe for every group.
 */
export function subscribeInventoryBatches(ids, callback, onError) {
  const unique = [...new Set((ids || []).filter((id) => typeof id === "string" && id))];
  const groups = [];
  for (let i = 0; i < unique.length; i += BATCH_IN_LIMIT) groups.push(unique.slice(i, i + BATCH_IN_LIMIT));
  const results = new Array(groups.length).fill(null);
  let failed = false;
  const unsubscribes = groups.map((group, index) =>
    onSnapshot(
      query(collection(db, INVENTORY_COLLECTION), where(documentId(), "in", group)),
      (snapshot) => {
        // Document id LAST so it always wins (see subscribeInventory).
        results[index] = snapshot.docs.map((d) => ({ ...d.data(), id: d.id }));
        if (!failed && results.every(Boolean)) callback(results.flat());
      },
      (err) => {
        console.error("Inventory batch subscription error:", err?.code || err);
        if (failed) return;
        failed = true;
        if (onError) onError(err);
      }
    )
  );
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}
