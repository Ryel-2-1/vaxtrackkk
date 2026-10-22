/**
 * Recording a returned stock decision BY QUANTITY: for each batch on a return,
 * how many vials were usable, damaged, a temperature excursion, or missing.
 *
 * Pure (no Firebase). It mirrors the server's rule in
 * functions/src/inventoryWorkflow.js `normalizeDispositionLines`: every batch
 * appears once, every figure is a whole number of zero or more, and each
 * batch's figures add up to exactly what came back. The server re-checks all
 * of this; this only lets the Admin see a problem before submitting.
 */

export const SPLIT_OUTCOMES = Object.freeze([
  { key: "usable", label: "Usable" },
  { key: "damaged", label: "Damaged" },
  { key: "temperature_excursion", label: "Temperature excursion" },
  { key: "missing", label: "Missing" },
]);

/** The return's batches as { inventoryId, batchLabel, quantity }, one per batch. */
export function returnBatches(ret) {
  const byId = new Map();
  for (const item of Array.isArray(ret?.items) ? ret.items : []) {
    const id = typeof item?.inventoryId === "string" ? item.inventoryId : null;
    if (!id) continue;
    const qty = Number.isInteger(item.quantity) ? item.quantity : 0;
    const prev = byId.get(id);
    byId.set(id, {
      inventoryId: id,
      batchLabel: prev?.batchLabel || item.batchId || id,
      quantity: (prev?.quantity ?? 0) + qty,
    });
  }
  return [...byId.values()];
}

/** A text field's value as a whole number, or null when it is not one. */
function wholeNumber(value) {
  if (value === "" || value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read a draft ({ [inventoryId]: { usable, damaged, ... } } of text or numbers)
 * against the return. Returns { valid, rows, lines } where each row carries
 * the batch, its figures, `assigned` (their total) and a `problem` sentence or
 * null, and `lines` is the payload for the server when valid.
 */
export function evaluateSplit(ret, draft = {}) {
  const rows = returnBatches(ret).map((batch) => {
    const entry = draft?.[batch.inventoryId] ?? {};
    const figures = {};
    let assigned = 0;
    let problem = null;
    for (const { key } of SPLIT_OUTCOMES) {
      const n = wholeNumber(entry[key]);
      if (n === null) {
        problem = "Use whole numbers of vials, zero or more.";
        figures[key] = 0;
      } else {
        figures[key] = n;
        assigned += n;
      }
    }
    if (!problem && assigned !== batch.quantity) {
      const diff = batch.quantity - assigned;
      problem = diff > 0
        ? `${diff.toLocaleString()} of ${batch.quantity.toLocaleString()} vials not yet recorded.`
        : `${(-diff).toLocaleString()} more than the ${batch.quantity.toLocaleString()} returned.`;
    }
    return { ...batch, figures, assigned, problem };
  });
  const valid = rows.length > 0 && rows.every((r) => r.problem === null);
  const lines = valid ? rows.map((r) => ({ inventoryId: r.inventoryId, ...r.figures })) : null;
  return { valid, rows, lines };
}

/** Totals by outcome across a valid split, e.g. for the confirmation sentence. */
export function splitTotals(lines) {
  const totals = Object.fromEntries(SPLIT_OUTCOMES.map(({ key }) => [key, 0]));
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const { key } of SPLIT_OUTCOMES) totals[key] += Number.isInteger(line?.[key]) ? line[key] : 0;
  }
  return totals;
}

/** Where a pending return came from, for the Admin's list. */
export function returnSourceLabel(ret) {
  if (ret?.source !== "cancelled_after_dispatch") return "Failed delivery";
  // Cancelled once the vials were handled: confirmed loaded, or with the rider.
  return ret?.cancelledFromStatus === "loading" ? "Cancelled after loading" : "Cancelled after dispatch";
}

/** The reason recorded with the return (failure reason or cancel reason). */
export function returnReason(ret) {
  return ret?.source === "cancelled_after_dispatch" ? ret?.cancelReason || null : ret?.failureReason || null;
}
