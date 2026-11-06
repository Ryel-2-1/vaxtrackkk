"use strict";

/**
 * Stock and expiry alerts — the transactions (rules in stockAlerts.js).
 *
 * reviewProductStockAlerts   one vaccine: re-read its batches, its reorder
 *                            configuration and its alerts, then open, update or
 *                            resolve them, in one transaction.
 * Run from: every inventory write (reviewStockAlertsOnInventoryWrite), every
 * reorder-configuration write, the daily inventory review, and the Admin's
 * "Check stock now" (recheckStockAlerts) — the last two catch a batch crossing
 * an expiry boundary with no stock change at all.
 */

const S = require("./stockAlerts");
const { MAX_PRODUCT_BATCHES } = require("./inventoryVisibility");
const { manilaDateString, PolicyError } = require("./policy");
const { loadUser, requireRole } = require("./operations");

const ALERTS = "alerts";
const validId = (id) => typeof id === "string" && id !== "" && !id.includes("/");

async function reviewProductStockAlerts({ db, FieldValue, vaccineId, now = new Date() }) {
  if (!validId(vaccineId)) throw new TypeError("Invalid vaccine id.");
  const todayIso = manilaDateString(now);
  return db.runTransaction(async (tx) => {
    const product = await tx.get(db.collection("vaccines").doc(vaccineId));
    const batchSnap = await tx.get(db.collection("inventory").where("vaccineId", "==", vaccineId).limit(MAX_PRODUCT_BATCHES + 1));
    const config = await tx.get(db.collection("inventoryAnalyticsConfig").doc(vaccineId));
    const batches = batchSnap.docs.slice(0, MAX_PRODUCT_BATCHES).map((d) => ({ id: d.id, data: d.data() }));
    const alertIds = [S.stockAlertId(vaccineId), ...batches.map((b) => S.expiryAlertId(b.id))];
    const alertSnaps = await tx.getAll(...alertIds.map((id) => db.collection(ALERTS).doc(id)));
    const existing = Object.fromEntries(alertSnaps.map((s) => [s.id, s.exists ? s.data() : null]));

    const conditions = product.exists
      ? S.evaluateStockConditions({
        vaccineId,
        product: product.data(),
        batches,
        config: config.exists ? config.data() : null,
        todayIso,
        complete: batchSnap.size <= MAX_PRODUCT_BATCHES,
      })
      : {};
    const writes = S.planStockAlertWrites({ conditions, existing, nowMs: now.getTime(), serverTimestamp: () => FieldValue.serverTimestamp() });
    for (const w of writes) tx.set(db.collection(ALERTS).doc(w.id), w.data, { merge: w.merge });
    return { vaccineId, written: writes.length };
  });
}

/** Both sides of an inventory write may name a vaccine (a batch moved products). */
async function reviewStockAlertsForInventoryWrite({ db, FieldValue, before, after, now = new Date() }) {
  const ids = new Set(
    [before?.exists ? before.data()?.vaccineId : null, after?.exists ? after.data()?.vaccineId : null].filter(validId),
  );
  const results = [];
  for (const vaccineId of ids) results.push(await reviewProductStockAlerts({ db, FieldValue, vaccineId, now }));
  return results;
}

/**
 * Admin "Check stock now": every vaccine, five at a time. Returns how many
 * were checked and how many alerts changed; a failure on one vaccine is
 * counted and skipped, never hidden as success.
 */
async function recheckStockAlerts({ db, FieldValue, uid, now = new Date(), limit = 500 }) {
  requireRole(await loadUser(db, uid), "admin");
  const snap = await db.collection("vaccines").limit(limit + 1).get();
  if (snap.size > limit) {
    throw new PolicyError("too-many-products", `There are more than ${limit} vaccines; the daily review covers them all.`);
  }
  let changed = 0;
  let failed = 0;
  for (let i = 0; i < snap.docs.length; i += 5) {
    await Promise.all(snap.docs.slice(i, i + 5).map(async (doc) => {
      try {
        changed += (await reviewProductStockAlerts({ db, FieldValue, vaccineId: doc.id, now })).written;
      } catch {
        failed++;
      }
    }));
  }
  return { checked: snap.size, changed, failed };
}

module.exports = { reviewProductStockAlerts, reviewStockAlertsForInventoryWrite, recheckStockAlerts };
