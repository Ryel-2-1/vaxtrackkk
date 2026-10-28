"use strict";

const { statuses, custodyFields } = require("./preDepartureCancellation.json");

/** Conservative order-only check; the transaction also verifies reservation/trip. */
function potentiallyCancellable(order) {
  if (!statuses.includes(order?.status) || ![1, 2].includes(order.allocationVersion) ||
      order.allocationStatus !== "reserved") return false;
  if (custodyFields.some((key) => order[key] !== undefined && order[key] !== null)) return false;
  if (order.isLoaded !== undefined && order.isLoaded !== false) return false;
  if (order.status === "loading" && order.isLoaded !== false) return false;
  if (order.failureCount !== undefined && order.failureCount !== 0) return false;
  if (order.status !== "pending_dispatch" || order.assignedRiderId != null || order.dispatchTripId != null) {
    if (typeof order.assignedRiderId !== "string" || !order.assignedRiderId ||
        typeof order.dispatchTripId !== "string" || !order.dispatchTripId || order.dispatchTripId.includes("/")) return false;
  }
  return true;
}

module.exports = { potentiallyCancellable };
