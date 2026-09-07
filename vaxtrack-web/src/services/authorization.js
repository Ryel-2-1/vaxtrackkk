/**
 * Who may enter which part of the web app.
 *
 * Pure and dependency-free: no Firebase, no React, no router. The three route
 * guards and the login redirect all call `resolveAccess`, so there is ONE
 * implementation of the decision instead of four near-copies that drift.
 *
 * FAIL CLOSED. Every unrecognised value — a missing status, an unknown role, a
 * typo, a status a future migration introduces — denies. The previous guards
 * read `(data.status || "approved")`, which meant a user document with NO
 * status field was treated as approved; production already contains such an
 * account (`role: "admin"` with no status). That default is gone: an
 * unrecognised status is a reason to stop, never a reason to proceed.
 *
 * Identity is `users/{auth.uid}` and nothing else. Employee id, name, email and
 * any `uid` or `id` field stored INSIDE the document are deliberately not
 * consulted here — the caller passes the profile it read at the auth uid.
 */

/** The only roles that exist. Anything else is unknown and denies. */
export const ROLES = Object.freeze({
  ADMIN: "admin",
  DISPATCHER: "dispatcher",
  SALES_REP: "salesrep",
  RIDER: "rider",
});

/** The only statuses that exist. Anything else — including absent — denies. */
export const STATUSES = Object.freeze({
  APPROVED: "approved",
  PENDING: "pending",
  PENDING_APPROVAL: "pending_approval",
  REJECTED: "rejected",
  DISABLED: "disabled",
});

/**
 * Historical spellings of the sales-rep role that exist in real documents.
 *
 * An alias list, not a fuzzy match: each entry is a spelling someone actually
 * wrote. A role this does not recognise is unknown, not "probably a sales rep".
 */
const SALES_REP_ALIASES = Object.freeze([
  "salesrep",
  "sales_rep",
  "sales-rep",
  "sales representative",
]);

/** Where each role's application lives. Rider is deliberately absent. */
const ROLE_HOME = Object.freeze({
  [ROLES.ADMIN]: "/admin",
  [ROLES.DISPATCHER]: "/dispatcher",
  [ROLES.SALES_REP]: "/sales-rep",
});

export const LOGIN_PATH = "/login";
export const PENDING_PATH = "/pending";

function clean(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The canonical role, or null when it is not one we recognise. */
export function normalizeRole(raw) {
  const value = clean(raw);
  if (value === ROLES.ADMIN) return ROLES.ADMIN;
  if (value === ROLES.DISPATCHER) return ROLES.DISPATCHER;
  if (value === ROLES.RIDER) return ROLES.RIDER;
  if (SALES_REP_ALIASES.includes(value)) return ROLES.SALES_REP;
  return null;
}

/** The canonical status, or null when it is absent or unrecognised. */
export function normalizeStatus(raw) {
  const value = clean(raw);
  return Object.values(STATUSES).includes(value) ? value : null;
}

/**
 * Decide whether this profile may enter `requiredRole`'s application.
 *
 * `profile` is the document read at `users/{auth.uid}`, or null when the user
 * is signed out or has no profile. Returns a decision plus a stable `reason`,
 * which exists so tests can assert WHY access was refused rather than only
 * where the user landed — two different failures that both redirect to /login
 * are not the same failure.
 */
export function resolveAccess({ profile, requiredRole }) {
  const deny = (reason) => ({ allowed: false, redirectTo: LOGIN_PATH, reason });

  if (!profile) return deny("no-profile");

  const status = normalizeStatus(profile.status);
  if (status === null) return deny("unknown-status");

  // Waiting on an admin: a real state with its own screen, not a rejection.
  if (status === STATUSES.PENDING || status === STATUSES.PENDING_APPROVAL) {
    return { allowed: false, redirectTo: PENDING_PATH, reason: "pending" };
  }
  if (status === STATUSES.REJECTED) return deny("rejected");
  if (status === STATUSES.DISABLED) return deny("disabled");
  if (status !== STATUSES.APPROVED) return deny("unknown-status");

  const role = normalizeRole(profile.role);
  if (role === null) return deny("unknown-role");

  // A rider has no web application to be sent to. Returning them to login is
  // the whole answer — there is no "their own dashboard" on this platform.
  if (role === ROLES.RIDER) return deny("rider-web-blocked");

  if (role === requiredRole) return { allowed: true, redirectTo: null, reason: "ok" };

  // Approved, known, but in the wrong place: send them to their own app rather
  // than to login, so a mistyped URL does not look like a sign-in failure.
  return { allowed: false, redirectTo: ROLE_HOME[role] ?? LOGIN_PATH, reason: "wrong-role" };
}

/**
 * Where an approved user should land straight after signing in.
 *
 * Same decision function, asked without a target: reusing `resolveAccess` means
 * login and the guards can never disagree about whether an account is usable.
 */
export function resolveLoginDestination(profile) {
  if (!profile) return { allowed: false, redirectTo: LOGIN_PATH, reason: "no-profile" };

  const role = normalizeRole(profile.role);
  // Ask about the caller's OWN role, so an approved admin resolves to /admin
  // rather than being told they are in the wrong place.
  const decision = resolveAccess({ profile, requiredRole: role });
  if (decision.allowed) return { ...decision, redirectTo: ROLE_HOME[role] ?? LOGIN_PATH };
  return decision;
}
