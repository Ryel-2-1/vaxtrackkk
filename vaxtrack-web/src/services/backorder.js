/**
 * Future-order (backorder) display helpers, shared by the Med Rep, Admin and
 * Dispatcher pages.
 *
 * Every figure the SERVER writes is authoritative — `allocationState`, each
 * item's `reservedQuantity` / `backorderedQuantity`. Nothing here decides
 * anything; it only reads those fields and words them. The one estimate
 * (`estimateBackorders`) is for the cart before submission, and is labelled as
 * an estimate wherever it is shown.
 */

export const FUTURE_ORDER_LABEL = "Out of stock — future order available";

/** The server's per-line ceiling (functions/src/policy.js MAX_LINE_QUANTITY). */
export const MAX_LINE_QUANTITY = 1000000;

export const ALLOCATION_STATE_LABELS = {
  awaiting_stock: "Awaiting stock",
  partially_reserved: "Partially reserved",
  fully_reserved: "Fully reserved",
};

/**
 * An ESTIMATE of how much of each cart line will wait for stock. The server
 * allocates per PRODUCT across every usable batch (FEFO), so the pool is the
 * product's total available, shared by the cart's lines in order. The server's
 * figure — returned at submission — is the only authoritative one.
 */
export function estimateBackorders(cart, products) {
  const pool = new Map();
  for (const product of products) {
    if (!product.orderable || !product.vaccineId) continue;
    pool.set(product.vaccineId, (pool.get(product.vaccineId) || 0) + Math.max(product.available || 0, 0));
  }
  const estimates = new Map();
  for (const item of cart) {
    const key = item.vaccineId;
    const left = key ? pool.get(key) || 0 : 0;
    const reservable = Math.min(left, item.quantity);
    if (key) pool.set(key, left - reservable);
    estimates.set(item.inventoryId, item.quantity - reservable);
  }
  return estimates;
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * The allocation picture of one order, from server-written fields only.
 * Legacy (version 1) orders reserved everything at creation, so they are
 * reported as fully reserved; an order with no allocation data is `unknown`.
 */
export function describeAllocation(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const version = order?.allocationVersion;

  if (version === 2) {
    const lines = items.map((item, index) => ({
      index,
      name: item.vaccineName || item.name || "Item",
      productKey: item.productKey || null,
      requested: count(item.quantity),
      reserved: count(item.reservedQuantity),
      backordered: count(item.backorderedQuantity),
    }));
    const requested = lines.reduce((sum, line) => sum + line.requested, 0);
    const reserved = lines.reduce((sum, line) => sum + line.reserved, 0);
    const backordered = lines.reduce((sum, line) => sum + line.backordered, 0);
    const state = ALLOCATION_STATE_LABELS[order.allocationState] ? order.allocationState : "unknown";
    return {
      tracked: true,
      state,
      label: ALLOCATION_STATE_LABELS[state] || "Unknown",
      fullyReserved: state === "fully_reserved",
      requested,
      reserved,
      backordered,
      lines,
    };
  }

  if (version === 1) {
    const requested = items.reduce((sum, item) => sum + count(item.quantity), 0);
    return {
      tracked: true,
      state: "fully_reserved",
      label: ALLOCATION_STATE_LABELS.fully_reserved,
      fullyReserved: true,
      requested,
      reserved: requested,
      backordered: 0,
      lines: items.map((item, index) => ({
        index,
        name: item.vaccineName || item.name || "Item",
        productKey: item.productKey || null,
        requested: count(item.quantity),
        reserved: count(item.quantity),
        backordered: 0,
      })),
    };
  }

  return {
    tracked: false,
    state: "unknown",
    label: "Not tracked",
    // Pre-reservation orders: dispatch is not gated (the rules only gate v2).
    fullyReserved: true,
    requested: 0,
    reserved: 0,
    backordered: 0,
    lines: [],
  };
}

/**
 * Why an order cannot be assigned yet, in words — or null when it can. Used to
 * disable Dispatcher assignment; the Firestore rules enforce the same gate.
 */
export function assignmentBlockReason(order) {
  if (order?.allocationVersion !== 2) return null;
  const info = describeAllocation(order);
  if (info.fullyReserved) return null;
  const short = info.lines
    .filter((line) => line.backordered > 0)
    .map((line) => `${line.name}: ${line.backordered.toLocaleString()} short`)
    .join(", ");
  return `Waiting for stock — ${info.reserved.toLocaleString()} of ${info.requested.toLocaleString()} reserved${short ? ` (${short})` : ""}. It can be assigned once every item is fully reserved.`;
}
