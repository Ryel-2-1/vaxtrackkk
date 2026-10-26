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
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
const riderTrackingOps = require("./src/riderTrackingOps");
const deliveryTimingOps = require("./src/deliveryTimingOps");
const riderDispatchOps = require("./src/riderDispatchOps");
const riderRecoveryOps = require("./src/riderRecoveryOps");
const { qaResetConfig } = require("./src/riderRecovery");

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
      // A Delayed delivery must be resumed (in transit) before proof/completion.
      "delivery-delayed": "failed-precondition",
      "proof-missing": "failed-precondition",
      "invoice-missing": "failed-precondition",
      "evidence-not-yours": "failed-precondition",
      // Clinic delivery geofence (deliveryGeofence.js): the Rider is not
      // provably at the destination right now. Retryable once that changes.
      "delivery-outside-geofence": "failed-precondition",
      "rider-location-stale": "failed-precondition",
      "rider-location-inaccurate": "failed-precondition",
      "rider-location-unavailable": "failed-precondition",
      "delivery-destination-invalid": "failed-precondition",
      "insufficient-stock": "failed-precondition",
      "batch-expired": "failed-precondition",
      "batch-unavailable": "failed-precondition",
      "inventory-migration-required": "failed-precondition",
      "inventory-invalid-quantity": "failed-precondition",
      "inventory-invalid-reserved": "failed-precondition",
      "inventory-invariant-broken": "failed-precondition",
      "batch-unpriced": "failed-precondition",
      // A batch whose price was recorded VAT-exclusive (before the VAT-inclusive
      // rule) stays unorderable until an Admin re-confirms it. Never reinterpreted.
      "batch-price-convention-legacy": "failed-precondition",
      "price-convention-required": "failed-precondition",
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
      // Negotiated pricing (negotiatedPricing.js): a changed price must be a
      // valid amount and explained.
      "invalid-agreed-price": "invalid-argument",
      "negotiation-reason-required": "invalid-argument",
      // Statutory (SC/PWD) line discounts.
      "invalid-statutory-discount": "invalid-argument",
      "statutory-discount-type-required": "invalid-argument",
      "statutory-discount-exceeds-line": "invalid-argument",
      "eligibility-not-confirmed": "invalid-argument",
      "discount-recorded-per-line": "failed-precondition",
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
      // Rider trips (riderDispatchOps.js).
      "rider-not-found": "not-found",
      "not-a-rider": "failed-precondition",
      "rider-not-approved": "failed-precondition",
      "rider-on-trip": "failed-precondition",
      "rider-returning": "failed-precondition",
      "rider-state-unknown": "failed-precondition",
      "order-not-pending": "failed-precondition",
      "order-already-assigned": "failed-precondition",
      "order-not-dispatchable": "failed-precondition",
      "order-not-loaded": "failed-precondition",
      "scheduled-date-not-reached": "failed-precondition",
      "scheduled-date-missing": "failed-precondition",
      "scheduled-date-invalid": "failed-precondition",
      "trip-not-forming": "failed-precondition",
      "trip-not-settled": "failed-precondition",
      "trip-full": "failed-precondition",
      // The trip moved underneath the caller — refresh, then retry.
      "trip-changed": "aborted",
      // Admin Rider recovery (riderRecoveryOps.js).
      "recovery-stale": "aborted",
      "recovery-blocked": "failed-precondition",
      "recovery-too-large": "failed-precondition",
      "qa-reset-disabled": "permission-denied",
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

// Rider preflight before evidence upload: inside the delivery geofence now?
// Reads only. The completion below repeats the decision authoritatively.
exports.validateDeliveryCompletionGeofence = callable(
  "validateDeliveryCompletionGeofence",
  ({ db, uid, data, now }) =>
    // `payload` is checked to carry the order id ONLY (no status, destination,
    // radius or location may be supplied by the client).
    operations.validateDeliveryCompletionGeofence({ db, uid, orderId: data.orderId, payload: data, now })
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
      payload: data,
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

// ---------------------------------------------------------------- rider trips
//
// One server-owned state per Rider (riderDispatchStates/{uid}) and a
// server-generated trip id (riderTrips). Orders join a trip only before
// departure; Finalize Dispatch sends the whole trip; once every trip order is
// settled the Rider is returning_to_hub until a Dispatcher/Admin confirms the
// physical return. Assignment and departure are refused to every client by
// firestore.rules — these callables are the only path.
exports.assignRiderToOrder = callable(
  "assignRiderToOrder",
  ({ db, FieldValue, uid, email, data, now }) =>
    riderDispatchOps.assignRiderToOrder({ db, FieldValue, uid, email, payload: data, now })
);

exports.finalizeRiderDispatch = callable(
  "finalizeRiderDispatch",
  ({ db, FieldValue, uid, email, data, now }) =>
    riderDispatchOps.finalizeRiderDispatch({ db, FieldValue, uid, email, payload: data, now })
);

exports.confirmRiderReturnToHub = callable(
  "confirmRiderReturnToHub",
  ({ db, FieldValue, uid, data }) => riderDispatchOps.confirmRiderReturnToHub({ db, FieldValue, uid, payload: data })
);

// Repair for a trip state a missed or failed trigger event left stale: a
// Dispatcher/Admin re-derives the named Riders' state from their orders (the
// same transaction the trigger runs). Never frees a Rider after a departure.
exports.recheckRiderTripStates = callable(
  "recheckRiderTripStates",
  ({ db, FieldValue, uid, data }) => riderDispatchOps.recheckRiderTripStates({ db, FieldValue, uid, payload: data })
);

// Admin Rider recovery (src/riderRecoveryOps.js): a read-only preview, then
// confirm_return or qa_reset against that preview's version.
//
// QA trip reset is STAGING/DEMO ONLY and fails closed: it needs BOTH an allowed
// project id (never production) AND QA_RIDER_RESET_ENABLED=true in
// functions/.env.<projectId>, read at deploy. A browser setting decides nothing.
const RIDER_QA_RESET = qaResetConfig({
  projectId: process.env.GCLOUD_PROJECT || (() => {
    try {
      return JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
    } catch {
      return null;
    }
  })(),
  flag: process.env.QA_RIDER_RESET_ENABLED,
});

exports.previewRiderRecovery = callable(
  "previewRiderRecovery",
  ({ db, uid, data }) => riderRecoveryOps.previewRiderRecovery({ db, uid, payload: data, config: RIDER_QA_RESET })
);

exports.applyRiderRecovery = callable(
  "applyRiderRecovery",
  ({ db, FieldValue, uid, email, data }) =>
    riderRecoveryOps.applyRiderRecovery({ db, FieldValue, uid, email, payload: data, config: RIDER_QA_RESET })
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
        // The dispatch event also freezes the delivery-timing baseline from
        // this write's own snapshot (statusEvents.recordStatusEvent).
        after,
        FieldValue,
        Timestamp: admin.firestore.Timestamp,
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

// ---------------------------------------------------------------- rider tracking
//
// Rider live location + route deviation (src/riderTracking.js is the contract,
// src/riderTrackingOps.js the transactions). The Rider app only REPORTS its
// position (riderLocations/{uid}) and which order it is navigating
// (riderNavigationSessions/{uid}); every deviation decision, alert and event is
// made here, so a client can never forge one. All handlers are retry-safe: they
// re-read the current documents in a transaction and replays are no-ops.

exports.trackRiderLocation = onDocumentWritten(
  { document: "riderLocations/{riderUid}", retry: true },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || after.riderUid !== event.params.riderUid) return;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const result = await riderTrackingOps.processLocationWrite({
      db,
      FieldValue,
      riderUid: event.params.riderUid,
      location: after,
      // The previous fix: continuity is judged from it, so an unchanged
      // deviation state never has to be rewritten per sample.
      previous: before,
    });
    // Ids and outcome only — never coordinates.
    if (result.event) logger.info("route-deviation-transition", { riderUid: event.params.riderUid, event: result.event });
  }
);

exports.trackNavigationSession = onDocumentWritten(
  { document: "riderNavigationSessions/{riderUid}", retry: true },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    // A write that only confirms a navigation fix is skipped (no transaction).
    await riderTrackingOps.handleSessionWrite({ db, FieldValue, riderUid: event.params.riderUid, after, before });
  }
);

// Trip membership and settlement after ANY order change: a cancellation before
// departure leaves the forming trip; delivered / cancelled / failed / requeued
// orders settle it; the last one moves the Rider to returning_to_hub. Also
// folds in assignments written directly by a client during the rollout window
// (before the rules forbid it) — logged as anomalies, never silently dropped.
exports.reconcileRiderDispatchOnOrderWrite = onDocumentWritten(
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const results = await riderDispatchOps.reconcileRiderOnOrderWrite({ db, FieldValue, before, after });
    for (const r of results) {
      if (r.anomalies?.length) {
        logger.warn("rider-dispatch-anomaly", { orderId: event.params.orderId, riderUid: r.riderUid, anomalies: r.anomalies });
      }
      // Fail closed: an assigned order whose status cannot be placed leaves the
      // Rider's state untouched, and every trip decision for them is refused.
      if (r.unknown) {
        logger.error("rider-dispatch-unknown-order", { orderId: event.params.orderId, riderUid: r.riderUid, orderIds: r.orderIds });
      }
      if (r.recovered) {
        logger.warn("rider-dispatch-recovered", { orderId: event.params.orderId, riderUid: r.riderUid, state: r.state });
      }
    }
  }
);

exports.syncRiderTrackingOnOrderWrite = onDocumentWritten(
  { document: "orders/{orderId}", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    await riderTrackingOps.handleOrderWrite({ db, FieldValue, orderId: event.params.orderId, before, after });
  }
);

// ---------------------------------------------------------------- delivery timing
//
// Automatic delivery timing (src/deliveryTiming.js): every 5 minutes, the
// orders whose next timing check is DUE (timingActive && timingNextCheckAt <=
// now; composite index in firestore.indexes.json) move forward on_time →
// at_risk → delayed by SERVER time. Never changes the lifecycle status and
// never blocks proof or completion; the first "delayed" records one history
// event and one alert. Each processed order leaves the due set, so a backlog
// drains oldest-first; overlapping or retried runs are no-ops.
exports.evaluateDeliveryTiming = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Asia/Manila" },
  async () => {
    const counts = await deliveryTimingOps.evaluateDeliveryTimingRun({
      db, FieldValue, Timestamp: admin.firestore.Timestamp, now: new Date(),
    });
    if (counts.scanned > 0) logger.info("delivery-timing", counts);
  }
);

// Retention: precise location is never kept indefinitely (src/riderTracking.js RETENTION).
exports.purgeRiderTrackingData = onSchedule(
  { schedule: "every 6 hours", timeZone: "Asia/Manila" },
  async () => {
    const counts = await riderTrackingOps.purgeExpiredTrackingData({
      db,
      Timestamp: admin.firestore.Timestamp,
      now: new Date(),
    });
    logger.info("rider-tracking-retention", counts);
  }
);
