/**
 * A clinic's most recent delivery — read from the orders, not from a stored
 * clinic field. Pure; no Firebase.
 *
 * `clinics/{id}.lastDelivery` is written once, at registration ("No delivery
 * yet"), and nothing ever updates it, so it cannot be shown as a fact. The
 * orders are the record: an order delivered to a clinic carries the clinic's
 * document id as `clinicDocId` (the order's destination snapshot). Orders from
 * before destination snapshots carry only the clinic NAME; those are matched
 * by current or former name when the name identifies a single clinic. Only
 * orders without a `clinicDocId` and outside the home delivery flow qualify.
 */

import { timestampMs } from "./deliveryMetrics.js";

export const NO_DELIVERY_TEXT = "No delivery recorded yet";

const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const isDelivered = (o) => o?.statusKey === "delivered" || o?.statusKey === "completed";
const namesOf = (clinic) => [
  clinic?.name,
  ...(Array.isArray(clinic?.previousNames) ? clinic.previousNames : []),
].map(norm).filter(Boolean);

/**
 * @param {object[]} orders  live orders (with statusKey)
 * @param {object[]} [clinics] directory, used to rule out ambiguous names
 */
export function lastDeliveryIndex(orders, clinics) {
  const byId = new Map();
  const byName = new Map();
  const nameOwners = clinics && new Map();
  for (const clinic of clinics ?? []) {
    if (!clinic.firestoreId) continue;
    for (const name of namesOf(clinic)) {
      const owner = nameOwners.get(name);
      nameOwners.set(name, owner === undefined || owner === clinic.firestoreId ? clinic.firestoreId : null);
    }
  }
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
  return { byId, byName, nameOwners };
}

/** Newest delivery time (ms) for a clinic, or null. */
export function lastDeliveryMs(index, clinic) {
  let newest = index?.byId.get(clinic?.firestoreId) ?? null;
  for (const name of namesOf(clinic)) {
    if (index?.nameOwners && index.nameOwners.get(name) !== clinic?.firestoreId) continue;
    const deliveredAt = index?.byName.get(name);
    if (deliveredAt !== undefined && (newest === null || deliveredAt > newest)) newest = deliveredAt;
  }
  return newest;
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
