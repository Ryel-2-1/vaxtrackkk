import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";

/**
 * Client side of the trusted inventory boundary.
 *
 * Order creation, cancellation and delivery move stock, so they are no longer
 * client writes at all — Firestore rules now refuse each of them directly.
 * These three wrappers are the only way to perform them.
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
  };
}

/**
 * A stable, cryptographically random request id for one checkout ATTEMPT.
 *
 * The old order number was `VT-ORD-${Date.now()}`, which is neither unique nor
 * stable: two submissions in the same millisecond collide, and a retry produces
 * a different value, so the server could not tell a retry from a new order.
 * This id is generated once, survives a recoverable failure, and is what makes
 * five simultaneous submissions land as one order.
 */
export function newRequestId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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
  clinicDocId,
  items,
  priority,
  deliveryInstructions,
}) {
  try {
    const result = await callables().create({
      requestId,
      clinicDocId,
      priority,
      deliveryInstructions,
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
  const reserved = batch?.reservedQuantity;
  if (reserved === undefined || reserved === null) return onHand;
  if (typeof reserved !== "number" || !Number.isInteger(reserved) || reserved < 0) {
    return null;
  }
  return Math.max(onHand - reserved, 0);
}
