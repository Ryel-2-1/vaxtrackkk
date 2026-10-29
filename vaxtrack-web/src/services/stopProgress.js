// Read-only progress. Proof and navigation never change an order's lifecycle
// or stand in for the rider's GPS position.
const ACTIVE = new Set(["assigned", "loading", "in_transit", "delayed"]);
const RIDING = new Set(["in_transit", "delayed"]);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const statusOf = (o) => String(o?.statusKey ?? o?.status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

export function shipmentProgress(order, navigationOrderId = null) {
  const status = statusOf(order);
  // Match the recorded-evidence contract, not a Storage upload or legacy URL
  // whose metadata save may have failed. Completion is server-authoritative.
  const proofRecorded = Boolean(order?.proofSubmittedAt && text(order.proofOfDeliveryUrl) &&
    text(order.proofRecipientName) && text(order.proofSubmittedByUid) && text(order.id) &&
    order.proofOfDeliveryPath === `proof_of_delivery/${order.id}/proof.jpg`);
  const proofNeedsReview = proofRecorded && order.proofSubmittedByUid !== order.assignedRiderId;
  const navigating = text(order?.id) && order.id === navigationOrderId && RIDING.has(status);
  const delivered = status === "delivered" || status === "completed";
  const cancelled = status === "cancelled" || status === "canceled";
  let state = "pending", label = "Proof pending";
  if (delivered) { state = "delivered"; label = "Delivered"; }
  else if (cancelled) { state = "cancelled"; label = "Cancelled"; }
  else if (status === "delivery_failed") { state = "attention"; label = "Delivery failed"; }
  else if (proofNeedsReview) { state = "attention"; label = "Proof needs review"; }
  else if (proofRecorded) { state = "proof"; label = "Proof recorded · completion pending"; }
  else if (status === "assigned" || status === "loading") { label = "Awaiting dispatch"; }
  else if (!ACTIVE.has(status)) { state = "unknown"; label = "Check shipment status"; }
  return { state, label, delivered, cancelled, proofRecorded, navigating, unfinished: ACTIVE.has(status) };
}

export function tripProgress(orders, selected, deviation = null) {
  if (!text(selected?.tripId) || !text(selected?.assignedRiderId)) return null;
  const navigationOrderId = deviation?.sessionState === "navigating" ? deviation.orderId : null;
  // Include completed stops, but never mix another rider or a different plan.
  // Missing coordinates must not hide a stop's recorded progress.
  const stops = orders.filter((o) => o.tripId === selected.tripId &&
    o.assignedRiderId === selected.assignedRiderId && Number.isInteger(o.stopSequence) && o.stopSequence > 0)
    .sort((a, b) => a.stopSequence - b.stopSequence || String(a.id).localeCompare(String(b.id)))
    .map((order) => ({ order, ...shipmentProgress(order, navigationOrderId) }));
  if (!stops.length) return null;
  return {
    stops,
    delivered: stops.filter((s) => s.delivered).length,
    proofRecorded: stops.filter((s) => s.proofRecorded).length,
    cancelled: stops.filter((s) => s.cancelled).length,
    navigationTarget: stops.find((s) => s.navigating) ?? null,
    nextUnfinished: stops.find((s) => s.unfinished) ?? null,
  };
}
