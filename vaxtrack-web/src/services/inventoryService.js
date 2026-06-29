import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

const INVENTORY_COLLECTION = "inventory";

export function subscribeInventory(callback) {
  return onSnapshot(collection(db, INVENTORY_COLLECTION), (snapshot) => {
    const batches = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() ?? 0;
        const bTime = b.createdAt?.toMillis?.() ?? 0;
        return bTime - aTime;
      });
    callback(batches);
  });
}
