import { collection, onSnapshot } from "firebase/firestore";
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
