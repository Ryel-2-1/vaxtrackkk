import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEUTRAL_NOTICE,
  RESEND_COOLDOWN_MS,
  mapResetError,
  normalizeEmail,
  requestPasswordReset,
  resendWaitMs,
  validateResetEmail,
} from "../src/services/passwordReset.js";

/**
 * The Forgot Password feature was a mock: it called no Firebase, accepted any
 * six-digit code, showed "Password Reset Successful" without changing anything,
 * and its Resend did nothing. This suite pins the real behaviour in two ways —
 * the decision logic is exercised directly (a stub stands in for Firebase's
 * send), and the page source is asserted to prove the fake OTP / new-password
 * screens are gone and success is only ever shown after a real, awaited send.
 */

// A send stub that records its calls and resolves/rejects on demand.
function stubSend({ fail } = {}) {
  const calls = [];
  const send = async (email) => {
    calls.push(email);
    if (fail) throw fail;
  };
  return { send, calls };
}

const authError = (code) => Object.assign(new Error(code), { code });

// ------------------------------------------------------------- validation

test("validateResetEmail rejects empty and malformed, trims a good address", () => {
  assert.equal(validateResetEmail("").ok, false);
  assert.equal(validateResetEmail("   ").ok, false);
  assert.equal(validateResetEmail("not-an-email").ok, false);
  assert.equal(validateResetEmail("no@domain").ok, false);

  const ok = validateResetEmail("  User@Example.com  ");
  assert.equal(ok.ok, true);
  // Trimmed but NOT lowercased — the local part can be case-sensitive.
  assert.equal(ok.value, "User@Example.com");
});

test("normalizeEmail trims and tolerates non-strings", () => {
  assert.equal(normalizeEmail("  a@b.co "), "a@b.co");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(null), "");
});

// ------------------------------------------------------- neutral outcome

test("an invalid email never calls Firebase", async () => {
  const { send, calls } = stubSend();
  const out = await requestPasswordReset({ email: "bad", send });
  assert.equal(out.kind, "invalid");
  assert.equal(calls.length, 0);
});

test("a successful request reports the neutral notice and sends once, trimmed", async () => {
  const { send, calls } = stubSend();
  const out = await requestPasswordReset({ email: "  a@b.co ", send });
  assert.equal(out.kind, "sent");
  assert.equal(out.message, NEUTRAL_NOTICE);
  assert.deepEqual(calls, ["a@b.co"]);
});

test("a nonexistent account is INDISTINGUISHABLE from a success", async () => {
  const success = await requestPasswordReset({
    email: "real@x.co",
    send: stubSend().send,
  });
  const missing = await requestPasswordReset({
    email: "ghost@x.co",
    send: stubSend({ fail: authError("auth/user-not-found") }).send,
  });

  // Same kind, same exact message — the form cannot be used to probe accounts.
  assert.equal(missing.kind, "sent");
  assert.equal(success.kind, "sent");
  assert.equal(missing.message, success.message);
});

test("the neutral notice does not assert a mail was sent to this address", () => {
  // It states the conditional ("if an account exists"), never a definite send.
  assert.match(NEUTRAL_NOTICE, /if an account exists/i);
});

// --------------------------------------------------- existence-neutral errors

test("infrastructure failures surface as actionable, existence-neutral errors", async () => {
  const tooMany = await requestPasswordReset({
    email: "a@b.co",
    send: stubSend({ fail: authError("auth/too-many-requests") }).send,
  });
  assert.equal(tooMany.kind, "error");
  assert.match(tooMany.message, /too many/i);

  const offline = await requestPasswordReset({
    email: "a@b.co",
    send: stubSend({ fail: authError("auth/network-request-failed") }).send,
  });
  assert.equal(offline.kind, "error");
  assert.match(offline.message, /connect|connection/i);

  const unknown = await requestPasswordReset({
    email: "a@b.co",
    send: stubSend({ fail: authError("auth/internal-error") }).send,
  });
  assert.equal(unknown.kind, "error");
  assert.match(unknown.message, /went wrong/i);
});

test("mapResetError never returns text that could reveal account existence", () => {
  for (const code of [
    "auth/too-many-requests",
    "auth/network-request-failed",
    "auth/internal-error",
    "",
  ]) {
    const msg = mapResetError(code);
    assert.equal(/exist|not found|no account|unregistered/i.test(msg), false);
  }
});

test("success is returned only AFTER the send resolves", async () => {
  let resolveSend;
  let sendSettled = false;
  const send = () =>
    new Promise((resolve) => {
      resolveSend = () => {
        sendSettled = true;
        resolve();
      };
    });

  const pending = requestPasswordReset({ email: "a@b.co", send });
  // Give the microtask queue a turn; the result must still be pending.
  await Promise.resolve();
  assert.equal(sendSettled, false);

  resolveSend();
  const out = await pending;
  assert.equal(sendSettled, true);
  assert.equal(out.kind, "sent");
});

// ----------------------------------------------------------- resend cooldown

test("resendWaitMs allows the first send and enforces the cooldown after", () => {
  assert.equal(resendWaitMs({ now: 1000, lastSentAt: null }), 0);
  // Immediately after a send, the full cooldown remains.
  assert.equal(
    resendWaitMs({ now: 1000, lastSentAt: 1000 }),
    RESEND_COOLDOWN_MS
  );
  // Part-way through.
  assert.equal(
    resendWaitMs({ now: 1000 + 10_000, lastSentAt: 1000 }),
    RESEND_COOLDOWN_MS - 10_000
  );
  // Past the cooldown.
  assert.equal(
    resendWaitMs({ now: 1000 + RESEND_COOLDOWN_MS + 5, lastSentAt: 1000 }),
    0
  );
});

// ============================================================ page source shape

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");

const PAGE = "src/pages/ForgotPassword.jsx";

test("the fake OTP screen and its handlers are gone", () => {
  const src = code(PAGE);
  for (const token of [
    "otp",
    "handleOtpChange",
    "handleOtpSubmit",
    "otp-row",
    "Verify Code",
    "Verify Identity",
    "Send Verification Code",
    "verification code",
  ]) {
    assert.equal(src.includes(token), false, `"${token}" must be gone`);
  }
});

test("the fake new-password screen and its fabricated success are gone", () => {
  const src = code(PAGE);
  for (const token of [
    "newPassword",
    "confirmPassword",
    "showNewPassword",
    "handleResetSubmit",
    "password-rules",
    "Set New Password",
    "Create New Password",
    "Password Reset Successful",
  ]) {
    assert.equal(src.includes(token), false, `"${token}" must be gone`);
  }
});

test("no client-side password write was invented", () => {
  const src = code(PAGE);
  // A reset email is the ONLY mechanism; the app must not try to set a password
  // itself, and must not reach Firestore directly from this page.
  for (const token of [
    "updatePassword",
    "confirmPasswordReset",
    "verifyPasswordResetCode",
    'from "firebase/firestore"',
  ]) {
    assert.equal(src.includes(token), false, `"${token}" must not appear`);
  }
});

test("the page sends a real Firebase reset email through the pure logic", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import \{[^}]*sendPasswordResetEmail[^}]*\} from "firebase\/auth"/,
    "must import sendPasswordResetEmail"
  );
  assert.match(
    src,
    /sendPasswordResetEmail\(auth, email\)/,
    "must call the real send with the app's auth"
  );
  assert.match(src, /requestPasswordReset\(\{[\s\S]*?send[\s\S]*?\}\)/, "must delegate to the pure logic");
});

test("success is shown only after the awaited request, inside the handler", () => {
  const src = read(PAGE);
  const submit = /const submit = async \([\s\S]*?\n {2}\};/.exec(src);
  assert.ok(submit, "the shared submit handler must exist");
  const body = submit[0];

  const awaitAt = body.indexOf("await requestPasswordReset");
  const successAt = body.indexOf('setStep("sent")');
  assert.ok(awaitAt !== -1, "the request must be awaited");
  assert.ok(
    successAt !== -1 && successAt > awaitAt,
    "the sent screen must be shown only after the awaited request"
  );
});

test("duplicate submissions are blocked by an in-flight guard", () => {
  const src = read(PAGE);
  const submit = /const submit = async \([\s\S]*?\n {2}\};/.exec(src)[0];

  assert.match(submit, /if \(submitting\)\s*return;/, "a re-entrancy guard must exist");
  assert.match(submit, /setSubmitting\(true\)/, "the in-flight flag must be raised");
  assert.match(submit, /setSubmitting\(false\)/, "and cleared in finally");
  assert.match(submit, /\}\s*finally\s*\{/, "clearing must be in a finally block");

  // The primary button is also disabled while a request is in flight.
  assert.match(
    src,
    /type="submit"[\s\S]*?disabled=\{submitting\}/,
    "the submit button must be disabled while submitting"
  );
});

test("resend actually re-requests and is guarded by the cooldown", () => {
  const src = read(PAGE);
  const resend = /const handleResend = \([\s\S]*?\n {2}\};/.exec(src);
  assert.ok(resend, "handleResend must exist");
  assert.match(resend[0], /submit\(email\)/, "resend must go through the real request path");
  assert.match(
    resend[0],
    /if \(submitting \|\| cooldown > 0\)\s*return;/,
    "resend must be blocked while in flight or cooling down"
  );
  // And the resend control is disabled in those same states.
  assert.match(
    src,
    /onClick=\{handleResend\}/,
    "the resend button must call the real handler"
  );
  assert.match(
    src,
    /disabled=\{submitting \|\| cooldown > 0\}/,
    "the resend button must be disabled while in flight or cooling down"
  );
});
