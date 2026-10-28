"use strict";

const { MAX_PRODUCT_BATCHES, millis, planObservation } = require("./inventoryVisibility");
const CURSOR_COLLECTION = "inventoryVisibilityMaintenance";
const CURSOR_ID = "catalog";

function productIds(before, after) {
  return [...new Set([before?.vaccineId, after?.vaccineId].filter((id) => typeof id === "string" && id && !id.includes("/")))];
}

/** Re-read all this product's batches. A late trigger never replays old counters. */
async function observeProductInventory({ db, vaccineId, now = new Date(), positiveEvidenceAt = null }) {
  if (typeof vaccineId !== "string" || !vaccineId || vaccineId.includes("/")) throw new TypeError("Invalid vaccine id.");
  const ref = db.collection("vaccines").doc(vaccineId);
  return db.runTransaction(async (tx) => {
    const product = await tx.get(ref);
    if (!product.exists) return { skipped: "missing_product" };
    const batches = await tx.get(db.collection("inventory").where("vaccineId", "==", vaccineId).limit(MAX_PRODUCT_BATCHES + 1));
    let evidenceMs = millis(positiveEvidenceAt);
    for (const batch of batches.docs) {
      const data = batch.data();
      if (data.voided !== true && Number.isSafeInteger(data.quantity) && data.quantity > 0) {
        const committed = millis(batch.updateTime);
        if (committed !== null) evidenceMs = Math.max(evidenceMs ?? committed, committed);
      }
    }
    const plan = planObservation({
      product: product.data(), batches: batches.docs.map((b) => b.data()),
      complete: batches.size <= MAX_PRODUCT_BATCHES,
      positiveEvidenceAt: evidenceMs === null ? null : new Date(evidenceMs), now,
    });
    if (plan.changed) tx.update(ref, plan.update);
    return { changed: plan.changed, state: plan.update.inventoryStockState };
  });
}

/** Positive snapshots are evidence of an interruption, even after being overwritten. */
async function observeInventoryWrite({ db, before, after, now = new Date() }) {
  const ids = productIds(before?.exists ? before.data() : null, after?.exists ? after.data() : null);
  return Promise.all(ids.map((vaccineId) => {
    const evidence = [before, after].filter((s) => s?.exists && s.data().vaccineId === vaccineId &&
      s.data().voided !== true && Number.isSafeInteger(s.data().quantity) && s.data().quantity > 0)
      .map((s) => millis(s.updateTime)).filter((ms) => ms !== null);
    return observeProductInventory({ db, vaccineId, now, positiveEvidenceAt: evidence.length ? new Date(Math.max(...evidence)) : null });
  }));
}

/**
 * One bounded page per daily run; a durable cursor prevents the first 200
 * products starving the rest. No new composite index. Unknown/oversized data
 * stays visible. Errors are isolated and revisited on the next catalog cycle.
 */
async function reviewInventoryVisibilityRun({ db, FieldPath, now = new Date(), pageSize = 200,
  observe = observeProductInventory, logFailure = () => {} }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new TypeError("Invalid review page size.");
  const cursorRef = db.collection(CURSOR_COLLECTION).doc(CURSOR_ID);
  const cursor = (await cursorRef.get()).data()?.afterId;
  let query = db.collection("vaccines").orderBy(FieldPath.documentId()).limit(pageSize);
  if (typeof cursor === "string" && cursor && !cursor.includes("/")) query = query.startAfter(cursor);
  const page = await query.get();
  let changed = 0;
  let failed = 0;
  // Five concurrent transactions, not an unbounded Promise.all over the catalog.
  for (let offset = 0; offset < page.docs.length; offset += 5) {
    await Promise.all(page.docs.slice(offset, offset + 5).map(async (product) => {
      try {
        const result = await observe({ db, vaccineId: product.id, now });
        if (result.changed) changed++;
      } catch (error) {
        failed++;
        logFailure({ vaccineId: product.id, errorType: error?.name ?? "Error" });
      }
    }));
  }
  const afterId = page.size === pageSize ? page.docs.at(-1).id : null;
  await cursorRef.set({ afterId, reviewedAt: now });
  return { scanned: page.size, changed, failed, afterId };
}

module.exports = { CURSOR_COLLECTION, productIds, observeProductInventory, observeInventoryWrite, reviewInventoryVisibilityRun };
