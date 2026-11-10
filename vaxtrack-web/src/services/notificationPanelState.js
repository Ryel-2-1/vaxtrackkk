// Bell-panel preferences only. Never deletes or resolves the underlying alert.
export const MAX_DISMISSED_NOTIFICATIONS = 2000;

export function notificationPanelKey(projectId, role, uid) {
  return `vaxtrack:${projectId}:notification-panel:${role}:${uid}`;
}

export function cleanDismissedIds(ids) {
  return [...new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.length > 0) : [])]
    .slice(-MAX_DISMISSED_NOTIFICATIONS);
}

export function loadDismissedIds(projectId, role, uid, storage) {
  if (!uid) return [];
  try {
    const store = storage ?? globalThis.localStorage;
    return cleanDismissedIds(JSON.parse(store.getItem(notificationPanelKey(projectId, role, uid)) || "[]"));
  } catch { return []; }
}

export function saveDismissedIds(projectId, role, uid, ids, storage) {
  if (!uid) return;
  try {
    const store = storage ?? globalThis.localStorage;
    store.setItem(notificationPanelKey(projectId, role, uid), JSON.stringify(cleanDismissedIds(ids)));
  }
  catch { /* The in-memory panel still works when browser storage is unavailable. */ }
}

// Horizontal intent only; scrolling down the list must never reveal actions.
export function notificationSwipeAction(dx, dy) {
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "open" : "close";
}

export function dispatcherPanelKey(notification) {
  return `${notification.id}:${notification.atMs ?? 0}`;
}
