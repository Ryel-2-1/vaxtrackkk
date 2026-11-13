import { isoDateOnly } from "./expiry.js";
import { formatRequestedDate } from "./requestedArrival.js";

/**
 * Checkout heads-up for stock that arrives AFTER the requested delivery date
 * (2026-11-13). The server never reserves such a batch for an earlier delivery
 * (functions/src/expiryGuard.js `arrivesBy`): the order waits for stock that is
 * at the hub in time, or is rescheduled. This only tells the Med Rep before
 * they place it. Nothing is blocked here.
 *
 * @param {Array<{inventoryId?: string, name?: string}>} items  cart lines
 * @param {Array<{id: string, arrivalDate?: string}>|null} batches  the cart's live batches
 * @param {string} requestedDate  'YYYY-MM-DD'
 * @returns {null | {latestArrival: string, names: string[], text: string}}
 */
export function lateStockArrival(items, batches, requestedDate) {
  const date = isoDateOnly(requestedDate);
  if (!date || !Array.isArray(items) || !Array.isArray(batches)) return null;
  const byId = new Map(batches.map((b) => [b.id, b]));
  const late = [];
  for (const item of items) {
    const arrival = isoDateOnly(byId.get(item?.inventoryId)?.arrivalDate);
    if (arrival && arrival > date) late.push({ arrival, name: item.name || "A vaccine" });
  }
  if (late.length === 0) return null;
  const latestArrival = late.map((l) => l.arrival).sort().at(-1);
  const names = [...new Set(late.map((l) => l.name))];
  const when = formatRequestedDate(latestArrival);
  return {
    latestArrival,
    names,
    text: `${names.join(", ")} ${names.length === 1 ? "arrives" : "arrive"} on ${when}, after your requested date. `
      + `The order waits for stock that is at the hub in time. If none is, it can't be dispatched: choose ${when} or later.`,
  };
}
