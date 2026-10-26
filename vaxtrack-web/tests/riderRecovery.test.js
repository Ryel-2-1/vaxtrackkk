// Admin Rider recovery — the panel's pure decisions and its contract with the
// server (functions/src/riderRecoveryOps.js). The server decides everything;
// these pin what the client shows and what it is allowed to send.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRODUCTION_PROJECT_ID,
  custodyLabel,
  qaResetVisible,
  splitOrders,
  tripStateLabel,
  validRecoveryReason,
} from "../src/services/riderRecovery.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const enabled = { actions: { qaReset: { enabled: true } } };

test("Reset QA trip shows only when the server enables it — and never in a production build", () => {
  assert.equal(PRODUCTION_PROJECT_ID, "vaxtrack-bef1b");
  assert.equal(qaResetVisible(enabled, "vaxtrack-staging"), true);
  assert.equal(qaResetVisible(enabled, "vaxtrack-bef1b"), false, "production: hidden even if the server said yes");
  assert.equal(qaResetVisible(enabled, ""), false);
  assert.equal(qaResetVisible(enabled, undefined), false);
  assert.equal(qaResetVisible({ actions: { qaReset: { enabled: false } } }, "vaxtrack-staging"), false, "the server switch decides");
  assert.equal(qaResetVisible(null, "vaxtrack-staging"), false);
});

test("trip state, custody and order grouping read the server's preview", () => {
  const preview = {
    derived: { state: "trip_forming", unknown: false },
    orders: [
      { orderId: "b", orderNumber: "VT-2", active: true, onTrip: true, custody: "not-loaded" },
      { orderId: "a", orderNumber: "VT-1", active: true, onTrip: true, custody: "loaded" },
      { orderId: "c", orderNumber: "VT-0", active: false, onTrip: true, custody: "with-rider" },
    ],
  };
  assert.equal(tripStateLabel(preview), "Trip forming · 2 orders");
  assert.equal(tripStateLabel({ derived: { unknown: true } }), "Trip status can't be checked");
  assert.equal(tripStateLabel({ derived: { state: "returning_to_hub" }, orders: [] }), "Returning to hub");
  const { active, finished } = splitOrders(preview);
  assert.deepEqual(active.map((o) => o.orderNumber), ["VT-1", "VT-2"]);
  assert.deepEqual(finished.map((o) => o.orderNumber), ["VT-0"]);
  assert.equal(custodyLabel("loaded-before"), "Was loaded (unticked since)");
  assert.equal(custodyLabel("anything-else"), "Unknown");
});

test("a recovery needs a short, real reason", () => {
  assert.equal(validRecoveryReason("QA done"), true);
  for (const bad of ["", "    ", "abc", "x".repeat(501), null]) assert.equal(validRecoveryReason(bad), false, String(bad));
});

test("the client sends only the Rider, the action, the preview version and a reason", () => {
  const svc = read("src/services/riderRecoveryService.js");
  assert.match(svc, /callables\(\)\.apply\(\{ riderUid, action, version, reason \}\)/);
  assert.match(svc, /callables\(\)\.preview\(\{ riderUid \}\)/);
  assert.match(svc, /httpsCallable\(fns, "previewRiderRecovery"\)/);
  assert.match(svc, /httpsCallable\(fns, "applyRiderRecovery"\)/);
});

test("the panel writes nothing to Firestore and confirms through a portaled dialog with a reason", () => {
  const panel = read("src/pages/admin/RiderRecoveryPanel.jsx");
  assert.equal(/from "firebase\/firestore"/.test(panel), false, "no direct reads or writes");
  assert.match(panel, /recheckRiderTripStatesOnServer\(\[riderUid\]\)/, "Re-check reuses the existing callable");
  assert.match(panel, /<AdminDialogLayer>\s*<ConfirmDialog/);
  assert.match(panel, /validate=\{validate\}/);
  assert.match(panel, /<textarea\s+id=\{reasonId\}/);
  assert.match(panel, /\{showQaReset && \(/, "Reset QA trip is conditional");
  assert.match(panel, /const showQaReset = qaResetVisible\(preview, projectId\);/);
  // Blockers are the server's sentences (order numbers), shown as a list.
  assert.match(panel, /qaReset\.blockers\.map\(\(b, i\) => \(\s*<li key=\{`\$\{b\.code\}-\$\{i\}`\}>\{b\.message\}<\/li>/);
  const riders = read("src/pages/admin/Riders.jsx");
  assert.match(riders, /\{rider\.uid && <RiderRecoveryPanel riderUid=\{rider\.uid\} riderName=\{rider\.name\} \/>\}/);
});
