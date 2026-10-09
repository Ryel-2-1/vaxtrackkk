/**
 * Allocation migration — DIAGNOSTIC + BACKFILL PROPOSAL (pure, read-only).
 *
 * Inputs are plain JSON exports of four collections; nothing here performs I/O,
 * holds credentials or writes anywhere. The output is a report and a PROPOSED
 * list of writes for a human to review. Applying any of it is a separate,
 * explicitly authorized step — never done by this module or its runner.
 *
 * What it looks for:
 *   1. Batch counters vs. the reservations that should explain them
 *      (reservedQuantity == Σ active slices; returnPendingQuantity == Σ pending
 *      return items). Mismatches are REPORTED, never "corrected" by guessing.
 *   2. Version-1 (pre-backorder) reservations: fully reserved by construction.
 *      Proposed: add the `inventoryIds` index field so provenance is indexed.
 *      Nothing else about them changes; they keep allocationVersion 1.
 *   3. Version-1 orders parked in `delivery_failed` whose reservation is still
 *      `reserved` — under the old design a failure kept its stock reserved,
 *      which is why a batch can show units "reserved" for an order that will
 *      not be delivered. Proposed: the same move the new server performs on a
 *      failure — reserved → return-pending, reservation → returned, and a
 *      pending inventoryReturns record for an Admin to disposition.
 *   4. Active orders with no allocation data at all (pre-reservation): they
 *      hold no stock and are not gated by allocation. Reported for review.
 *   5. Reservations still `reserved` for an order that is delivered or
 *      cancelled (a leak). Reported for review — no automatic fix.
 *   6. Version-2 orders waiting for stock with no allocationPriorityKey — the
 *      paged queue cannot see them. Reported.
 *   7. Batches that cannot be allocated per product (no `vaccineId`) or whose
 *      figures are not usable integers / are implausibly large. Reported.
 *
 * Input: { inventory: [{id, data}], orders: [{id, data}],
 *          reservations: [{id, data}], returns: [{id, data}] }
 */

const ACTIVE_ORDER_STATUSES = ["pending_dispatch", "assigned", "loading", "in_transit", "delayed"];
const TERMINAL_ORDER_STATUSES = ["delivered", "completed", "cancelled", "canceled"];
/** The Add Stock ceiling; above it a batch is unconfirmed and never allocated. */
const { MAX_STOCK_QUANTITY: IMPLAUSIBLE_QUANTITY } = require("./policy");

const isCount = (v) => Number.isInteger(v) && v >= 0;
const countOr0 = (v) => (v === undefined || v === null ? 0 : v);

function sliceTotals(items) {
  const byBatch = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.inventoryId !== "string" || !isCount(item.quantity)) continue;
    byBatch.set(item.inventoryId, (byBatch.get(item.inventoryId) || 0) + item.quantity);
  }
  return byBatch;
}

function buildAllocationDiagnostic({ inventory = [], orders = [], reservations = [], returns = [] } = {}) {
  const orderById = new Map(orders.map((o) => [o.id, o.data || {}]));
  const batchById = new Map(inventory.map((b) => [b.id, b.data || {}]));

  const explainedReserved = new Map();
  const explainedReturning = new Map();
  const findings = [];
  const proposals = [];

  // ---- reservations
  for (const { id, data: r = {} } of reservations) {
    const order = orderById.get(id) || null;
    const status = order?.status ?? null;
    if (r.status !== "reserved") continue;
    const totals = sliceTotals(r.items);
    for (const [inv, q] of totals) explainedReserved.set(inv, (explainedReserved.get(inv) || 0) + q);

    if (!order) {
      findings.push({ kind: "reservation-without-order", reservationId: id, units: [...totals.values()].reduce((a, b) => a + b, 0) });
      continue;
    }
    if (TERMINAL_ORDER_STATUSES.includes(status)) {
      findings.push({ kind: "reservation-leak-on-terminal-order", orderId: id, orderNumber: order.orderNumber ?? null, orderStatus: status, slices: [...totals].map(([inventoryId, quantity]) => ({ inventoryId, quantity })) });
      continue;
    }
    const version = r.allocationVersion ?? order.allocationVersion;
    if (version === 1) {
      if (!Array.isArray(r.inventoryIds)) {
        proposals.push({
          kind: "index-v1-reservation",
          safe: true,
          orderId: id,
          write: { collection: "inventoryReservations", doc: id, merge: { inventoryIds: [...totals.keys()].sort() } },
          why: "Lets provenance find this reservation by batch without a scan. Changes no quantity.",
        });
      }
      if (status === "delivery_failed") {
        const items = [...totals].map(([inventoryId, quantity]) => ({
          inventoryId,
          batchId: batchById.get(inventoryId)?.batchId ?? null,
          productKey: batchById.get(inventoryId)?.vaccineId ?? null,
          quantity,
        }));
        const total = items.reduce((s, x) => s + x.quantity, 0);
        findings.push({ kind: "v1-failed-order-still-reserved", orderId: id, orderNumber: order.orderNumber ?? null, units: total, items });
        proposals.push({
          kind: "convert-v1-failure-to-return-pending",
          safe: false,
          requiresAdminReview: true,
          orderId: id,
          orderNumber: order.orderNumber ?? null,
          units: total,
          writes: [
            ...items.map((x) => ({
              collection: "inventory",
              doc: x.inventoryId,
              increment: { reservedQuantity: -x.quantity, returnPendingQuantity: x.quantity },
            })),
            { collection: "inventoryReservations", doc: id, merge: { status: "returned", returnId: `${id}_1` } },
            {
              collection: "inventoryReturns",
              doc: `${id}_1`,
              create: {
                orderId: id,
                orderNumber: order.orderNumber ?? null,
                status: "pending",
                items,
                inventoryIds: items.map((x) => x.inventoryId).sort(),
                productKeys: [...new Set(items.map((x) => x.productKey).filter(Boolean))].sort(),
                totalQuantity: total,
                failureReason: order.deliveryFailureReason ?? null,
                reportedByUid: order.deliveryFailedByUid ?? null,
                reportedAt: "<order.deliveryFailedAt>",
                migratedFromV1: true,
              },
            },
            { collection: "orders", doc: id, merge: { allocationStatus: "returned", pendingReturnId: `${id}_1` } },
          ],
          why: "Under the old design a failed delivery kept its stock reserved. The new design holds it as return-pending until an Admin confirms its condition. Must run in ONE transaction per order, after re-reading every document.",
        });
      }
    }
  }

  // ---- pending returns
  for (const { data: r = {} } of returns) {
    if (r.status !== "pending") continue;
    for (const [inv, q] of sliceTotals(r.items)) explainedReturning.set(inv, (explainedReturning.get(inv) || 0) + q);
  }

  // ---- orders with no allocation data
  for (const { id, data: o = {} } of orders) {
    if (!ACTIVE_ORDER_STATUSES.includes(o.status) && o.status !== "delivery_failed") continue;
    if (o.allocationVersion !== 1 && o.allocationVersion !== 2) {
      findings.push({ kind: "order-without-allocation", orderId: id, orderNumber: o.orderNumber ?? null, status: o.status ?? null });
    }
    // The allocator pages the queue by allocationPriorityKey; an open,
    // backordered order without one is invisible to it and would wait forever.
    if (
      o.allocationVersion === 2 && o.allocationOpen === true &&
      Array.isArray(o.backorderedProductKeys) && o.backorderedProductKeys.length > 0 &&
      (typeof o.allocationPriorityKey !== "string" || o.allocationPriorityKey === "")
    ) {
      findings.push({ kind: "order-not-queueable", orderId: id, orderNumber: o.orderNumber ?? null });
    }
  }

  // ---- batches
  const batches = [];
  for (const { id, data: b = {} } of inventory) {
    const reserved = countOr0(b.reservedQuantity);
    const returning = countOr0(b.returnPendingQuantity);
    const quarantined = countOr0(b.quarantinedQuantity);
    const problems = [];
    if (!isCount(b.quantity)) problems.push("quantity is not a whole number");
    else if (b.quantity > IMPLAUSIBLE_QUANTITY) problems.push("quantity is implausibly large — excluded from allocation and new orders until an Admin confirms it");
    if (!isCount(reserved)) problems.push("reservedQuantity is not a whole number");
    if (!isCount(returning)) problems.push("returnPendingQuantity is not a whole number");
    if (!isCount(quarantined)) problems.push("quarantinedQuantity is not a whole number");
    if (typeof b.vaccineId !== "string" || b.vaccineId === "") problems.push("no vaccineId — cannot be allocated per product");
    const er = explainedReserved.get(id) || 0;
    const ert = explainedReturning.get(id) || 0;
    const reconciled = isCount(reserved) && isCount(returning) && reserved === er && returning === ert;
    if (isCount(b.quantity) && isCount(reserved) && isCount(returning) && isCount(quarantined) && b.quantity < reserved + returning + quarantined) {
      problems.push("held units exceed stock on hand");
    }
    batches.push({
      inventoryId: id,
      batchId: b.batchId ?? null,
      vaccineName: b.vaccineName ?? null,
      onHand: b.quantity ?? null,
      reservedQuantity: b.reservedQuantity ?? null,
      explainedReserved: er,
      returnPendingQuantity: b.returnPendingQuantity ?? null,
      explainedReturnPending: ert,
      reconciled,
      problems,
    });
  }

  return {
    batches,
    findings,
    proposals,
    summary: {
      batches: batches.length,
      unreconciledBatches: batches.filter((b) => !b.reconciled).length,
      batchesWithProblems: batches.filter((b) => b.problems.length > 0).length,
      v1FailedStillReserved: findings.filter((f) => f.kind === "v1-failed-order-still-reserved").length,
      reservationLeaks: findings.filter((f) => f.kind === "reservation-leak-on-terminal-order").length,
      ordersWithoutAllocation: findings.filter((f) => f.kind === "order-without-allocation").length,
      ordersNotQueueable: findings.filter((f) => f.kind === "order-not-queueable").length,
      proposedWrites: proposals.length,
    },
  };
}

function formatAllocationDiagnostic(report) {
  const lines = [];
  const s = report.summary;
  lines.push("ALLOCATION DIAGNOSTIC (read-only)");
  lines.push(`batches ${s.batches} · unreconciled ${s.unreconciledBatches} · with problems ${s.batchesWithProblems}`);
  lines.push(`v1 failed orders still reserved ${s.v1FailedStillReserved} · reservation leaks ${s.reservationLeaks} · orders without allocation ${s.ordersWithoutAllocation}`);
  lines.push("");
  for (const b of report.batches) {
    if (b.reconciled && b.problems.length === 0) continue;
    lines.push(`BATCH ${b.batchId ?? b.inventoryId} (${b.vaccineName ?? "?"}): on hand ${b.onHand}, reserved ${b.reservedQuantity} (explained ${b.explainedReserved}), return-pending ${b.returnPendingQuantity ?? 0} (explained ${b.explainedReturnPending})${b.reconciled ? "" : " — DOES NOT RECONCILE"}`);
    for (const p of b.problems) lines.push(`  - ${p}`);
  }
  for (const f of report.findings) {
    if (f.kind === "v1-failed-order-still-reserved") {
      lines.push(`FAILED ORDER ${f.orderNumber ?? f.orderId} still holds ${f.units} reserved unit(s): ${f.items.map((x) => `${x.batchId ?? x.inventoryId}×${x.quantity}`).join(", ")}`);
    } else if (f.kind === "reservation-leak-on-terminal-order") {
      lines.push(`LEAK: ${f.orderNumber ?? f.orderId} is ${f.orderStatus} but its reservation is still active`);
    } else if (f.kind === "order-without-allocation") {
      lines.push(`NO ALLOCATION: ${f.orderNumber ?? f.orderId} (${f.status}) predates reservations — holds no stock`);
    } else if (f.kind === "order-not-queueable") {
      lines.push(`NOT QUEUEABLE: ${f.orderNumber ?? f.orderId} waits for stock but has no allocationPriorityKey`);
    } else if (f.kind === "reservation-without-order") {
      lines.push(`ORPHAN RESERVATION ${f.reservationId}: ${f.units} unit(s), no order document`);
    }
  }
  lines.push("");
  lines.push(`PROPOSED (not applied): ${report.proposals.length}`);
  for (const p of report.proposals) {
    lines.push(`  [${p.safe ? "safe" : "needs Admin review"}] ${p.kind} ${p.orderNumber ?? p.orderId}${p.units ? ` (${p.units} units)` : ""}`);
  }
  return lines.join("\n");
}

module.exports = { buildAllocationDiagnostic, formatAllocationDiagnostic, IMPLAUSIBLE_QUANTITY };
