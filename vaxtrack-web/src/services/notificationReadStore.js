import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { capReadIds } from "./notificationReadState.js";
import { listenLive } from "./liveSnapshot.js";
import { logSafeError } from "./liveDataErrors.js";

/**
 * notificationReadStates/{uid} — which bell notifications this user has read,
 * so read state follows them to any device. Private to its owner
 * (firestore.rules); at most MAX_READ_IDS of the most recent ids.
 */
const readStateRef = (uid) => doc(db, "notificationReadStates", uid);

export function subscribeReadIds(uid, onIds, onError) {
  return listenLive(
    readStateRef(uid),
    (snap) => {
      const ids = snap.exists() ? snap.data().ids : [];
      onIds(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    },
    (error) => {
      logSafeError("subscribeReadIds", error);
      onError?.(error);
    }
  );
}

export function saveReadIdsRemote(uid, ids) {
  return setDoc(readStateRef(uid), { ids: capReadIds(ids), updatedAt: serverTimestamp() });
}
