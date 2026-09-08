import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { ORDER_STATUSES, STATUS_LABELS } from "./orderWorkflow";

const ORDERS = "orders";

export const normalizeStatusKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");

/**
 * Legacy status fields, in the order they are consulted.
 *
 * `status` is canonical and the only one anything writes today; the rest appear
 * on historical documents. An obsolete field may answer only when the canonical
 * one is ABSENT — never when it is present, whatever value it holds.
 */
export const STATUS_FIELDS = Object.freeze([
  "status",
  "orderStatus",
  "deliveryStatus",
  "shipmentStatus",
  "dispatchStatus",
]);

/**
 * The status an order document carries, or `null` when it carries none.
 *
 * This used to end in `|| "pending"`, which turned "no status field at all"
 * into a real lifecycle state: a document that had never been given a status
 * displayed, filtered and counted as one waiting to be dispatched. Absent now
 * stays absent, and the display layer renders it as unknown.
 */
export const getOrderStatusValue = (data) => {
  for (const field of STATUS_FIELDS) {
    const value = data?.[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
};

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
/** Shown wherever a status cannot be resolved to a canonical one. */
export const UNKNOWN_STATUS_KEY = "unknown";
export const UNKNOWN_STATUS_LABEL = "Unknown";

/**
 * Read-only aliases that appear on historical documents. They are display
 * synonyms of a canonical status, not statuses of their own — orderWorkflow
 * refuses to write either, and stored values are never rewritten.
 */
export const LEGACY_STATUS_ALIASES = Object.freeze({
  completed: "delivered",
  canceled: "cancelled",
});

/**
 * The canonical status a key resolves to, or null if it resolves to none.
 *
 * `pending` used to be accepted here as a real state. It is not in
 * ORDER_STATUSES and nothing writes it; it only ever arrived from the old
 * `|| "pending"` fallback, so it now resolves to unknown like any other
 * unrecognised value.
 */
export const resolveStatusKey = (statusKey) => {
  const key = LEGACY_STATUS_ALIASES[statusKey] ?? statusKey;
  return ORDER_STATUSES.includes(key) ? key : null;
};

/**
 * Display label for an order status.
 *
 * An unrecognised value used to fall through to "Pending", which presented a
 * status nobody could account for as a normal early-lifecycle order. It now
 * reads "Unknown", so a document carrying something the system does not define
 * is visible as exactly that.
 */
export const mapOrderStatusLabel = (statusKey) => {
  const canonical = resolveStatusKey(statusKey);
  return canonical === null ? UNKNOWN_STATUS_LABEL : STATUS_LABELS[canonical];
};

/**
 * Presentation category for an order status.
 *
 * Derived from the canonical list rather than a hand-maintained subset. The old
 * buckets conflated distinct states: `delivered` and `completed` shared the
 * "transit" bucket, so finished orders were counted as on route; `cancelled`
 * shared "delayed", so closed orders inflated the delayed count and its banner;
 * and every unrecognised value fell into the "loading" default, hiding it among
 * orders progressing normally.
 *
 * Each canonical status now has its own category, and anything else is
 * `unknown`.
 */
export const mapOrderStatusType = (statusKey) =>
  resolveStatusKey(statusKey) ?? UNKNOWN_STATUS_KEY;

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
