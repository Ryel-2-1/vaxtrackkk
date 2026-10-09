import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { InventoryCallableError } from "./inventoryCallables";

/**
 * Client side of the delivery-schedule boundary.
 *
 * The schedule fields are server-owned: Firestore rules refuse a direct client
 * write to them, Admin included. rescheduleOrderDelivery (functions/src/
 * scheduleOperations.js) is the only way to change a delivery's date or time,
 * because it is the only path that also records who/when, keeps the Med Rep's
 * original request and appends a scheduleEvents history entry.
 *
 * It sends the order id, the new date and time and an optional reason — never a
 * price, quantity, destination or status.
 */
const FUNCTIONS_REGION = "asia-southeast1";

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new InventoryCallableError(details.code, error.message, details.info);
  }
  if (error?.code === "functions/unauthenticated") {
    throw new InventoryCallableError(
      "unauthenticated",
      "Your session has expired. Please sign in again."
    );
  }
  throw new InventoryCallableError(
    "service-unavailable",
    "The scheduling service is unavailable right now. Nothing was changed — please try again.",
    null
  );
}

/**
 * Move an order's delivery to a new Manila date and optional 'HH:MM' time.
 * Admin only (enforced on the server).
 */
export async function rescheduleOrderDelivery({ orderId, requestedDeliveryDate, scheduledDeliveryTime, reason }) {
  const payload = { orderId, requestedDeliveryDate };
  if (scheduledDeliveryTime) payload.scheduledDeliveryTime = scheduledDeliveryTime;
  if (typeof reason === "string" && reason.trim()) payload.reason = reason.trim();
  try {
    const call = httpsCallable(getFunctions(app, FUNCTIONS_REGION), "rescheduleOrderDelivery");
    const result = await call(payload);
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}
