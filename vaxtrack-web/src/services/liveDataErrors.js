// What a page says when live data cannot be loaded or a write fails.
//
// One mapping for every page, so the same failure reads the same everywhere and
// raw Firebase text ("Missing or insufficient permissions.", "The query requires
// an index…", "Failed to get document because the client is offline.") never
// reaches the screen. The page names WHAT failed; this decides WHY.

const FIREBASE_CODES = new Set([
  "cancelled",
  "unknown",
  "invalid-argument",
  "deadline-exceeded",
  "not-found",
  "already-exists",
  "permission-denied",
  "resource-exhausted",
  "failed-precondition",
  "aborted",
  "out-of-range",
  "unimplemented",
  "internal",
  "unavailable",
  "data-loss",
  "unauthenticated",
  "network-request-failed",
]);

const OFFLINE_CODES = new Set(["unavailable", "deadline-exceeded", "network-request-failed"]);

function codeOf(error) {
  const raw = typeof error?.code === "string" ? error.code : "";
  // Firestore codes arrive bare; Auth and callable errors are prefixed.
  return raw.replace(/^(firestore|functions|auth)\//, "");
}

/**
 * True when the error came from Firebase rather than from this app's own code.
 * The app's domain errors (AssignmentError, InventoryCallableError,
 * WorkflowError, …) carry their own class name and an operator-ready message,
 * even when their code happens to share a word with Firebase's.
 */
export function isFirebaseError(error) {
  if (!error) return false;
  if (error.name === "FirebaseError") return true;
  const raw = typeof error.code === "string" ? error.code : "";
  if (/^(firestore|functions|auth)\//.test(raw)) return true;
  return FIREBASE_CODES.has(raw) && (error.name === undefined || error.name === "Error");
}

/**
 * The kind of failure:
 *   "permission" | "signed-out" | "offline" | "index" | "not-found" | "generic"
 * A missing index arrives as failed-precondition whose text mentions the
 * index; any other failed-precondition is a generic failure.
 */
export function liveErrorKind(error) {
  const code = codeOf(error);
  if (code === "permission-denied") return "permission";
  if (code === "unauthenticated") return "signed-out";
  if (OFFLINE_CODES.has(code)) return "offline";
  if (code === "failed-precondition" && /index/i.test(String(error?.message || ""))) return "index";
  if (code === "not-found") return "not-found";
  return "generic";
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * The message for a failed LOAD of `what` ("orders", "the invoice", …).
 * Permission denied is never phrased as "nothing here": an empty list and a
 * refused read must not look alike.
 */
export function liveErrorMessage(error, what = "this data") {
  switch (liveErrorKind(error)) {
    case "permission":
      return `You do not have permission to view ${what}.`;
    case "signed-out":
      return "Your session has ended. Sign in again to continue.";
    case "offline":
      return `${capitalize(what)} could not be loaded because the server could not be reached. Check your connection and try again.`;
    case "index":
      return `${capitalize(what)} cannot be shown because a required database index is missing. Please contact an administrator.`;
    case "not-found":
      return `${capitalize(what)} no longer exists.`;
    default:
      return `${capitalize(what)} could not be loaded. Please try again.`;
  }
}

/**
 * The message for a failed WRITE. Messages this app wrote for the operator
 * (validation errors thrown by the services) are kept; anything Firebase said
 * is replaced with `fallback` or a mapped explanation.
 */
export function friendlyErrorMessage(error, fallback = "Something went wrong. Please try again.") {
  if (!error) return fallback;
  if (!isFirebaseError(error)) {
    return typeof error.message === "string" && error.message.trim() ? error.message : fallback;
  }
  switch (liveErrorKind(error)) {
    case "permission":
      return "You do not have permission to make this change.";
    case "signed-out":
      return "Your session has ended. Sign in again to continue.";
    case "offline":
      return "Could not reach the server. Check your connection and try again.";
    case "not-found":
      return "This record no longer exists. The page shows the latest data.";
    default:
      return fallback;
  }
}
