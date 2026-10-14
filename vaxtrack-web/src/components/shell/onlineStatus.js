// Whether the browser is connected, as an external store for
// useSyncExternalStore. Kept free of React so it can be tested with a fake
// window.
//
// Firestore keeps every open listener's last data while offline and resumes
// on its own when the connection returns — nothing on screen is cleared — so
// what the pages need is to SAY that the figures may be out of date. A
// browser's `navigator.onLine` is the signal for that; a listener that fails
// outright reports through its own error state instead.

/** Subscribes `onChange` to the window's online/offline events; returns the unsubscribe. */
export function subscribeOnlineStatus(win, onChange) {
  if (!win?.addEventListener) return () => {};
  win.addEventListener("online", onChange);
  win.addEventListener("offline", onChange);
  return () => {
    win.removeEventListener("online", onChange);
    win.removeEventListener("offline", onChange);
  };
}

/** True unless the browser says it is offline (unknown counts as online). */
export function readOnlineStatus(win) {
  return win?.navigator?.onLine !== false;
}

export const OFFLINE_MESSAGE =
  "You're offline. Showing the last data received — it may be out of date. It will update automatically when the connection returns.";
