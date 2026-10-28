"use strict";

/** List housekeeping only. Never archive a product or change stock/ordering. */
const VISIBILITY_VERSION = 1;
const MAX_PRODUCT_BATCHES = 1000;
const MANILA_OFFSET = 8 * 60 * 60 * 1000;

function millis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (value && typeof value.toMillis === "function") {
    const result = value.toMillis();
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

/** Calendar months, Philippine time, preserving time of day and clamping month-end. */
function inactiveAfter(value) {
  const start = millis(value);
  if (start === null) return null;
  const d = new Date(start + MANILA_OFFSET);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 4, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) - MANILA_OFFSET;
}

function physicalStockState(batches, complete = true) {
  if (!complete || !Array.isArray(batches)) return "needs_review";
  let hasStock = false;
  for (const batch of batches) {
    const held = ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity"].map((key) => batch?.[key] ?? 0);
    if (held.some((n) => !Number.isSafeInteger(n) || n < 0)) return "needs_review";
    // A voided entry isn't stock, but never hide a contradictory custody record.
    if (batch?.voided === true) {
      if (held.some((n) => n > 0)) return "needs_review";
      continue;
    }
    if (!Number.isSafeInteger(batch?.quantity) || batch.quantity < 0 ||
        held.reduce((a, b) => a + b, 0) > batch.quantity) return "needs_review";
    if (batch.quantity > 0) hasStock = true;
  }
  return hasStock ? "in_stock" : "empty";
}

/**
 * First confirmed observation, NOT createdAt/expiry/last sale, starts the clock.
 * A previously unseen positive event resets an empty interval conservatively
 * at observation time. Replays/old events cannot reset it again or backdate it.
 */
function planObservation({ product, batches, complete = true, positiveEvidenceAt = null, now }) {
  const nowMs = millis(now);
  if (nowMs === null) throw new TypeError("A valid server observation time is required.");
  const state = physicalStockState(batches, complete);
  const previousPositive = millis(product?.inventoryPositiveEvidenceAt);
  const evidence = millis(positiveEvidenceAt);
  const positiveMs = evidence === null ? previousPositive : Math.max(previousPositive ?? evidence, evidence);
  const newPositiveEvidence = evidence !== null && (previousPositive === null || evidence > previousPositive);
  const oldEmpty = millis(product?.inventoryEmptySince);
  const keepInterval = product?.inventoryVisibilityVersion === VISIBILITY_VERSION &&
    product.inventoryStockState === "empty" && oldEmpty !== null && oldEmpty <= nowMs && !newPositiveEvidence;
  const emptyMs = state === "empty" ? (keepInterval ? oldEmpty : Math.max(nowMs, positiveMs ?? nowMs)) : null;
  const update = {
    inventoryVisibilityVersion: VISIBILITY_VERSION,
    inventoryStockState: state,
    inventoryEmptySince: emptyMs === null ? null : new Date(emptyMs),
    inventoryPositiveEvidenceAt: positiveMs === null ? null : new Date(positiveMs),
  };
  const changed = product?.inventoryVisibilityVersion !== VISIBILITY_VERSION ||
    product.inventoryStockState !== state || oldEmpty !== emptyMs || previousPositive !== positiveMs;
  return { changed, update };
}

module.exports = { VISIBILITY_VERSION, MAX_PRODUCT_BATCHES, millis, inactiveAfter, physicalStockState, planObservation };
