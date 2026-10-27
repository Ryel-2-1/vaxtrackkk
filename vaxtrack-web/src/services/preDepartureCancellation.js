import contract from "../../functions/src/preDepartureCancellation.json" with { type: "json" };
import { normalizeRole, normalizeStatus } from "./authorization.js";
import { validateReason } from "./orderWorkflow.js";
import { UserMessageError } from "./userMessageError.js";
import { createSingleFlight } from "./singleFlight.js";

// Mirrors the conservative server order check; reservation and trip are server-only.
export function potentiallyCancellable(order) {
  if (!contract.statuses.includes(order?.status) || ![1, 2].includes(order.allocationVersion) ||
      order.allocationStatus !== "reserved") return false;
  if (contract.custodyFields.some((key) => order[key] !== undefined && order[key] !== null)) return false;
  if (order.isLoaded !== undefined && order.isLoaded !== false) return false;
  if (order.status === "loading" && order.isLoaded !== false) return false;
  if (order.failureCount !== undefined && order.failureCount !== 0) return false;
  if (order.status !== "pending_dispatch" || order.assignedRiderId != null || order.dispatchTripId != null) {
    if (typeof order.assignedRiderId !== "string" || !order.assignedRiderId ||
        typeof order.dispatchTripId !== "string" || !order.dispatchTripId || order.dispatchTripId.includes("/")) return false;
  }
  return true;
}

export function canCancelBeforeDeparture({ order, uid, profile }) {
  if (!uid || normalizeStatus(profile?.status) !== "approved" || !potentiallyCancellable(order)) return false;
  const role = normalizeRole(profile?.role);
  return role === "admin" || (role === "salesrep" && order.createdByUid === uid);
}

export const CANCELLATION_WARNING = "Cancelling releases this order’s reserved stock. Other waiting orders may receive it, so availability must be checked again when placing a new order.";
export const REORDER_GUIDANCE = "After cancellation, the Med Rep can check current availability and manually place one order for available items and another for unavailable items, if still needed. New orders do not retain the original stock, price, priority or arrival preference.";

/** No cart/draft/key inputs: only the existing server cancellation operation. */
export function createCancellationRequest(cancel) {
  const flight = createSingleFlight();
  return (orderId, reason) => flight.run(async () => {
    if (typeof orderId !== "string" || !orderId || orderId.includes("/")) {
      throw new UserMessageError("That order could not be identified. Refresh the order list.");
    }
    const checked = validateReason(reason, { label: "reason for cancelling" });
    if (!checked.ok) throw new UserMessageError(checked.message);
    const result = await cancel(orderId, checked.value);
    if (result?.status !== "cancelled") {
      throw new UserMessageError("Cancellation could not be confirmed. Check the order status before trying again.");
    }
    return result;
  });
}
