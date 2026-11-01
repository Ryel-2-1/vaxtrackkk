// Read state is private to a signed-in user and this browser. Dispatcher clients
// may read shared operational alerts but Firestore rules do not let them edit
// those alerts; changing the shared `read` field would also affect Admin.
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
    store.setItem(notificationReadKey(projectId, role, uid), JSON.stringify(ids));
  } catch {
    // Storage may be disabled; the in-memory read state still works this session.
  }
}

export function withReadIds(current, ids) {
  return [...new Set([...current, ...ids])];
}
