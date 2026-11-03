"use strict";

/**
 * Stock and expiry alerts (MOD-10) — the decision, pure; no Firestore.
 *
 * Two server-written alert types, one alert document per condition:
 *
 *   stock_low     alerts/stock_low_<vaccineId>
 *     low   a vaccine's AVAILABLE vials are at or below its safety stock —
 *           the Admin's own reorder configuration (inventoryAnalyticsConfig,
 *           enabled, safetyStockQuantity). No threshold is ever invented: a
 *           vaccine without one gets no low-stock alert.
 *     out   no vials available at all, for a vaccine that has stock batches.
 *   batch_expiry  alerts/batch_expiry_<inventoryId>
 *     expiring  a batch still holding vials expires within 30 days — the
 *               "critical" band Admin Inventory already shows (src/services/expiry.js).
 *     expired   a batch past its expiry date still holds vials.
 *
 * AVAILABLE = quantity − reserved − returnPending − quarantined, on batches
 * that are not voided and not expired (expired stock cannot be ordered).
 * HOLDING (for expiry) = quantity − quarantined: vials still on the shelf.
 *
 * Lifecycle: an alert opens when its condition appears and is resolved by the
 * server ("cleared") when it goes away. An Admin may resolve one by hand; it is
 * then left alone while the SAME condition continues, and reopens only when the
 * condition gets worse (low → out, expiring → expired) or clears and returns.
 * An archived vaccine raises nothing; its open alerts are cleared.
 */

const { isoDateOnly } = require("./policy");

const EXPIRING_WITHIN_DAYS = 30; // src/services/expiry.js CRITICAL_WITHIN_DAYS
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ADMIN_PATH = "/admin/inventory";

const TYPE = Object.freeze({ STOCK: "stock_low", EXPIRY: "batch_expiry" });
const stockAlertId = (vaccineId) => `stock_low_${vaccineId}`;
const expiryAlertId = (inventoryId) => `batch_expiry_${inventoryId}`;

const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (v, fallback) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const plural = (n, word) => `${n.toLocaleString("en-PH")} ${word}${n === 1 ? "" : "s"}`;

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / MS_PER_DAY);
}

/** One batch's figures, or null when its counters cannot be trusted. */
function batchFigures(data, todayIso) {
  const held = ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity"].map((k) => data?.[k] ?? 0);
  if (!whole(data?.quantity) || !held.every(whole)) return null;
  const [reserved, returnPending, quarantined] = held;
  const expiry = isoDateOnly(data?.expiryDate);
  const expired = expiry !== null && expiry < todayIso;
  const voided = data?.voided === true;
  return {
    expiry,
    expired,
    voided,
    holding: voided ? 0 : Math.max(0, data.quantity - quarantined),
    available: voided || expired || expiry === null ? 0 : Math.max(0, data.quantity - reserved - returnPending - quarantined),
  };
}

/** The safety stock (vials) from an enabled quantity-based configuration, else null. */
function safetyStockOf(config) {
  if (!config || config.enabled !== true) return null;
  const qty = config.safetyStockQuantity;
  return Number.isSafeInteger(qty) && qty > 0 ? qty : null;
}

/**
 * The conditions that hold now, keyed by alert id:
 *   { [alertId]: { type, conditionKey, severity, title, message, fields } }
 * `complete` false (too many batches to read) skips the product-level check.
 */
function evaluateStockConditions({ vaccineId, product, batches, config, todayIso, complete = true }) {
  const out = {};
  if (product?.archived === true) return out;
  const name = text(product?.vaccineName, text(product?.name, "This vaccine"));
  let available = 0;
  let countable = complete;
  let stockBatches = 0;
  for (const { id, data } of batches) {
    const f = batchFigures(data, todayIso);
    if (f === null) {
      countable = false;
      continue;
    }
    if (!f.voided) stockBatches++;
    available += f.available;
    if (f.holding > 0 && f.expiry !== null) {
      const days = daysBetween(todayIso, f.expiry);
      const batchLabel = text(data?.batchId, "a batch");
      if (f.expired) {
        out[expiryAlertId(id)] = {
          type: TYPE.EXPIRY,
          conditionKey: "expired",
          severity: "critical",
          title: `Expired stock: ${name}`,
          message: `Batch ${batchLabel} of ${name} expired on ${f.expiry} and still holds ${plural(f.holding, "vial")}. ` +
            "Quarantine or dispose of it in Inventory.",
          fields: { vaccineId, vaccineName: name, inventoryId: id, batchId: text(data?.batchId, null), expiryDate: f.expiry, holdingQuantity: f.holding },
        };
      } else if (days <= EXPIRING_WITHIN_DAYS) {
        out[expiryAlertId(id)] = {
          type: TYPE.EXPIRY,
          conditionKey: "expiring",
          severity: "warning",
          title: `Expiring soon: ${name}`,
          message: `Batch ${batchLabel} of ${name} expires on ${f.expiry} with ${plural(f.holding, "vial")} in stock. ` +
            "Use or allocate it first.",
          fields: { vaccineId, vaccineName: name, inventoryId: id, batchId: text(data?.batchId, null), expiryDate: f.expiry, holdingQuantity: f.holding },
        };
      }
    }
  }
  if (countable && stockBatches > 0) {
    const safety = safetyStockOf(config);
    if (available === 0) {
      out[stockAlertId(vaccineId)] = {
        type: TYPE.STOCK,
        conditionKey: "out",
        severity: "critical",
        title: `Out of stock: ${name}`,
        message: `${name} has no vials available to order. Add stock in Inventory.`,
        fields: { vaccineId, vaccineName: name, availableQuantity: 0, safetyStockQuantity: safety },
      };
    } else if (safety !== null && available <= safety) {
      out[stockAlertId(vaccineId)] = {
        type: TYPE.STOCK,
        conditionKey: "low",
        severity: "warning",
        title: `Low stock: ${name}`,
        message: `${name} has ${plural(available, "vial")} available, at or below its safety stock of ${plural(safety, "vial")}. ` +
          "Reorder or add stock.",
        fields: { vaccineId, vaccineName: name, availableQuantity: available, safetyStockQuantity: safety },
      };
    }
  }
  return out;
}

/** Worse wins: a manually resolved alert reopens only for a worse condition. */
const RANK = Object.freeze({ low: 1, out: 2, expiring: 1, expired: 2 });

/**
 * The alert writes, given what holds now and what is stored.
 *   conditions  evaluateStockConditions(...)
 *   existing    { [alertId]: stored alert data } for every alert id this
 *               product could own (its stock alert + one per batch)
 * Returns [{ id, data, merge }] — merge true for an update of a stored alert.
 */
function planStockAlertWrites({ conditions, existing, nowMs, serverTimestamp }) {
  const writes = [];
  const ids = new Set([...Object.keys(conditions), ...Object.keys(existing).filter((id) => existing[id])]);
  for (const id of ids) {
    const want = conditions[id] ?? null;
    const have = existing[id] ?? null;
    if (want) {
      const open = have?.status === "active";
      const sameCondition = have?.conditionKey === want.conditionKey;
      const handResolved = have?.status === "resolved" && have?.resolvedBy !== "server";
      if (handResolved && have.conditionKey && RANK[want.conditionKey] <= RANK[have.conditionKey]) continue;
      if (open && sameCondition && have.message === want.message && have.severity === want.severity) continue;
      // A new alert, or a worse condition, reads as new; an improvement (out →
      // low) or a changed count updates the open alert quietly.
      const reopen = !open || (!sameCondition && (RANK[want.conditionKey] ?? 0) > (RANK[have.conditionKey] ?? 0));
      writes.push({
        id,
        merge: Boolean(have) && !reopen,
        data: {
          type: want.type,
          severity: want.severity,
          status: "active",
          title: want.title,
          message: want.message,
          conditionKey: want.conditionKey,
          ...want.fields,
          path: ADMIN_PATH,
          audience: "admin",
          source: "server",
          updatedAt: serverTimestamp(),
          lastDetectedAtMs: nowMs,
          ...(reopen
            ? { read: false, createdAt: serverTimestamp(), resolvedAt: null, resolvedBy: null, resolutionReason: null }
            : {}),
        },
      });
    } else if (have?.status === "active") {
      writes.push({
        id,
        merge: true,
        data: { status: "resolved", resolvedBy: "server", resolutionReason: "cleared", resolvedAt: serverTimestamp(), updatedAt: serverTimestamp() },
      });
    } else if (have?.status === "resolved" && have.conditionKey) {
      // Cleared after a person resolved it: a future occurrence opens a new alert.
      writes.push({ id, merge: true, data: { conditionKey: null, updatedAt: serverTimestamp() } });
    }
  }
  return writes;
}

module.exports = {
  TYPE,
  EXPIRING_WITHIN_DAYS,
  stockAlertId,
  expiryAlertId,
  batchFigures,
  safetyStockOf,
  evaluateStockConditions,
  planStockAlertWrites,
};
