/**
 * Dispatcher cancel dialog: what cancelling does to the order's stock, by
 * whether its vials have been handled. Mirrors the server
 * (functions/src/policy.js cancellationReturnsForInspection), which decides
 * from the stored order — this text only explains it: once the order is
 * confirmed as loaded in Cargo Loading, or dispatched, its vials come back as a
 * return for an Admin to inspect instead of going straight back into available
 * stock. [loadingConfirmed] is loadingCustodyConfirmed(order): the checkbox is
 * ticked now, or the loading audit shows it was ticked before an untick.
 */
export function cancelStockEffect(statusKey, loadingConfirmed = false) {
  switch (statusKey) {
    case "in_transit":
    case "delayed":
      return "Its vials are with the rider. They will be held as a return until an Admin checks them under Stock Allocation — they do not go back into available stock automatically.";
    case "loading":
      return loadingConfirmed === true
        ? "Its vials were confirmed as loaded in Cargo Loading. They will be held as a return until an Admin inspects them under Stock Allocation — they do not go back into available stock automatically."
        : "Nothing on it is confirmed as loaded, so its reservation is released for other orders straight away.";
    case "delivery_failed":
      return "Its returned vials stay with their return for an Admin to check.";
    default:
      return "Its reserved stock is released for other orders.";
  }
}
