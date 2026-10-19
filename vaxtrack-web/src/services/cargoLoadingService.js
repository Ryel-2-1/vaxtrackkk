import {
  collection,
  doc,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { getOrderStatusValue, normalizeStatusKey } from "./deliveryService";
import { dispatchEligibility } from "./dispatchEligibility";
import {
  ACTOR_DISPATCHER,
  assertTransition,
  canUpdateLoadingMetadata,
  normalizeStatus,
  WorkflowError,
} from "./orderWorkflow";
import { logSafeError } from "./liveDataErrors.js";
import { hasLoadingAudit } from "./loadingCustody.js";
import { listenLive } from "./liveSnapshot.js";
import { finalizeRiderTripOnServer } from "./riderDispatchService";

const ORDERS = "orders";
const USERS = "users";

/**
 * The loading custody audit for an order that has none yet: stamped by the
 * server clock and the signed-in dispatcher. firestore.rules accepts exactly
 * this (request.time, request.auth.uid, the token's email) and refuses any
 * write that clears or rewrites an audit already on the order.
 */
function loadingAuditStamp(currentUser) {
  return {
    loadedAt: serverTimestamp(),
    loadedByUid: currentUser.uid,
    ...(currentUser.email ? { loadedByEmail: currentUser.email } : {}),
  };
}

/**
 * Refuse a scheduled order before 00:00 Asia/Manila on its requested date, or
 * one whose stored date is unusable. firestore.rules enforces the same instant.
 * @throws {WorkflowError} code `scheduled-date-not-reached` / `scheduled-date-invalid`
 */
function assertScheduleReached(order) {
  const schedule = dispatchEligibility(order);
  if (!schedule.eligible) throw new WorkflowError(schedule.code, schedule.message);
}

// Orders that still need to be loaded / are part of the current dispatch prep.
// Delivered and cancelled orders are intentionally excluded.
const ACTIVE_LOADING_STATUSES = ["assigned", "loading"];

// Reuse the same field fallbacks used across the app for consistency.
function riderDisplayName(u) {
  return u.fullName || u.name || u.displayName || u.email || "Unknown Rider";
}

function riderPlate(u) {
  return u.vehiclePlate || u.motorcycle || u.motorcycleId || u.vehicle || "";
}

function isApprovedRider(u) {
  const role = (u.role || "").trim().toLowerCase();
  const status = (u.status || "").trim().toLowerCase();
  return role === "rider" && status === "approved";
}

// Sort orders inside a rider group: explicit deliverySequence first,
// then fall back to createdAt (oldest first) when no sequence exists.
function sortGroupOrders(a, b) {
  const aSeq = Number(a.deliverySequence);
  const bSeq = Number(b.deliverySequence);
  const aHasSeq = Number.isFinite(aSeq);
  const bHasSeq = Number.isFinite(bSeq);

  if (aHasSeq && bHasSeq) return aSeq - bSeq;
  if (aHasSeq) return -1;
  if (bHasSeq) return 1;

  const aMs = a.createdAt?.toMillis?.() ?? 0;
  const bMs = b.createdAt?.toMillis?.() ?? 0;
  return aMs - bMs;
}

/**
 * Subscribe to active assigned orders grouped by rider.
 *
 * Reads the whole `orders` and `users` collections and filters/groups
 * client-side. This mirrors subscribeDeliveries / subscribeRiders and avoids
 * requiring a Firestore composite index.
 *
 * The callback receives an array of groups:
 *   { riderId, rider, orders, totalOrders, loadedCount, allLoaded }
 *
 * Returns an unsubscribe function that detaches both listeners.
 */
export function subscribeCargoLoadingGroups(callback, onError) {
  let ridersById = {};
  let ordersRaw = [];
  let ridersLoaded = false;
  let ordersLoaded = false;

  const emit = () => {
    // Wait until both streams have delivered at least once so we never
    // group orders against an empty rider map.
    if (!ridersLoaded || !ordersLoaded) return;

    const groupsMap = {};

    ordersRaw
      .filter((order) => ACTIVE_LOADING_STATUSES.includes(order.statusKey))
      .forEach((order) => {
        const riderId = order.assignedRiderId;
        if (!riderId) return; // unassigned orders are not shown here

        const rider = ridersById[riderId];
        if (!rider) return; // only approved riders are shown

        if (!groupsMap[riderId]) {
          groupsMap[riderId] = { riderId, rider, orders: [] };
        }
        groupsMap[riderId].orders.push(order);
      });

    const groups = Object.values(groupsMap)
      .map((group) => {
        const orders = [...group.orders].sort(sortGroupOrders);
        const loadedCount = orders.filter((o) => o.isLoaded === true).length;
        return {
          riderId: group.riderId,
          rider: {
            uid: group.rider.uid,
            name: riderDisplayName(group.rider),
            plate: riderPlate(group.rider),
            phone: group.rider.phone || group.rider.contactNumber || "",
            email: group.rider.email || "",
          },
          orders,
          totalOrders: orders.length,
          loadedCount,
          allLoaded: orders.length > 0 && loadedCount === orders.length,
        };
      })
      // Sort riders consistently by name so card order is stable.
      .sort((a, b) => a.rider.name.localeCompare(b.rider.name));

    callback(groups);
  };

  // Production hardening (2026-07-24): server-filter to role == "rider" so
  // Firestore rules can restrict `users` reads. `isApprovedRider` still runs
  // client-side to narrow to status == "approved" (the role check it also does
  // is now redundant but harmless). Verified: all rider docs use role exactly
  // "rider", so this returns the identical rider set as the prior whole-users
  // read.
  const ridersQuery = query(
    collection(db, USERS),
    where("role", "==", "rider")
  );
  const unsubUsers = listenLive(
    ridersQuery,
    (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        if (isApprovedRider(data)) {
          // Document id last. This uid is what groups a rider's orders and is
          // handed to finalizeRiderDispatch, whose batch writes target those
          // orders — so a stored `uid` field must never displace it. Same
          // ordering riderService already uses.
          map[d.id] = { ...data, uid: d.id };
        }
      });
      ridersById = map;
      ridersLoaded = true;
      emit();
    },
    (error) => {
      logSafeError("subscribeCargoLoadingGroups (users)", error);
      if (onError) onError(error);
    }
  );

  const unsubOrders = listenLive(
    collection(db, ORDERS),
    (snap) => {
      ordersRaw = snap.docs.map((d) => {
        const data = d.data();
        const statusKey = normalizeStatusKey(getOrderStatusValue(data));
        // Document id last — this id is passed to updateOrderLoadedState and
        // finalizeRiderDispatch, which write to orders/{id}.
        return { ...data, id: d.id, statusKey };
      });
      ordersLoaded = true;
      emit();
    },
    (error) => {
      logSafeError("subscribeCargoLoadingGroups (orders)", error);
      if (onError) onError(error);
    }
  );

  return () => {
    unsubUsers();
    unsubOrders();
  };
}

/**
 * Persist whether a single order has been physically loaded.
 * Stores the loaded state in Firestore (not just React state) plus a small
 * audit trail. Does not touch unrelated order fields.
 *
 * Cargo Loading is the canonical dispatch path, so confirming the first order
 * of an `assigned` group also advances it to `loading` — this is what keeps the
 * documented pending_dispatch → assigned → loading → in_transit → delivered
 * flow reachable now that Shipments no longer offers "Start loading".
 *
 * The first confirmation stamps the loading audit (loadedAt / loadedByUid /
 * loadedByEmail); it is never cleared or rewritten afterwards, because
 * cancellation treats an order ever confirmed as loaded as handled stock.
 *
 * Unchecking only clears the loaded flag. The status is deliberately NOT
 * regressed from `loading` back to `assigned`: `loading` means preparation has
 * begun, and silent backwards transitions would confuse the audit trail and
 * every downstream role view.
 *
 * @param {string} orderId
 * @param {boolean} isLoaded
 * @param {{uid?: string, email?: string}} dispatcher
 * @param {string} [currentStatusKey] normalized status of the order as shown in
 *   the UI; only `"assigned"` triggers the promotion to `loading`.
 */
export async function updateOrderLoadedState(orderId, isLoaded) {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new WorkflowError("order-id-required", "Order ID is required.");
  }

  const currentUser = auth.currentUser;
  if (!currentUser?.uid) {
    throw new WorkflowError(
      "not-signed-in",
      "Your session has expired. Please sign in again."
    );
  }

  const ref = doc(db, ORDERS, orderId);
  const loaded = !!isLoaded;

  // The order's own status decides what may happen, re-read here rather than
  // taken from the caller. It used to arrive as a `currentStatusKey` argument
  // derived from the rendered list, so a stale screen could promote an order
  // that had already moved on.
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new WorkflowError("order-not-found", "That order no longer exists.");
    }
    const order = snap.data();
    const status = normalizeStatus(getOrderStatusValue(order));

    const permitted = canUpdateLoadingMetadata(status);
    if (!permitted.ok) throw new WorkflowError(permitted.code, permitted.message);

    const update = {
      isLoaded: loaded,
      updatedAt: serverTimestamp(),
    };

    // The audit records the FIRST confirmation and is kept from then on. A
    // legacy order ticked before the audit existed (isLoaded true, no audit)
    // gets one on its next change, untick included, so the custody evidence
    // survives the untick.
    const needsAudit =
      !hasLoadingAudit(order) && (loaded || order.isLoaded === true);
    if (needsAudit) Object.assign(update, loadingAuditStamp(currentUser));

    if (loaded) {

      // First confirmation of an `assigned` order promotes it to `loading`.
      // Cargo Loading is the ONLY authority for this step, and the transition
      // is checked against the shared policy rather than an inline literal.
      if (status === "assigned") {
        assertTransition(ACTOR_DISPATCHER, status, "loading");
        // Loading is dispatch preparation; not before the scheduled day.
        assertScheduleReached(order);
        update.status = "loading";
        update.statusUpdatedAt = serverTimestamp();
        update.statusUpdatedByUid = currentUser.uid;
        if (currentUser.email) update.statusUpdatedByEmail = currentUser.email;
      }
    }
    // Unticking clears only isLoaded. The audit stays: the vials WERE handled,
    // and a later cancellation must still return them for inspection. The
    // status is deliberately NOT regressed from `loading` back to
    // `assigned` either: `loading → assigned` is not in the dispatcher
    // matrix at all, so the rules refuse it too.

    tx.update(ref, update);
    return { orderId, isLoaded: loaded, status: update.status ?? status };
  });
}

/**
 * Finalize Dispatch: the Rider's whole forming trip leaves, at once — on the
 * server (finalizeRiderDispatch callable, functions/src/riderDispatchOps.js).
 *
 * The server re-reads the Rider's trip and every order in one transaction:
 * the orders sent must be exactly the trip's (a stale or partial group is
 * refused with `trip-changed`), every one in Loading, confirmed loaded, fully
 * reserved and on or after its date — or nothing moves. Departure then locks
 * the trip: no order can join it, and the Rider takes no new assignment until
 * their return to the hub is confirmed. A repeat of a Finalize that already
 * ran is a no-op success. firestore.rules refuse the direct loading →
 * in_transit write, Admin included.
 *
 * `tripId` is the server trip id the page saw (riderDispatchStates), passed so
 * a trip replaced in the meantime is refused rather than sent; it may be null
 * for a Rider the server has not classified yet.
 */
export async function finalizeRiderDispatch(riderId, orderIds, tripId = null) {
  if (typeof riderId !== "string" || riderId.trim() === "") {
    throw new WorkflowError("rider-required", "Rider is required.");
  }
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new WorkflowError("no-orders", "No orders to finalize.");
  }
  if (!auth.currentUser?.uid) {
    throw new WorkflowError("not-signed-in", "Your session has expired. Please sign in again.");
  }
  return finalizeRiderTripOnServer({ riderUid: riderId, orderIds: [...new Set(orderIds)], tripId });
}
