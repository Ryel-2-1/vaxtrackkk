/**
 * The usual largest batch. Above this an Admin must confirm the figure: the
 * quantity is still accepted, because a real delivery can be larger, but a typo
 * here misstates every stock number downstream. The server enforces the same
 * rule (functions/src/policy.js LARGE_STOCK_QUANTITY) and records who confirmed.
 */
export const LARGE_STOCK_QUANTITY = 5000;

export function isLargeStockQuantity(quantity) {
  return Number.isInteger(quantity) && quantity > LARGE_STOCK_QUANTITY;
}

/** "12,000 vials is above the usual 5,000 per batch." */
export function largeQuantityMessage(quantity) {
  return `${quantity.toLocaleString("en-PH")} vials is above the usual ${LARGE_STOCK_QUANTITY.toLocaleString("en-PH")} per batch.`;
}
