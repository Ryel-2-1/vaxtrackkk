import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";

/**
 * Live status history for one order: `orders/{orderId}/statusEvents`, oldest
 * first. Written only by the server's recordOrderStatusEvent trigger; clients
 * can read it (as far as they can read the order) and never write it.
 */
export function subscribeOrderStatusEvents(orderId, callback, onError) {
  return onSnapshot(
    query(collection(db, "orders", orderId, "statusEvents"), orderBy("at", "asc")),
    (snap) => callback(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
    (error) => {
      console.error("subscribeOrderStatusEvents error:", error?.code ?? error);
      if (onError) onError(error);
    }
  );
}
