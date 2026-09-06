import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

const ORDERS = "orders";

export const normalizeStatusKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");

export const getOrderStatusValue = (data) =>
  data.status ||
  data.orderStatus ||
  data.deliveryStatus ||
  data.shipmentStatus ||
  data.dispatchStatus ||
  "pending";

export const mapOrderStatusLabel = (statusKey) => {
  switch (statusKey) {
    case "pending":
    case "pending_dispatch":
    case "assigned":
    case "loading":
      return "Loading";
    case "in_transit":
      return "In Transit";
    case "delayed":
      return "Delayed";
    case "cancelled":
    case "canceled":
      return "Cancelled";
    case "completed":
    case "delivered":
      return "Delivered";
    default:
      return "Pending";
  }
};

export const mapOrderStatusType = (statusKey) => {
  switch (statusKey) {
    case "in_transit":
    case "delivered":
    case "completed":
      return "transit";
    case "delayed":
    case "cancelled":
    case "canceled":
      return "delayed";
    default:
      return "loading";
  }
};

export function subscribeDeliveries(callback, onError) {
  return onSnapshot(
    collection(db, ORDERS),
    (snap) => {
      const orders = snap.docs
        .map((d) => {
          const data = d.data();
          const rawStatus = getOrderStatusValue(data);
          const statusKey = normalizeStatusKey(rawStatus);
          return {
            // Document data first, then the Firestore document id, so a
            // stored field named `id` can never replace the identity that
            // every order write targets. The derived status fields below
            // already sat after the spread and keep that position.
            ...data,
            id: d.id,
            rawStatus,
            statusKey,
            statusLabel: mapOrderStatusLabel(statusKey),
            statusType: mapOrderStatusType(statusKey),
          };
        })
        .sort((a, b) => {
          const aMs = a.createdAt?.toMillis?.() ?? 0;
          const bMs = b.createdAt?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      callback(orders);
    },
    (error) => {
      console.error("subscribeDeliveries error:", error);
      if (onError) onError(error);
    }
  );
}
