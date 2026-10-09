"use strict";

/**
 * AI Inventory Analytics — Phase 1: demand, stock and weekly history.
 *
 * Pure: no Firestore, no Functions SDK. The generator (scripts/
 * generateInventoryAnalytics.mjs → inventoryAnalyticsRun.js) reads documents
 * and hands them in; everything that decides WHAT counts as demand or stock
 * lives here, so it is unit-testable and has one implementation.
 *
 * ADVISORY ONLY. Nothing in the analytics modules writes inventory, orders,
 * reservations, prices or invoices; the only documents the generator writes are
 * the analytics collections themselves.
 *
 * DEMAND (one definition, used everywhere)
 *
 *   Requested demand = the `quantity` of each order line, counted ONCE per
 *   order document — never from delivered quantity (that would hide demand
 *   that went backordered for lack of stock), and never from status events,
 *   reservations or allocation events (each of those repeats the same order).
 *
 *   Included orders: status pending_dispatch, assigned, loading, in_transit,
 *   delayed, delivered (legacy "completed") and delivery_failed (still a
 *   genuine order: it may be requeued; a requeue keeps the SAME document, so it
 *   is still counted once). Whether an order is partially or fully reserved
 *   does not matter — reservation never changes requested quantity.
 *
 *   Excluded: cancelled (legacy "canceled"), and any order whose status is
 *   missing or not a VaxTrack status (reported, never guessed). There is no
 *   trusted "exclude from analytics" flag in the data model today, so none is
 *   honoured; inventing one would let anyone hide demand.
 *
 *   Product: the line's `productKey` (the vaccines-catalog id the allocation
 *   engine reserves against); for older lines without it, the quoted batch's
 *   `vaccineId`; otherwise the line is excluded with a warning.
 *
 *   Demand date (canonical): the order's requestedDeliveryDate when it is a
 *   real YYYY-MM-DD date; otherwise the Manila calendar day of createdAt;
 *   otherwise the line is excluded from the time series with a warning. The
 *   current date is never substituted.
 *
 * STOCK (per product, from the batches)
 *
 *   available  = Σ allocatableUnits(batch) — the allocation engine's own rule:
 *                on hand − reserved − return-pending − quarantined, and ZERO
 *                for an expired, undated, unusable-status, corrupt or
 *                unconfirmed (> 100,000,000) batch.
 *   reserved   = Σ reservedQuantity
 *   backordered = Σ (requested − reserved) over lines of orders the allocator
 *                still serves (isAllocatableOrder) — active backorders only.
 *   confirmed incoming: the data model has NO trusted incoming-stock field, so
 *                it is not tracked (reported as null; treated as 0 — the
 *                conservative choice, never an invented delivery).
 */

const { isoDateOnly, manilaDateString, isUnconfirmedStockQuantity, MAX_LINE_QUANTITY } = require("./policy");
const { allocatableUnits, readCounter, lineCounts, isAllocatableOrder } = require("./allocation");

const HORIZONS = Object.freeze([7, 30, 90]);
const PRIMARY_HORIZON = 30;
const AREA_ALL = "all";
/** Weekly buckets older than this many complete weeks are not used. */
const MAX_TRAINING_WEEKS = 52;

const ANALYTICS_COLLECTIONS = Object.freeze({
  FORECASTS: "inventoryForecasts",
  RUNS: "inventoryAnalyticsRuns",
  CONFIG: "inventoryAnalyticsConfig",
});

const DEMAND_STATUSES = Object.freeze([
  "pending_dispatch",
  "assigned",
  "loading",
  "in_transit",
  "delayed",
  "delivered",
  "delivery_failed",
]);
const EXCLUDED_STATUSES = Object.freeze(["cancelled"]);
const STATUS_ALIASES = Object.freeze({ completed: "delivered", canceled: "cancelled" });

/** No trusted incoming-stock field exists in the data model (see header). */
const CONFIRMED_INCOMING_TRACKED = false;

/**
 * Data-quality warning codes. Messages never carry names, emails, addresses or
 * any patient/authentication data — only counts and opaque document ids.
 */
const WARNING = Object.freeze({
  MISSING_ORDER_DATE: "missing_order_date",
  MISSING_PRODUCT_ID: "missing_product_id",
  UNKNOWN_SKU: "unknown_sku",
  INVALID_QUANTITY: "invalid_quantity",
  CANCELLED_EXCLUDED: "cancelled_excluded",
  UNRECOGNISED_STATUS: "unrecognised_status",
  ORDER_WITHOUT_LINES: "order_without_lines",
  INVENTORY_INCONSISTENCY: "inventory_quantity_inconsistency",
  BATCH_WITHOUT_PRODUCT: "batch_without_product",
  MISSING_REORDER_CONFIG: "missing_lead_time_configuration",
  INSUFFICIENT_HISTORY: "insufficient_weekly_history",
});

const WARNING_TEXT = Object.freeze({
  [WARNING.MISSING_ORDER_DATE]: "Order lines without a usable requested delivery date or creation date — excluded from the weekly history.",
  [WARNING.MISSING_PRODUCT_ID]: "Order lines with no vaccine/product identity — excluded from demand.",
  [WARNING.UNKNOWN_SKU]: "Products with no SKU in the vaccine catalog (or no catalog entry at all).",
  [WARNING.INVALID_QUANTITY]: "Order lines with a missing, zero, negative or non-whole quantity — rejected.",
  [WARNING.CANCELLED_EXCLUDED]: "Cancelled orders — excluded from demand.",
  [WARNING.UNRECOGNISED_STATUS]: "Orders with a missing or unrecognised status — excluded from demand.",
  [WARNING.ORDER_WITHOUT_LINES]: "Orders with no order lines — nothing to count.",
  [WARNING.INVENTORY_INCONSISTENCY]: "Batches whose stock counters are invalid, unconfirmed or exceed on-hand — counted as unavailable.",
  [WARNING.BATCH_WITHOUT_PRODUCT]: "Batches not linked to a catalog vaccine — not attributable to a product.",
  [WARNING.MISSING_REORDER_CONFIG]: "Vaccines with no enabled lead-time / safety-stock configuration — reorder configuration required.",
  [WARNING.INSUFFICIENT_HISTORY]: "Vaccines with fewer than 4 usable weeks of history — no forecast is made.",
});

const MAX_SAMPLE_REFS = 5;

/** Collects warnings as { code, count, sampleRefs }, in a stable order. */
function createWarningLog() {
  const byCode = new Map();
  return {
    add(code, ref) {
      const entry = byCode.get(code) ?? { code, count: 0, sampleRefs: [] };
      entry.count += 1;
      if (ref && entry.sampleRefs.length < MAX_SAMPLE_REFS && !entry.sampleRefs.includes(ref)) {
        entry.sampleRefs.push(ref);
      }
      byCode.set(code, entry);
    },
    count(code) {
      return byCode.get(code)?.count ?? 0;
    },
    list() {
      return [...byCode.values()]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((w) => ({ ...w, message: WARNING_TEXT[w.code] ?? w.code }));
    },
  };
}

// ---------------------------------------------------------------- dates

/** A Firestore Timestamp, Date or millis → Date, else null. */
function toDate(value) {
  if (value == null) return null;
  if (typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  return null;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts the ISO week containing `iso` (YYYY-MM-DD). */
function weekStartOf(iso) {
  const day = new Date(`${iso}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((day + 6) % 7));
}

/** Whole weeks from week-start `a` to week-start `b` (b ≥ a). */
function weeksBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (7 * 86400000));
}

/**
 * The canonical demand date of an order: requested delivery date, else the
 * Manila day it was created, else null. Never "today".
 */
function demandDateOf(order) {
  const requested = isoDateOnly(order?.requestedDeliveryDate);
  if (requested) return { date: requested, source: "requested_delivery_date" };
  const created = toDate(order?.createdAt);
  if (created) return { date: manilaDateString(created), source: "created_at" };
  return { date: null, source: null };
}

/** The training window for an analysis run "as of" `now`. */
function trainingWindowFor(now) {
  const asOfDate = manilaDateString(now);
  // The current week is incomplete, so the last usable bucket is last week.
  const lastWeekStart = addDays(weekStartOf(asOfDate), -7);
  const earliestWeekStart = addDays(lastWeekStart, -7 * (MAX_TRAINING_WEEKS - 1));
  return { asOfDate, lastWeekStart, earliestWeekStart, windowEnd: addDays(lastWeekStart, 6) };
}

// ---------------------------------------------------------------- orders → demand

/** "In Transit" / "in-transit" / "completed" → canonical key, or "" when absent. */
function normalizeOrderStatus(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return STATUS_ALIASES[key] ?? key;
}

function lineQuantity(raw) {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= MAX_LINE_QUANTITY ? raw : null;
}

/**
 * Every demand line, counted once, plus the data-quality findings.
 *
 * [orders]        [{ id, data }]
 * [batchesById]   Map inventoryId → batch data (to resolve older lines' product)
 * Returns { lines: [{ orderId, vaccineId, quantity, date, dateSource }],
 *           counts, warnings: WarningLog }
 */
function extractDemand({ orders, batchesById = new Map(), warnings = createWarningLog() }) {
  const lines = [];
  const counts = { ordersRead: 0, ordersCounted: 0, ordersExcluded: 0, candidateLines: 0, linesCounted: 0, linesExcluded: 0 };

  for (const { id, data } of orders) {
    counts.ordersRead += 1;
    const status = normalizeOrderStatus(data?.status);
    if (EXCLUDED_STATUSES.includes(status)) {
      warnings.add(WARNING.CANCELLED_EXCLUDED, id);
      counts.ordersExcluded += 1;
      continue;
    }
    if (!DEMAND_STATUSES.includes(status)) {
      warnings.add(WARNING.UNRECOGNISED_STATUS, id);
      counts.ordersExcluded += 1;
      continue;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      warnings.add(WARNING.ORDER_WITHOUT_LINES, id);
      counts.ordersExcluded += 1;
      continue;
    }
    counts.ordersCounted += 1;
    const { date, source } = demandDateOf(data);

    for (const line of items) {
      counts.candidateLines += 1;
      const quantity = lineQuantity(line?.quantity);
      if (quantity === null) {
        warnings.add(WARNING.INVALID_QUANTITY, id);
        counts.linesExcluded += 1;
        continue;
      }
      const productKey = typeof line?.productKey === "string" && line.productKey ? line.productKey : null;
      const quoted = typeof line?.inventoryId === "string" ? batchesById.get(line.inventoryId) : null;
      const vaccineId =
        productKey ?? (typeof quoted?.vaccineId === "string" && quoted.vaccineId ? quoted.vaccineId : null);
      if (!vaccineId) {
        warnings.add(WARNING.MISSING_PRODUCT_ID, id);
        counts.linesExcluded += 1;
        continue;
      }
      if (!date) {
        warnings.add(WARNING.MISSING_ORDER_DATE, id);
        counts.linesExcluded += 1;
        continue;
      }
      counts.linesCounted += 1;
      lines.push({ orderId: id, vaccineId, quantity, date, dateSource: source });
    }
  }
  return { lines, counts, warnings };
}

/**
 * Active backorders per product: requested − reserved on the lines of every
 * order the allocator is still serving. Nothing else is "backordered".
 */
function backorderedByProduct(orders) {
  const out = new Map();
  for (const { data } of orders) {
    if (!isAllocatableOrder(data)) continue;
    for (const line of Array.isArray(data.items) ? data.items : []) {
      const key = typeof line?.productKey === "string" && line.productKey ? line.productKey : null;
      if (!key) continue;
      const { backordered } = lineCounts(line);
      if (backordered > 0) out.set(key, (out.get(key) ?? 0) + backordered);
    }
  }
  return out;
}

// ---------------------------------------------------------------- batches → stock

function emptyStock() {
  return {
    batchCount: 0,
    onHandQuantity: 0,
    reservedQuantity: 0,
    returnPendingQuantity: 0,
    quarantinedQuantity: 0,
    availableQuantity: 0,
    unavailableBatchCount: 0,
    inconsistentBatchCount: 0,
    firstArrivalDate: null,
  };
}

/**
 * Current stock per product from its batches, as of `now`.
 * Returns Map vaccineId → stock (see emptyStock) and records warnings.
 */
function stockByProduct({ batches, now, warnings = createWarningLog() }) {
  const out = new Map();
  for (const { id, data } of batches) {
    const vaccineId = typeof data?.vaccineId === "string" && data.vaccineId ? data.vaccineId : null;
    if (!vaccineId) {
      warnings.add(WARNING.BATCH_WITHOUT_PRODUCT, id);
      continue;
    }
    const s = out.get(vaccineId) ?? emptyStock();
    s.batchCount += 1;

    const onHand = readCounter(data.quantity);
    const reserved = readCounter(data.reservedQuantity);
    const returning = readCounter(data.returnPendingQuantity);
    const quarantined = readCounter(data.quarantinedQuantity);
    const corrupt = !onHand.ok || !reserved.ok || !returning.ok || !quarantined.ok;
    const unconfirmed = onHand.ok && isUnconfirmedStockQuantity(onHand.value);
    const overHeld =
      !corrupt && reserved.value + returning.value + quarantined.value > onHand.value;
    if (corrupt || unconfirmed || overHeld) {
      warnings.add(WARNING.INVENTORY_INCONSISTENCY, id);
      s.inconsistentBatchCount += 1;
    }

    if (onHand.ok && !unconfirmed) s.onHandQuantity += onHand.value;
    if (reserved.ok) s.reservedQuantity += reserved.value;
    if (returning.ok) s.returnPendingQuantity += returning.value;
    if (quarantined.ok) s.quarantinedQuantity += quarantined.value;

    // The allocation engine's own availability rule (zero for any unusable batch).
    const available = allocatableUnits(data, now);
    s.availableQuantity += available;
    if (available === 0) s.unavailableBatchCount += 1;

    const arrival = isoDateOnly(data.arrivalDate) ?? (toDate(data.createdAt) ? manilaDateString(toDate(data.createdAt)) : null);
    if (arrival && (s.firstArrivalDate === null || arrival < s.firstArrivalDate)) s.firstArrivalDate = arrival;

    out.set(vaccineId, s);
  }
  return out;
}

// ---------------------------------------------------------------- weekly history

/**
 * A product's weekly requested-demand series inside the training window.
 *
 * The series starts at the product's first evidence of existing — its first
 * demand week or the arrival week of its first batch, whichever is earlier —
 * capped to MAX_TRAINING_WEEKS, and ends at the last COMPLETE week. Weeks with
 * no orders are real zeros inside that span. Lines dated outside the window
 * (older than the cap, or in the current or a future week) are not part of the
 * history; they are counted in `outsideWindowLines`.
 */
function weeklySeries({ lines, firstArrivalDate = null, window }) {
  const firstDemand = lines.reduce((min, l) => (min === null || l.date < min ? l.date : min), null);
  const evidence = [firstDemand, firstArrivalDate].filter(Boolean).sort()[0] ?? null;
  if (!evidence) return { series: [], outsideWindowLines: lines.length };

  let start = weekStartOf(evidence);
  if (start < window.earliestWeekStart) start = window.earliestWeekStart;
  if (start > window.lastWeekStart) return { series: [], outsideWindowLines: lines.length };

  const weeks = weeksBetween(start, window.lastWeekStart) + 1;
  const series = Array.from({ length: weeks }, (_, i) => ({ weekStart: addDays(start, 7 * i), quantity: 0 }));
  let outsideWindowLines = 0;
  for (const l of lines) {
    const w = weekStartOf(l.date);
    if (w < start || w > window.lastWeekStart) {
      outsideWindowLines += 1;
      continue;
    }
    series[weeksBetween(start, w)].quantity += l.quantity;
  }
  return { series, outsideWindowLines };
}

module.exports = {
  HORIZONS,
  PRIMARY_HORIZON,
  AREA_ALL,
  MAX_TRAINING_WEEKS,
  ANALYTICS_COLLECTIONS,
  DEMAND_STATUSES,
  EXCLUDED_STATUSES,
  CONFIRMED_INCOMING_TRACKED,
  WARNING,
  WARNING_TEXT,
  createWarningLog,
  toDate,
  addDays,
  weekStartOf,
  weeksBetween,
  demandDateOf,
  trainingWindowFor,
  normalizeOrderStatus,
  extractDemand,
  backorderedByProduct,
  stockByProduct,
  weeklySeries,
};
