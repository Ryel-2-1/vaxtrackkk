/** Automatic list housekeeping only; manual archive, ordering and custody stay separate. */
const MANILA_OFFSET = 8 * 60 * 60 * 1000;

function millis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (value && typeof value.toMillis === "function") {
    const result = value.toMillis();
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

export function inactiveAfter(value) {
  const start = millis(value);
  if (start === null) return null;
  const d = new Date(start + MANILA_OFFSET);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 4, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) - MANILA_OFFSET;
}

function provablyEmpty(batch) {
  const held = ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity"].map((key) => batch?.[key] ?? 0);
  if (held.some((n) => !Number.isSafeInteger(n) || n !== 0)) return false;
  return batch?.voided === true || batch?.quantity === 0;
}

/**
 * Both live sources must agree: ANY new stock/held/corrupt figure shows the
 * product immediately, even before the asynchronous observer catches up.
 * Missing metadata never hides legacy data. Pass the COMPLETE inventory,
 * before search/pagination/normalization; never use a cart's partial query.
 */
export function inactiveProductIds(vaccines, batches, nowMs) {
  const hidden = new Set();
  if (!Array.isArray(vaccines) || !Array.isArray(batches) || !Number.isFinite(nowMs)) return hidden;
  const notEmpty = new Set(batches.filter((b) => !provablyEmpty(b)).map((b) => b.vaccineId));
  for (const vaccine of vaccines) {
    const threshold = inactiveAfter(vaccine.inventoryEmptySince);
    if (typeof vaccine.id === "string" && vaccine.inventoryVisibilityVersion === 1 &&
        vaccine.inventoryStockState === "empty" && threshold !== null && nowMs > threshold &&
        !notEmpty.has(vaccine.id)) hidden.add(vaccine.id);
  }
  return hidden;
}
