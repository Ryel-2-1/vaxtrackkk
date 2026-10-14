// Pure plan for removing the LEGACY rider-location copies.
//
// Before riderLocations/{uid} existed, the Rider app copied its position onto
// every in-transit ORDER and onto the rider's USER document, and nothing ever
// removed it. Live location now lives only in riderLocations/{uid} (cleared
// when tracking ends, purged after 24 h), so these copies are stale personal
// data with no reader. This module decides exactly which fields to delete.
// No Firebase import, no I/O.

/** The fields the old LocationService wrote (orders and users alike). */
export const LEGACY_LOCATION_FIELDS = Object.freeze([
  "lastLocation",
  "lastLocationUpdate",
  "locationAccuracy",
  "heading",
  "speed",
]);

/**
 * Fields to delete from one document. On ORDERS every legacy field goes. On
 * USERS only a rider's are touched, and `heading`/`speed` only alongside a
 * `lastLocation` copy — a non-location field of that name is never assumed.
 */
export function legacyFieldsIn(collectionName, data) {
  if (!data || typeof data !== "object") return [];
  const present = LEGACY_LOCATION_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(data, f));
  if (collectionName === "orders") return present;
  if (collectionName === "users") {
    if (String(data.role || "").trim().toLowerCase() !== "rider") return [];
    const hasCopy = present.includes("lastLocation") || present.includes("lastLocationUpdate");
    return hasCopy ? present : [];
  }
  return [];
}

/** Ordered, exact plan: [{ collection, id, fields }]. */
export function planLegacyLocationCleanup({ orders = [], users = [] }) {
  const ops = [];
  for (const [name, docs] of [["orders", orders], ["users", users]]) {
    for (const d of docs) {
      const fields = legacyFieldsIn(name, d);
      if (fields.length) ops.push({ collection: name, id: d.id, fields });
    }
  }
  return ops.sort((a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id));
}

/** Counts for the dry-run report — ids and field names only, never values. */
export function summarizePlan(ops) {
  const byCollection = {};
  const byField = {};
  for (const op of ops) {
    byCollection[op.collection] = (byCollection[op.collection] || 0) + 1;
    for (const f of op.fields) byField[f] = (byField[f] || 0) + 1;
  }
  return { documents: ops.length, byCollection, byField };
}

/** Split into Firestore batches (limit 500 writes; keep headroom). */
export function chunk(ops, size = 400) {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}
