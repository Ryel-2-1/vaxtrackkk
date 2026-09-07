"use strict";

/**
 * VaxTrack trusted server boundary.
 *
 * Five explicit callables — create+reserve, cancel+release, deliver+consume,
 * and the two invoice-pricing operations. Every one names a single business
 * action. Deliberately NOT a generic "update status", "adjust inventory" or
 * "write invoice" entry point: a generic mutation function would put the
 * lifecycle and the pricing straight back in the caller's hands, which is
 * exactly what this boundary exists to remove.
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
 * PRICING IS SERVER-AUTHORITATIVE. Each inventory batch owns a VAT-exclusive
 * clinic selling price in PHP centavos (`sellingPriceCentavos`, integer > 0),
 * written only by an admin. `createOrderWithReservation` reads that price from
 * the batch INSIDE the reservation transaction and writes an immutable snapshot
 * onto the order. The caller supplies no price at all — only the price it
 * EXPECTED, which is compared and, on any difference in either direction,
 * refuses the checkout with `price-changed` for human review. A batch with no
 * valid price cannot be ordered; the catalog shows it disabled and says why.
 *
 * Orders placed before this checkpoint carry no `pricingVersion` and keep the
 * manual invoice-time pricing they have always had. Nothing back-fills a price
 * onto them: an invented figure would misstate what a clinic was charged.
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { PolicyError } = require("./src/policy");
const operations = require("./src/operations");
const invoiceOperations = require("./src/invoiceOperations");

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
      "batch-unpriced": "failed-precondition",
      "price-not-confirmed": "failed-precondition",
      // ---- invoice pricing ----
      "invoice-not-found": "not-found",
      "order-not-priced": "failed-precondition",
      "order-has-no-items": "failed-precondition",
      "order-snapshot-invalid": "failed-precondition",
      "invoice-already-issued": "failed-precondition",
      "invalid-invoice-status": "failed-precondition",
      "discount-exceeds-subtotal": "failed-precondition",
      // Someone changed the stored base pricing out from under the draft.
      "invoice-base-mismatch": "aborted",
      "invoice-total-mismatch": "aborted",
      // `aborted` — like an idempotency conflict, the state moved underneath
      // the caller. It is retryable, but only after a human has looked.
      "price-changed": "aborted",
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

/**
 * Invoice pricing for SERVER-PRICED orders only.
 *
 * Two named operations, not a generic invoice mutation entry point. Neither
 * accepts a base price, quantity or total: those are read from the order inside
 * the transaction. The caller supplies presentation text and explicit
 * adjustments, and nothing else is even accepted as input.
 *
 * Orders with no `pricingVersion` do not reach these at all — they keep the
 * existing client-side manual invoice path unchanged.
 */
exports.saveInvoiceDraftForPricedOrder = callable(
  "saveInvoiceDraftForPricedOrder",
  ({ db, FieldValue, uid, data, now }) =>
    invoiceOperations.saveInvoiceDraftForPricedOrder({ db, FieldValue, uid, payload: data, now })
);

exports.issueInvoiceForPricedOrder = callable(
  "issueInvoiceForPricedOrder",
  ({ db, FieldValue, uid, data, now }) =>
    invoiceOperations.issueInvoiceForPricedOrder({ db, FieldValue, uid, payload: data, now })
);
