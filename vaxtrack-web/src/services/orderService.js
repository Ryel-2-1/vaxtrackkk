import {
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  query,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { assignRiderToOrderOnServer, RiderDispatchError } from "./riderDispatchService";
import {
  ACTOR_DISPATCHER,
  assertTransition,
  MAX_REASON_LENGTH,
  normalizeStatus,
  validateReason,
  WorkflowError,
} from "./orderWorkflow";
import { UserMessageError } from "./userMessageError.js";
import { motorcycleRouteMetadata } from "./routeMetadata.js";
import { logSafeError } from "./liveDataErrors.js";
import { listenLive } from "./liveSnapshot.js";

const ORDERS_COLLECTION = "orders";

// IDENTITY RULE for every order read in this file.
//
// The Firestore document id is the order's only identity: every write in the
// app targets `orders/{id}`, and the rules match a rider's own orders on that
// path. Spreading the document data AFTER `id` let a stored field named `id`
// silently replace it, which would point a later assign/status/cargo write at
// a different document. So the document id is always assigned last and wins.
//
// It is never derived from `orderNumber`, an invoice number, `clinicId`,
// `clinicDocId`, or a rider identifier — those are business identifiers and
// are not interchangeable with document identity.
export async function getOrderById(orderId) {
  if (!orderId) return null;
  const snap = await getDoc(doc(db, ORDERS_COLLECTION, orderId));
  if (!snap.exists()) return null;
  return { ...snap.data(), id: snap.id };
}

export function subscribeSalesRepOrders(uid, callback, onError) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("createdByUid", "==", uid)
  );

  return listenLive(
    q,
    (snapshot) => {
      const orders = snapshot.docs
        // document id last — see the identity rule above
        .map((docItem) => ({ ...docItem.data(), id: docItem.id }))
        .sort((a, b) => {
          const aMs = a.createdAt?.toMillis?.() ?? 0;
          const bMs = b.createdAt?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      callback(orders);
    },
    (error) => {
      logSafeError("subscribeSalesRepOrders", error);
      if (onError) onError(error);
    }
  );
}

// Live: every pending_dispatch order, re-delivered on every change (an
// assignment here or in another browser removes the order from the next
// snapshot). `onError` is optional; without it a failure is silent, as before.
export function subscribePendingDispatchOrders(callback, onError) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("status", "==", "pending_dispatch")
  );

  return listenLive(
    q,
    (snapshot) => {
      // document id last — see the identity rule above
      const orders = snapshot.docs.map((docItem) => ({
        ...docItem.data(),
        id: docItem.id,
      }));

      callback(orders);
    },
    (error) => onError?.(error)
  );
}

/**
 * A rejected assignment. `code` is stable and machine-readable; `message` is
 * already phrased for display, so the page can surface it without translating.
 */
export class AssignmentError extends UserMessageError {
  // `details` is optional context for the page (e.g. the status the order was
  // found in), never shown raw.
  constructor(code, message, details) {
    super(message);
    this.name = "AssignmentError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Assign an approved rider to a pending order — on the server.
 *
 * Takes the order DOCUMENT id and the rider's Firestore/Auth UID (the users
 * document id); an employee id or any display identifier is never accepted.
 *
 * Since Rider trips this is the assignRiderToOrder callable
 * (functions/src/riderDispatchOps.js), not a client transaction: the decision
 * needs the Rider's server-owned trip state, which no client write can read
 * reliably. In one transaction the server re-reads the order (still
 * pending_dispatch, unassigned, its date reached, fully reserved), the rider
 * (stored role `rider`, status `approved`) and the Rider's trip — an order
 * joins a trip only before departure, so a Rider on the road or returning to
 * the hub is refused. Two dispatchers racing for one order, or two orders
 * racing for one Rider, serialize there. firestore.rules refuse the direct
 * write, Admin included.
 *
 * Display fields and the audit (who assigned, when) are written by the server
 * from the rider document and the verified caller — never from this page.
 *
 * @returns {Promise<{orderId: string, riderUid: string, tripId: string, replayed: boolean}>}
 * @throws {AssignmentError} with the server's stable code (order-not-pending,
 *   order-already-assigned, rider-on-trip, rider-returning, …)
 */
export async function assignRiderToOrder(orderId, riderUid) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new AssignmentError("order-id-required", "Order ID is required.");
  }
  if (typeof riderUid !== "string" || riderUid.trim() === "") {
    throw new AssignmentError("rider-uid-required", "Please select an available rider.");
  }
  if (!auth.currentUser?.uid) {
    throw new AssignmentError("not-signed-in", "Your session has expired. Please sign in again.");
  }
  try {
    return await assignRiderToOrderOnServer(orderId, riderUid);
  } catch (error) {
    // Keep the page's error type: the code and the server's sentence (and any
    // context, e.g. the status the order was found in) pass through as-is.
    if (error instanceof RiderDispatchError) {
      throw new AssignmentError(error.code, error.message, error.details ?? undefined);
    }
    throw error;
  }
}

export function subscribeAssignedRiderOrders(riderId, callback) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("assignedRiderId", "==", riderId)
  );

  return listenLive(q, (snapshot) => {
    const orders = snapshot.docs
      // document id last — see the identity rule above
      .map((docItem) => ({
        ...docItem.data(),
        id: docItem.id,
      }))
      .filter(
        (order) => order.status === "assigned" || order.status === "in_transit"
      );

    callback(orders);
  });
}

/*
 * Failed-delivery recovery used to be a client transaction here
 * (`reassignFailedOrder`, delivery_failed → assigned). It was removed: the
 * failed order's stock now goes to return-pending on the server, so recovery
 * must re-enter allocation. It is the `requeueFailedOrder` callable
 * (inventoryCallables.js), and firestore.rules refuse any client write out of
 * delivery_failed.
 */

/**
 * The longest cancellation reason that may be stored. Mirrored exactly by
 * `maxReasonLength()` in firestore.rules and by MAX_REASON_LENGTH in
 * orderWorkflow.
 */
export const MAX_CANCEL_REASON_LENGTH = MAX_REASON_LENGTH;

/**
 * Cancel a non-terminal order, with a reason.
 *
 * This REPLACES the former `updateOrderStatus(orderId, newStatus, …)`, which
 * accepted any string at all — it would happily write `delivered`, `delayed`,
 * or a typo, from any current status, on behalf of a dispatcher. Cancellation
 * is the only status change a dispatcher performs outside Cargo Loading and
 * assignment, so that is the only operation exported here: there is no longer
 * a generic writer to route around the policy with.
 *
 * The order is re-read inside a transaction and the move is checked against
 * the shared matrix, so an order that has already been delivered, cancelled, or
 * changed since the screen rendered cannot be cancelled.
 *
 * @param {string} orderId
 * @param {string} reason required, trimmed, non-empty
 * @returns {Promise<{orderId: string, status: 'cancelled', cancelReason: string}>}
 * @throws {WorkflowError}
 */
/**
 * ⚠️ SUPERSEDED — no page calls this, and Firestore rules refuse it.
 *
 * Cancelling releases the order's reserved stock, which has to commit with the
 * status change, so it moved to `cancelOrderWithInventoryRelease`. The rules no
 * longer accept a client `cancelled` write from any role.
 *
 * Kept for its transition and reason tests, which still describe the contract
 * the callable enforces server-side.
 */
export async function cancelOrderByDispatcher(orderId, reason) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new WorkflowError("order-id-required", "Order ID is required.");
  }

  // Same shared rule every reason field in this workflow uses.
  const checked = validateReason(reason, { label: "reason to cancel this order" });
  if (!checked.ok) {
    throw new WorkflowError(
      checked.code === "reason-required"
        ? "cancel-reason-required"
        : "cancel-reason-too-long",
      checked.message
    );
  }
  const cancelReason = checked.value;

  const currentUser = auth.currentUser;
  if (!currentUser?.uid) {
    throw new WorkflowError(
      "not-signed-in",
      "Your session has expired. Please sign in again."
    );
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) {
      throw new WorkflowError("order-not-found", "That order no longer exists.");
    }
    const current = normalizeStatus(snap.data().status);

    // Rejects terminal orders, unknown statuses and every non-cancel move.
    assertTransition(ACTOR_DISPATCHER, current, "cancelled");

    tx.update(orderRef, {
      status: "cancelled",
      cancelReason,
      cancelledAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      ...(currentUser.email ? { statusUpdatedByEmail: currentUser.email } : {}),
    });

    return { orderId, status: "cancelled", cancelReason };
  });
}

// Persist a generated route + ETA onto an order (Dispatcher Geofence,
// motorcycle routing). Only these route fields (+ updatedAt) are written, so the
// dispatcher rule allowlist (`dispatcherOrderFields`) permits it. `route` comes
// from routeService.fetchRoute plus a computed `etaText`.
export async function saveOrderRoute(orderId, route, destinationRevision = 0) {
  if (!orderId) throw new Error("Order ID is required.");
  if (!route?.polyline) throw new Error("Route polyline is required.");
  if (!Number.isSafeInteger(destinationRevision) || destinationRevision < 0) {
    throw new UserMessageError("Refresh the destination before generating a route.");
  }

  const metadata = motorcycleRouteMetadata(route);
  const orderRef = doc(db, ORDERS_COLLECTION, orderId);
  return updateDoc(orderRef, {
    routePolyline: route.polyline,
    routeDistanceMeters: Number(route.distanceMeters) || 0,
    routeDurationSeconds: Number(route.durationSeconds) || 0,
    routeEtaText: route.etaText || "",
    routeGeneratedAt: serverTimestamp(),
    ...metadata,
    // Rules compare this to the order's current revision. A route fetched for
    // old coordinates cannot be written after a destination correction.
    routeDestinationRevision: destinationRevision,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Save an optimized multi-stop trip across a rider's orders, atomically.
 *
 * Every order in the group gets the SAME trip identity + whole-trip route
 * (`tripId`, `tripPolyline`, total distance/duration, `tripStopCount`) plus its
 * OWN place in the tour (`stopSequence`, `stopEtaSeconds`, `stopEtaText`). One
 * `writeBatch` so the group can never be left half-sequenced.
 *
 * The trip fields are set at optimization time by the dispatcher and never by
 * riders — the Firestore rules allow them only in `dispatcherOrderFields()`.
 *
 * @param {{
 *   tripId?: string,
 *   polyline: string,
 *   distanceMeters: number,
 *   durationSeconds: number,
 *   stops: {orderId: string, sequence: number, etaSeconds: number, etaText?: string}[],
 * }} trip
 * @returns {Promise<{tripId: string, stopCount: number}>}
 */
export async function saveRiderTripRoute(trip) {
  if (!trip?.polyline) throw new Error("Trip polyline is required.");
  const stops = Array.isArray(trip.stops) ? trip.stops : [];
  if (stops.length < 2) {
    throw new Error("A trip needs at least two stops.");
  }
  const metadata = motorcycleRouteMetadata(trip, true);
  const tripId = trip.tripId || crypto.randomUUID();
  const stopCount = stops.length;
  const distanceMeters = Number(trip.distanceMeters) || 0;
  const durationSeconds = Number(trip.durationSeconds) || 0;

  const batch = writeBatch(db);
  for (const stop of stops) {
    if (!stop?.orderId) throw new Error("Every stop needs an order id.");
    batch.update(doc(db, ORDERS_COLLECTION, stop.orderId), {
      tripId,
      tripStopCount: stopCount,
      tripPolyline: trip.polyline,
      tripDistanceMeters: distanceMeters,
      tripDurationSeconds: durationSeconds,
      stopSequence: Number(stop.sequence) || 0,
      stopEtaSeconds: Number(stop.etaSeconds) || 0,
      stopEtaText: stop.etaText || "",
      tripGeneratedAt: serverTimestamp(),
      ...metadata,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return { tripId, stopCount };
}
