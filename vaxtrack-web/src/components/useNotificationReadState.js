import { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../firebase";
import {
  loadReadIds,
  saveReadIds,
  unsyncedReadIds,
  withReadIds,
} from "../services/notificationReadState";
import { saveReadIdsRemote, subscribeReadIds } from "../services/notificationReadStore";
import { logSafeError } from "../services/liveDataErrors";

/** Read marks settle this long before they are written to Firestore. */
const SYNC_DELAY_MS = 600;

/**
 * The bell's read state for the signed-in user, synced across devices.
 *
 * Starts from this browser's cache (instant, offline-safe), merges the shared
 * copy in Firestore as it arrives, and writes back only ids the shared copy
 * lacks — so two devices converge on the union and an idle bell never writes.
 * Returns [readIds, markRead(ids)].
 */
export default function useNotificationReadState(role) {
  const uid = auth.currentUser?.uid ?? null;
  const projectId = auth.app.options.projectId;
  const [readIds, setReadIds] = useState(() => loadReadIds(projectId, role, uid));
  // The shared copy as last seen; null until Firestore has answered.
  const remoteRef = useRef(null);

  useEffect(() => {
    if (!uid) return undefined;
    return subscribeReadIds(
      uid,
      (ids) => {
        remoteRef.current = ids;
        setReadIds((current) => withReadIds(current, ids));
      },
      () => { remoteRef.current = null; }
    );
  }, [uid]);

  useEffect(() => {
    if (!uid) return undefined;
    saveReadIds(projectId, role, uid, readIds);
    const remote = remoteRef.current;
    if (remote === null || unsyncedReadIds(readIds, remote).length === 0) return undefined;
    const timer = setTimeout(() => {
      saveReadIdsRemote(uid, readIds).catch((error) => logSafeError("saveReadIdsRemote", error));
    }, SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [projectId, role, uid, readIds]);

  const markRead = useCallback((ids) => setReadIds((current) => withReadIds(current, ids)), []);
  return [readIds, markRead];
}
