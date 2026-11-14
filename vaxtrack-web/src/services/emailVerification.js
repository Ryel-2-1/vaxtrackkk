/**
 * Email verification for self sign-ups (2026-11-14). An Admin can approve an
 * applicant only once their email is verified; the server checks it
 * (functions/src/staffAccounts.js, `email-not-verified`). Pure wording here.
 */

/** What to tell the applicant after asking Firebase to send the link. */
export function verificationSendMessage(errorCode, email = "") {
  const to = email ? ` to ${email}` : "";
  if (!errorCode) return `We sent a new verification link${to}. Check your inbox and spam folder.`;
  if (errorCode === "auth/too-many-requests") {
    return "A link was sent very recently. Please wait a few minutes before asking for another.";
  }
  if (errorCode === "auth/network-request-failed") {
    return "No connection. Check your internet and try again.";
  }
  return "The verification email could not be sent. Please try again in a moment.";
}
