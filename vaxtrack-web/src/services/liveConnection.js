// Keeping live listeners alive — the pure part (no Firebase, no DOM).
//
// Firestore already copes with a dropped connection on its own: an open
// listener keeps its last data while offline and resumes when the network
// returns (the shell's offline notice says so). What it does NOT do is come
// back after the listener itself FAILS: an error closes it for good, and
// without help the page would stay frozen until someone refreshes the browser.
//
// createRecoveringListener() wraps one listener so that:
//   - a TRANSIENT failure (server unavailable, internal, rate-limited,
//     timeout) re-opens it after a short backoff, up to RETRY_DELAYS_MS.length
//     times, WITHOUT reporting an error — the page keeps showing its last data
//     while the shell says "Reconnecting…";
//   - a failure that will not fix itself (permission, signed out, missing
//     index, not found), or one that outlasts the retries, is reported to the
//     page's own error callback exactly as before, and registered so the
//     shell's "Try again" can re-open it;
//   - every re-open first closes the previous listener, so there is never more
//     than one; closing the wrapper cancels any pending retry.
//
// The registry is a tiny external store the shell reads with
// useSyncExternalStore.

import { errorKind } from "./liveDataErrors.js";

/** Backoff before each automatic re-open, in ms. Not polling: only after a failure. */
export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000]);

const PERMANENT_KINDS = new Set(["permission", "signed-out", "index", "not-found"]);

/** Will re-opening this listener plausibly work without anyone changing anything? */
export function isTransientListenerError(error) {
  return !PERMANENT_KINDS.has(errorKind(error));
}

/** A registry of listeners that are reconnecting or have failed. */
export function createConnectionRegistry() {
  const reconnecting = new Set();
  const failed = new Map(); // token -> { retry, retryable }
  const watchers = new Set();
  let snapshot = { reconnecting: 0, failed: 0, retryable: 0 };

  const publish = () => {
    let retryable = 0;
    for (const f of failed.values()) if (f.retryable) retryable += 1;
    snapshot = { reconnecting: reconnecting.size, failed: failed.size, retryable };
    for (const w of watchers) w();
  };

  return {
    markReconnecting(token) {
      failed.delete(token);
      reconnecting.add(token);
      publish();
    },
    markFailed(token, retry, retryable) {
      reconnecting.delete(token);
      failed.set(token, { retry, retryable });
      publish();
    },
    clear(token) {
      const had = reconnecting.delete(token) | failed.delete(token);
      if (had) publish();
    },
    /** Re-open every failed listener once. Returns how many were re-opened. */
    retryFailed() {
      const entries = [...failed.values()];
      failed.clear();
      publish();
      for (const f of entries) f.retry();
      return entries.length;
    },
    getSnapshot: () => snapshot,
    subscribe(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
  };
}

/** The app's one registry, read by the shell notice. */
export const liveConnection = createConnectionRegistry();

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  // Never keep a test runner (or a closing tab) alive for a pending retry.
  if (t && typeof t.unref === "function") t.unref();
  return t;
};

/**
 * Wrap one listener. `attach(onNext, onError)` opens it and returns its
 * unsubscribe (e.g. `(n, e) => onSnapshot(ref, n, e)`). Returns this wrapper's
 * unsubscribe.
 */
export function createRecoveringListener({
  attach,
  onNext,
  onError,
  registry = liveConnection,
  schedule = defaultSchedule,
  cancel = clearTimeout,
  delays = RETRY_DELAYS_MS,
}) {
  const token = {};
  let unsubscribe = null;
  let timer = null;
  let attempt = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    let failedHere = false;
    const stop = attach(
      (snapshot) => {
        if (closed) return;
        attempt = 0;
        registry.clear(token);
        onNext(snapshot);
      },
      (error) => {
        if (closed) return;
        failedHere = true;
        unsubscribe = null; // a failed listener is already closed
        if (isTransientListenerError(error) && attempt < delays.length) {
          const wait = delays[attempt];
          attempt += 1;
          registry.markReconnecting(token);
          timer = schedule(() => {
            timer = null;
            open();
          }, wait);
          return;
        }
        registry.markFailed(
          token,
          () => {
            attempt = 0;
            open();
          },
          isTransientListenerError(error)
        );
        if (onError) onError(error);
      }
    );
    // attach() may report a failure synchronously; only keep a live handle.
    unsubscribe = failedHere ? null : stop;
  };

  open();

  return () => {
    closed = true;
    if (timer !== null) cancel(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    registry.clear(token);
  };
}

export const RECONNECTING_MESSAGE =
  "Reconnecting to live updates… The page shows the last data received.";
export const LIVE_FAILED_MESSAGE =
  "Live updates stopped for part of this page. The figures shown may be out of date.";
