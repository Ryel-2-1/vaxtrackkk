import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verificationSendMessage } from "../src/services/emailVerification.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// An Admin can approve a self sign-up only once its email is verified (2026-11-14).

test("sign-up sends the verification link, and a failed send never undoes the application", () => {
  const page = read("src/pages/Register.jsx");
  assert.match(page, /try \{\s*await sendEmailVerification\(credential\.user\);\s*\} catch \{/);
  // Sent while still signed in: before the sign-out that ends a new application.
  assert.ok(page.indexOf("sendEmailVerification(credential.user)") < page.indexOf("await signOut(auth);\n      navigate(\"/pending\""));
  assert.match(page, /navigate\("\/pending", \{ state: \{ email: check\.value\.email \} \}\);/);
});

test("the pending page shows verification status and can send the link again", () => {
  const page = read("src/pages/PendingApproval.jsx");
  assert.match(page, /await sendEmailVerification\(user\);/);
  assert.match(page, /await user\.reload\(\);/);
  assert.match(page, /An administrator can approve your account only after that\./);
});

test("send results are worded for the applicant, never Firebase's own text", () => {
  assert.equal(verificationSendMessage(null, "a@b.test"), "We sent a new verification link to a@b.test. Check your inbox and spam folder.");
  assert.match(verificationSendMessage("auth/too-many-requests"), /wait a few minutes/);
  assert.match(verificationSendMessage("auth/network-request-failed"), /No connection/);
  assert.match(verificationSendMessage("auth/internal-error"), /could not be sent/);
});

test("the server refuses a first approval without a verified email, and says what to do", () => {
  const server = read("functions/src/staffAccounts.js");
  assert.match(server, /"email-not-verified",/);
  assert.match(server, /const firstApproval = status === "approved" && \["pending", "pending_approval"\]\.includes\(normalizeStatus\(target\.status\)\);/);
  assert.match(read("functions/index.js"), /"email-not-verified": "failed-precondition",/);
  assert.match(read("functions/index.js"), /staffAccounts\.setStaffStatus\(\{ db, FieldValue, authAdmin: admin\.auth\(\),/);
});
