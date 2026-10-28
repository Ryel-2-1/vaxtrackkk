/**
 * Table display for batch IDs. Batch IDs have no length limit (the rules only
 * require a non-empty string), so a table cell shows at most
 * BATCH_ID_DISPLAY_MAX characters: the start and the end joined by an
 * ellipsis, keeping the lot prefix and suffix that tell batches apart. The
 * stored value is never changed; screens that abbreviate must offer the full
 * value elsewhere (Med Rep Inventory: the row details dialog).
 */

export const BATCH_ID_DISPLAY_MAX = 24;
const TAIL = 8;

/**
 * The abbreviated form of `batchId`, or null when it already fits.
 * Counts code points, so a surrogate pair is never split.
 *
 * @param {string} batchId
 * @returns {string | null}
 */
export function abbreviateBatchId(batchId) {
  const chars = Array.from(String(batchId ?? ""));
  if (chars.length <= BATCH_ID_DISPLAY_MAX) return null;
  const head = chars.slice(0, BATCH_ID_DISPLAY_MAX - TAIL - 1).join("");
  return `${head}…${chars.slice(-TAIL).join("")}`;
}
