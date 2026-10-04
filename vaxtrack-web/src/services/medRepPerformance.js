/**
 * Med Rep performance — pure aggregation, no Firebase import (runs under
 * `node --test`). Admin Analytics feeds it the orders and users it already
 * subscribes to; nothing here reads or writes Firestore.
 *
 * Primary metric: DELIVERED ORDERS HANDLED. An order counts only when
 *   - its status is `delivered` (or the legacy alias `completed`),
 *   - `createdByUid` names an existing Med Rep account (role `salesrep`), and
 *   - `deliveredAt` is a real timestamp inside the selected range.
 * The range is measured on `deliveredAt` — the server-stamped completion —
 * never on creation time. A delivery that failed, was retried and then
 * completed is one order document, so it counts once. Money (price, invoice,
 * VAT, discount) plays no part.
 *
 * Identity is the stored uid only. Names, emails, labels and clinic
 * assignments are never used to attribute an order.
 */

import { normalizeRole, normalizeStatus, ROLES, STATUSES } from "./authorization.js";
import { readTerritory } from "./territory.js";

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Manila, UTC+8, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERFORMANCE_RANGES = Object.freeze([
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
]);
export const DEFAULT_PERFORMANCE_RANGE = "30";

export const EMPTY_PERFORMANCE_MESSAGE = "No completed Med Rep deliveries were recorded for this period.";

// ---------------------------------------------------------------- time

/** Milliseconds from a Firestore Timestamp, Date, or epoch number; else null. */
export function timestampMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** The instant a Manila calendar day begins (00:00 Asia/Manila). */
export function manilaDayStartMs(ms) {
  return Math.floor((ms + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
}

/** 'YYYY-MM-DD' for the Manila calendar day containing `ms`. */
export function manilaDateString(ms) {
  return new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The selected range in Manila calendar days. "Last 7 days" is today plus the
 * six Manila days before it, from 00:00 Manila on the first day up to `nowMs`.
 * "All time" has no start.
 */
export function performanceRange(rangeKey, nowMs) {
  const range = PERFORMANCE_RANGES.find((r) => r.key === rangeKey) ?? PERFORMANCE_RANGES[1];
  const startMs = range.days == null ? null : manilaDayStartMs(nowMs) - (range.days - 1) * DAY_MS;
  return {
    key: range.key,
    label: range.label,
    startMs,
    endMs: nowMs,
    startDate: startMs == null ? null : manilaDateString(startMs),
    endDate: manilaDateString(nowMs),
  };
}

function inRange(ms, range) {
  return ms != null && ms <= range.endMs && (range.startMs == null || ms >= range.startMs);
}

// ---------------------------------------------------------------- orders

// Same precedence as deliveryService.getOrderStatusValue: the canonical
// `status` answers; an obsolete field is consulted only when it is absent.
const STATUS_FIELDS = ["status", "orderStatus", "deliveryStatus", "shipmentStatus", "dispatchStatus"];

function statusKeyOf(order) {
  for (const field of STATUS_FIELDS) {
    const v = order?.[field];
    if (typeof v === "string" && v.trim() !== "") {
      return v.trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
    }
  }
  return "";
}

/** Final status is delivered (canonical `delivered` or legacy `completed`). */
export function isDeliveredStatus(order) {
  const key = statusKeyOf(order);
  return key === "delivered" || key === "completed";
}

function vialCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Vials on one order: the sum of its line quantities, else its order-level
 * quantity. Anything that is not a finite positive number counts as 0, so a
 * malformed record can lower a total but never turn it into NaN.
 */
export function orderVials(order) {
  if (Array.isArray(order?.items) && order.items.length > 0) {
    return order.items.reduce((sum, item) => sum + vialCount(item?.quantity), 0);
  }
  return vialCount(order?.quantity);
}

// ---------------------------------------------------------------- aggregation

/** Med Rep accounts that may appear: role salesrep, approved or disabled. */
function medRepAccounts(users) {
  const out = new Map();
  for (const u of users || []) {
    if (!u || typeof u.id !== "string") continue;
    if (normalizeRole(u.role) !== ROLES.SALES_REP) continue;
    out.set(u.id, { user: u, status: normalizeStatus(u.status) });
  }
  return out;
}

function displayName(user) {
  const name = [user?.fullName, user?.name, user?.displayName].find((v) => typeof v === "string" && v.trim());
  return name ? name.trim() : "Unnamed Med Rep";
}

/**
 * Rank the Med Reps for one range.
 *
 * Rows: every ACTIVE Med Rep (even with zero), plus every INACTIVE Med Rep with
 * at least one counted delivery in the range. Pending and rejected accounts,
 * and every other role, never appear.
 *
 * Order: delivered orders ↓, then vials ↓, then name A→Z (display only).
 * Dense rank: equal delivered AND equal vials share a rank; the next distinct
 * result takes the next number.
 *
 * Exclusions are delivered orders that cannot be attributed safely; they are
 * counted for the Admin note but never ranked or added to the totals.
 */
export function computeMedRepPerformance({ orders, users, nowMs, rangeKey = DEFAULT_PERFORMANCE_RANGE }) {
  const range = performanceRange(rangeKey, nowMs);
  const accounts = medRepAccounts(users);
  const stats = new Map();
  const statFor = (uid) => {
    if (!stats.has(uid)) stats.set(uid, { delivered: 0, vials: 0, lastDeliveredMs: null, ordersPlaced: 0 });
    return stats.get(uid);
  };
  const exclusions = { missingMedRep: 0, missingCompletion: 0, ineligibleAccount: 0 };

  // One entry per order document — a repeated id is the same order.
  const unique = new Map();
  for (const o of orders || []) if (o && typeof o.id === "string") unique.set(o.id, o);

  for (const order of unique.values()) {
    const uid = typeof order.createdByUid === "string" ? order.createdByUid.trim() : "";
    const account = uid ? accounts.get(uid) : null;
    const rankable =
      account && (account.status === STATUSES.APPROVED || account.status === STATUSES.DISABLED);

    // Supporting metric: orders placed in the range (by creation time).
    if (rankable && inRange(timestampMs(order.createdAt), range)) statFor(uid).ordersPlaced += 1;

    if (!isDeliveredStatus(order)) continue;
    const deliveredMs = timestampMs(order.deliveredAt);
    if (deliveredMs == null) {
      // Cannot be placed in ANY range — reported, never ranked.
      exclusions.missingCompletion += 1;
      continue;
    }
    if (!inRange(deliveredMs, range)) continue;
    if (!account) {
      exclusions.missingMedRep += 1;
      continue;
    }
    if (!rankable) {
      exclusions.ineligibleAccount += 1;
      continue;
    }
    const s = statFor(uid);
    s.delivered += 1;
    s.vials += orderVials(order);
    if (s.lastDeliveredMs == null || deliveredMs > s.lastDeliveredMs) s.lastDeliveredMs = deliveredMs;
  }

  const rows = [];
  for (const [uid, { user, status }] of accounts) {
    const s = stats.get(uid) ?? { delivered: 0, vials: 0, lastDeliveredMs: null, ordersPlaced: 0 };
    const active = status === STATUSES.APPROVED;
    const inactiveWithHistory = status === STATUSES.DISABLED && s.delivered > 0;
    if (!active && !inactiveWithHistory) continue;
    rows.push({
      uid,
      name: displayName(user),
      accountStatus: active ? "active" : "inactive",
      territory: readTerritory(user),
      delivered: s.delivered,
      vials: s.vials,
      lastDeliveredMs: s.lastDeliveredMs,
      ordersPlaced: s.ordersPlaced,
      rank: 0,
    });
  }

  rows.sort((a, b) => b.delivered - a.delivered || b.vials - a.vials || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  let rank = 0;
  let previous = null;
  for (const row of rows) {
    if (!previous || previous.delivered !== row.delivered || previous.vials !== row.vials) rank += 1;
    row.rank = rank;
    previous = row;
  }

  const totals = rows.reduce((t, r) => ({ delivered: t.delivered + r.delivered, vials: t.vials + r.vials }), { delivered: 0, vials: 0 });
  // A leader exists only when someone actually delivered; ties are named together.
  const top = rows.filter((r) => r.rank === 1 && r.delivered > 0);
  const leader = top.length ? { names: top.map((r) => r.name), delivered: top[0].delivered, vials: top[0].vials } : null;

  return {
    range,
    rows,
    totals,
    leader,
    exclusions: { ...exclusions, total: exclusions.missingMedRep + exclusions.missingCompletion + exclusions.ineligibleAccount },
  };
}

/** The Admin note for unattributable completed orders, or "" when there are none. */
export function exclusionNote(exclusions) {
  const n = exclusions?.total ?? 0;
  if (n === 0) return "";
  return `${n} completed ${n === 1 ? "order was" : "orders were"} excluded because ${n === 1 ? "its" : "their"} Med Rep or completion record could not be verified.`;
}
