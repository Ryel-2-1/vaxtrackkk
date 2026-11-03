"use strict";

/**
 * Offline delivery completion — the transactions (rules in offlineCompletion.js).
 *
 *   riderLocationTrails/{uid}   server-owned trail of the Rider's trusted fixes
 *                               (recordTrailPoint, from the riderLocations trigger).
 *   orders/{id}.offlineCompletionReview
 *                               an offline record a person must decide on.
 *   alerts/offline_review_<orderId>_<capturedAtMs>   Needs action (Dispatcher).
 * A verified record needs no alert of its own: the order's completionMode
 * and offlineEvidence say how it was completed (the bell's "Delivery
 * completed" entry reads them).
 *
 * submitOfflineDeliveryCompletion — the Rider's offline record, once online.
 *   Verified automatically → Delivered through the SAME completion transaction
 *   as a live completion (stock consumed once), stamped completionMode
 *   "offline". Otherwise → kept on the order for review; nothing completes.
 * resolveOfflineCompletionReview — a Dispatcher/Admin approves (→ Delivered,
 *   "offline_approved") or rejects (order stays in transit) a record in review.
 */

const O = require("./offlineCompletion");
const { PolicyError } = require("./policy");
const { loadUser, requireRole, completeDelivery } = require("./operations");
const { SHIPMENT_PATH, destinationLabel } = require("./deliveryTimingOps");

const ORDERS = "orders";
const ALERTS = "alerts";

const orderNumberOf = (order) =>
  typeof order?.orderNumber === "string" && order.orderNumber.trim() ? order.orderNumber.trim() : null;
const riderNameOf = (order) =>
  typeof order?.assignedRiderName === "string" && order.assignedRiderName.trim() ? order.assignedRiderName.trim() : "The rider";

const manilaClock = (ms) =>
  new Date(ms).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });

/** Add a riderLocations fix to the Rider's trail, when it qualifies. Idempotent. */
async function recordTrailPoint({ db, riderUid, location, nowMs }) {
  const point = O.trailPointFrom(location);
  if (!point) return { recorded: false };
  const ref = db.collection(O.TRAIL_COLLECTION).doc(riderUid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = O.appendTrailPoint(snap.exists ? snap.get("points") : [], point, nowMs);
    if (!next) return { recorded: false };
    // expireAt: Firestore's TTL policy (firestore.indexes.json) deletes a
    // trail nobody has written to for TRAIL_KEEP_MS; the retention job
    // (purgeExpiredTrackingData) does the same, so either one is enough.
    tx.set(ref, { riderUid, points: next, updatedAtMs: nowMs, expireAt: new Date(nowMs + O.TRAIL_KEEP_MS) });
    return { recorded: true };
  });
}

function evidenceOf(capture, decision, nowMs) {
  return {
    latitude: capture.lat,
    longitude: capture.lng,
    accuracyMeters: capture.accuracyM,
    capturedAtMs: capture.capturedAtMs,
    receivedAtMs: nowMs,
    distanceMeters: decision.distanceM ?? null,
    radiusMeters: decision.radiusM ?? null,
  };
}

function reviewAlert({ FieldValue, orderId, order, review }) {
  const number = orderNumberOf(order);
  return {
    type: O.ALERT_REVIEW,
    severity: "warning",
    status: "active",
    read: false,
    title: "Offline delivery needs review",
    message: `${riderNameOf(order)} recorded ${number ? `Order ${number}` : "a delivery"} at ${destinationLabel(order)} ` +
      `without signal at ${manilaClock(review.capturedAtMs)}, but it could not be verified automatically: ` +
      `${review.message} Review the photos and location, then approve or reject it.`,
    orderId,
    deliveryId: orderId,
    orderNumber: number,
    riderId: order.assignedRiderId ?? null,
    riderName: order.assignedRiderName ?? null,
    reason: review.reason,
    path: SHIPMENT_PATH(orderId),
    source: "server",
    resolutionReason: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * The Rider's offline record, sent once back online. Photos must already be
 * recorded on the order (the app uploads them first). Returns
 * { orderId, status: "delivered", completionMode: "offline" } or
 * { orderId, status: "needs_review", reason }.
 */
async function submitOfflineDeliveryCompletion({ db, FieldValue, uid, email = null, payload, now = new Date() }) {
  requireRole(await loadUser(db, uid), "rider");
  const { orderId, capture } = O.parseOfflinePayload(payload);
  const nowMs = now.getTime();
  const trailRef = db.collection(O.TRAIL_COLLECTION).doc(uid);
  const result = await completeDelivery({
    db,
    FieldValue,
    orderId,
    riderUid: uid,
    actorUid: uid,
    actorEmail: email,
    now,
    verifyLocation: async (tx, order) => {
      const trailSnap = await tx.get(trailRef);
      const decision = O.evaluateOfflineCapture({
        order,
        capture,
        trail: trailSnap.exists ? trailSnap.get("points") : [],
        receivedAtMs: nowMs,
      });
      const evidence = evidenceOf(capture, decision, nowMs);
      if (decision.ok) {
        return {
          orderFields: {
            completionMode: "offline",
            offlineEvidence: evidence,
            [O.REVIEW_COLLECTION_FIELD]: FieldValue.delete(),
          },
        };
      }
      // Already in review for this same record: a retry changes nothing.
      const existing = order[O.REVIEW_COLLECTION_FIELD];
      if (existing?.status === "pending" && existing.capturedAtMs === capture.capturedAtMs) {
        return { stop: { orderId, status: "needs_review", reason: existing.reason, replayed: true } };
      }
      const review = {
        status: "pending",
        reason: decision.reason,
        message: O.reviewMessage(decision.reason, decision),
        riderUid: uid,
        ...evidence,
      };
      const alertRef = db.collection(ALERTS).doc(O.reviewAlertId(orderId, capture.capturedAtMs));
      const alertSnap = await tx.get(alertRef);
      tx.update(db.collection(ORDERS).doc(orderId), {
        [O.REVIEW_COLLECTION_FIELD]: review,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!alertSnap.exists) tx.create(alertRef, reviewAlert({ FieldValue, orderId, order, review }));
      return { stop: { orderId, status: "needs_review", reason: decision.reason, replayed: false } };
    },
  });

  return result.status === "delivered" && !result.replayed ? { ...result, completionMode: "offline" } : result;
}

async function loadReviewer(db, uid) {
  const user = await loadUser(db, uid);
  const role = typeof user?.role === "string" ? user.role.trim().toLowerCase() : "";
  requireRole(user, role === "admin" ? "admin" : "dispatcher");
  return role === "admin" ? "admin" : "dispatcher";
}

async function resolveReviewAlert({ db, FieldValue, orderId, capturedAtMs, resolution }) {
  const ref = db.collection(ALERTS).doc(O.reviewAlertId(orderId, capturedAtMs));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") !== "active") return;
    tx.update(ref, {
      status: "resolved",
      resolutionReason: resolution,
      resolvedBy: "server",
      resolvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * A Dispatcher/Admin decides an offline record in review:
 *   { orderId, decision: "approve" | "reject", note? }
 * Approve completes it (stock consumed once, completionMode "offline_approved");
 * reject leaves the order in transit — the Rider completes it live or reports a
 * failure. Either way the review alert is resolved.
 */
async function resolveOfflineCompletionReview({ db, FieldValue, uid, email = null, payload, now = new Date() }) {
  const actorRole = await loadReviewer(db, uid);
  if (!payload || typeof payload !== "object" || Object.keys(payload).some((k) => !["orderId", "decision", "note"].includes(k))) {
    throw new PolicyError("invalid-payload", "Only the delivery, the decision and a note may be sent.");
  }
  const { orderId, decision } = payload;
  const note = typeof payload.note === "string" ? payload.note.trim().slice(0, 500) : "";
  if (typeof orderId !== "string" || orderId.trim() === "" || orderId.includes("/")) {
    throw new PolicyError("invalid-payload", "That delivery could not be identified.");
  }
  if (decision !== "approve" && decision !== "reject") {
    throw new PolicyError("invalid-payload", "Choose approve or reject.");
  }
  if (decision === "reject" && note === "") {
    throw new PolicyError("note-required", "Add a reason for rejecting this offline delivery.");
  }
  const orderRef = db.collection(ORDERS).doc(orderId);
  const pendingReview = (order) => {
    const review = order?.[O.REVIEW_COLLECTION_FIELD];
    if (review?.status !== "pending") {
      throw new PolicyError("no-pending-review", "This delivery has no offline record waiting for review.");
    }
    return review;
  };
  const decidedFields = (review, status) => ({
    [`${O.REVIEW_COLLECTION_FIELD}.status`]: status,
    [`${O.REVIEW_COLLECTION_FIELD}.decidedByUid`]: uid,
    [`${O.REVIEW_COLLECTION_FIELD}.decidedByRole`]: actorRole,
    [`${O.REVIEW_COLLECTION_FIELD}.decidedAt`]: FieldValue.serverTimestamp(),
    [`${O.REVIEW_COLLECTION_FIELD}.decisionNote`]: note || null,
  });

  if (decision === "reject") {
    const review = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) throw new PolicyError("order-not-found", "That delivery no longer exists.");
      const r = pendingReview(snap.data());
      tx.update(orderRef, { ...decidedFields(r, "rejected"), updatedAt: FieldValue.serverTimestamp() });
      return r;
    });
    await resolveReviewAlert({ db, FieldValue, orderId, capturedAtMs: review.capturedAtMs, resolution: "rejected" });
    return { orderId, status: "in_transit", decision: "rejected" };
  }

  // Approve: the order must still be with the Rider who recorded it.
  const first = await orderRef.get();
  if (!first.exists) throw new PolicyError("order-not-found", "That delivery no longer exists.");
  const riderUid = pendingReview(first.data()).riderUid;
  let approved = null;
  const result = await completeDelivery({
    db,
    FieldValue,
    orderId,
    riderUid,
    actorUid: uid,
    actorEmail: email,
    now,
    verifyLocation: async (tx, order) => {
      const review = pendingReview(order);
      if (review.riderUid !== riderUid) {
        throw new PolicyError("review-changed", "This offline record changed while you were reviewing it. Open it again.");
      }
      approved = review;
      const evidence = Object.fromEntries(
        ["latitude", "longitude", "accuracyMeters", "capturedAtMs", "receivedAtMs", "distanceMeters", "radiusMeters"]
          .map((k) => [k, review[k] ?? null]),
      );
      return {
        orderFields: {
          completionMode: "offline_approved",
          offlineEvidence: evidence,
          ...decidedFields(review, "approved"),
        },
      };
    },
  });
  if (approved) {
    await resolveReviewAlert({ db, FieldValue, orderId, capturedAtMs: approved.capturedAtMs, resolution: "approved" });
  }
  return { ...result, decision: "approved" };
}

module.exports = { recordTrailPoint, submitOfflineDeliveryCompletion, resolveOfflineCompletionReview };
