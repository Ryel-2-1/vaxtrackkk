"use strict";

/**
 * VaxTrack trusted server boundary.
 *
 * Eight explicit callables — create+reserve, cancel+release, deliver+consume,
 * destination request/review, retired legacy correction, and two invoice operations. Each names one business
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
 * ⚠️ APP CHECK IS NOT ENFORCED BY DEFAULT. Enforcement is a per-project switch,
 * ENFORCE_APP_CHECK, read at deploy time from functions/.env.<projectId>
 * (e.g. functions/.env.vaxtrack-staging: ENFORCE_APP_CHECK=true). Until it is
 * set, these callables authenticate the USER but do not attest the CLIENT: a
 * valid signed-in token from any client reaches them. Firebase Authentication
 * is not App Check and is not claimed to be.
 *
 * Turn it on for a project only once EVERY client of that project sends App
 * Check tokens: the web app (reCAPTCHA Enterprise, src/firebase.js) AND the
 * rider app, which calls markOrderDeliveredWithInventoryConsumption. Enforcing
 * before the rider app is attested would refuse every delivery completion.
 * Enabling it in production remains a required RELEASE-SECURITY GATE.
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
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { PolicyError } = require("./src/policy");
const operations = require("./src/operations");
const destinationOperations = require("./src/destinationOperations");
const scheduleOperations = require("./src/scheduleOperations");
const invoiceOperations = require("./src/invoiceOperations");
const statusEvents = require("./src/statusEvents");
const inventoryWorkflow = require("./src/inventoryWorkflow");
const allocation = require("./src/allocation");
const failureReturn = require("./src/failureReturn");
const orderHistoryOutbox = require("./src/orderHistoryOutbox");

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
      "destination-not-found": "not-found",
      "destination-legacy": "failed-precondition",
      "destination-unchanged": "failed-precondition",
      "destination-changed": "aborted",
      "destination-request-stale": "aborted",
      "destination-request-changed": "aborted",
      "destination-request-not-found": "not-found",
      "destination-request-pending": "failed-precondition",
      "order-owner-missing": "failed-precondition",
      "not-order-owner": "permission-denied",
      "workflow-updated": "failed-precondition",
      "invoice-destination-changed": "aborted",
      "clinic-not-found": "not-found",
      "inventory-not-found": "not-found",
      "reservation-not-found": "failed-precondition",
      "reservation-already-settled": "failed-precondition",
      "invalid-status-transition": "failed-precondition",
      "proof-missing": "failed-precondition",
      "invoice-missing": "failed-precondition",
      "evidence-not-yours": "failed-precondition",
      "insufficient-stock": "failed-precondition",
      "batch-expired": "failed-precondition",
      "batch-unavailable": "failed-precondition",
      "inventory-migration-required": "failed-precondition",
      "inventory-invalid-quantity": "failed-precondition",
      "inventory-invalid-reserved": "failed-precondition",
      "inventory-invariant-broken": "failed-precondition",
      "batch-unpriced": "failed-precondition",
      "price-not-confirmed": "failed-precondition",
      "invalid-requested-date": "invalid-argument",
      "requested-date-required": "invalid-argument",
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
      // Inventory allocation, failure returns and stock addition.
      "order-not-fully-reserved": "failed-precondition",
      "order-not-failed": "failed-precondition",
      "legacy-order-not-requeueable": "failed-precondition",
      "inventory-quantity-unconfirmed": "failed-precondition",
      "batch-id-exists": "already-exists",
      "vaccine-not-found": "not-found",
      "invalid-stock-batch": "invalid-argument",
      "unknown-field": "invalid-argument",
      "return-not-found": "not-found",
      "return-already-resolved": "failed-precondition",
      "invalid-disposition": "invalid-argument",
      "invalid-notes": "invalid-argument",
      // An order-history record with this id already holds different content.
      // Nothing was written or changed (orderHistory.js).
      "history-integrity-conflict": "failed-precondition",
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
// Per-project App Check enforcement (see the header). Read once, at deploy.
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";

function callable(name, run) {
  return onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Please sign in and try again.");
    }
    try {
      // `now` is the server's clock, taken once per invocation so a retried
      // transaction cannot see the expiry cutoff move underneath it.
      // `email` is the caller's Firebase Auth email from the verified ID
      // token (null when the account has none) — never a client-sent value.
      const email = typeof request.auth?.token?.email === "string" ? request.auth.token.email : null;
      return await run({ db, FieldValue, uid, email, data: request.data ?? {}, now: new Date() });
    } catch (error) {
      throw toHttpsError(error, name);
    }
  });
}

exports.createOrderWithReservation = callable(
  "createOrderWithReservation",
  // `email` (from the verified token) is snapshotted onto the order's
  // confirmation receipt; it never decides anything.
  ({ db, FieldValue, uid, email, data, now }) =>
    operations.createOrderWithReservation({ db, FieldValue, uid, email, payload: data, now })
);

exports.correctOrderDestination = callable(
  "correctOrderDestination",
  // Keep the deployed legacy endpoint fail-closed: older web bundles must
  // never bypass the Med Rep approval by calling its former immediate write.
  () => { throw new PolicyError("workflow-updated", "Reload the app. Destination changes now require Med Rep approval."); }
);

exports.requestOrderDestinationChange = callable(
  "requestOrderDestinationChange",
  ({ db, FieldValue, uid, data }) =>
    destinationOperations.requestOrderDestinationChange({ db, FieldValue, uid, payload: data })
);

exports.reviewOrderDestinationChange = callable(
  "reviewOrderDestinationChange",
  ({ db, FieldValue, uid, data }) =>
    destinationOperations.reviewOrderDestinationChange({ db, FieldValue, uid, payload: data })
);

// Admin-only: move an order's delivery date/time, before or after rider
// assignment or dispatch. Records who/when and a scheduleEvents entry; never
// touches price, VAT, discount, inventory, destination or status.
exports.rescheduleOrderDelivery = callable(
  "rescheduleOrderDelivery",
  ({ db, FieldValue, uid, data, now }) =>
    scheduleOperations.rescheduleOrderDelivery({ db, FieldValue, uid, payload: data, now })
);

exports.cancelOrderWithInventoryRelease = callable(
  "cancelOrderWithInventoryRelease",
  ({ db, FieldValue, uid, email, data, now }) =>
    operations.cancelOrderWithInventoryRelease({
      db,
      FieldValue,
      uid,
      email,
      orderId: data.orderId,
      reason: data.reason,
      now,
    })
);

exports.markOrderDeliveredWithInventoryConsumption = callable(
  "markOrderDeliveredWithInventoryConsumption",
  ({ db, FieldValue, uid, email, data, now }) =>
    operations.markOrderDeliveredWithInventoryConsumption({
      db,
      FieldValue,
      uid,
      email,
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

/**
 * Order status history (see src/statusEvents.js).
 *
 * Fires on every write to an order and records an event only when the status
 * actually changed. Its own `firstDispatchedAt` stamp re-fires it with an
 * unchanged status, which records nothing — so it cannot loop.
 */
// ---------------------------------------------------------------- inventory
//
// Stock addition, delivery failure, return disposition and failed-order requeue
// (src/inventoryWorkflow.js). Allocation itself is src/allocation.js.

exports.addStockBatchWithAllocation = callable(
  "addStockBatchWithAllocation",
  ({ db, FieldValue, uid, data, now }) =>
    inventoryWorkflow.addStockBatchWithAllocation({ db, FieldValue, uid, payload: data, now })
);

exports.reportDeliveryFailure = callable(
  "reportDeliveryFailure",
  ({ db, FieldValue, uid, email, data, now }) =>
    inventoryWorkflow.reportDeliveryFailure({ db, FieldValue, uid, email, payload: data, now })
);

exports.confirmReturnDisposition = callable(
  "confirmReturnDisposition",
  ({ db, FieldValue, uid, data, now }) =>
    inventoryWorkflow.confirmReturnDisposition({ db, FieldValue, uid, payload: data, now })
);

exports.requeueFailedOrder = callable(
  "requeueFailedOrder",
  ({ db, FieldValue, uid, email, data, now }) =>
    inventoryWorkflow.requeueFailedOrder({ db, FieldValue, uid, email, payload: data, now })
);

exports.getReservationProvenance = callable(
  "getReservationProvenance",
  ({ db, uid, data, now }) => inventoryWorkflow.getReservationProvenance({ db, uid, payload: data, now })
);

// Safety net. The callables allocate synchronously; these re-run allocation
// when free stock grows by any path (including an admin stock correction) or an
// order newly joins the queue — e.g. if a synchronous round lost a race.
// Allocation is idempotent and writes nothing when there is nothing to do, so
// its own writes re-triggering these are harmless no-ops.
exports.allocateOnInventoryWrite = onDocumentWritten(
  { document: "inventory/{inventoryId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const now = new Date();
    const productKeys = inventoryWorkflow.productKeysForInventoryWrite(before, after, now);
    if (productKeys.length === 0) return;
    await allocation.allocateProducts({ db, FieldValue, productKeys, now, source: { operation: "allocateOnInventoryWrite" } });
  }
);

exports.allocateOnOrderWrite = onDocumentWritten(
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const productKeys = inventoryWorkflow.productKeysForOrderWrite(before, after);
    if (productKeys.length === 0) return;
    await allocation.allocateProducts({
      db,
      FieldValue,
      productKeys,
      now: new Date(),
      source: { operation: "allocateOnOrderWrite" },
    });
  }
);

// Allocation that outgrew one bounded run continues here (allocation.js
// allocateProduct → allocationContinuations/{productKey}). Each link exists only
// because the previous one made progress, and a chain is capped, so it always
// ends; marking a finished record "done" re-triggers this as a no-op.
exports.continueAllocation = onDocumentWritten(
  { document: "allocationContinuations/{productKey}", retry: true },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    await allocation.runContinuation({
      db,
      FieldValue,
      productKey: event.params.productKey,
      data: after,
      now: new Date(),
    });
  }
);

// Order history outbox (src/orderHistoryOutbox.js). Every new order's creation
// transaction creates orderHistoryOutbox/{orderId} { status: "pending" }; this
// records the order's initial-allocation outcome if the placing call did not
// (it stopped between transactions, or its allocation failed). retry: true, so
// a transient failure is retried; the marker makes a duplicate impossible, and
// marking it "done" re-fires this trigger as a no-op.
exports.materializeOrderHistory = onDocumentWritten(
  { document: "orderHistoryOutbox/{orderId}", retry: true },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || after.status !== "pending") return;
    const result = await orderHistoryOutbox.materializeInitialHistory({
      db,
      FieldValue,
      orderId: event.params.orderId,
      now: new Date(),
      materializedBy: "materializeOrderHistory",
      allocate: true,
    });
    if (result.reason === "integrity-conflict") {
      logger.error("materializeOrderHistory: integrity conflict, nothing overwritten", {
        orderId: event.params.orderId,
        fields: result.fields,
      });
    }
  }
);

// TEMPORARY COMPATIBILITY (Rider builds released before reportDeliveryFailure).
// Those builds write in_transit|delayed → delivery_failed directly; while the
// rules still accept that one write, this settles its stock exactly like the
// callable (reserved → return-pending + a pending return). Remove together with
// legacyRiderFailureWritesAllowed() in firestore.rules.
exports.settleClientReportedFailure = onDocumentWritten(
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const result = await failureReturn.settleClientReportedFailure({
      db,
      FieldValue,
      orderId: event.params.orderId,
      before,
      after,
    });
    // Adoption telemetry for the rollout: every hit is an OLD Rider build still
    // writing failures directly. Phase 2 (strict rules) waits until this stops.
    // Ids only — no reason text, no personal data.
    if (result) {
      logger.info("legacy-rider-failure-write", {
        orderId: event.params.orderId,
        riderUid: after?.deliveryFailedByUid ?? null,
        settled: result.settled === true,
      });
    }
  }
);

exports.recordOrderStatusEvent = onDocumentWritten(
  // retry: a transient failure must not lose a history entry. Safe because the
  // CloudEvent id is the event document id, so a redelivery is a no-op.
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const statusEvent = statusEvents.deriveStatusEvent({ before, after });
    if (!statusEvent) return;

    const orderId = event.params.orderId;
    try {
      const result = await statusEvents.recordStatusEvent({
        db,
        orderId,
        eventId: event.id,
        event: statusEvent,
        at: event.data.after.updateTime,
      });
      if (!result.recorded) {
        logger.info("recordOrderStatusEvent: skipped", { orderId, reason: result.reason });
      }
    } catch (error) {
      // Rethrown so the platform retries; the event id keeps a retry idempotent.
      logger.error("recordOrderStatusEvent failed", { orderId, code: error?.code ?? null });
      throw error;
    }
  }
);
