/**
 * Order Receipt History + Stock Allocation History — display helpers.
 *
 * Pure module (no Firebase), shared by the Med Rep and Admin history pages and
 * executed directly by the unit tests. Every figure comes from server-written
 * documents: the receipt (orderReceipts/{orderId}), the ledger
 * (inventoryAllocationEvents) and the order itself. Nothing here invents a
 * value — where a record does not exist the helpers say so in words.
 *
 * Two rules matter most:
 *   - A batch is shown against an order line ONLY when an allocation event
 *     proves it was reserved. The line's quoted batch (the price source) is
 *     never presented as a reservation; a line with nothing reserved reads
 *     "Awaiting batch allocation".
 *   - An order with no receipt is a legacy order. Its current data may be
 *     shown, separately, but it is never labelled as the original receipt.
 */

import { statusLabel, normalizeStatus } from "./orderWorkflow.js";
import { describeAllocation, ALLOCATION_STATE_LABELS } from "./backorder.js";
import { VAT_RATE_PERCENT, VAT_INCLUSIVE_NOTE } from "./pricingConfig.js";

export const LEGACY_RECEIPT_MESSAGE = "Legacy order — original receipt snapshot unavailable";
export const LEGACY_RECEIPT_DETAIL =
  "This order was placed before Order Confirmation Receipts were recorded. The details below are the order's current information, not the receipt it was confirmed with.";
export const RECONSTRUCTED_RECEIPT_MESSAGE =
  "Reconstructed receipt — rebuilt later from the order record, not captured at confirmation";
export const AWAITING_BATCH_LABEL = "Awaiting batch allocation";
export const RECEIPT_TITLE = "Order Confirmation Receipt";
export const RECEIPT_DISCLAIMER =
  "Confirms what the server accepted when the order was placed. It is not an official invoice and not proof of payment.";
export const NO_HISTORY_MESSAGE =
  "No allocation history is recorded for this order. History is kept for orders placed after it was introduced; earlier events were not recorded and are not reconstructed.";

export const HISTORY_PAGE_SIZE = 25;

/** The receipt's provenance: "original", "reconstructed" or "legacy" (none). */
export function receiptStatus(receipt) {
  if (!receipt) return "legacy";
  if (receipt.isReconstructed === true || receipt.receiptKind === "reconstructed") return "reconstructed";
  return "original";
}

// ---------------------------------------------------------------- stage

/**
 * One label for where an order stands now, combining the delivery status with
 * the allocation state while it still awaits dispatch. Keys are filter values.
 */
export const STAGE_OPTIONS = Object.freeze([
  { value: "processing", label: "Processing" },
  { value: "awaiting_stock", label: "Awaiting stock" },
  { value: "partially_reserved", label: "Partially reserved" },
  { value: "fully_reserved", label: "Fully reserved" },
  { value: "assigned", label: "Assigned" },
  { value: "loading", label: "Loading" },
  { value: "in_transit", label: "In transit" },
  { value: "delayed", label: "Delayed" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
]);
const STAGE_LABEL = Object.fromEntries(STAGE_OPTIONS.map((o) => [o.value, o.label]));

// Legacy spellings accepted on read (never written) — the same two aliases
// deliveryService.normalizeStatusKey resolves.
const READ_ALIASES = Object.freeze({ completed: "delivered", canceled: "cancelled" });

export function fulfilmentStage(order) {
  const raw = typeof order?.status === "string" ? order.status.trim().toLowerCase() : "";
  const status = normalizeStatus(READ_ALIASES[raw] ?? raw);
  const value = (() => {
    if (status === null || status === "pending_dispatch") {
      if (order?.allocationVersion === 2 && ALLOCATION_STATE_LABELS[order.allocationState]) return order.allocationState;
      return "processing";
    }
    if (status === "delivery_failed") return "failed";
    return STAGE_LABEL[status] ? status : "processing";
  })();
  return { value, label: STAGE_LABEL[value] ?? statusLabel(status) };
}

export const ALLOCATION_FILTER_OPTIONS = Object.freeze([
  { value: "awaiting_stock", label: "Awaiting stock" },
  { value: "partially_reserved", label: "Partially reserved" },
  { value: "fully_reserved", label: "Fully reserved" },
  { value: "untracked", label: "Not tracked (legacy)" },
]);

export function allocationFilterValue(order) {
  const info = describeAllocation(order);
  return info.tracked ? info.state : "untracked";
}

// ---------------------------------------------------------------- time

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds ?? 0) / 1e6);
  return null;
}

export function formatDateTime(value) {
  const ms = toMillis(value);
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
}

/** A yyyy-mm-dd input value as the instant that day starts in Manila (UTC+8). */
export function manilaDayStart(isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const ms = Date.parse(`${isoDate}T00:00:00+08:00`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The first instant AFTER the given Manila day — an exclusive upper bound. */
export function manilaDayEnd(isoDate) {
  const start = manilaDayStart(isoDate);
  return start ? new Date(start.getTime() + 86400000) : null;
}

// ---------------------------------------------------------------- rows + filters

/** One list row: the order now, plus its receipt when one exists. */
export function historyRow(order, receipt = null) {
  const stage = fulfilmentStage(order);
  const allocation = describeAllocation(order);
  return {
    id: order.id,
    order,
    receipt,
    receiptStatus: receiptStatus(receipt),
    // The full reference; never truncated.
    reference: order.orderNumber || receipt?.orderNumber || order.id,
    createdAtMs: toMillis(order.createdAt) ?? toMillis(receipt?.orderCreatedAt),
    doctor: order.doctorName || receipt?.doctorName || "",
    clinic: order.clinicName || order.destinationName || receipt?.clinicName || "",
    medRep: receipt?.medRepName || receipt?.medRepEmail || "",
    medRepUid: order.createdByUid || receipt?.medRepUid || null,
    priority: String(order.priority || receipt?.priority || "").toLowerCase() === "urgent" ? "Urgent" : "Standard",
    stage,
    allocationState: allocationFilterValue(order),
    allocationLabel: allocation.tracked ? allocation.label : "Not tracked",
    requested: allocation.tracked ? allocation.requested : (Array.isArray(order.items) ? order.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) : 0),
    reserved: allocation.reserved,
    backordered: allocation.backordered,
    skus: Array.isArray(receipt?.skus) ? receipt.skus : (Array.isArray(order.items) ? order.items.map((i) => i.sku).filter(Boolean) : []),
  };
}

/**
 * Append a newly loaded page to the rows already shown. Pages are read with a
 * document cursor (createdAt ↓, then document id), so a page never repeats or
 * skips an order even when new orders are placed while browsing — those sort
 * BEFORE the first page. Rows are still de-duplicated by id as a guard.
 */
export function mergeHistoryPage(prev, next) {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...next.filter((r) => !seen.has(r.id) && seen.add(r.id))];
}

/** The exact notice whenever filters act on loaded records only. */
export const LOADED_FILTER_NOTICE = "Search/filtering currently covers loaded records";

/**
 * The notice line, or null when no client-side filter is active. Exact
 * full-reference lookup is not a client-side filter: it queries the whole
 * authorized history.
 */
export function loadedFilterNotice({ filtersActive, hasMore, loadedCount }) {
  if (!filtersActive) return null;
  return hasMore
    ? `${LOADED_FILTER_NOTICE} (${loadedCount} loaded). Load older orders to search further.`
    : `${LOADED_FILTER_NOTICE} — all ${loadedCount} orders in this period are loaded.`;
}

const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Client-side filters over the rows already loaded. Search matches the full
 * reference, doctor, clinic, Med Rep and SKU (substring, case-insensitive).
 */
export function matchesHistoryFilters(row, filters = {}) {
  const q = norm(filters.search);
  if (q) {
    const hay = [row.reference, row.id, row.doctor, row.clinic, row.medRep, ...(row.skus || [])].map(norm);
    if (!hay.some((h) => h.includes(q))) return false;
  }
  if (filters.stage && row.stage.value !== filters.stage) return false;
  if (filters.allocationState && row.allocationState !== filters.allocationState) return false;
  if (filters.priority && row.priority !== filters.priority) return false;
  const from = manilaDayStart(filters.dateFrom);
  const to = manilaDayEnd(filters.dateTo);
  if (from && (row.createdAtMs == null || row.createdAtMs < from.getTime())) return false;
  if (to && (row.createdAtMs == null || row.createdAtMs >= to.getTime())) return false;
  return true;
}

// ---------------------------------------------------------------- ledger

export const EVENT_LABELS = Object.freeze({
  order_placed: "Order placed",
  initial_allocation: "Reservation at confirmation",
  stock_allocated: "Stock reserved",
  partially_reserved: "Partially reserved",
  fully_reserved: "Fully reserved",
  reservation_released: "Reservation released (cancelled)",
  backorder_cancelled: "Backorder cancelled",
  reservation_consumed: "Consumed at delivery",
  moved_to_return_pending: "Moved to Return Pending",
  return_restored: "Return restored to stock",
  return_quarantined: "Return quarantined",
  return_written_off: "Return written off",
  order_requeued: "Requeued after failed delivery",
});

const EVENT_TONES = Object.freeze({
  order_placed: "neutral",
  initial_allocation: "neutral",
  stock_allocated: "success",
  partially_reserved: "info",
  fully_reserved: "success",
  reservation_released: "warning",
  backorder_cancelled: "warning",
  reservation_consumed: "success",
  moved_to_return_pending: "danger",
  return_restored: "info",
  return_quarantined: "danger",
  return_written_off: "danger",
  order_requeued: "warning",
});

export const SOURCE_LABELS = Object.freeze({
  createOrderWithReservation: "Order placement",
  addStockBatchWithAllocation: "Stock added",
  cancelOrderWithInventoryRelease: "Cancellation",
  markOrderDeliveredWithInventoryConsumption: "Delivery completion",
  reportDeliveryFailure: "Failed-delivery report",
  settleClientReportedFailure: "Failed-delivery report",
  requeueFailedOrder: "Requeue",
  confirmReturnDisposition: "Return confirmation",
  allocateOnInventoryWrite: "Stock change",
  allocateOnOrderWrite: "Order queued",
  continueAllocation: "Allocation (continued)",
  remediateStagingArvReturns: "Return migration (staging remediation)",
  materializeOrderHistory: "History recovery",
  "createOrderWithReservation:replay": "Order placement (retried)",
});

export function eventLabel(eventType) {
  return EVENT_LABELS[eventType] ?? "Allocation event";
}
export function eventTone(eventType) {
  return EVENT_TONES[eventType] ?? "neutral";
}
export function sourceLabel(sourceOperation) {
  return SOURCE_LABELS[sourceOperation] ?? "System";
}

/** Chronological: commit time, then the order written within one commit. */
export function sortEvents(events) {
  return [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const d = (toMillis(a.createdAt) ?? 0) - (toMillis(b.createdAt) ?? 0);
    if (d !== 0) return d;
    return (a.ordinal ?? 0) - (b.ordinal ?? 0);
  });
}

/**
 * Shown while an original receipt's initial-allocation record is being
 * written. The server guarantees it (an outbox marker created with the order,
 * completed by the placing call or a retrying trigger), so it is never
 * presented as "not recorded".
 */
export const INITIAL_ALLOCATION_PENDING = "Recording the reservation at confirmation…";

/** The reservation captured at confirmation, per line, or null when not yet recorded. */
export function confirmationSnapshot(events) {
  const hit = (Array.isArray(events) ? events : []).find((e) => e.eventType === "initial_allocation");
  if (!hit) return null;
  return {
    recovered: hit.recovered === true,
    reserved: hit.reservedQuantityAfter ?? 0,
    backordered: hit.backorderedQuantityAfter ?? 0,
    lines: (hit.lines || []).map((l) => ({
      lineIndex: l.lineIndex,
      reserved: l.reservedQuantityAfter ?? 0,
      backordered: l.backorderedQuantityAfter ?? 0,
    })),
  };
}

const HOLD_ADD = new Set(["stock_allocated"]);
const HOLD_REMOVE = new Set(["reservation_released", "moved_to_return_pending"]);

/**
 * Each line now: requested / reserved / backordered from the order, and the
 * batches holding it as PROVEN by allocation events of the current epoch.
 *
 *   reserved 0                → no batches; "Awaiting batch allocation"
 *   reserved, events present  → the batches the events name
 *   reserved, no events       → legacy: "Batch not recorded" (never the quote)
 *   consumed at delivery      → the batches, marked delivered
 */
export function currentLineFulfilment(order, events) {
  const allocation = describeAllocation(order);
  const epoch = Number.isInteger(order?.failureCount) && order.failureCount > 0 ? order.failureCount : 0;
  const ledger = sortEvents(events).filter((e) => (e.epoch ?? 0) === epoch);
  const held = new Map(); // lineIndex -> Map(inventoryId -> { batchId, quantity })
  const consumedLines = new Set();
  for (const e of ledger) {
    const direction = HOLD_ADD.has(e.eventType) ? 1 : HOLD_REMOVE.has(e.eventType) ? -1 : 0;
    if (e.eventType === "reservation_consumed") {
      for (const l of e.lines || []) if (l.consumedQuantity > 0) consumedLines.add(l.lineIndex);
    }
    if (direction === 0) continue;
    for (const line of e.lines || []) {
      if (!Number.isInteger(line.lineIndex)) continue;
      if (!held.has(line.lineIndex)) held.set(line.lineIndex, new Map());
      const byBatch = held.get(line.lineIndex);
      for (const b of line.batches || []) {
        const key = b.inventoryId || b.batchId;
        const prev = byBatch.get(key) ?? { batchId: b.batchId || null, inventoryId: b.inventoryId || null, quantity: 0 };
        prev.quantity += direction * (Number(b.quantity) || 0);
        byBatch.set(key, prev);
      }
    }
  }
  const items = Array.isArray(order?.items) ? order.items : [];
  return allocation.lines.length
    ? allocation.lines.map((line) => {
        const proven = [...(held.get(line.index)?.values() ?? [])].filter((b) => b.quantity > 0);
        let batchNote = null;
        if (line.reserved === 0) batchNote = AWAITING_BATCH_LABEL;
        else if (proven.length === 0) batchNote = "Batch not recorded (placed before allocation history)";
        return {
          lineIndex: line.index,
          name: line.name,
          sku: items[line.index]?.sku || null,
          requested: line.requested,
          reserved: line.reserved,
          backordered: line.backordered,
          batches: line.reserved === 0 ? [] : proven,
          batchNote,
          delivered: consumedLines.has(line.index),
        };
      })
    : items.map((item, index) => ({
        lineIndex: index,
        name: item.vaccineName || item.name || "Item",
        sku: item.sku || null,
        requested: Number(item.quantity) || 0,
        reserved: null,
        backordered: null,
        batches: [],
        batchNote: "Allocation not tracked for this legacy order",
        delivered: false,
      }));
}

/** Batch labels an event proves, for the timeline. Empty for events that hold none. */
export function eventBatches(event) {
  return (Array.isArray(event?.batches) ? event.batches : [])
    .filter((b) => (Number(b.quantity) || 0) > 0)
    .map((b) => ({ label: b.batchId || b.inventoryId || "Unknown batch", quantity: Number(b.quantity) || 0 }));
}

/** Lines of a receipt with the confirmation reservation beside each, when recorded. */
export function receiptLines(receipt, snapshot) {
  return (Array.isArray(receipt?.lines) ? receipt.lines : []).map((l) => {
    const at = snapshot?.lines?.find((x) => x.lineIndex === l.lineIndex) ?? null;
    return {
      ...l,
      reservedAtConfirmation: at ? at.reserved : null,
      backorderedAtConfirmation: at ? at.backordered : null,
    };
  });
}

export const VAT_STATUS_LABELS = Object.freeze({
  vatable: `VAT ${VAT_RATE_PERCENT}%`,
  vat_exempt: "VAT-exempt",
  // Mixed orders are allowed on this branch: VAT applies to the VATable items only.
  mixed: "VATable and VAT-exempt items",
  not_classified: "VAT determined at invoicing",
  not_recorded: "Not recorded",
});

/**
 * How a receipt's money is described, from the convention recorded ON that
 * receipt — never re-interpreted. Receipts recorded with VAT-inclusive prices
 * (every receipt under the confirmed rule) say the VAT is included; a receipt
 * recorded under the earlier VAT-exclusive convention is shown exactly as
 * recorded and labelled so. Amounts are the stored ones; nothing is recomputed.
 */
export function receiptPriceLabels(receipt) {
  const inclusive = receipt?.priceIsVatInclusive === true;
  return {
    inclusive,
    subtotalLabel: inclusive ? "Subtotal (VAT-inclusive for VATable products)" : "Subtotal (recorded as VAT-exclusive)",
    vatSuffix: inclusive ? " (included in the subtotal)" : "",
    note: inclusive ? VAT_INCLUSIVE_NOTE : "Recorded before prices were confirmed as VAT-inclusive; shown exactly as recorded.",
  };
}
