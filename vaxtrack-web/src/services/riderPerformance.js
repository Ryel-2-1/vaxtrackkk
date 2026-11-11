/**
 * Rider performance (2026-11-11) — the rider counterpart of
 * medRepPerformance.js, with the same ranges, counting rules and ranking.
 * Pure aggregation, no Firebase import; Admin Analytics feeds it the orders
 * and users it already has.
 *
 * Primary metric: DELIVERED ORDERS. An order counts for a rider only when
 *   - its status is `delivered` (or the legacy alias `completed`),
 *   - `assignedRiderId` names an existing Rider account, and
 *   - `deliveredAt` is a real timestamp inside the selected range.
 * The rider stays on a delivered order (it is cleared only when a failed
 * order is put back in the queue), so the rider who completed it is the one
 * credited. Identity is the stored uid only, never a name.
 *
 * Supporting figures use the page's existing definitions (deliveryMetrics.js)
 * so the table agrees with the rest of Analytics: on time = delivered on or
 * before the requested Manila date; delivery time = dispatch → completion.
 */

import { normalizeRole, normalizeStatus, ROLES, STATUSES } from "./authorization.js";
import { averageDeliveryTime, onTimeStats } from "./deliveryMetrics.js";
import {
  DEFAULT_PERFORMANCE_RANGE,
  isDeliveredStatus,
  orderVials,
  performanceRange,
  timestampMs,
} from "./medRepPerformance.js";

export const EMPTY_RIDER_PERFORMANCE_MESSAGE = "No completed rider deliveries were recorded for this period.";

function riderAccounts(users) {
  const out = new Map();
  for (const u of users || []) {
    if (!u || typeof u.id !== "string") continue;
    if (normalizeRole(u.role) !== ROLES.RIDER) continue;
    out.set(u.id, { user: u, status: normalizeStatus(u.status) });
  }
  return out;
}

function displayName(user) {
  const name = [user?.fullName, user?.name, user?.displayName].find((v) => typeof v === "string" && v.trim());
  return name ? name.trim() : "Unnamed rider";
}

/**
 * Rank the riders for one range.
 *
 * Rows: every ACTIVE rider (even with zero), plus every INACTIVE rider with at
 * least one counted delivery. Pending and rejected applications never appear.
 * Order: delivered ↓, vials ↓, name A→Z; dense rank on (delivered, vials).
 * Delivered orders that cannot be credited to a rider are counted for a note.
 */
export function computeRiderPerformance({ orders, users, nowMs, rangeKey = DEFAULT_PERFORMANCE_RANGE }) {
  const range = performanceRange(rangeKey, nowMs);
  const accounts = riderAccounts(users);
  const delivered = new Map(); // uid → the rider's delivered orders in range
  const exclusions = { missingRider: 0, missingCompletion: 0, ineligibleAccount: 0 };

  const unique = new Map();
  for (const o of orders || []) if (o && typeof o.id === "string") unique.set(o.id, o);

  for (const order of unique.values()) {
    if (!isDeliveredStatus(order)) continue;
    const deliveredMs = timestampMs(order.deliveredAt);
    if (deliveredMs == null) {
      exclusions.missingCompletion += 1;
      continue;
    }
    if (deliveredMs > range.endMs || (range.startMs != null && deliveredMs < range.startMs)) continue;
    const uid = typeof order.assignedRiderId === "string" ? order.assignedRiderId.trim() : "";
    const account = uid ? accounts.get(uid) : null;
    if (!account) {
      exclusions.missingRider += 1;
      continue;
    }
    if (account.status !== STATUSES.APPROVED && account.status !== STATUSES.DISABLED) {
      exclusions.ineligibleAccount += 1;
      continue;
    }
    if (!delivered.has(uid)) delivered.set(uid, []);
    // deliveryMetrics reads the normalized `statusKey`; this order is delivered.
    delivered.get(uid).push({ ...order, statusKey: "delivered" });
  }

  const rows = [];
  for (const [uid, { user, status }] of accounts) {
    const list = delivered.get(uid) ?? [];
    const active = status === STATUSES.APPROVED;
    if (!active && !(status === STATUSES.DISABLED && list.length > 0)) continue;
    const onTime = onTimeStats(list);
    const lastDeliveredMs = list.reduce((max, o) => Math.max(max, timestampMs(o.deliveredAt) ?? 0), 0) || null;
    rows.push({
      uid,
      name: displayName(user),
      accountStatus: active ? "active" : "inactive",
      delivered: list.length,
      vials: list.reduce((sum, o) => sum + orderVials(o), 0),
      onTime: onTime.onTime,
      onTimeMeasured: onTime.measured,
      onTimeRate: onTime.rate,
      averageMinutes: averageDeliveryTime(list).averageMinutes,
      lastDeliveredMs,
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

  const all = [...delivered.values()].flat();
  const allOnTime = onTimeStats(all);
  const totals = {
    delivered: rows.reduce((t, r) => t + r.delivered, 0),
    vials: rows.reduce((t, r) => t + r.vials, 0),
    onTimeRate: allOnTime.rate,
    onTimeMeasured: allOnTime.measured,
  };
  const top = rows.filter((r) => r.rank === 1 && r.delivered > 0);
  const leader = top.length ? { names: top.map((r) => r.name), delivered: top[0].delivered, vials: top[0].vials } : null;

  return {
    range,
    rows,
    totals,
    leader,
    exclusions: { ...exclusions, total: exclusions.missingRider + exclusions.missingCompletion + exclusions.ineligibleAccount },
  };
}

/** The Admin note for delivered orders that could not be credited, or "". */
export function riderExclusionNote(exclusions) {
  const n = exclusions?.total ?? 0;
  if (n === 0) return "";
  return `${n} completed ${n === 1 ? "order was" : "orders were"} left out because ${n === 1 ? "its" : "their"} rider or completion record could not be verified.`;
}
