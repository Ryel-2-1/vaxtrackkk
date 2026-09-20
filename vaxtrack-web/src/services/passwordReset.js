/**
 * Password-reset request logic — pure and dependency-free.
 *
 * No Firebase, no React, no I/O. ForgotPassword.jsx passes the real
 * `sendPasswordResetEmail(auth, email)` in as `send`; everything that decides
 * what to validate, what the user is told, and — crucially — how to keep the
 * outcome IDENTICAL whether or not an account exists lives here. That last
 * property is what stops the form being used to probe which emails are
 * registered, and it is only trustworthy if it is unit-tested, which needs the
 * one side effect (the send) to be injectable. Hence this split.
 */

/** A resend is refused until this long after the previous accepted request. */
export const RESEND_COOLDOWN_MS = 30_000;

/**
 * One neutral sentence for every outcome that could otherwise confirm or deny
 * an account. A successful send AND a Firebase `auth/user-not-found` are both
 * reported with THIS EXACT text, so a caller cannot tell them apart. It does
 * not assert that a mail was sent to this specific address — it states the
 * conditional truth, which is the standard privacy-preserving phrasing.
 */
export const NEUTRAL_NOTICE =
  "If an account exists for that email, we've sent a password reset link. " +
  "Check your inbox and your spam folder.";

// Deliberately loose: one @, a dot in the domain, no spaces. This is a cheap
// "is this even an address" gate, not an RFC validator — Firebase is the real
// authority, and over-strict client regexes reject legitimate addresses.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim only. Never lowercase — an email's local part can be case-sensitive. */
export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate the address locally before any network call.
 *
 * A format failure is safe to report plainly: it is about the string the user
 * typed, not about whether an account exists, so it reveals nothing.
 */
export function validateResetEmail(value) {
  const email = normalizeEmail(value);
  if (!email) {
    return { ok: false, message: "Please enter your registered email address." };
  }
  if (!EMAIL_SHAPE.test(email)) {
    return { ok: false, message: "Please enter a valid email address." };
  }
  return { ok: true, value: email };
}

/**
 * Actionable, existence-neutral text for the only failures that are NOT about
 * whether an account exists — a rate limit or a lost connection happen the same
 * way for a registered and an unregistered address alike. The one code that
 * WOULD reveal existence, `auth/user-not-found`, never reaches this map: it is
 * neutralised to NEUTRAL_NOTICE in requestPasswordReset before we get here.
 */
export function mapResetError(code) {
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please wait a moment and then try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Unable to connect. Check your internet connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * Request a reset for `email`, sending through the injected `send`.
 *
 * Returns a discriminated outcome (`kind`):
 *   "invalid" — local validation failed; NOTHING was sent.
 *   "sent"    — Firebase accepted the request, OR the account does not exist.
 *               These two are returned identically, on purpose.
 *   "error"   — an infrastructure failure unrelated to account existence.
 *
 * `kind: "sent"` is only ever returned AFTER `send` resolves (or after the
 * existence-hiding user-not-found), never before it — so a caller can show
 * success strictly on a real, completed request.
 */
export async function requestPasswordReset({ email, send }) {
  const check = validateResetEmail(email);
  if (!check.ok) {
    return { kind: "invalid", message: check.message };
  }

  try {
    await send(check.value);
    return { kind: "sent", message: NEUTRAL_NOTICE, email: check.value };
  } catch (error) {
    const code = error?.code ?? "";
    // The sole existence oracle. An unregistered address must be reported
    // exactly as a successful send is, so nothing distinguishes the two.
    if (code === "auth/user-not-found") {
      return { kind: "sent", message: NEUTRAL_NOTICE, email: check.value };
    }
    return { kind: "error", message: mapResetError(code), code };
  }
}

/**
 * Milliseconds a caller must still wait before another send is allowed.
 * 0 means "allowed now". Pure, so the component's countdown and the guard both
 * read the same rule.
 */
export function resendWaitMs({ now, lastSentAt, cooldownMs = RESEND_COOLDOWN_MS }) {
  if (!lastSentAt) return 0;
  const elapsed = now - lastSentAt;
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}
