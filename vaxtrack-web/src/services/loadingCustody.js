/**
 * The loading custody record on an order: `loadedAt` + `loadedByUid`, stamped
 * by the FIRST Cargo Loading confirmation and never cleared or rewritten by a
 * dispatcher afterwards (firestore.rules, loadingAuditWriteValid). Unticking
 * clears only `isLoaded`.
 *
 * Mirrors functions/src/policy.js (hasLoadingAudit / loadingCustodyConfirmed),
 * which is what actually decides a cancellation; tests/cancelAfterDispatch.test.js
 * holds the two to the same table.
 */

function isValidTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (value && typeof value.toMillis === "function") {
    try {
      return Number.isFinite(value.toMillis());
    } catch {
      return false;
    }
  }
  return false;
}

/** A complete audit: a real timestamp and the confirming dispatcher's uid. */
export function hasLoadingAudit(order) {
  return (
    isValidTimestamp(order?.loadedAt) &&
    typeof order?.loadedByUid === "string" &&
    order.loadedByUid.length > 0
  );
}

/**
 * Were this order's vials ever confirmed as loaded? Yes when the flag is
 * exactly true now (including legacy orders ticked before the audit existed)
 * or a complete audit survives an untick.
 */
export function loadingCustodyConfirmed(order) {
  return order?.isLoaded === true || hasLoadingAudit(order);
}
