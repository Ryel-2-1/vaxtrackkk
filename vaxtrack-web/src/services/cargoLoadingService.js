import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";
import { getOrderStatusValue, normalizeStatusKey } from "./deliveryService";

const ORDERS = "orders";
const USERS = "users";

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

  const unsubUsers = onSnapshot(
    collection(db, USERS),
    (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        if (isApprovedRider(data)) {
          map[d.id] = { uid: d.id, ...data };
        }
      });
      ridersById = map;
      ridersLoaded = true;
      emit();
    },
    (error) => {
      console.error("subscribeCargoLoadingGroups (users) error:", error);
      if (onError) onError(error);
    }
  );

  const unsubOrders = onSnapshot(
    collection(db, ORDERS),
    (snap) => {
      ordersRaw = snap.docs.map((d) => {
        const data = d.data();
        const statusKey = normalizeStatusKey(getOrderStatusValue(data));
        return { id: d.id, ...data, statusKey };
      });
      ordersLoaded = true;
      emit();
    },
    (error) => {
      console.error("subscribeCargoLoadingGroups (orders) error:", error);
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
 */
export async function updateOrderLoadedState(orderId, isLoaded, dispatcher) {
  if (!orderId) throw new Error("Order ID is required.");

  const ref = doc(db, ORDERS, orderId);
  const loaded = !!isLoaded;

  const update = {
    isLoaded: loaded,
    updatedAt: serverTimestamp(),
  };

  if (loaded) {
    update.loadedAt = serverTimestamp();
    if (dispatcher?.uid) update.loadedByUid = dispatcher.uid;
    if (dispatcher?.email) update.loadedByEmail = dispatcher.email;
  } else {
    // Clearing a confirmation removes the audit fields so they never go stale.
    update.loadedAt = null;
    update.loadedByUid = null;
    update.loadedByEmail = null;
  }

  return updateDoc(ref, update);
}

/**
 * Finalize dispatch for a rider's whole group atomically.
 *
 * Uses a Firestore write batch so either every order is moved to `in_transit`
 * or none are — the group is never left partially finalized. Writes dispatch
 * audit fields using server timestamps and does not overwrite unrelated fields.
 */
export async function finalizeRiderDispatch(riderId, orderIds, dispatcher) {
  if (!riderId) throw new Error("Rider is required.");
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new Error("No orders to finalize.");
  }

  const batch = writeBatch(db);

  orderIds.forEach((orderId) => {
    const ref = doc(db, ORDERS, orderId);
    const update = {
      // `in_transit` is the existing normalized VaxTrack dispatch status.
      status: "in_transit",
      dispatchedAt: serverTimestamp(),
      loadingFinalizedAt: serverTimestamp(),
      // Keep the standard status-transition audit fields consistent with
      // updateOrderStatus so Shipments / Geofence reflect the change correctly.
      startedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (dispatcher?.uid) {
      update.dispatchedByUid = dispatcher.uid;
      update.statusUpdatedByUid = dispatcher.uid;
    }
    if (dispatcher?.email) {
      update.dispatchedByEmail = dispatcher.email;
      update.statusUpdatedByEmail = dispatcher.email;
    }

    batch.update(ref, update);
  });

  return batch.commit();
}
