import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  OFFLINE_REVIEW_REASONS,
  offlineCompletionNote,
  pendingOfflineReview,
} from "../src/services/offlineCompletionView.js";
import { buildDispatcherNotificationFeed } from "../src/services/dispatcherNotificationFeed.js";
import { presentAlert } from "../src/services/alertPresentation.js";

const require = createRequire(import.meta.url);
const server = require("../functions/src/offlineCompletion.js");

const AT = Date.parse("2026-11-02T06:14:00Z"); // 2:14 PM Manila

test("review reasons match the server's, one for one", () => {
  assert.deepEqual(Object.keys(OFFLINE_REVIEW_REASONS).sort(), Object.keys(server.REVIEW_REASONS).sort());
  for (const [k, v] of Object.entries(server.REVIEW_REASONS)) assert.equal(OFFLINE_REVIEW_REASONS[k], v, k);
});

test("a completed-offline order says so, how it was decided and when it was recorded", () => {
  assert.equal(offlineCompletionNote({ completionMode: null }), null, "live completions get no note");
  const ev = { capturedAtMs: AT, distanceMeters: 12, radiusMeters: 50 };
  const auto = offlineCompletionNote({ completionMode: "offline", offlineEvidence: ev });
  assert.match(auto, /^Completed offline\. Recorded on the rider's phone without signal at Nov 2, 2:14 PM, 12 m from the clinic \(area 50 m\); the position was verified/);
  assert.match(offlineCompletionNote({ completionMode: "offline_approved", offlineEvidence: ev }), /after dispatcher review/);
});

test("only a pending review is offered for a decision", () => {
  assert.equal(pendingOfflineReview({}), null);
  assert.equal(pendingOfflineReview({ offlineCompletionReview: { status: "rejected" } }), null);
  const r = pendingOfflineReview({ offlineCompletionReview: {
    status: "pending", reason: "too_old", capturedAtMs: AT, receivedAtMs: AT + 4 * 3600e3,
    distanceMeters: 12.4, radiusMeters: 50, accuracyMeters: 7.6, latitude: 14.3, longitude: 121.07,
  } });
  assert.equal(r.reasonText, server.REVIEW_REASONS.too_old);
  assert.deepEqual([r.distanceMeters, r.accuracyMeters, r.radiusMeters], [12, 8, 50]);
});

test("the bell: review is Needs action; a verified offline completion is a shipment update, said once", () => {
  const nowMs = AT + 3600e3;
  const feed = buildDispatcherNotificationFeed({
    alerts: [{ id: "a1", type: "offline_completion_review", status: "active", orderId: "o2", orderNumber: "VT-ORD-1-AAAA",
      riderName: "Abdul", message: "Abdul recorded Order VT-ORD-1-AAAA … could not be verified automatically.", createdAt: AT }],
    orders: [{ id: "o1", orderNumber: "VT-ORD-2-BBBB", clinicName: "Terminal", status: "delivered", deliveredAt: AT + 60e3,
      completionMode: "offline", offlineEvidence: { capturedAtMs: AT, distanceMeters: 12, radiusMeters: 50 } }],
    near: {},
    nowMs,
  });
  assert.equal(feed.actions[0].title, "Offline delivery needs review");
  assert.equal(feed.actions[0].path, "/dispatcher/shipments?order=o2");
  assert.equal(feed.updates.length, 1);
  assert.equal(feed.updates[0].title, "Delivery completed offline");
  assert.match(feed.updates[0].message, /without signal at Nov 2, 2:14 PM/);
  const resolved = presentAlert({ type: "offline_completion_review", status: "resolved", resolutionReason: "rejected", orderNumber: "VT-ORD-1-AAAA" }, { role: "dispatcher" });
  assert.equal(resolved.title, "Offline delivery reviewed");
  assert.match(resolved.message, /was rejected/);
});
