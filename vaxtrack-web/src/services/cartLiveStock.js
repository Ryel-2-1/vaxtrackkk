// The Med Rep cart, checked against what its batches look like NOW.
//
// A cart line carries what the catalog showed when it was added: the batch's
// available stock and its unit price. Both used to stay frozen on the Place
// Order page until a reload, so a batch that sold out (or was restocked) in the
// meantime still read "Available: 40 vials", and a price changed by an admin
// surfaced only as a refusal at checkout.
//
// Nothing here changes the cart on its own. Lines are ANNOTATED with what
// changed; finalizing is BLOCKED until the rep reviews each change — accepts
// the current price, acknowledges a new shortfall, or removes a line that can
// no longer be ordered — and only an explicit acceptance (acceptLiveLine)
// rewrites a line. The server stays authoritative: it re-reads every batch and
// refuses any price that is not the current one, whatever this page shows.

import { evaluateBatchEligibility } from "./orderEligibility.js";
import { readPriceCentavos } from "./money.js";

/** The batch ids the cart needs to watch — and nothing else. */
export function cartBatchIds(items) {
  return [...new Set(items.map((item) => item.inventoryId).filter((id) => typeof id === "string" && id))].sort();
}

/**
 * [items]   cart lines ({ inventoryId, quantity, expectedUnitPriceCentavos, availableNow, … })
 * [batches] the live snapshot of THOSE batches, or null while it is not
 *           available (loading or failed) — then the lines are returned as
 *           they were.
 * [todayIso] Manila 'YYYY-MM-DD', read where the snapshot arrived.
 *
 * Each returned line adds:
 *   live              true when a current batch was found
 *   cartAvailable     the availability the rep saw (or last accepted)
 *   availableNow      current available stock (the cart's value when not live)
 *   livePriceCentavos the batch's current unit price (null = not priced)
 *   priceChanged      the current price differs from the one in the cart
 *   batchGone         the batch no longer exists
 *   liveBlockedReason why the batch can no longer be ordered (same rule as the
 *                     catalog and the server), or null
 *   stockShortNow     the line fitted the stock the rep saw but no longer fits
 *                     (part of it would now be backordered)
 */
export function liveCartLines(items, batches, todayIso) {
  const quiet = { live: false, livePriceCentavos: null, priceChanged: false, batchGone: false, liveBlockedReason: null, stockShortNow: false };
  if (!Array.isArray(batches)) {
    return items.map((item) => ({ ...item, ...quiet, cartAvailable: item.availableNow }));
  }
  const byId = new Map(batches.map((b) => [b.id, b]));
  return items.map((item) => {
    const batch = item.inventoryId ? byId.get(item.inventoryId) : undefined;
    if (!batch) {
      return { ...item, ...quiet, cartAvailable: item.availableNow, batchGone: Boolean(item.inventoryId) };
    }
    const eligibility = evaluateBatchEligibility(batch, todayIso);
    const available = eligibility.availableQuantity;
    const liveAvailable = Number.isInteger(available) && available >= 0 ? available : null;
    const livePriceCentavos = readPriceCentavos(batch.sellingPriceCentavos);
    const cartAvailable = item.availableNow;
    return {
      ...item,
      live: true,
      cartAvailable,
      availableNow: liveAvailable ?? item.availableNow,
      livePriceCentavos,
      priceChanged: livePriceCentavos !== item.expectedUnitPriceCentavos,
      batchGone: false,
      liveBlockedReason: eligibility.eligible ? null : eligibility.reason || "This batch can no longer be ordered.",
      stockShortNow:
        liveAvailable !== null &&
        Number.isInteger(cartAvailable) &&
        item.quantity <= cartAvailable &&
        item.quantity > liveAvailable,
    };
  });
}

/**
 * What each annotated line needs before the order may be finalized:
 *   "remove"       the batch is gone, can no longer be ordered, or has no price
 *   "accept-price" the price changed; the rep accepts the current one or removes the line
 *   "accept-stock" the line no longer fits the stock; the rep acknowledges the
 *                  backorder (or lowers the quantity, or removes it)
 *   null           nothing to review
 */
export function lineReview(line) {
  if (line.batchGone || line.liveBlockedReason) return "remove";
  if (line.live && line.priceChanged) return line.livePriceCentavos === null ? "remove" : "accept-price";
  if (line.stockShortNow) return "accept-stock";
  return null;
}

/**
 * The checkout gate. [status] is the live listener's state: "loading",
 * "live" or "failed".
 *   blocked   finalizing is not allowed
 *   checking  the current prices are still being read
 *   pending   lines that need the rep's review
 *   unverified the live check failed: not blocked (the server re-checks every
 *             price and refuses a stale one), but the rep is told
 */
export function cartReview(lines, status) {
  const pending = lines.filter((line) => lineReview(line) !== null);
  const checking = status === "loading" && lines.length > 0;
  return {
    checking,
    unverified: status === "failed",
    pending,
    blocked: checking || pending.length > 0,
  };
}

/**
 * The rep's explicit acceptance of what a line shows now — the ONLY way the
 * live data changes the cart. Accepting a price makes the current price the
 * one the server is asked to confirm; acknowledging a shortfall records the
 * stock the rep has now seen. Every other line, and the quantity, are untouched.
 */
export function acceptLiveLine(items, line) {
  const review = lineReview(line);
  if (review !== "accept-price" && review !== "accept-stock") return items;
  return items.map((item) => {
    if (item.inventoryId !== line.inventoryId || item.sku !== line.sku) return item;
    const next = { ...item };
    if (line.priceChanged && line.livePriceCentavos !== null) next.expectedUnitPriceCentavos = line.livePriceCentavos;
    if (Number.isInteger(line.availableNow)) next.availableNow = line.availableNow;
    return next;
  });
}
