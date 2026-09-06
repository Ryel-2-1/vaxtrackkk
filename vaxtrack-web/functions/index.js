"use strict";

/**
 * VaxTrack trusted server boundary.
 *
 * Three explicit callables — create+reserve, cancel+release, deliver+consume.
 * Deliberately NOT a generic "update status" or "adjust inventory" entry point:
 * a generic mutation function would put the whole lifecycle back in the
 * caller's hands, which is exactly what this boundary exists to remove.
 *
 * RUNTIME / REGION
 *   nodejs22  — GA in firebase-tools 15.17.0 (deprecates 2027-04-30).
 *   asia-southeast1 — present in firebase-functions 6.6.0's gen-2
 *   `SupportedRegion` union, and the same region as staging Firestore, so a
 *   transaction does not cross a region boundary on every call.
 *   Gen 2 (firebase-functions/v2).
 *   minInstances 0 — nothing idle is reserved, so staging costs nothing at rest.
 *   maxInstances 10 — a deliberately low ceiling. These are low-volume
 *   operator actions; the cap bounds accidental cost far below anything the
 *   real workload needs.
 *
 * ⚠️ APP CHECK IS NOT ENFORCED. Web and Android App Check are not configured
 * and the physical phone is unavailable, so `enforceAppCheck` stays off. That
 * means these callables authenticate the USER but do not attest the CLIENT: a
 * valid signed-in token from any client reaches them. Firebase Authentication
 * is not App Check and is not claimed to be. Enabling App Check enforcement is
 * a required RELEASE-SECURITY GATE before production.
 *
 * ⚠️ PRICING IS NOT SERVER-AUTHORITATIVE. Inventory documents carry no price
 * field, so `unitPrice` is accepted from the caller and stored for invoice
 * compatibility only. It is explicitly untrusted, takes no part in any
 * inventory, identity or authorization decision, and must not be read as a
 * verified figure. An authoritative pricing source is a separate checkpoint.
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { PolicyError } = require("./src/policy");
const operations = require("./src/operations");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

setGlobalOptions({
  region: "asia-southeast1",
  minInstances: 0,
  maxInstances: 10,
  memory: "256MiB",
  timeoutSeconds: 60,
});

/**
 * Map a domain failure to a callable error.
 *
 * The stable `code` travels in `details` so the client can branch on it
 * without parsing prose, while `message` stays the sentence a user reads. An
 * unexpected error is logged with its type only and returned as `internal` —
 * never echoed back, so a stack trace or a document value cannot leak.
 */
function toHttpsError(error, context) {
  if (error instanceof PolicyError) {
    const map = {
      "unauthenticated": "unauthenticated",
      "profile-missing": "permission-denied",
      "wrong-role": "permission-denied",
      "not-approved": "permission-denied",
      "not-assigned-rider": "permission-denied",
      "order-not-found": "not-found",
      "clinic-not-found": "not-found",
      "inventory-not-found": "not-found",
      "reservation-not-found": "failed-precondition",
      "reservation-already-settled": "failed-precondition",
      "invalid-status-transition": "failed-precondition",
      "insufficient-stock": "failed-precondition",
      "batch-expired": "failed-precondition",
      "batch-unavailable": "failed-precondition",
      "inventory-migration-required": "failed-precondition",
      "inventory-invalid-quantity": "failed-precondition",
      "inventory-invalid-reserved": "failed-precondition",
      "inventory-invariant-broken": "failed-precondition",
      "idempotency-conflict": "aborted",
    };
    const httpsCode = map[error.code] ?? "invalid-argument";
    return new HttpsError(httpsCode, error.message, {
      code: error.code,
      ...(error.details ? { info: error.details } : {}),
    });
  }
  logger.error("Unhandled callable failure", {
    context,
    errorType: error?.constructor?.name ?? typeof error,
  });
  return new HttpsError("internal", "Something went wrong. Please try again.");
}

/** Shared entry: require authentication, then run the operation. */
function callable(name, run) {
  return onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Please sign in and try again.");
    }
    try {
      // `now` is the server's clock, taken once per invocation so a retried
      // transaction cannot see the expiry cutoff move underneath it.
      return await run({ db, FieldValue, uid, data: request.data ?? {}, now: new Date() });
    } catch (error) {
      throw toHttpsError(error, name);
    }
  });
}

exports.createOrderWithReservation = callable(
  "createOrderWithReservation",
  ({ db, FieldValue, uid, data, now }) =>
    operations.createOrderWithReservation({ db, FieldValue, uid, payload: data, now })
);

exports.cancelOrderWithInventoryRelease = callable(
  "cancelOrderWithInventoryRelease",
  ({ db, FieldValue, uid, data, now }) =>
    operations.cancelOrderWithInventoryRelease({
      db,
      FieldValue,
      uid,
      orderId: data.orderId,
      reason: data.reason,
      now,
    })
);

exports.markOrderDeliveredWithInventoryConsumption = callable(
  "markOrderDeliveredWithInventoryConsumption",
  ({ db, FieldValue, uid, data, now }) =>
    operations.markOrderDeliveredWithInventoryConsumption({
      db,
      FieldValue,
      uid,
      orderId: data.orderId,
      now,
    })
);
