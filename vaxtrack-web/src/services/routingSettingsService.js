import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { listenLive } from "./liveSnapshot.js";
import { logSafeError } from "./liveDataErrors.js";
import { UserMessageError } from "./userMessageError.js";
import {
  ROUTING_SETTINGS_COLLECTION,
  ROUTING_SETTINGS_DOC,
  validateRoutingSettings,
} from "./routingSettings.js";

/**
 * Firestore side of the routing settings (operationsSettings/routing).
 * Admin and Dispatcher may read it; only Admin writes (firestore.rules).
 */
const settingsRef = () => doc(db, ROUTING_SETTINGS_COLLECTION, ROUTING_SETTINGS_DOC);

/** Live settings document, or null when none has been saved yet. */
export function subscribeRoutingSettings(callback, onError) {
  return listenLive(
    settingsRef(),
    (snap) => callback(snap.exists() ? snap.data() : null),
    (err) => {
      logSafeError("Routing settings subscription", err);
      if (onError) onError(err);
    }
  );
}

/** Admin only. Validates first, so an invalid form never reaches the rules. */
export async function saveRoutingSettings(form) {
  const result = validateRoutingSettings(form);
  if (!result.ok) throw new UserMessageError("Check the highlighted routing settings.");
  const uid = auth.currentUser?.uid;
  if (!uid) throw new UserMessageError("Sign in again to save the routing settings.");
  await setDoc(settingsRef(), {
    ...result.value,
    updatedAt: serverTimestamp(),
    updatedByUid: uid,
  });
  return result.value;
}
