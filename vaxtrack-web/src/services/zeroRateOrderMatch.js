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

/**
 * The Med Rep's latest OPEN zero-rating request (pending or approved, for a
 * delivery today or later) that no longer matches the checkout, and what
 * changed (2026-11-13). An approval applies only to the exact order it was
 * asked for; when the rep edits the cart afterwards the checkout used to fall
 * back to the first question with no word about the request, so it looked as
 * if the request — and the order — had vanished. The cart is never touched;
 * this only explains. Null when nothing open differs, or one matches exactly.
 */
export function zeroRateRequestNoLongerMatching(rows, { items, doctorId, doctorAddressId, requestedDeliveryDate, today }) {
  const open = (Array.isArray(rows) ? rows : [])
    .filter((row) => (row.status === "pending" || row.status === "approved") &&
      (!today || !row.requestedDeliveryDate || row.requestedDeliveryDate >= today))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  if (open.length === 0) return null;
  const current = { doctorId, doctorAddressId, requestedDeliveryDate, items };
  if (matchingZeroRateOrderRequests(open, current).length > 0) return null;
  // Prefer the request for the doctor now chosen; otherwise the latest one.
  const row = open.find((r) => r.doctorId === doctorId) ?? open[0];
  const changes = [];
  if (row.doctorId !== doctorId) changes.push("doctor");
  else if (row.doctorAddressId !== doctorAddressId) changes.push("delivery address");
  if (row.requestedDeliveryDate !== requestedDeliveryDate) changes.push("delivery date");
  const asked = new Map((row.items || []).map((i) => [i.inventoryId, Number(i.quantity)]));
  const now = new Map((items || []).map((i) => [i.inventoryId, Number(i.quantity)]));
  const sameSet = asked.size === now.size && [...asked.keys()].every((id) => now.has(id));
  if (!sameSet) changes.push("items");
  else if ([...asked].some(([id, q]) => now.get(id) !== q)) changes.push("vial counts");
  if (changes.length === 0) return null;
  const list = changes.length === 1 ? changes[0] : `${changes.slice(0, -1).join(", ")} and ${changes.at(-1)}`;
  const state = row.status === "approved" ? "approved" : "waiting for Admin";
  return {
    request: row,
    changes,
    text: `Your zero-rating request (${state}) no longer matches this cart: the ${list} changed. `
      + "Nothing in your cart was removed. Change it back to use that request, or request zero-rating again for these details.",
  };
}

/** Pending reviews always wait; saved attempts can recover during a listener outage. */
export function zeroRateCheckoutBlock({ requests, ready, loadError, sending, recovering = false }) {
  if (sending) return "Sending your zero-rating request. Please wait before finalizing.";
  if (requests.some((row) => row.status === "pending")) {
    return "Wait for Admin to approve or deny this order’s zero-rating request before finalizing.";
  }
  if (recovering) return "";
  if (loadError) return "Zero-rating review status could not be verified. Please wait for it to reconnect before finalizing.";
  if (!ready) return "Checking zero-rating review status…";
  return "";
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
