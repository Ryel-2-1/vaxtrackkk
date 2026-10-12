// What a page says when live data cannot be loaded or a write fails.
//
// One mapping for every page, so the same failure reads the same everywhere and
// raw Firebase text ("Missing or insufficient permissions.", "The query requires
// an index…", "Failed to get document because the client is offline.") never
// reaches the screen. The page names WHAT failed; this decides WHY.
//
// Three rules hold for every message this module returns:
//   1. No technical detail: no Firebase/Cloud Function text, function names,
//      collection paths, project ids, stack traces or HTTP status text.
//   2. A stable domain code (from a callable's `details.code` or one of the
//      app's own error classes) decides the message — never English prose.
//   3. A useful domain sentence the app or server wrote for the operator is
//      kept, not replaced with something generic.
//
// TRUST: an error's own text is shown only when the error is a
// UserMessageError (services/userMessageError.js) — the app's validation and
// domain errors and the callable wrappers' domain errors all are. A plain
// Error, a TypeError, a library error or a Firebase error is never trusted,
// however harmless its text looks; it gets the mapped message for its code or
// the page's fallback. The technical-content filter below is defence in
// depth on top of that decision, not the decision itself.

import { isUserMessageError } from "./userMessageError.js";

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
  // Firestore codes arrive bare; Auth, Storage and callable errors are prefixed.
  return raw.replace(/^(firestore|functions|auth|storage)\//, "");
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
  if (/^(firestore|functions|auth|storage)\//.test(raw)) return true;
  return FIREBASE_CODES.has(raw) && (error.name === undefined || error.name === "Error");
}

/**
 * The kind of a failed LOAD:
 *   "permission" | "signed-out" | "offline" | "index" | "not-found" |
 *   "rate-limited" | "generic"
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
  if (code === "resource-exhausted") return "rate-limited";
  return "generic";
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const CONTACT_ADMIN = "Contact an administrator if you believe this is incorrect.";

/**
 * The message for a failed LOAD of `what` ("orders", "the invoice", …).
 * Permission denied is never phrased as "nothing here": an empty list and a
 * refused read must not look alike.
 */
export function liveErrorMessage(error, what = "this data") {
  switch (liveErrorKind(error)) {
    case "permission":
      return `You do not have permission to view ${what}. ${CONTACT_ADMIN}`;
    case "signed-out":
      return "Your session has ended. Sign in again to continue.";
    case "offline":
      return `${capitalize(what)} could not be loaded because the server could not be reached. Check your connection and try again.`;
    case "index":
      return `${capitalize(what)} cannot be shown because a required database index is missing. Please contact an administrator.`;
    case "not-found":
      return `${capitalize(what)} no longer exists.`;
    case "rate-limited":
      return `${capitalize(what)} could not be loaded because there were too many requests. Wait a moment and try again.`;
    default:
      return `${capitalize(what)} could not be loaded. Please try again.`;
  }
}

// ----------------------------------------------------------------- writes

/**
 * Stable domain codes → the kind of failure. Codes come from the server's
 * PolicyError (functions/index.js forwards them as `details.code`) and from
 * the app's own error classes. Unknown codes fall back to the Firebase code.
 */
const DOMAIN_KINDS = Object.freeze({
  // who may act
  "unauthenticated": "signed-out",
  "profile-missing": "permission",
  "wrong-role": "permission",
  "not-approved": "permission",
  "not-assigned-rider": "permission",
  "not-order-owner": "permission",
  // the record is gone
  "order-not-found": "not-found",
  "invoice-not-found": "not-found",
  "inventory-not-found": "not-found",
  "clinic-not-found": "not-found",
  "vaccine-not-found": "not-found",
  "rider-not-found": "not-found",
  "user-not-found": "not-found",
  "return-not-found": "not-found",
  "destination-not-found": "not-found",
  "destination-request-not-found": "not-found",
  // the record moved underneath the caller
  "workflow-updated": "changed",
  "destination-changed": "changed",
  "destination-request-stale": "changed",
  "destination-request-changed": "changed",
  "invoice-destination-changed": "changed",
  "invoice-base-mismatch": "changed",
  "invoice-total-mismatch": "changed",
  // duplicates
  "batch-id-exists": "conflict",
  "idempotency-conflict": "conflict",
  "duplicate-inventory-line": "conflict",
  "history-integrity-conflict": "conflict",
  "destination-request-pending": "conflict",
  // assignment
  "order-already-assigned": "already-assigned",
  // lifecycle
  "invalid-status-transition": "transition",
  "reservation-already-settled": "transition",
  "return-already-resolved": "transition",
  "order-not-failed": "transition",
  "legacy-order-not-requeueable": "transition",
  // stock
  "insufficient-stock": "stock",
  "batch-expired": "stock",
  "batch-unavailable": "stock",
  "order-not-fully-reserved": "stock",
  "inventory-quantity-unconfirmed": "stock",
  // current price
  "price-changed": "price",
  "price-not-confirmed": "price",
  "batch-unpriced": "price",
  "batch-price-convention-legacy": "price",
  // pricing / VAT validation
  "invalid-agreed-price": "pricing",
  "negotiation-reason-required": "pricing",
  "adjustment-reason-required": "pricing",
  "invalid-statutory-discount": "pricing",
  "statutory-discount-type-required": "pricing",
  "statutory-discount-exceeds-line": "pricing",
  "discount-exceeds-subtotal": "pricing",
  "discount-recorded-per-line": "pricing",
  "order-snapshot-invalid": "pricing",
  "price-convention-required": "pricing",
  "vat-classification-required": "pricing",
  // SC/PWD eligibility attestation
  "eligibility-not-confirmed": "attestation",
  // clinic delivery geofence
  "delivery-outside-geofence": "geofence-outside",
  "rider-location-stale": "geofence-stale",
  "rider-location-inaccurate": "geofence-inaccurate",
  "rider-location-unavailable": "geofence-unavailable",
  "delivery-destination-invalid": "geofence-unavailable",
  // proof
  "proof-missing": "proof",
  "invoice-missing": "proof",
  "evidence-not-yours": "proof",
  // invoices
  "invoice-already-issued": "invoice-issued",
  // the service could not be reached (callable wrappers)
  "service-unavailable": "offline",
});

const FIREBASE_KINDS = Object.freeze({
  "permission-denied": "permission",
  "unauthenticated": "signed-out",
  "unavailable": "offline",
  "network-request-failed": "offline",
  "deadline-exceeded": "timeout",
  "not-found": "not-found",
  "already-exists": "conflict",
  "aborted": "changed",
  "resource-exhausted": "rate-limited",
  "too-many-requests": "rate-limited",
  // Storage
  "unauthorized": "permission",
  "retry-limit-exceeded": "proof",
  "canceled": "proof",
  "object-not-found": "not-found",
});

/**
 * The kind of any failure, for writes and actions:
 *   "permission" | "signed-out" | "offline" | "timeout" | "index" |
 *   "not-found" | "changed" | "conflict" | "already-assigned" | "transition" |
 *   "stock" | "price" | "pricing" | "attestation" | "geofence-outside" |
 *   "geofence-stale" | "geofence-inaccurate" | "geofence-unavailable" |
 *   "proof" | "invoice-issued" | "rate-limited" | "generic"
 * Decided by code — never by reading the message.
 */
export function errorKind(error) {
  if (!error) return "generic";
  const code = codeOf(error);
  if (DOMAIN_KINDS[code]) return DOMAIN_KINDS[code];
  if (code === "failed-precondition" && isFirebaseError(error) && /index/i.test(String(error?.message || ""))) {
    return "index";
  }
  return FIREBASE_KINDS[code] ?? "generic";
}

/** The kinds after which the outcome of a write is NOT known. */
export function isOutcomeUnknown(error) {
  return errorKind(error) === "timeout";
}

const KIND_MESSAGES = Object.freeze({
  "permission": `You do not have permission to perform this action. ${CONTACT_ADMIN}`,
  "signed-out": "Your session has ended. Sign in again to continue.",
  "offline": "We couldn't reach the server, so nothing was saved. Check your connection and try again.",
  "timeout":
    "The server took too long to respond, so we can't confirm whether this was saved. Check the latest data before trying again.",
  "index": "This action needs a database index that isn't set up yet. Contact an administrator.",
  "not-found": "This record no longer exists. The page shows the latest data.",
  "changed": "This record was changed by someone else. Nothing was saved — review the latest version and try again.",
  "conflict": "This would create a duplicate record. Nothing was saved.",
  "already-assigned": "This order has already been assigned. The page shows the current assignment.",
  "transition": "This action is no longer available for the record's current status. The page shows the latest status.",
  "stock": "There isn't enough stock available for this request. Nothing was saved — adjust the quantity and try again.",
  "price": "A price changed while you were working. Nothing was saved — review the current price and confirm again.",
  "pricing": "One of the prices or discounts isn't valid. Nothing was saved — correct it and try again.",
  "attestation": "Confirm that you verified the customer’s eligibility for each SC/PWD discount. Nothing was placed.",
  "geofence-outside": "The rider isn't within the clinic's delivery area yet. Nothing was recorded — try again at the destination.",
  "geofence-stale": "The rider's location is out of date. Nothing was recorded — wait for a fresh location and try again.",
  "geofence-inaccurate": "The rider's location isn't accurate enough yet. Nothing was recorded — wait for a better GPS fix and try again.",
  "geofence-unavailable": "The delivery location couldn't be checked. Nothing was recorded — try again shortly.",
  "proof": "The proof of delivery couldn't be saved. Nothing was recorded — try again.",
  "invoice-issued": "This invoice has already been issued and can no longer be changed.",
  "rate-limited": "Too many requests right now. Wait a moment and try again.",
});

export const GENERIC_FAILURE_MESSAGE = "We couldn't complete this action. Please try again.";

/**
 * Text that looks technical and must never be shown: Firebase/Google wording,
 * resource paths, URLs, stack frames, HTTP status text, programmer
 * identifiers (camelCase, snake_case) and JavaScript runtime phrasing.
 */
const TECHNICAL_PATTERNS = [
  /firebase|firestore|googleapis|gstatic|cloud function|callable/i,
  /\bprojects\/|\bdatabases\/|\(default\)|\bdocuments\//i,
  /https?:\/\//i,
  /\n\s*at\s|\bat\s+[\w.$<>]+\s*\(|\.(?:js|jsx|mjs|ts):\d+/,
  /\b(?:HTTP|status)\s*\(?\s*[1-5]\d\d\b/i,
  /\b(?:INTERNAL|PERMISSION_DENIED|FAILED_PRECONDITION|UNAVAILABLE|UNAUTHENTICATED|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|INVALID_ARGUMENT)\b/,
  /missing or insufficient permissions|requires an index|client is offline/i,
  /cannot read propert|is not a function|is not defined|unexpected token|undefined|\bNaN\b|\[object /i,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/, // camelCase identifiers: createOrderWithReservation, orderId
  /\b[a-z0-9]+_[a-z0-9_]+\b/, // snake_case identifiers: pending_dispatch, invoice_2026
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, // constants: MISSING_KEY
  /\(\s*[1-5]\d\d\s*\)/, // a bare status code: "service error (404)"
  /\b(?:\w+)?Error:/, // "TypeError:", "FirebaseError:", "Error:"
];

/** True when `text` is a sentence fit to show a user. */
export function isSafeUserMessage(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 500) return false;
  return !TECHNICAL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Only an explicit UserMessageError carries a sentence written for the user.
 * Decided by type — never by inspecting the text.
 */
export function isTrustedAppError(error) {
  return isUserMessageError(error);
}

/**
 * The message for a failed WRITE or action.
 *
 * Order of preference:
 *   1. a UserMessageError's own sentence (which must also pass the
 *      technical-content check);
 *   2. the mapped message for a recognized stable code (permission, offline,
 *      stock, …);
 *   3. `fallback`, which names what failed ("The order could not be saved.").
 * A plain Error's, Firebase's, the browser's and JavaScript's own text never
 * surface.
 */
export function friendlyErrorMessage(error, fallback = GENERIC_FAILURE_MESSAGE) {
  if (!error) return fallback;
  if (isTrustedAppError(error) && isSafeUserMessage(error.message)) return error.message.trim();
  const kind = errorKind(error);
  return KIND_MESSAGES[kind] ?? fallback;
}

/** Just the mapped message for a kind — for pages that branch on errorKind. */
export function messageForKind(kind, fallback = GENERIC_FAILURE_MESSAGE) {
  return KIND_MESSAGES[kind] ?? fallback;
}

// ----------------------------------------------------------------- logging

/**
 * The only context a page logs about a failure: where it happened, the
 * error's class and its code. Never the message (it can carry an email, a
 * proof URL or a document value), never the payload, never the stack.
 */
export function safeErrorContext(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const name = typeof error?.name === "string" ? error.name : typeof error;
  return { code, type: name };
}

export function logSafeError(context, error) {
  console.error(`[VaxTrack] ${context}`, safeErrorContext(error));
}

// ----------------------------------------------------------------- page states

/**
 * The state a live list is in. Loading, a genuinely empty result and each
 * kind of failure are distinct, so "No records found" is shown only when the
 * query actually succeeded with nothing in it.
 *
 *   "loading" | "permission" | "signed-out" | "offline" | "index" |
 *   "not-found" | "rate-limited" | "error" | "empty" | "ready"
 */
export function loadStateOf({ loading = false, error = null, isEmpty = false } = {}) {
  if (error) {
    const kind = typeof error === "string" ? error : liveErrorKind(error);
    return kind === "generic" ? "error" : kind;
  }
  if (loading) return "loading";
  return isEmpty ? "empty" : "ready";
}

/** A KPI figure: a dash while loading or after a failed load — never a false zero. */
export function kpiValue(value, { loading = false, error = null } = {}) {
  if (loading || error) return "—";
  return value;
}
