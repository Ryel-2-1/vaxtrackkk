import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";

/**
 * Client side of the trusted inventory boundary.
 *
 * Order creation, cancellation and delivery move stock, so they are no longer
 * client writes at all — Firestore rules now refuse each of them directly.
 * These wrappers are the only way to perform them — and, for future orders,
 * the only way stock is added, returned or reallocated.
 *
 * The region must match the deployed functions (asia-southeast1, the same
 * region as staging Firestore); a mismatch fails at call time rather than
 * silently reaching a different deployment.
 */
const FUNCTIONS_REGION = "asia-southeast1";

function callables() {
  const fns = getFunctions(app, FUNCTIONS_REGION);
  return {
    create: httpsCallable(fns, "createOrderWithReservation"),
    cancel: httpsCallable(fns, "cancelOrderWithInventoryRelease"),
    deliver: httpsCallable(fns, "markOrderDeliveredWithInventoryConsumption"),
    addStock: httpsCallable(fns, "addStockBatchWithAllocation"),
    disposition: httpsCallable(fns, "confirmReturnDisposition"),
    requeue: httpsCallable(fns, "requeueFailedOrder"),
    provenance: httpsCallable(fns, "getReservationProvenance"),
  };
}

/**
 * A stable, cryptographically random request id for one checkout ATTEMPT.
 *
 * The old order number was `VT-ORD-${Date.now()}`, which is neither unique nor
 * stable: two submissions in the same millisecond collide, and a retry produces
 * a different value, so the server could not tell a retry from a new order.
 *
 * Generated in services/orderDraftRequest.js (Firebase-free), which also keeps
 * it for the life of the order draft — across refreshes, not just this page —
 * and is the only place its storage rules live. Re-exported here so existing
 * imports keep working.
 */
export { newRequestId } from "./orderDraftRequest";

/**
 * A failure from a callable, carrying the server's stable domain code.
 *
 * `code` is the domain code (`insufficient-stock`, `batch-expired`, …) that the
 * UI branches on; `message` is the sentence the server wrote for the user.
 * Parsing prose to decide behaviour is what this avoids.
 */
export class InventoryCallableError extends Error {
  constructor(code, message, info) {
    super(message);
    this.name = "InventoryCallableError";
    this.code = code;
    this.info = info ?? null;
  }
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new InventoryCallableError(details.code, error.message, details.info);
  }
  // Not a domain failure: network, region mismatch, or the function being
  // unavailable. Deliberately not dressed up as a stock problem.
  if (error?.code === "functions/unauthenticated") {
    throw new InventoryCallableError(
      "unauthenticated",
      "Your session has expired. Please sign in again."
    );
  }
  throw new InventoryCallableError(
    "service-unavailable",
    "The ordering service is unavailable right now. Your cart has been kept — please try again.",
    null
  );
}

/**
 * Create an order and reserve its stock.
 *
 * `items` carry the authoritative inventory DOCUMENT id, an integer quantity,
 * and the price the rep was SHOWN — nothing else. Every display value and every
 * figure of money on the stored order is snapshotted server-side from the batch
 * itself; the expected price is only ever compared, never used as a price, and
 * a mismatch in either direction refuses the checkout.
 */
export async function createOrderWithReservation({
  requestId,
  doctorId,
  doctorAddressId,
  items,
  priority,
  deliveryInstructions,
  // Required booking date ('YYYY-MM-DD'). It MUST be forwarded to the callable,
  // which re-validates and stores it and refuses an order without one
  // (`requested-date-required`, operations.js). Omitting it here once silently
  // dropped every requested date, so orders arrived undated.
  requestedDeliveryDate,
}) {
  try {
    const result = await callables().create({
      requestId,
      doctorId,
      doctorAddressId,
      priority,
      deliveryInstructions,
      requestedDeliveryDate,
      items: items.map((item) => ({
        inventoryId: item.inventoryId,
        quantity: item.quantity,
        // The price this cart was built against. Sent so the server can prove
        // it has not moved — NOT so the server can use it. `unitPrice` is
        // deliberately no longer sent at all; the callable now rejects it.
        expectedUnitPriceCentavos: item.expectedUnitPriceCentavos,
      })),
    });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

export async function cancelOrderWithInventoryRelease(orderId, reason) {
  try {
    const result = await callables().cancel({ orderId, reason });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

export async function markOrderDeliveredWithInventoryConsumption(orderId) {
  try {
    const result = await callables().deliver({ orderId });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Admin: add a stock batch. The server creates the batch, then — in the SAME
 * transaction — reserves it for waiting future orders in priority order (FEFO
 * per product). Resolves `{ inventoryId, batchId, status, added,
 * allocatedToOrders, leftAvailable, allocations }`.
 *
 * Only the fields the server accepts are sent; catalog values (name, type,
 * VAT) are read server-side from the vaccine document.
 */
export async function addStockBatchWithAllocation({
  vaccineId,
  batchId,
  manufacturingDate,
  arrivalDate,
  expiryDate,
  quantity,
  sellingPriceCentavos,
  manufacturer,
}) {
  try {
    const result = await callables().addStock({
      vaccineId,
      batchId,
      manufacturingDate,
      arrivalDate,
      expiryDate,
      quantity,
      sellingPriceCentavos,
      ...(manufacturer ? { manufacturer } : {}),
    });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Admin: decide what happens to stock returned by a failed delivery.
 * `disposition` is one of usable | damaged | temperature_excursion | missing.
 * Usable stock is restored and immediately reallocated to waiting orders;
 * the rest is quarantined or written off and never allocated.
 */
export async function confirmReturnDisposition(returnId, disposition, notes) {
  try {
    const result = await callables().disposition({
      returnId,
      disposition,
      ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
    });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Dispatcher: put a failed order back into the dispatch queue. Its stock was
 * returned at failure, so it re-enters allocation and waits to be fully
 * reserved again before it can be assigned.
 */
export async function requeueFailedOrder(orderId) {
  try {
    const result = await callables().requeue({ orderId });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/** Admin: which orders and returns account for a batch's held units. */
export async function getReservationProvenance(inventoryId) {
  try {
    const result = await callables().provenance({ inventoryId });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Available stock for a batch, derived — never stored.
 *
 * A persisted `availableQuantity` would be a third number that has to be kept
 * in step with two others, and nothing could enforce that it was. Returns null
 * when the batch cannot be ordered at all, so callers must handle the reason
 * rather than showing a plausible-looking figure.
 */
export function availableStock(batch) {
  const onHand = batch?.quantity;
  if (typeof onHand !== "number" || !Number.isInteger(onHand) || onHand < 0) {
    return null; // legacy string quantity, or corrupt
  }
  // Reserved, return-pending and quarantined units are on hand but not free.
  let held = 0;
  for (const raw of [batch?.reservedQuantity, batch?.returnPendingQuantity, batch?.quarantinedQuantity]) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
    held += raw;
  }
  return Math.max(onHand - held, 0);
}
