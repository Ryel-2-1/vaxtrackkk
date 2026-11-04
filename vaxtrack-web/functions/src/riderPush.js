"use strict";

/**
 * Rider push notifications (MOD-10) — which Rider hears about which order
 * change. Pure; no Firestore, no FCM.
 *
 * Decided from an order's before / after snapshot (one trigger,
 * notifyRiderOnOrderWrite), so every path that assigns, reassigns or cancels —
 * callable, recovery, admin — notifies the same way:
 *
 *   assigned        a Rider becomes the order's assignedRiderId
 *   reassigned      the order leaves a Rider for someone else (that Rider is told)
 *   cancelled       an order assigned to a Rider is cancelled
 *   offline_approved / offline_rejected
 *                   a dispatcher decided the Rider's offline record
 *
 * Text names the order code and the destination only — never an address,
 * doctor name, clinic contact or document id.
 */

const { orderCodeOf } = require("./riderTracking");
const { destinationLabel } = require("./deliveryTimingOps");

const REVIEW_FIELD = "offlineCompletionReview";

const uidOf = (v) => (typeof v === "string" && v !== "" && !v.includes("/") ? v : null);
const statusOf = (o) => (typeof o?.status === "string" ? o.status.trim().toLowerCase() : "");
const orderText = (o) => {
  const code = orderCodeOf(o?.orderNumber);
  return code ? `Order ${code}` : "A delivery";
};

/**
 * The notifications this write calls for: [{ riderUid, kind, title, body }].
 * `before` / `after` are the order data (null for a create / delete).
 */
function riderNotificationsFor(before, after) {
  if (!after) return [];
  const out = [];
  const was = uidOf(before?.assignedRiderId);
  const now = uidOf(after.assignedRiderId);
  const status = statusOf(after);
  const order = orderText(after);
  const where = destinationLabel(after);

  if (status === "cancelled" && statusOf(before) !== "cancelled") {
    const rider = was ?? now;
    if (rider) {
      out.push({
        riderUid: rider,
        kind: "cancelled",
        title: "Delivery cancelled",
        body: `${order} to ${where} was cancelled. It is no longer on your list.`,
      });
    }
    return out;
  }

  if (now && now !== was && ["assigned", "loading"].includes(status)) {
    out.push({
      riderUid: now,
      kind: "assigned",
      title: "New delivery assigned",
      body: `${order} to ${where} was assigned to you. Open VaxTrack for the details.`,
    });
  }
  if (was && was !== now && status !== "cancelled") {
    out.push({
      riderUid: was,
      kind: "reassigned",
      title: "Delivery reassigned",
      body: `${order} to ${where} was moved to another rider. It is no longer on your list.`,
    });
  }

  const reviewBefore = before?.[REVIEW_FIELD];
  const reviewAfter = after[REVIEW_FIELD];
  const reviewRider = uidOf(reviewAfter?.riderUid);
  if (reviewBefore?.status === "pending" && reviewRider) {
    if (reviewAfter?.status === "approved") {
      out.push({
        riderUid: reviewRider,
        kind: "offline_approved",
        title: "Offline delivery approved",
        body: `The dispatcher approved your offline record. ${order} to ${where} is delivered.`,
      });
    } else if (reviewAfter?.status === "rejected") {
      out.push({
        riderUid: reviewRider,
        kind: "offline_rejected",
        title: "Offline delivery not accepted",
        body: `The dispatcher did not accept your offline record for ${order}. Open VaxTrack to see why, then complete it again or report a failed delivery.`,
      });
    }
  }
  return out;
}

/** Tokens kept per Rider (one per phone they have signed in on, newest last). */
const MAX_TOKENS = 5;

/** FCM error codes that mean a token is gone for good and should be removed. */
const DEAD_TOKEN_CODES = Object.freeze([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

module.exports = { riderNotificationsFor, MAX_TOKENS, DEAD_TOKEN_CODES, TOKENS_COLLECTION: "riderPushTokens" };
