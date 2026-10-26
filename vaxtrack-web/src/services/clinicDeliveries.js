/**
 * A clinic's most recent delivery — read from the orders, not from a stored
 * clinic field. Pure; no Firebase.
 *
 * `clinics/{id}.lastDelivery` is written once, at registration ("No delivery
 * yet"), and nothing ever updates it, so it cannot be shown as a fact. The
 * orders are the record: an order delivered to a clinic carries the clinic's
 * document id as `clinicDocId` (the order's destination snapshot). Orders from
 * before destination snapshots carry only the clinic NAME; those are matched
 * by exact name (registration refuses duplicate clinic names), and only when
 * the order has no `clinicDocId` and is not a home delivery.
 */

import { timestampMs } from "./deliveryMetrics.js";

export const NO_DELIVERY_TEXT = "No delivery recorded yet";

const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const isDelivered = (o) => o?.statusKey === "delivered" || o?.statusKey === "completed";

/**
 * @param {object[]} orders  live orders (with statusKey)
 * @returns {{ byId: Map<string, number>, byName: Map<string, number> }} newest deliveredAt ms
 */
export function lastDeliveryIndex(orders) {
  const byId = new Map();
  const byName = new Map();
  const keep = (map, key, ms) => {
    if (key && (!map.has(key) || map.get(key) < ms)) map.set(key, ms);
  };
  for (const order of orders || []) {
    if (!isDelivered(order)) continue;
    const ms = timestampMs(order.deliveredAt);
    if (ms === null) continue;
    if (typeof order.clinicDocId === "string" && order.clinicDocId) {
      keep(byId, order.clinicDocId, ms);
    } else if (order.destinationType !== "home") {
      keep(byName, norm(order.clinicName), ms);
    }
  }
  return { byId, byName };
}

/** Newest delivery time (ms) for a clinic, or null. */
export function lastDeliveryMs(index, clinic) {
  const a = index?.byId.get(clinic?.firestoreId) ?? null;
  const b = index?.byName.get(norm(clinic?.name)) ?? null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** "Oct 21, 2026" in Manila time, or the no-delivery wording. */
export function lastDeliveryText(ms) {
  if (ms === null || ms === undefined) return NO_DELIVERY_TEXT;
  return new Date(ms).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  });
}
