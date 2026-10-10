import { collection, doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { TRACKING_COLLECTIONS } from "./riderTracking";

// Read-only subscriptions to rider live tracking. Rules decide who may read:
//   riderLocations        — Admin/Dispatcher list + get; a Med Rep may GET one
//                           rider only while that rider carries an active order
//                           the Med Rep owns (server-maintained index).
//   riderDeviationStates  — Admin/Dispatcher only.
// Nothing here writes; the rider app and the server own every write.

function keyed(snap) {
  const out = {};
  for (const d of snap.docs) out[d.id] = { ...d.data(), id: d.id };
  return out;
}

/** Every rider's current location, keyed by rider uid (Admin / Dispatcher). */
export function subscribeAllRiderLocations(onData, onError) {
  return onSnapshot(
    collection(db, TRACKING_COLLECTIONS.LOCATIONS),
    (snap) => onData(keyed(snap)),
    (error) => onError?.(error),
  );
}

/** Every rider's server deviation state, keyed by rider uid (Admin / Dispatcher). */
export function subscribeAllDeviationStates(onData, onError) {
  return onSnapshot(
    collection(db, TRACKING_COLLECTIONS.DEVIATION_STATES),
    (snap) => onData(keyed(snap)),
    (error) => onError?.(error),
  );
}

/** One rider's current location (null when the rider has never reported). */
export function subscribeRiderLocation(riderUid, onData, onError) {
  return onSnapshot(
    doc(db, TRACKING_COLLECTIONS.LOCATIONS, riderUid),
    (snap) => onData(snap.exists() ? { ...snap.data(), id: snap.id } : null),
    (error) => onError?.(error),
  );
}

/** One rider's server deviation state (Admin / Dispatcher only). */
export function subscribeRiderDeviationState(riderUid, onData, onError) {
  return onSnapshot(
    doc(db, TRACKING_COLLECTIONS.DEVIATION_STATES, riderUid),
    (snap) => onData(snap.exists() ? { ...snap.data(), id: snap.id } : null),
    (error) => onError?.(error),
  );
}
