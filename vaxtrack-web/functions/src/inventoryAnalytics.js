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
 *   Product: resolved deterministically (resolveLineProduct) — the line's
 *   productKey, vaccineId or productId when it exists in the vaccine catalog,
 *   else the referenced batch's catalog vaccineId, else an EXACT SKU match to
 *   exactly one vaccine. Never names, partial SKUs or guesses; an unresolved
 *   or ambiguous line is excluded with a warning, and the source used for
 *   every line is recorded in the run's identity diagnostics.
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
  AMBIGUOUS_SKU: "ambiguous_product_sku",
  ALLOCATION_MAY_BE_PENDING: "allocation_may_be_pending",
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
  [WARNING.MISSING_PRODUCT_ID]: "Order lines whose vaccine/product cannot be resolved deterministically — excluded from demand.",
  [WARNING.AMBIGUOUS_SKU]: "Order lines whose SKU matches more than one catalog vaccine — excluded from demand (never first-match).",
  [WARNING.ALLOCATION_MAY_BE_PENDING]: "Vaccines whose available stock could cover every backordered vial — allocation may be pending; not a shortage.",
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

// ---------------------------------------------------------------- product identity

/** Where a line's product identity came from (recorded in run diagnostics). */
const IDENTITY_SOURCE = Object.freeze({
  LINE_PRODUCT_KEY: "line_product_key",
  LINE_VACCINE_ID: "line_vaccine_id",
  LINE_PRODUCT_ID: "line_product_id",
  INVENTORY_BATCH: "inventory_batch",
  EXACT_SKU: "exact_sku",
});
const IDENTITY_UNRESOLVED = "unresolved";
const IDENTITY_AMBIGUOUS_SKU = "ambiguous_sku";
const IDENTITY_RESULTS = Object.freeze([...Object.values(IDENTITY_SOURCE), IDENTITY_UNRESOLVED, IDENTITY_AMBIGUOUS_SKU]);

/** Identifier fields a line may carry. Diagnostics report their NAMES only. */
const LINE_IDENTIFIER_FIELDS = Object.freeze(["productKey", "vaccineId", "productId", "inventoryId", "sku", "batchId"]);
const MAX_UNRESOLVED_DIAGNOSTICS = 50;

/** The vaccine catalog as the resolver needs it: ids, and SKU → vaccine ids. */
function createProductCatalog({ vaccines = [], batchesById = new Map() } = {}) {
  const vaccineIds = new Set();
  const skuIndex = new Map();
  for (const { id, data } of vaccines) {
    vaccineIds.add(id);
    const sku = data?.internalSku;
    if (typeof sku === "string" && sku !== "") skuIndex.set(sku, [...(skuIndex.get(sku) ?? []), id]);
  }
  return { vaccineIds, skuIndex, batchesById };
}

const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);

/**
 * The product an order line is demand for — from deterministic sources only,
 * in this order:
 *
 *   1. line.productKey that exists in the vaccine catalog
 *   2. line.vaccineId, then line.productId, that exists in the catalog
 *   3. the referenced inventory batch's vaccineId, when that exists in the catalog
 *   4. line.sku EXACTLY equal (case-sensitive, untrimmed) to the internalSku of
 *      exactly ONE catalog vaccine
 *
 * Never a product name, a partial or fuzzy SKU, clinic or doctor data, a guess,
 * or the first of several matches: several vaccines sharing the SKU is
 * "ambiguous_sku", and the line stays excluded.
 * Returns { vaccineId, source } — vaccineId null when unresolved/ambiguous.
 */
function resolveLineProduct(line, catalog) {
  const known = (v) => (v !== null && catalog.vaccineIds.has(v) ? v : null);
  const productKey = known(nonEmpty(line?.productKey));
  if (productKey) return { vaccineId: productKey, source: IDENTITY_SOURCE.LINE_PRODUCT_KEY };
  const vaccineId = known(nonEmpty(line?.vaccineId));
  if (vaccineId) return { vaccineId, source: IDENTITY_SOURCE.LINE_VACCINE_ID };
  const productId = known(nonEmpty(line?.productId));
  if (productId) return { vaccineId: productId, source: IDENTITY_SOURCE.LINE_PRODUCT_ID };
  const inventoryId = nonEmpty(line?.inventoryId);
  const batchVaccine = known(nonEmpty(inventoryId ? catalog.batchesById.get(inventoryId)?.vaccineId : null));
  if (batchVaccine) return { vaccineId: batchVaccine, source: IDENTITY_SOURCE.INVENTORY_BATCH };
  const sku = nonEmpty(line?.sku);
  if (sku) {
    const matches = catalog.skuIndex.get(sku) ?? [];
    if (matches.length === 1) return { vaccineId: matches[0], source: IDENTITY_SOURCE.EXACT_SKU };
    if (matches.length > 1) return { vaccineId: null, source: IDENTITY_AMBIGUOUS_SKU };
  }
  return { vaccineId: null, source: IDENTITY_UNRESOLVED };
}

/** A SKU as a product code, or "[redacted]" when it does not look like one. */
function safeSku(value) {
  if (typeof value !== "string" || value === "") return null;
  return /^[A-Za-z0-9._-]{1,40}$/.test(value) ? value : "[redacted]";
}

/**
 * A structural description of an unresolved line: document id, line index,
 * which identifier FIELDS exist, the SKU code and the inventory document id.
 * Never names, clinics, doctors, addresses, emails, phones or user ids.
 */
function lineDiagnostic(orderId, lineIndex, line, result) {
  return {
    orderId,
    lineIndex,
    identifierFields: LINE_IDENTIFIER_FIELDS.filter((f) => line?.[f] !== undefined && line?.[f] !== null && line?.[f] !== ""),
    sku: safeSku(line?.sku),
    inventoryId: nonEmpty(line?.inventoryId),
    result,
  };
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
 * [batchesById]   Map inventoryId → batch data
 * [vaccines]      [{ id, data }] the vaccine catalog (identity + SKU)
 * Returns { lines: [{ orderId, lineIndex, vaccineId, quantity, date, dateSource,
 *           identitySource }], counts, identity, warnings: WarningLog }
 */
function extractDemand({
  orders,
  batchesById = new Map(),
  vaccines = [],
  catalog = createProductCatalog({ vaccines, batchesById }),
  warnings = createWarningLog(),
}) {
  const lines = [];
  const counts = { ordersRead: 0, ordersCounted: 0, ordersExcluded: 0, candidateLines: 0, linesCounted: 0, linesExcluded: 0 };
  const identity = {
    bySource: Object.fromEntries(IDENTITY_RESULTS.map((r) => [r, 0])),
    unresolvedLines: [],
    unresolvedLineCount: 0,
  };

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

    for (const [lineIndex, line] of items.entries()) {
      counts.candidateLines += 1;
      const quantity = lineQuantity(line?.quantity);
      if (quantity === null) {
        warnings.add(WARNING.INVALID_QUANTITY, id);
        counts.linesExcluded += 1;
        continue;
      }
      const { vaccineId, source: identitySource } = resolveLineProduct(line, catalog);
      identity.bySource[identitySource] += 1;
      if (!vaccineId) {
        warnings.add(identitySource === IDENTITY_AMBIGUOUS_SKU ? WARNING.AMBIGUOUS_SKU : WARNING.MISSING_PRODUCT_ID, id);
        identity.unresolvedLineCount += 1;
        if (identity.unresolvedLines.length < MAX_UNRESOLVED_DIAGNOSTICS) {
          identity.unresolvedLines.push(lineDiagnostic(id, lineIndex, line, identitySource));
        }
        counts.linesExcluded += 1;
        continue;
      }
      if (!date) {
        warnings.add(WARNING.MISSING_ORDER_DATE, id);
        counts.linesExcluded += 1;
        continue;
      }
      counts.linesCounted += 1;
      lines.push({ orderId: id, lineIndex, vaccineId, quantity, date, dateSource: source, identitySource });
    }
  }
  return { lines, counts, identity, warnings };
}

/**
 * Active backorders per product: requested − reserved on the lines of every
 * order the allocator is still serving. Nothing else is "backordered".
 */
function backorderedByProduct(orders, catalog) {
  const out = new Map();
  for (const { data } of orders) {
    if (!isAllocatableOrder(data)) continue;
    for (const line of Array.isArray(data.items) ? data.items : []) {
      // The same deterministic resolver as demand; an unresolved line is not attributed.
      const key = catalog ? resolveLineProduct(line, catalog).vaccineId : nonEmpty(line?.productKey);
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
  IDENTITY_SOURCE,
  IDENTITY_UNRESOLVED,
  IDENTITY_AMBIGUOUS_SKU,
  LINE_IDENTIFIER_FIELDS,
  createProductCatalog,
  resolveLineProduct,
  lineDiagnostic,
  extractDemand,
  backorderedByProduct,
  stockByProduct,
  weeklySeries,
};
