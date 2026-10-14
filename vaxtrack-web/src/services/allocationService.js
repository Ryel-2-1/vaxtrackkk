import { collection, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { logSafeError } from "./liveDataErrors.js";
import { listenLive } from "./liveSnapshot.js";

/**
 * Read-only views of the allocation workflow (Admin).
 *
 * Every figure shown comes from server-written documents; nothing here writes.
 * Changes go through the trusted callables in inventoryCallables.js.
 */

const WAITING_STATES = ["awaiting_stock", "partially_reserved"];

/**
 * Future orders still waiting for stock, in the SAME order the server
 * allocates them: `allocationPriorityKey` encodes Urgent first, then the
 * earliest requested date/time, then creation time, then document id.
 * Uses the (allocationOpen, allocationState, allocationPriorityKey) index.
 */
export function subscribeBackorderQueue(callback, onError) {
  const q = query(
    collection(db, "orders"),
    where("allocationOpen", "==", true),
    where("allocationState", "in", WAITING_STATES),
    orderBy("allocationPriorityKey", "asc")
  );
  return listenLive(
    q,
    (snapshot) => callback(snapshot.docs.map((d) => ({ ...d.data(), id: d.id }))),
    (err) => {
      logSafeError("Backorder queue subscription", err);
      if (onError) onError(err);
    }
  );
}

/**
 * Stock returned by failed deliveries and still awaiting an Admin decision,
 * oldest first. These units are neither reserved nor available.
 */
export function subscribePendingReturns(callback, onError) {
  const q = query(
    collection(db, "inventoryReturns"),
    where("status", "==", "pending"),
    orderBy("reportedAt", "asc")
  );
  return listenLive(
    q,
    (snapshot) => callback(snapshot.docs.map((d) => ({ ...d.data(), id: d.id }))),
    (err) => {
      logSafeError("Pending returns subscription", err);
      if (onError) onError(err);
    }
  );
}
