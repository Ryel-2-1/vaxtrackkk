// Pure cleanup PLAN for VaxTrack staging, built from a read-only audit report.
//
// No Firebase import and no I/O. It turns the audit's classification into an
// exact, ordered list of operations, and checks that list against a fresh read
// of the live data. It never decides on its own to touch a record the audit did
// not name, and it refuses (returns problems) rather than guessing.

import { allocationFindings, statusTypeOf } from "./stagingAuditAnalysis.mjs";

/**
 * Decisions taken after reviewing the audit. Every override is explicit and
 * carries its reason, so the plan never silently differs from the report.
 */
export const DEFAULT_DECISIONS = Object.freeze({
  // The script marked these DELETE, but each has a related record that makes a
  // plain delete unsafe. They move to KEEP or REVIEW with the reason.
  overrides: {
    WgoXY0Wwy15nVS1QXpa2: {
      verdict: "KEEP",
      reason:
        "cancelled order carrying the only ISSUED invoice (INV-2026-000001). Deleting it orphans " +
        "an issued invoice and leaves a gap in the invoice numbering. Cancelled orders only " +
        "affect 'Total deliveries', so keeping it is harmless.",
    },
  },
  // REVIEW MANUALLY orders the plan proposes to clear, pending approval.
  // All lack the now-mandatory requestedDeliveryDate, so dispatch eligibility
  // refuses them; a date cannot be invented for a customer who never gave one.
  reviewToCancelAndDelete: [
    "3RUCxvr6K1TZNjAJ5D9z",
    "6Ds9MwwXST9zcNPTXDPZ",
    "EdaTJQeOvrfIBwhS8GkV",
    "Nf0jzHCeKVdL0K2wuJsi",
    "mYqc6GgfMRtvmJ2FofuT",
    "ql0AtVXhDnwZo5jMVs4R",
    "tKPpI44Yf22SFd7MJlCR",
  ],
  // Already cancelled AND released: no stock is held, a plain delete is safe.
  reviewToDelete: ["EX8KH3TmxxVNZupip1AY", "vPu5O4QYnlVWceZTlmbJ"],
});

export const CANCEL_REASON = "Staging data cleanup: abandoned QA test order (approved manifest)";

/** Build the ordered plan from an audit report. */
export function buildCleanupPlan(report, decisions = DEFAULT_DECISIONS) {
  const verdictOf = (o) => decisions.overrides[o.id]?.verdict ?? o.classification.verdict;
  const reviewCancel = new Set(decisions.reviewToCancelAndDelete);
  const reviewDelete = new Set(decisions.reviewToDelete);

  const cancelFirst = [];
  const deleteOnly = [];
  const keep = [];
  const unresolved = [];

  for (const o of report.orders) {
    const v = verdictOf(o);
    const holds = o.allocation.holdsInventory;
    const entry = {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      allocationState: o.allocation.state,
      legacy: o.allocation.legacy,
      items: o.allocation.items,
      alertIds: o.alertIds,
      invoiceId: o.invoice?.id ?? null,
      tripId: o.tripId,
      reason: decisions.overrides[o.id]?.reason ?? o.classification.reason,
    };
    if (v === "KEEP") keep.push(entry);
    else if (v === "REPAIR" || (v === "REVIEW MANUALLY" && reviewCancel.has(o.id))) {
      if (!holds) unresolved.push({ ...entry, problem: "marked cancel-first but holds no reservation" });
      else cancelFirst.push(entry);
    } else if (v === "DELETE" || (v === "REVIEW MANUALLY" && reviewDelete.has(o.id))) {
      if (holds) unresolved.push({ ...entry, problem: "would delete an order that still holds stock" });
      else if (entry.invoiceId) unresolved.push({ ...entry, problem: "would orphan an invoice" });
      else deleteOnly.push(entry);
    } else {
      unresolved.push({ ...entry, problem: `no decision for verdict ${v}` });
    }
  }

  const removed = [...cancelFirst, ...deleteOnly];
  return {
    cancelFirst,
    deleteOnly,
    keep,
    unresolved,
    deletePaths: {
      orders: removed.map((e) => `orders/${e.id}`), // recursive: removes subcollections too
      inventoryReservations: removed.filter((e) => !e.legacy).map((e) => `inventoryReservations/${e.id}`),
      alerts: removed.flatMap((e) => e.alertIds.map((id) => `alerts/${id}`)),
      invoices: [],
      // One per server-created order, keyed `${uid}__${requestId}`. The id is NOT
      // derivable from the order and the collection is deny-all to clients, so
      // these cannot be named without a privileged read.
      orderRequestKeysToLocate: removed.filter((e) => !e.legacy).map((e) => e.id),
    },
  };
}

/** Stock released per batch by the cancel-first phase. */
export function releaseByBatch(plan) {
  const out = {};
  for (const e of plan.cancelFirst) {
    for (const i of e.items) {
      if (!i.inventoryId) continue;
      out[i.inventoryId] = (out[i.inventoryId] || 0) + i.quantity;
    }
  }
  return out;
}

/**
 * Re-check the plan against a FRESH read. Any drift since the audit — a status
 * change, a different allocation, a batch whose reserved figure no longer
 * covers the release, a new related record — is a problem, and the dry run
 * reports it instead of proceeding.
 */
export function verifyPlanAgainstLive(plan, live) {
  const problems = [];
  const orders = new Map(live.orders.map((o) => [o.id, o]));
  const batches = new Map(live.inventory.map((b) => [b.id, b]));

  for (const e of [...plan.cancelFirst, ...plan.deleteOnly, ...plan.keep]) {
    const o = orders.get(e.id);
    if (!o) {
      problems.push(`${e.id}: no longer exists`);
      continue;
    }
    const nowStatus = statusTypeOf(o);
    const nowAlloc = allocationFindings(o).state;
    if (nowStatus !== e.status) problems.push(`${e.id}: status changed ${e.status} → ${nowStatus}`);
    if (nowAlloc !== e.allocationState) problems.push(`${e.id}: allocation changed ${e.allocationState} → ${nowAlloc}`);
  }
  for (const e of plan.cancelFirst) {
    if (!["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivery_failed"].includes(e.status)) {
      problems.push(`${e.id}: status ${e.status} is not cancellable by the trusted callable`);
    }
  }

  // Batches: after the release, nothing may go negative and every remaining
  // reservation must still be covered by the orders that are kept.
  const release = releaseByBatch(plan);
  for (const [id, qty] of Object.entries(release)) {
    const b = batches.get(id);
    if (!b) {
      problems.push(`batch ${id}: missing — release of ${qty} would fail`);
      continue;
    }
    const reserved = b.reservedQuantity;
    if (!Number.isInteger(reserved) || reserved < qty) {
      problems.push(`batch ${id}: reserved ${reserved} does not cover release of ${qty}`);
    }
  }
  const keptReserved = {};
  for (const o of live.orders) {
    if (!plan.keep.some((k) => k.id === o.id)) continue;
    const a = allocationFindings(o);
    if (!a.holdsInventory) continue;
    for (const i of a.items) keptReserved[i.inventoryId] = (keptReserved[i.inventoryId] || 0) + i.quantity;
  }
  for (const b of live.inventory) {
    const after = (b.reservedQuantity ?? 0) - (release[b.id] || 0);
    if (after < 0) problems.push(`batch ${b.id}: reserved would go negative (${after})`);
    else if (after !== (keptReserved[b.id] || 0)) {
      problems.push(`batch ${b.id}: after release ${after} ≠ reserved by kept orders ${keptReserved[b.id] || 0}`);
    }
  }

  // Related records that appeared since the audit.
  const removing = new Set([...plan.cancelFirst, ...plan.deleteOnly].map((e) => e.id));
  const plannedAlerts = new Set(plan.deletePaths.alerts.map((p) => p.split("/")[1]));
  for (const a of live.alerts) {
    if (a.orderId && removing.has(a.orderId) && !plannedAlerts.has(a.id)) {
      problems.push(`alert ${a.id} references ${a.orderId} but is not in the plan`);
    }
  }
  for (const inv of live.invoices) {
    if (inv.orderId && removing.has(inv.orderId)) {
      problems.push(`invoice ${inv.id} references ${inv.orderId} — would be orphaned`);
    }
  }
  for (const [orderId, subs] of Object.entries(live.subcollections || {})) {
    if (removing.has(orderId) && subs.length > 0) {
      // Not a blocker by itself (recursive delete removes them) but they must
      // be in the backup first.
      if (!live.backedUpSubcollections) problems.push(`orders/${orderId} has ${subs.length} subcollection doc(s) not yet backed up`);
    }
  }
  if (plan.unresolved.length > 0) problems.push(`${plan.unresolved.length} record(s) have no safe decision`);
  return problems;
}
