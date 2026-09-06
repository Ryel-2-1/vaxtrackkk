import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { STATUS_LABELS } from "./orderWorkflow";

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

/**
 * Display label for an order status.
 *
 * `pending_dispatch`, `assigned` and `loading` all used to render as "Loading",
 * which said something untrue about the first two: an order awaiting dispatch
 * has not been given to anyone, and an assigned order has not been loaded. Each
 * canonical status now shows its own name, taken from the shared policy so the
 * label exists in exactly one place.
 *
 * The legacy read-only aliases stay mapped here — `completed` and `canceled`
 * appear on historical documents and must still display correctly. This is the
 * display layer, not the write policy; orderWorkflow deliberately refuses them.
 * Stored values are never rewritten.
 */
export const mapOrderStatusLabel = (statusKey) => {
  switch (statusKey) {
    case "completed":
      return STATUS_LABELS.delivered;
    case "canceled":
      return STATUS_LABELS.cancelled;
    case "pending":
      return "Pending";
    default:
      return STATUS_LABELS[statusKey] ?? "Pending";
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
