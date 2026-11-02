export function matchingZeroRateRequest(rows, { doctorId, doctorAddressId, requestedDeliveryDate }) {
  return rows.filter((row) => row.doctorId === doctorId &&
    row.doctorAddressId === doctorAddressId && row.requestedDeliveryDate === requestedDeliveryDate)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

function sameItems(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const key = (lines) => JSON.stringify(lines.map((item) => [item.inventoryId, Number(item.quantity)]).sort());
  return key(left) === key(right);
}

export function matchingZeroRateOrderRequests(rows, { items, ...destination }) {
  return matchingZeroRateRequest(rows, destination).filter((row) => sameItems(row.items, items));
}

export function approvedZeroRateForOrder(rows, { recoveryAllowed = false, recoveryApprovalId = "", restored = null, ...order }) {
  const matches = matchingZeroRateOrderRequests(rows, order);
  if (!recoveryAllowed) return matches.find((row) => row.status === "approved") ?? null;
  if (!recoveryApprovalId) return null;
  const saved = matches.find((row) => row.id === recoveryApprovalId &&
    (row.status === "approved" || row.status === "used"));
  if (saved) return saved;
  return restored?.zeroRateRequestId === recoveryApprovalId &&
    restored.doctorId === order.doctorId && restored.doctorAddressId === order.doctorAddressId &&
    restored.requestedDeliveryDate === order.requestedDeliveryDate && sameItems(restored.items, order.items)
    ? { id: recoveryApprovalId, status: "used" } : null;
}
