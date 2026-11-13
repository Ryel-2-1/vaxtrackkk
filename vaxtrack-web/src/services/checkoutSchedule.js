import { manilaToday, validateRequestedDate } from "./requestedDate.js";
import { normalizeRequestedArrival } from "./requestedArrival.js";

/**
 * Only a durable pending attempt may skip the local clock pre-check. Its
 * snapshot must still match in submitOrderDraft; the SERVER replays an existing
 * key or applies strict date/time validation before creating anything new.
 * This never changes a date/time, invents a deadline, or rotates a request id.
 */
export function validateCheckoutSchedule({ requestedDeliveryDate, requestedArrival, recovering = false, now = new Date() }) {
  const date = validateRequestedDate(requestedDeliveryDate, { today: manilaToday(now), allowPast: recovering });
  const arrival = date.ok ? normalizeRequestedArrival(requestedArrival, {
    requestedDeliveryDate: date.value,
    now,
    validateFuture: !recovering,
  }) : null;
  return { date, arrival };
}

/** Known validation/release failures are not connectivity failures. No raw
 * payload key or provider message is rendered, and no automatic retry omits a
 * requested time just to get past an older server. */
export function checkoutScheduleErrorMessage(code) {
  switch (code) {
    case "unknown-field":
      return "This checkout is not compatible with the current ordering service. Your cart has been kept. Contact an administrator before retrying.";
    case "invalid-requested-arrival":
      return "Check the requested delivery time. Choose a valid time or window on the requested day. Your cart has been kept.";
    case "requested-arrival-passed":
      return "The requested delivery time has already passed. Check Order Tracking for an earlier attempt before changing the date or time.";
    default:
      return null;
  }
}
