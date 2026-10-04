// Pure analysis for the READ-ONLY staging data audit (auditStagingData.mjs).
//
// No Firebase import and no I/O: every function takes plain objects already
// read from Firestore and returns findings, so the classification can be unit
// tested without a project. Nothing here can write anything.
//
// The dashboard figures are recomputed with the SAME rules the Admin pages use
// (Deliveries.jsx, Analytics.jsx, Invoices.jsx + invoiceService.js), so the
// audit explains the numbers on screen rather than a different definition of
// them. Each mirror names the source it follows.

import { ORDER_STATUSES } from "../src/services/orderWorkflow.js";

export const REQUIRED_PROJECT_ID = "vaxtrack-staging";
export const ALLOCATION_VERSION = 1; // functions/src/policy.js

// Philippines bounding box (generous). A coordinate inside the world but outside
// this box is not a plausible VaxTrack delivery point.
export const PH_BOUNDS = Object.freeze({ minLat: 4.2, maxLat: 21.5, minLng: 116.0, maxLng: 127.0 });

/** Transit legs longer than this are treated as abandoned testing, not real trips. */
export const ABANDONED_TRANSIT_HOURS = 24;
/** Orders created within this window with identical contents are duplicate candidates. */
export const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ primitives

/** Milliseconds from any timestamp shape used in the project, or null. */
export function tsMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function isoOrNull(value) {
  const ms = tsMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

// deliveryService.js: STATUS_FIELDS + getOrderStatusValue + normalizeStatusKey
// + LEGACY_STATUS_ALIASES + resolveStatusKey.
const STATUS_FIELDS = ["status", "orderStatus", "deliveryStatus", "shipmentStatus", "dispatchStatus"];
const LEGACY_ALIASES = { completed: "delivered", canceled: "cancelled" };

export function rawStatusOf(order) {
  for (const field of STATUS_FIELDS) {
    const v = order?.[field];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

export function normalizeStatusKey(value) {
  return String(value || "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
}

/** Canonical status, or "unknown" — exactly what the Admin pages display. */
export function statusTypeOf(order) {
  const key = normalizeStatusKey(rawStatusOf(order));
  const resolved = LEGACY_ALIASES[key] ?? key;
  return ORDER_STATUSES.includes(resolved) ? resolved : "unknown";
}

function finite(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// ------------------------------------------------------------ dashboard mirrors

/** Admin → Deliveries KPI cards (Deliveries.jsx). Every order, no date range. */
export function deliveriesMetrics(orders) {
  const count = (k) => orders.filter((o) => statusTypeOf(o) === k).length;
  return {
    totalDeliveries: orders.length,
    inTransit: count("in_transit"),
    delayed: count("delayed"),
    deliveryFailed: count("delivery_failed"),
    preparing: count("pending_dispatch") + count("assigned") + count("loading"),
    delivered: count("delivered"),
    cancelled: count("cancelled"),
    unknown: count("unknown"),
  };
}

/**
 * Admin → Analytics "Average latest transit segment" (Analytics.jsx):
 * orders created within `days` of `nowMs`, status delivered/completed,
 * startedAt → deliveredAt, only when end > start.
 */
export function averageLatestTransit(orders, { nowMs, days = 30 } = {}) {
  const cutoff = days == null ? -Infinity : nowMs - days * MS_PER_DAY;
  const legs = [];
  for (const o of orders) {
    const created = tsMs(o.createdAt) ?? 0; // Analytics treats a missing createdAt as 0
    if (created < cutoff) continue;
    if (statusTypeOf(o) !== "delivered") continue;
    const start = tsMs(o.startedAt);
    const end = tsMs(o.deliveredAt);
    if (start == null || end == null || end <= start) continue;
    legs.push({ id: o.id, minutes: (end - start) / 60000 });
  }
  const avg = legs.length ? legs.reduce((s, l) => s + l.minutes, 0) / legs.length : null;
  return { averageMinutes: avg, formatted: formatMinutes(avg), legs };
}

export function formatMinutes(minutes) {
  if (minutes == null) return "—";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

// invoiceService.js: queueInvoiceStatus + orderPriority; Invoices.jsx summary.
export function queueInvoiceStatus(invoice) {
  if (!invoice) return "Pending";
  switch (invoice.invoiceStatus) {
    case "issued":
      return "Issued";
    case "cancelled":
      return "Cancelled";
    case "draft": {
      const hasItems = Array.isArray(invoice.items) && invoice.items.length > 0;
      return hasItems && Number(invoice.grandTotal) > 0 ? "Ready to Print" : "In Progress";
    }
    default:
      return "Pending";
  }
}

export function queuePriority(order, invoice) {
  const raw =
    order.invoicePriority ||
    invoice?.invoicePriority ||
    (String(order.priority || "").toLowerCase() === "urgent" ? "Urgent" : "Normal");
  return ["Normal", "High", "Urgent"].includes(raw) ? raw : "Normal";
}

/** Map invoice docs by their `orderId` field, as subscribeInvoiceQueue does. */
export function invoicesByOrderId(invoices) {
  const map = {};
  for (const inv of invoices) if (inv.orderId) map[inv.orderId] = inv;
  return map;
}

/** Admin → Invoices KPI cards. Every order whose status is not cancelled/canceled. */
export function invoiceMetrics(orders, invoices) {
  const byOrder = invoicesByOrderId(invoices);
  const rows = orders
    .filter((o) => !["cancelled", "canceled"].includes(normalizeStatusKey(rawStatusOf(o))))
    .map((o) => {
      const inv = byOrder[o.id] || null;
      return {
        orderId: o.id,
        statusType: statusTypeOf(o),
        invoiceStatus: queueInvoiceStatus(inv),
        priority: queuePriority(o, inv),
      };
    });
  const pending = rows.filter((r) => ["Pending", "In Progress", "Ready to Print"].includes(r.invoiceStatus));
  const pendingByOrderStatus = {};
  for (const r of pending) pendingByOrderStatus[r.statusType] = (pendingByOrderStatus[r.statusType] || 0) + 1;
  return {
    eligibleRows: rows.length,
    pendingInvoices: pending.length,
    highPriority: pending.filter((r) => r.priority === "High" || r.priority === "Urgent").length,
    totalIssued: rows.filter((r) => r.invoiceStatus === "Issued").length,
    pendingByOrderStatus,
    pendingOrderIds: pending.map((r) => r.orderId),
  };
}

// ------------------------------------------------------------ per-order checks

export function coordinateIssues(order) {
  const issues = [];
  const { clinicLat: lat, clinicLng: lng } = order;
  if (lat == null && lng == null) {
    issues.push("missing-coordinates");
    return issues;
  }
  if (lat == null || lng == null) {
    issues.push("missing-one-coordinate");
    return issues;
  }
  if (!finite(lat) || !finite(lng)) {
    issues.push("nonnumeric-coordinates");
    return issues;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) issues.push("out-of-range-coordinates");
  else if (lat === 0 && lng === 0) issues.push("null-island-coordinates");
  else if (lat < PH_BOUNDS.minLat || lat > PH_BOUNDS.maxLat || lng < PH_BOUNDS.minLng || lng > PH_BOUNDS.maxLng) {
    issues.push("coordinates-outside-philippines");
  }
  if (
    finite(order.destinationLat) &&
    finite(order.destinationLng) &&
    (order.destinationLat !== lat || order.destinationLng !== lng)
  ) {
    issues.push("destination-alias-mismatch");
  }
  return issues;
}

/** Lifecycle fields that must exist for the order's current status. */
export function statusConsistencyIssues(order) {
  const s = statusTypeOf(order);
  const issues = [];
  const has = (f) => order[f] != null && order[f] !== "";
  if (s === "unknown") issues.push("unrecognised-status");
  if (["assigned", "loading", "in_transit", "delayed", "delivery_failed", "delivered"].includes(s) && !has("assignedRiderId")) {
    issues.push("active-without-rider");
  }
  if (["in_transit", "delayed", "delivery_failed", "delivered"].includes(s) && !has("startedAt")) {
    issues.push("no-transit-start");
  }
  if (s === "delivered" && !has("deliveredAt")) issues.push("delivered-without-deliveredAt");
  if (s === "delayed" && !has("delayReason")) issues.push("delayed-without-reason");
  if (s === "delivery_failed" && !has("deliveryFailureReason")) issues.push("failed-without-reason");
  if (s === "cancelled" && !has("cancelledAt")) issues.push("cancelled-without-cancelledAt");
  if (!has("createdAt")) issues.push("no-createdAt");
  return issues;
}

/** Chronology: each stamp that exists must not precede the one before it. */
export function chronologyIssues(order) {
  const issues = [];
  const created = tsMs(order.createdAt);
  const assigned = tsMs(order.assignedAt);
  const started = tsMs(order.startedAt);
  const delivered = tsMs(order.deliveredAt);
  const cancelled = tsMs(order.cancelledAt);
  if (created != null && assigned != null && assigned < created) issues.push("assigned-before-created");
  if (assigned != null && started != null && started < assigned) issues.push("transit-before-assigned");
  if (created != null && started != null && started < created) issues.push("transit-before-created");
  if (started != null && delivered != null && delivered <= started) {
    // A resumed delivery re-stamps startedAt, so delivered < startedAt is
    // impossible for any real path.
    issues.push("completed-before-transit-start");
  }
  if (created != null && delivered != null && delivered < created) issues.push("delivered-before-created");
  if (created != null && cancelled != null && cancelled < created) issues.push("cancelled-before-created");
  return issues;
}

/** Transit duration findings. `nowMs` lets an open leg be measured. */
export function transitFindings(order, nowMs) {
  const s = statusTypeOf(order);
  const started = tsMs(order.startedAt);
  const delivered = tsMs(order.deliveredAt);
  const out = { transitMinutes: null, openTransitHours: null, issues: [] };
  if (started != null && delivered != null && delivered > started) {
    out.transitMinutes = (delivered - started) / 60000;
    if (out.transitMinutes > ABANDONED_TRANSIT_HOURS * 60) out.issues.push("extreme-completed-transit");
  }
  if (["in_transit", "delayed"].includes(s) && started != null) {
    out.openTransitHours = (nowMs - started) / 3600000;
    if (out.openTransitHours > ABANDONED_TRANSIT_HOURS) out.issues.push("abandoned-open-transit");
  }
  return out;
}

/**
 * Expected inventory state for the order, from its own fields. The reservation
 * documents are server-only (deny-all to clients), so this audit reasons from
 * the order's `allocationStatus` and cross-checks the batch `reservedQuantity`.
 */
export function allocationFindings(order) {
  const s = statusTypeOf(order);
  const legacy = order.allocationVersion !== ALLOCATION_VERSION;
  const status = order.allocationStatus ?? null;
  const issues = [];
  let state;
  if (legacy) {
    state = "legacy-unallocated";
  } else {
    state = status || "missing";
    const expected =
      s === "delivered" ? "consumed" : s === "cancelled" ? "released" : s === "unknown" ? null : "reserved";
    if (status == null) issues.push("allocation-status-missing");
    else if (expected && status !== expected) issues.push(`allocation-${status}-but-order-${s}`);
  }
  return {
    legacy,
    state,
    holdsInventory: !legacy && status === "reserved",
    items: (Array.isArray(order.items) ? order.items : []).map((i) => ({
      inventoryId: i.inventoryId ?? null,
      batchId: i.batchId ?? null,
      quantity: Number(i.quantity) || 0,
    })),
    issues,
  };
}

/** References to other documents, checked against the loaded sets. */
export function referenceIssues(order, refs) {
  const issues = [];
  const s = statusTypeOf(order);
  if (order.clinicDocId && !refs.clinics.has(order.clinicDocId)) issues.push("clinic-missing");
  if (order.doctorId) {
    if (!refs.doctors.has(order.doctorId)) issues.push("doctor-missing");
    else if (order.doctorAddressId && !refs.addresses.has(`${order.doctorId}/${order.doctorAddressId}`)) {
      issues.push("doctor-address-missing");
    }
  }
  if (!order.clinicDocId && !order.doctorId) issues.push("no-destination-reference");
  const rider = order.assignedRiderId ? refs.users.get(order.assignedRiderId) : null;
  if (order.assignedRiderId && !rider) issues.push("rider-missing");
  else if (rider && rider.role !== "rider") issues.push("assigned-user-not-rider");
  else if (rider && rider.status !== "approved" && !["delivered", "cancelled"].includes(s)) {
    issues.push("active-order-rider-not-approved");
  }
  const rep = order.createdByUid ? refs.users.get(order.createdByUid) : null;
  if (!order.createdByUid) issues.push("no-creator");
  else if (!rep) issues.push("creator-missing");
  else if (!["salesrep", "admin"].includes(rep.role)) issues.push("creator-not-salesrep");
  return issues;
}

export function requestedDateIssues(order) {
  const v = order.requestedDeliveryDate;
  if (v == null || v === "") return ["no-requested-date"];
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return ["requested-date-not-manila-ymd"];
  return [];
}

/** Text that marks a record as a test artifact rather than demo data. */
const TEST_TEXT = /\b(test|testing|qa|dummy|sample|asdf|qwerty|lorem|xxx|placeholder|random|tmp|temp)\b/i;

export function testMarkers(order) {
  const fields = ["clinicName", "destinationName", "doctorName", "deliveryAddress", "clinicAddress", "deliveryInstructions", "vaccineName"];
  return fields.filter((f) => typeof order[f] === "string" && TEST_TEXT.test(order[f]));
}

function itemsSignature(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items
    .map((i) => `${i.inventoryId ?? i.batchId ?? i.name ?? "?"}x${Number(i.quantity) || 0}`)
    .sort()
    .join("|") || `${order.vaccineName ?? "?"}x${Number(order.quantity) || 0}`;
}

/** Groups of orders with identical creator, destination and items created close together. */
export function duplicateGroups(orders) {
  const byKey = new Map();
  for (const o of orders) {
    const key = [o.createdByUid ?? "", o.doctorAddressId ?? o.clinicDocId ?? o.clinicName ?? "", itemsSignature(o), o.requestedDeliveryDate ?? ""].join("§");
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(o);
  }
  const groups = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (tsMs(a.createdAt) ?? 0) - (tsMs(b.createdAt) ?? 0));
    let cluster = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const gap = (tsMs(sorted[i].createdAt) ?? 0) - (tsMs(sorted[i - 1].createdAt) ?? 0);
      if (gap <= DUPLICATE_WINDOW_MS) cluster.push(sorted[i]);
      else {
        if (cluster.length > 1) groups.push(cluster.map((o) => o.id));
        cluster = [sorted[i]];
      }
    }
    if (cluster.length > 1) groups.push(cluster.map((o) => o.id));
  }
  return groups;
}

/** Proof references: presence and host kind only — never the URL (it carries a token). */
export function proofKind(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("firebasestorage.googleapis.com") || host.endsWith("firebasestorage.app")) return "storage-object";
    return "external-url";
  } catch {
    return "unparseable";
  }
}

// ------------------------------------------------------------ inventory

/**
 * Batch-level reconciliation: the reserved figure each batch SHOULD carry is
 * the sum of quantities on non-legacy orders whose allocation is still
 * `reserved`. Any difference means deleting or cancelling orders could strand
 * or underflow stock.
 */
export function inventoryReconciliation(inventory, orders) {
  const expected = new Map();
  for (const o of orders) {
    const a = allocationFindings(o);
    if (!a.holdsInventory) continue;
    for (const item of a.items) {
      if (!item.inventoryId) continue;
      expected.set(item.inventoryId, (expected.get(item.inventoryId) || 0) + item.quantity);
    }
  }
  const rows = inventory.map((b) => {
    const qty = b.quantity;
    const reserved = b.reservedQuantity ?? 0;
    const exp = expected.get(b.id) || 0;
    const issues = [];
    if (typeof qty !== "number" || !Number.isInteger(qty)) issues.push("quantity-not-integer");
    if (typeof reserved !== "number" || !Number.isInteger(reserved)) issues.push("reserved-not-integer");
    if (typeof qty === "number" && qty < 0) issues.push("negative-quantity");
    if (typeof reserved === "number" && reserved < 0) issues.push("negative-reserved");
    if (typeof qty === "number" && typeof reserved === "number" && reserved > qty) issues.push("reserved-exceeds-on-hand");
    if (typeof reserved === "number" && reserved !== exp) issues.push("reserved-mismatch");
    return {
      id: b.id,
      batchId: b.batchId ?? null,
      vaccineName: b.vaccineName ?? null,
      quantity: qty ?? null,
      reservedQuantity: b.reservedQuantity ?? null,
      expectedReserved: exp,
      issues,
    };
  });
  const known = new Set(inventory.map((b) => b.id));
  const missingBatches = [...expected.keys()].filter((id) => !known.has(id));
  return { rows, missingBatches };
}

// ------------------------------------------------------------ classification

const HARD_DELETE_SIGNALS = new Set([
  "missing-coordinates",
  "missing-one-coordinate",
  "nonnumeric-coordinates",
  "out-of-range-coordinates",
  "null-island-coordinates",
  "coordinates-outside-philippines",
  "completed-before-transit-start",
  "delivered-before-created",
  "transit-before-created",
  "extreme-completed-transit",
  "abandoned-open-transit",
  "clinic-missing",
  "doctor-missing",
  "doctor-address-missing",
  "no-destination-reference",
  "rider-missing",
  "assigned-user-not-rider",
  "creator-missing",
  "no-creator",
  "duplicate",
  "unrecognised-status",
]);

/**
 * KEEP / DELETE / REPAIR / REVIEW MANUALLY.
 *
 *  - An order that still HOLDS inventory is never DELETE: deleting it would
 *    strand the reserved quantity. It becomes REPAIR (cancel through the
 *    trusted callable first, which releases stock) when it is otherwise a
 *    deletion candidate, else REVIEW MANUALLY if its allocation is inconsistent.
 *  - Age alone never makes a record a candidate.
 */
export function classify(finding) {
  const deleteSignals = finding.issues.filter((i) => HARD_DELETE_SIGNALS.has(i));
  const allocationBroken = finding.allocation.issues.length > 0;
  const holds = finding.allocation.holdsInventory;
  if (deleteSignals.length > 0) {
    if (holds) return { verdict: "REPAIR", reason: "holds reserved stock; cancel via cancelOrderWithInventoryRelease, then delete", deleteSignals };
    if (allocationBroken) return { verdict: "REVIEW MANUALLY", reason: "deletion candidate with inconsistent allocation state", deleteSignals };
    return { verdict: "DELETE", reason: deleteSignals.join(", "), deleteSignals };
  }
  if (allocationBroken) return { verdict: "REVIEW MANUALLY", reason: finding.allocation.issues.join(", "), deleteSignals };
  const repairable = finding.issues.filter((i) =>
    ["delivered-without-deliveredAt", "delayed-without-reason", "failed-without-reason", "cancelled-without-cancelledAt", "no-transit-start", "active-without-rider", "destination-alias-mismatch", "no-requested-date", "requested-date-not-manila-ymd", "active-order-rider-not-approved", "creator-not-salesrep"].includes(i)
  );
  if (repairable.length > 0) return { verdict: "REVIEW MANUALLY", reason: repairable.join(", "), deleteSignals };
  return { verdict: "KEEP", reason: "", deleteSignals };
}

/** Full per-order findings. `refs` = { clinics:Set, doctors:Set, addresses:Set, users:Map }. */
export function analyzeOrders(orders, { refs, invoices, alerts, nowMs }) {
  const dupGroups = duplicateGroups(orders);
  const dupIds = new Map();
  dupGroups.forEach((g) => g.slice(1).forEach((id) => dupIds.set(id, g[0]))); // keep the earliest of each cluster
  const invByOrder = invoicesByOrderId(invoices);
  const alertsByOrder = new Map();
  for (const a of alerts) {
    if (!a.orderId) continue;
    if (!alertsByOrder.has(a.orderId)) alertsByOrder.set(a.orderId, []);
    alertsByOrder.get(a.orderId).push(a.id);
  }

  return orders.map((o) => {
    const transit = transitFindings(o, nowMs);
    const allocation = allocationFindings(o);
    const issues = [
      ...coordinateIssues(o),
      ...statusConsistencyIssues(o),
      ...chronologyIssues(o),
      ...transit.issues,
      ...referenceIssues(o, refs),
      ...requestedDateIssues(o),
      ...(dupIds.has(o.id) ? ["duplicate"] : []),
    ];
    const inv = invByOrder[o.id] || null;
    const rider = o.assignedRiderId ? refs.users.get(o.assignedRiderId) : null;
    const rep = o.createdByUid ? refs.users.get(o.createdByUid) : null;
    const finding = {
      id: o.id,
      orderNumber: o.orderNumber ?? null,
      status: statusTypeOf(o),
      rawStatus: rawStatusOf(o),
      priority: o.priority ?? null,
      invoicePriority: o.invoicePriority ?? null,
      createdAt: isoOrNull(o.createdAt),
      requestedDeliveryDate: o.requestedDeliveryDate ?? null,
      assignedAt: isoOrNull(o.assignedAt),
      startedAt: isoOrNull(o.startedAt),
      deliveredAt: isoOrNull(o.deliveredAt),
      cancelledAt: isoOrNull(o.cancelledAt),
      transitMinutes: transit.transitMinutes,
      openTransitHours: transit.openTransitHours,
      clinicDocId: o.clinicDocId ?? null,
      clinicName: o.clinicName ?? null,
      doctorId: o.doctorId ?? null,
      doctorAddressId: o.doctorAddressId ?? null,
      destinationType: o.destinationType ?? null,
      medRep: o.createdByUid ? { uid: o.createdByUid, name: rep?.name ?? null, role: rep?.role ?? null } : null,
      rider: o.assignedRiderId ? { uid: o.assignedRiderId, name: rider?.name ?? o.assignedRiderName ?? null, status: rider?.status ?? null } : null,
      clinicLat: o.clinicLat ?? null,
      clinicLng: o.clinicLng ?? null,
      tripId: o.tripId ?? null,
      invoice: inv ? { id: inv.id, status: inv.invoiceStatus ?? null, queueStatus: queueInvoiceStatus(inv) } : null,
      queueInvoiceStatus: queueInvoiceStatus(inv),
      allocation,
      alertIds: alertsByOrder.get(o.id) || [],
      proof: {
        proofOfDelivery: proofKind(o.proofOfDeliveryUrl),
        invoicePhoto: proofKind(o.invoiceUrl),
      },
      hasRoute: Boolean(o.routePolyline),
      hasDestinationChangeRequest: Boolean(o.destinationChangeRequest),
      testMarkers: testMarkers(o),
      duplicateOf: dupIds.get(o.id) ?? null,
      issues,
    };
    finding.classification = classify(finding);
    return finding;
  });
}

/** Invoices and alerts that point at orders which do not exist. */
export function orphanedRelated({ orders, invoices, alerts }) {
  const ids = new Set(orders.map((o) => o.id));
  return {
    invoices: invoices.filter((i) => i.orderId && !ids.has(i.orderId)).map((i) => ({ id: i.id, orderId: i.orderId, status: i.invoiceStatus ?? null })),
    invoicesWithoutOrderId: invoices.filter((i) => !i.orderId).map((i) => i.id),
    alerts: alerts.filter((a) => a.orderId && !ids.has(a.orderId)).map((a) => ({ id: a.id, orderId: a.orderId, type: a.type ?? null })),
  };
}

/** Guard used by the I/O script before anything connects. */
export function assertStagingTarget({ argv, configuredProjectId }) {
  const i = argv.indexOf("--project");
  const flag = i >= 0 ? argv[i + 1] : null;
  if (flag !== REQUIRED_PROJECT_ID) {
    return { ok: false, message: `Pass --project ${REQUIRED_PROJECT_ID} explicitly (got ${flag ?? "nothing"}).` };
  }
  if (configuredProjectId !== REQUIRED_PROJECT_ID) {
    return { ok: false, message: `.env.staging points at "${configuredProjectId}", not ${REQUIRED_PROJECT_ID}.` };
  }
  return { ok: true };
}
