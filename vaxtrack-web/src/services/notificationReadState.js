// Which bell notifications a signed-in user has read. The shared copy lives in
// Firestore (notificationReadStates/{uid}, notificationReadStore.js) so it
// follows the user to any device; this browser keeps a cache for an instant,
// offline-safe first paint. Dispatcher clients may read shared operational
// alerts but Firestore rules do not let them edit those alerts; changing the
// shared `read` field would also affect Admin.

/** Ids kept per user: the most recent, so a long-lived account stays small. */
export const MAX_READ_IDS = 500;

export function capReadIds(ids) {
  return ids.length > MAX_READ_IDS ? ids.slice(-MAX_READ_IDS) : ids;
}

export function notificationReadKey(projectId, role, uid) {
  return `vaxtrack:${projectId}:notification-read:${role}:${uid}`;
}

export function loadReadIds(projectId, role, uid, storage) {
  if (!uid) return [];
  try {
    const store = storage ?? globalThis.localStorage;
    const value = JSON.parse(store.getItem(notificationReadKey(projectId, role, uid)) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveReadIds(projectId, role, uid, ids, storage) {
  if (!uid) return;
  try {
    const store = storage ?? globalThis.localStorage;
    store.setItem(notificationReadKey(projectId, role, uid), JSON.stringify(capReadIds(ids)));
  } catch {
    // Storage may be disabled; the in-memory read state still works this session.
  }
}

/** Union, newest last, capped. */
export function withReadIds(current, ids) {
  return capReadIds([...new Set([...current, ...ids])]);
}

/** Ids this device knows as read that the shared copy does not have yet. */
export function unsyncedReadIds(local, remote) {
  const known = new Set(remote);
  return local.filter((id) => !known.has(id));
}
