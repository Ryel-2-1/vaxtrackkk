// The three role guards (AdminRoute, DispatcherRoute, SalesRepRoute), as
// wiring that can be tested without React or Firebase.
//
// The guard used to read users/{uid} ONCE when the session started. A role or
// status change made by an administrator — a dispatcher disabled, a rep moved
// to another role — therefore did not take effect until the browser was
// refreshed, and the pages kept their listeners open under a profile the rules
// no longer accepted. The profile is now watched: every snapshot is put through
// the SAME resolver (services/authorization.js), so a change applies at once —
// the guard redirects, the role's shell unmounts, and every page listener under
// it unsubscribes with it.
//
// Identity stays the AUTH uid; nothing inside the document can redirect the
// lookup. The decision is unchanged — only how often it is asked.

import { LOGIN_PATH, resolveAccess } from "./authorization.js";

export const ACCESS_LOADING = Object.freeze({ state: "loading", redirectTo: LOGIN_PATH });

// Failures that only mean "not reachable right now". An open session is kept
// through them — the cached profile already decided — rather than signed out
// of the area by a dropped connection.
const TRANSIENT = new Set(["unavailable", "deadline-exceeded", "network-request-failed"]);

/** The guard's state for one profile snapshot (null when the document is absent). */
export function accessFromProfile(profile, requiredRole) {
  const decision = resolveAccess({ profile, requiredRole });
  return decision.allowed
    ? { state: "allowed", redirectTo: LOGIN_PATH }
    : { state: "redirect", redirectTo: decision.redirectTo };
}

/** The guard's state when the profile listener fails. Fails closed except for a transient drop. */
export function accessAfterProfileError(current, error) {
  const code = typeof error?.code === "string" ? error.code.replace(/^firestore\//, "") : "";
  if (current?.state === "allowed" && TRANSIENT.has(code)) return current;
  return { state: "redirect", redirectTo: LOGIN_PATH };
}

/**
 * Watches the auth session and, while signed in, the user's own profile.
 *
 *   subscribeAuth(cb) → unsubscribe                       (onAuthStateChanged)
 *   subscribeProfile(uid, onProfile, onError) → unsubscribe (onSnapshot users/{uid})
 *   onChange({ state, redirectTo })
 *
 * At most one profile listener is open at a time: it is closed on sign-out,
 * on a change of signed-in user, and by the returned cleanup.
 */
export function watchRouteAccess({ subscribeAuth, subscribeProfile, requiredRole, onChange }) {
  let current = ACCESS_LOADING;
  let profileUid = null;
  let stopProfile = null;

  const set = (next) => {
    current = next;
    onChange(next);
  };
  const closeProfile = () => {
    if (stopProfile) stopProfile();
    stopProfile = null;
    profileUid = null;
  };

  const stopAuth = subscribeAuth((user) => {
    if (!user) {
      closeProfile();
      set({ state: "redirect", redirectTo: LOGIN_PATH });
      return;
    }
    if (user.uid === profileUid && stopProfile) return;
    closeProfile();
    // A different account: nothing decided for the previous one may show.
    if (current.state !== "loading") set(ACCESS_LOADING);
    profileUid = user.uid;
    stopProfile = subscribeProfile(
      user.uid,
      (profile) => set(accessFromProfile(profile, requiredRole)),
      (error) => set(accessAfterProfileError(current, error))
    );
  });

  return () => {
    closeProfile();
    stopAuth();
  };
}
