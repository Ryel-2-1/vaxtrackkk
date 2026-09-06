import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  query,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { buildClinicLocationSnapshot } from "./orderLocation";
import {
  ACTOR_DISPATCHER,
  assertTransition,
  MAX_REASON_LENGTH,
  normalizeStatus,
  validateReason,
  WorkflowError,
} from "./orderWorkflow";

const ORDERS_COLLECTION = "orders";
const USERS_COLLECTION = "users";

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

/**
 * ⚠️ SUPERSEDED — no page calls this, and Firestore rules refuse it.
 *
 * Creating an order reserves stock, and a client `addDoc` cannot commit
 * together with the reservation, so the whole operation moved to the trusted
 * callable `createOrderWithReservation`. The rules now allow order creation to
 * ADMIN only, so a sales-rep call fails with permission-denied.
 *
 * Kept for its field-shape and clinic-snapshot tests, which still describe what
 * an order document must look like — the callable builds the same shape. It is
 * not a live path and must not become one; add fields to the callable instead.
 */
export async function createSalesRepOrder(orderData = {}) {
  if (!orderData.clinicName) {
    throw new Error("Clinic name is required.");
  }
  if (!orderData.vaccineName) {
    throw new Error("Vaccine name is required.");
  }
  if (!orderData.quantity || orderData.quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  const orderNumber = orderData.orderNumber || `VT-ORD-${Date.now()}`;

  const doc = {
    orderNumber,
    clinicName: orderData.clinicName,
    clinicAddress: orderData.clinicAddress || "",
    vaccineName: orderData.vaccineName,
    vaccineType: orderData.vaccineType || "",
    quantity: Number(orderData.quantity),
    unit: orderData.unit || "vials",
    storageTemp: orderData.storageTemp || "",
    priority: orderData.priority || "Standard",

    status: "pending_dispatch",

    assignedRiderId: null,
    assignedRiderName: null,

    createdByRole: "sales_rep",
    createdByUid: orderData.createdByUid || null,
    createdByEmail: orderData.createdByEmail || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (orderData.region) {
    doc.region = orderData.region;
  }

  if (orderData.deliveryInstructions) {
    doc.deliveryInstructions = orderData.deliveryInstructions;
  }

  // Order-time snapshot of the clinic's delivery location.
  //
  // Derived ONLY from the selected clinic record plus its Firestore document
  // id. Any `clinicLat` / `clinicLng` / `clinicGeofenceRadiusM` /
  // `clinicLocationVerified` a caller puts on `orderData` is deliberately
  // ignored — otherwise a client could pair a real clinic with a destination of
  // its own choosing. Firestore rules re-verify the result against the clinic
  // document, so this is the first of two independent checks, not the only one.
  //
  // This also fixes a real bug: the caller has always sent a clinic reference,
  // but the document below is built from an explicit field list, so it was
  // silently dropped and NO order in the collection carried one.
  const { fields: clinicLocationFields } = buildClinicLocationSnapshot(
    orderData.clinicDocId,
    orderData.clinic
  );
  Object.assign(doc, clinicLocationFields);

  // Server-stamped so the snapshot's own age is trustworthy. Always written,
  // including for a clinic with no usable location — "we looked, and there was
  // nothing verified to copy" is itself the fact worth recording.
  doc.clinicLocationSnapshotAt = serverTimestamp();

  if (Array.isArray(orderData.items) && orderData.items.length > 0) {
    doc.items = orderData.items.map((item) => ({
      name: item.name || "",
      sku: item.sku || "",
      chain: item.chain || item.temp || item.category || "",
      quantity: Number(item.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
    }));
  }

  return addDoc(collection(db, ORDERS_COLLECTION), doc);
}

export function subscribeSalesRepOrders(uid, callback, onError) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("createdByUid", "==", uid)
  );

  return onSnapshot(
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
      console.error("subscribeSalesRepOrders error:", error);
      if (onError) onError(error);
    }
  );
}

export function subscribePendingDispatchOrders(callback) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("status", "==", "pending_dispatch")
  );

  return onSnapshot(q, (snapshot) => {
    // document id last — see the identity rule above
    const orders = snapshot.docs.map((docItem) => ({
      ...docItem.data(),
      id: docItem.id,
    }));

    callback(orders);
  });
}

/**
 * A rejected assignment. `code` is stable and machine-readable; `message` is
 * already phrased for display, so the page can surface it without translating.
 */
export class AssignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssignmentError";
    this.code = code;
  }
}

// The canonical rider identity, matched exactly. A user is assignable only when
// their STORED role and status say so — never because the UI offered them.
const RIDER_ROLE = "rider";
const RIDER_APPROVED_STATUS = "approved";
const ASSIGNABLE_FROM_STATUS = "pending_dispatch";

/** First non-empty trimmed string, or null. Never invents a value. */
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * Whether an order already carries a rider.
 *
 * Absent, null and the empty string mean unassigned — sales-rep-created orders
 * start with an explicit null. Deliberately uses the RAW string length rather
 * than a trimmed one so this agrees exactly with `hasNoAssignedRider()` in
 * firestore.rules, which can only test `size() == 0`. If the two disagreed, a
 * whitespace-only value would pass here and then be refused by the rules.
 * Anything that is not a string is treated as assigned, matching the rule.
 */
function hasAssignedRider(order) {
  const value = order.assignedRiderId;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  return true;
}

/**
 * Assign an approved rider to a pending order, atomically.
 *
 * Takes the order DOCUMENT id and the rider's Firestore/Auth UID — the same
 * value as the `users` document id. An employee id or any other display
 * identifier is never accepted as the assignment identity.
 *
 * Everything that decides whether the assignment is legal is re-read INSIDE a
 * transaction, so the caller's view of the world is never trusted:
 *
 *   - the order must exist, still be `pending_dispatch`, and still carry no
 *     usable `assignedRiderId`;
 *   - the user must exist, with stored role exactly `rider` and stored status
 *     exactly `approved`.
 *
 * That closes the race the previous version had: the order id arrived from
 * localStorage and was written with `updateDoc`, so two dispatchers acting on
 * the same queue entry both succeeded and the later write silently replaced the
 * earlier rider. Firestore re-runs a transaction whose read set changed, so the
 * loser now re-reads an order that is already `assigned` and is rejected.
 *
 * A rider may hold any number of active deliveries — no per-rider limit is
 * enforced here, by decision.
 *
 * Display fields are copied from the rider DOCUMENT, never from the caller, and
 * only when genuinely present: a rider with no phone on record simply gets no
 * `assignedRiderPhone` rather than an invented one.
 *
 * @returns {Promise<{orderId: string, riderUid: string, assignedRiderName: string|null}>}
 * @throws {AssignmentError}
 */
export async function assignRiderToOrder(orderId, riderUid) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new AssignmentError("order-id-required", "Order ID is required.");
  }
  if (typeof riderUid !== "string" || riderUid.trim() === "") {
    throw new AssignmentError("rider-uid-required", "Please select an available rider.");
  }

  // The dispatcher's own identity comes from the session, not from a caller
  // argument, so the audit trail cannot be attributed to someone else. The
  // Firestore rule also requires this to equal request.auth.uid.
  const currentUser = auth.currentUser;
  if (!currentUser?.uid) {
    throw new AssignmentError(
      "not-signed-in",
      "Your session has expired. Please sign in again."
    );
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);
  const riderRef = doc(db, USERS_COLLECTION, riderUid);

  return runTransaction(db, async (tx) => {
    // Both reads happen before any write, as Firestore transactions require.
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      throw new AssignmentError("order-not-found", "That order no longer exists.");
    }
    const order = orderSnap.data();

    if (order.status !== ASSIGNABLE_FROM_STATUS) {
      throw new AssignmentError(
        "order-not-pending",
        "That order is no longer awaiting dispatch. Refresh the queue."
      );
    }
    if (hasAssignedRider(order)) {
      throw new AssignmentError(
        "order-already-assigned",
        "That order has already been assigned to a rider."
      );
    }

    const riderSnap = await tx.get(riderRef);
    if (!riderSnap.exists()) {
      throw new AssignmentError("rider-not-found", "That rider account no longer exists.");
    }
    const rider = riderSnap.data();

    if (rider.role !== RIDER_ROLE) {
      throw new AssignmentError("not-a-rider", "That account is not a rider.");
    }
    if (rider.status !== RIDER_APPROVED_STATUS) {
      throw new AssignmentError(
        "rider-not-approved",
        "That rider is not approved for assignment."
      );
    }

    // Authoritative display values, read from the rider document.
    const assignedRiderName = firstNonEmptyString(
      rider.fullName,
      rider.name,
      rider.displayName,
      rider.email
    );
    const assignedRiderPhone = firstNonEmptyString(rider.phone, rider.contactNumber);

    const update = {
      status: "assigned",
      assignedRiderId: riderUid,
      assignedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      assignedByUid: currentUser.uid,
    };
    if (assignedRiderName) update.assignedRiderName = assignedRiderName;
    if (assignedRiderPhone) update.assignedRiderPhone = assignedRiderPhone;
    if (currentUser.email) update.assignedByEmail = currentUser.email;

    tx.update(orderRef, update);

    return { orderId, riderUid, assignedRiderName };
  });
}

export function subscribeAssignedRiderOrders(riderId, callback) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("assignedRiderId", "==", riderId)
  );

  return onSnapshot(q, (snapshot) => {
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

export async function startRiderDelivery(orderId) {
  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);

  return updateDoc(orderRef, {
    status: "in_transit",
    startedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Recover a failed delivery by sending it back out to an approved rider.
 *
 * A DELIBERATELY SEPARATE entry point from `assignRiderToOrder`, not a relaxed
 * mode of it. That function only ever accepts `pending_dispatch`, and widening
 * it to also accept `delivery_failed` would have meant one function with two
 * meanings and a weaker precondition — exactly the kind of drift that lets a
 * failed order be treated as a fresh one. Both remain narrow.
 *
 * The order returns to `assigned` and re-enters the normal path through Cargo
 * Loading; it is never pushed straight back into transit, because the cargo has
 * to be handled and confirmed again.
 *
 * The same rider may be chosen again (a retry) or a different approved one (a
 * reassignment). Either way the rider's display fields are read from the user
 * DOCUMENT, never from the caller.
 *
 * The failure record — reason, timestamp, and which rider reported it — is
 * deliberately left untouched. Clearing it would make a twice-attempted order
 * indistinguishable from a new one.
 *
 * @param {string} orderId
 * @param {string} riderUid the users document id / Auth UID
 * @returns {Promise<{orderId: string, riderUid: string, previousAssignedRiderId: string|null, assignedRiderName: string|null}>}
 * @throws {AssignmentError}
 */
export async function reassignFailedOrder(orderId, riderUid) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new AssignmentError("order-id-required", "Order ID is required.");
  }
  if (typeof riderUid !== "string" || riderUid.trim() === "") {
    throw new AssignmentError("rider-uid-required", "Please select an available rider.");
  }

  const currentUser = auth.currentUser;
  if (!currentUser?.uid) {
    throw new AssignmentError(
      "not-signed-in",
      "Your session has expired. Please sign in again."
    );
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);
  const riderRef = doc(db, USERS_COLLECTION, riderUid);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      throw new AssignmentError("order-not-found", "That order no longer exists.");
    }
    const order = orderSnap.data();

    // Only a failed delivery may be recovered. Re-read inside the transaction,
    // so a screen that rendered before a dispatcher already recovered — or
    // cancelled — the order cannot act on the stale view.
    const current = normalizeStatus(order.status);
    if (current !== "delivery_failed") {
      throw new AssignmentError(
        "order-not-failed",
        "That order is no longer awaiting recovery. Refresh the list."
      );
    }
    // Belt and braces: the move itself must also be legal for a dispatcher.
    assertTransition(ACTOR_DISPATCHER, current, "assigned");

    const riderSnap = await tx.get(riderRef);
    if (!riderSnap.exists()) {
      throw new AssignmentError("rider-not-found", "That rider account no longer exists.");
    }
    const rider = riderSnap.data();
    if (rider.role !== RIDER_ROLE) {
      throw new AssignmentError("not-a-rider", "That account is not a rider.");
    }
    if (rider.status !== RIDER_APPROVED_STATUS) {
      throw new AssignmentError(
        "rider-not-approved",
        "That rider is not approved for assignment."
      );
    }

    const assignedRiderName = firstNonEmptyString(
      rider.fullName,
      rider.name,
      rider.displayName,
      rider.email
    );
    const assignedRiderPhone = firstNonEmptyString(rider.phone, rider.contactNumber);
    const previousAssignedRiderId = firstNonEmptyString(order.assignedRiderId);

    const update = {
      status: "assigned",
      assignedRiderId: riderUid,
      assignedAt: serverTimestamp(),
      assignedByUid: currentUser.uid,
      reassignedAt: serverTimestamp(),
      reassignedByUid: currentUser.uid,
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      // The order goes back through Cargo Loading, so the previous run's
      // loaded confirmation must not carry over.
      isLoaded: false,
    };
    if (previousAssignedRiderId) {
      update.previousAssignedRiderId = previousAssignedRiderId;
    }
    if (assignedRiderName) update.assignedRiderName = assignedRiderName;
    if (assignedRiderPhone) update.assignedRiderPhone = assignedRiderPhone;
    if (currentUser.email) {
      update.assignedByEmail = currentUser.email;
      update.statusUpdatedByEmail = currentUser.email;
    }

    // deliveryFailureReason / deliveryFailedAt / deliveryFailedByUid are NOT in
    // this update, so they survive untouched.
    tx.update(orderRef, update);

    return {
      orderId,
      riderUid,
      previousAssignedRiderId: previousAssignedRiderId ?? null,
      assignedRiderName,
    };
  });
}

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
// OpenRouteService). Only these route fields (+ updatedAt) are written, so the
// dispatcher rule allowlist (`dispatcherOrderFields`) permits it. `route` comes
// from routeService.fetchRoute plus a computed `etaText`.
export async function saveOrderRoute(orderId, route) {
  if (!orderId) throw new Error("Order ID is required.");
  if (!route?.polyline) throw new Error("Route polyline is required.");

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);
  return updateDoc(orderRef, {
    routePolyline: route.polyline,
    routeDistanceMeters: Number(route.distanceMeters) || 0,
    routeDurationSeconds: Number(route.durationSeconds) || 0,
    routeEtaText: route.etaText || "",
    routeGeneratedAt: serverTimestamp(),
    routeProvider: "openrouteservice",
    updatedAt: serverTimestamp(),
  });
}