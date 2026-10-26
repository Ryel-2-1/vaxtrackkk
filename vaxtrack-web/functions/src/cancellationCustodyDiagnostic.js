"use strict";

/**
 * Cancellation custody — DIAGNOSTIC (pure, read-only).
 *
 * Before cancelOrderWithInventoryRelease decided custody from the stored order
 * (f8abad1), cancelling an order after its vials were loaded or had left with a
 * Rider RELEASED the reservation: the units became available — and could be
 * allocated to another order — while they were still on the vehicle. This
 * module finds the historical records that may have been affected.
 *
 * It only REPORTS. It proposes no writes and nothing here can perform one: a
 * record of where a vial physically went cannot be reconstructed from these
 * fields, so every finding needs a person who can check the shelf, the Rider
 * and the paperwork. Use it to build that checklist, never to "correct" stock.
 *
 * What it looks for:
 *   1. Cancelled orders whose reservation was RELEASED although the order
 *      carries evidence that its vials had left the hub (dispatch / trip
 *      departure fields) — the confirmed shape of the old bug.
 *   2. The same, with only loading evidence (confirmed as loaded in Cargo
 *      Loading, never dispatched) — handled vials released without inspection.
 *   3. Cancelled orders whose reservation is still `reserved` (a leak: units
 *      held for an order that will never be delivered).
 *   4. Cancelled orders marked returned whose return record is missing, and
 *      cancellation returns whose order is not cancelled (broken pairing).
 *
 * Limitations (stated in every report):
 *   - Evidence is per ORDER, not per vial. A finding means "these units may have
 *     been released while away from the hub", not "these units are missing".
 *   - Units released by the old behaviour may since have been reserved,
 *     delivered or counted; the current batch counters cannot tell which.
 *   - An order with NO custody evidence is not proof its vials stayed at the
 *     hub: older records may simply lack the fields. Those are counted, not
 *     cleared.
 *
 * Input: { orders: [{id, data}], reservations: [{id, data}], returns: [{id, data}] }
 */

const DISPATCH_EVIDENCE_FIELDS = Object.freeze([
  "dispatchedAt", "loadingFinalizedAt", "startedAt", "dispatchedByUid",
]);
const LOADING_EVIDENCE_FIELDS = Object.freeze(["loadedAt", "loadedByUid"]);
const CANCELLED = new Set(["cancelled", "canceled"]);

const present = (data, field) => data?.[field] !== undefined && data?.[field] !== null && data?.[field] !== "";

function unitsByInventory(items) {
  const totals = new Map();
  for (const slice of Array.isArray(items) ? items : []) {
    const id = typeof slice?.inventoryId === "string" ? slice.inventoryId : null;
    const qty = Number.isInteger(slice?.quantity) && slice.quantity > 0 ? slice.quantity : 0;
    if (!id || qty === 0) continue;
    totals.set(id, (totals.get(id) || 0) + qty);
  }
  return [...totals].map(([inventoryId, quantity]) => ({ inventoryId, quantity })).sort((a, b) => a.inventoryId.localeCompare(b.inventoryId));
}

function evidenceOf(order) {
  const dispatch = DISPATCH_EVIDENCE_FIELDS.filter((f) => present(order, f));
  const loading = LOADING_EVIDENCE_FIELDS.filter((f) => present(order, f));
  if (order?.isLoaded === true) loading.push("isLoaded");
  return { dispatch, loading };
}

function buildCancellationCustodyDiagnostic({ orders = [], reservations = [], returns = [] } = {}) {
  const reservationById = new Map(reservations.map((r) => [r.id, r.data || {}]));
  const returnById = new Map(returns.map((r) => [r.id, r.data || {}]));
  const orderById = new Map(orders.map((o) => [o.id, o.data || {}]));

  const releasedAfterDispatch = [];
  const releasedAfterLoading = [];
  const leakedReservations = [];
  const brokenReturnPairs = [];
  let cancelledOrders = 0;
  let releasedWithoutEvidence = 0;

  for (const { id, data: order = {} } of orders) {
    if (!CANCELLED.has(order.status)) continue;
    cancelledOrders += 1;
    const reservation = reservationById.get(id) || null;
    const evidence = evidenceOf(order);
    const finding = {
      orderId: id,
      orderNumber: order.orderNumber ?? null,
      allocationVersion: order.allocationVersion ?? null,
      reservationStatus: reservation?.status ?? null,
      settlementType: reservation?.settlementType ?? null,
      units: unitsByInventory(reservation?.items),
      evidence: [...evidence.dispatch, ...evidence.loading],
    };

    if (reservation?.status === "released") {
      if (evidence.dispatch.length > 0) releasedAfterDispatch.push(finding);
      else if (evidence.loading.length > 0) releasedAfterLoading.push(finding);
      else releasedWithoutEvidence += 1;
    } else if (reservation?.status === "reserved") {
      leakedReservations.push(finding);
    }

    const pendingReturnId = typeof order.pendingReturnId === "string" ? order.pendingReturnId : null;
    if (order.allocationStatus === "returned" && (!pendingReturnId || !returnById.has(pendingReturnId))) {
      brokenReturnPairs.push({ kind: "order-without-return", orderId: id, orderNumber: order.orderNumber ?? null, returnId: pendingReturnId });
    }
  }

  for (const { id, data: rt = {} } of returns) {
    if (rt.source !== "cancelled_after_dispatch") continue;
    const owner = orderById.get(rt.orderId);
    if (!owner || !CANCELLED.has(owner.status)) {
      brokenReturnPairs.push({ kind: "cancellation-return-without-cancelled-order", returnId: id, orderId: rt.orderId ?? null, orderStatus: owner?.status ?? null });
    }
  }

  const sumUnits = (list) => list.reduce((s, f) => s + f.units.reduce((t, u) => t + u.quantity, 0), 0);
  return {
    summary: {
      cancelledOrders,
      releasedAfterDispatch: releasedAfterDispatch.length,
      releasedAfterDispatchUnits: sumUnits(releasedAfterDispatch),
      releasedAfterLoading: releasedAfterLoading.length,
      releasedAfterLoadingUnits: sumUnits(releasedAfterLoading),
      releasedWithoutEvidence,
      leakedReservations: leakedReservations.length,
      brokenReturnPairs: brokenReturnPairs.length,
    },
    releasedAfterDispatch,
    releasedAfterLoading,
    leakedReservations,
    brokenReturnPairs,
    proposedWrites: [],
  };
}

function formatCancellationCustodyDiagnostic(report) {
  const s = report.summary;
  const lines = [
    "Cancellation custody diagnostic (read-only — proposes no writes)",
    `cancelled orders ${s.cancelledOrders}`,
    `released after dispatch ${s.releasedAfterDispatch} (${s.releasedAfterDispatchUnits} units) · released after loading only ${s.releasedAfterLoading} (${s.releasedAfterLoadingUnits} units)`,
    `released with no custody evidence ${s.releasedWithoutEvidence} (not proof the vials stayed at the hub)`,
    `cancelled but still reserved ${s.leakedReservations} · broken order/return pairs ${s.brokenReturnPairs}`,
  ];
  const list = (title, findings) => {
    if (findings.length === 0) return;
    lines.push("", title);
    for (const f of findings) {
      const units = f.units.map((u) => `${u.inventoryId}×${u.quantity}`).join(", ") || "no slices";
      lines.push(`  ${f.orderNumber || f.orderId} [${f.orderId}] ${units} · evidence: ${f.evidence.join(", ") || "none"}`);
    }
  };
  list("Released after dispatch — check with the Rider and the batch:", report.releasedAfterDispatch);
  list("Released after loading only — check whether the vials were unloaded and inspected:", report.releasedAfterLoading);
  list("Cancelled but still reserved:", report.leakedReservations);
  if (report.brokenReturnPairs.length > 0) {
    lines.push("", "Broken order/return pairs:");
    for (const b of report.brokenReturnPairs) lines.push(`  ${b.kind}: order ${b.orderId ?? "?"} return ${b.returnId ?? "?"}`);
  }
  lines.push(
    "",
    "Limitations: custody evidence is per order, not per vial; released units may since have been",
    "reserved, delivered or counted; a missing field is not proof the vials stayed at the hub.",
    "No stock is corrected here — every finding needs a physical check and a separate, authorized decision.",
  );
  return lines.join("\n");
}

module.exports = {
  buildCancellationCustodyDiagnostic,
  formatCancellationCustodyDiagnostic,
  DISPATCH_EVIDENCE_FIELDS,
  LOADING_EVIDENCE_FIELDS,
};
