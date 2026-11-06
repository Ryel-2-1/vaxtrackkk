import { friendlyErrorMessage } from "./liveDataErrors.js";
import { checkoutScheduleErrorMessage } from "./checkoutSchedule.js";
import { formatCentavos } from "./money.js";
/**
 * A server error code turned into something a rep can act on.
 *
 * The server already writes a user-facing sentence; this only adds the extra
 * step where the right next action is not obvious from the message alone.
 */
const ORDER_FAILURE_MESSAGE =
  "We couldn't confirm the order. Your cart and entries are still here. Check Order Tracking before trying again.";

export function messageForCallableError(error) {
  const scheduleMessage = checkoutScheduleErrorMessage(error?.code);
  if (scheduleMessage) return scheduleMessage;
  switch (error?.code) {
    case "insufficient-stock": {
      const info = error.info;
      return info
        ? `Only ${info.available} left in batch ${info.batchId ?? info.inventoryId}. Adjust the quantity and try again.`
        : friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
    }
    case "batch-expired":
      return "One of these batches has expired and can no longer be ordered. Remove it and pick another.";
    case "price-changed": {
      // The whole point of the check is that a rep sees the real numbers and
      // decides, so both figures are named rather than summarised as "changed".
      const info = error.info;
      if (!info) return friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
      const batch = info.batchId ?? info.inventoryId;
      return `The standard price of batch ${batch} changed from ${formatCentavos(
        info.expectedUnitPriceCentavos
      )} to ${formatCentavos(
        info.currentUnitPriceCentavos
      )} while you were ordering. Nothing was placed. Accept the new standard price on that line, check your agreed price, and confirm again.`;
    }
    case "batch-unpriced":
      return "One of these batches has no selling price yet. An admin needs to price it before it can be ordered.";
    case "price-not-confirmed":
      return "This cart was built before batch pricing. Please rebuild it from the catalog so the prices can be confirmed.";
    case "adjustment-reason-required":
      return "Give a reason for every negotiated price that differs from the standard price. Nothing was placed.";
    case "invalid-agreed-price":
      return "One of the agreed prices is not a valid amount. Correct it and confirm again. Nothing was placed.";
    case "inventory-migration-required":
      return "One of these batches still records its stock as text and needs an admin migration before it can be ordered.";
    case "idempotency-conflict":
      // The server recognised this draft's request ID but with different
      // contents: an earlier attempt of this checkout WAS placed. The ID is
      // deliberately not rotated automatically — that would let the rep place
      // a second order without knowing the first exists.
      return "An earlier attempt of this checkout was already placed with different details. Check Order Tracking first. If you still need this order, discard the previous attempt and finalize again.";
    case "duplicate-inventory-line":
      return "The same batch appears on two lines. Combine them into one.";
    case "requested-date-required":
      return "Choose a delivery date for this order. Nothing was placed.";
    case "invalid-requested-date":
      return friendlyErrorMessage(error, "Choose a valid delivery date, today or later. Nothing was placed.");
    default:
      // A domain refusal keeps the server's own sentence (a trusted domain
      // error); anything else gets a safe mapped message — never raw text.
      return friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
  }
}

