import { orderDestination, orderReference } from "./orderLabel.js";
import { FRESHNESS, millisOf, normalizeStatus } from "./riderTracking.js";
import { presentAlert } from "./alertPresentation.js";
import { offlineCompletionNote } from "./offlineCompletionView.js";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

// "Near destination" is decided on the server (functions/src/arrivalProximity
// .js) from every Rider fix, so it does not depend on this page being open:
// `near` is the arrivalProximity documents keyed by order id. The 15-minute
// "still awaiting completion" follow-up is a server alert
// (delivery_awaiting_completion) and arrives with the other alerts.

function shipmentPath(order) {
  return `/dispatcher/shipments?order=${encodeURIComponent(order.id)}`;
}

function shipmentName(order) {
  return orderReference(order, orderDestination(order) || "the shipment");
}

function riderName(order) {
  return typeof order.assignedRiderName === "string" && order.assignedRiderName.trim()
    ? order.assignedRiderName.trim() : "The rider";
}

function item({ id, kind, title, message, atMs, path, rawAlert = null }) {
  return { id, kind, title, message, atMs, path, rawAlert };
}

export function buildDispatcherNotificationFeed({ alerts, orders, near, nowMs }) {
  const items = [];
  const alertOrderIds = new Set(alerts.filter((a) => a.type === "delivery_delay" && a.orderId).map((a) => a.orderId));
  for (const alert of alerts) {
    const view = presentAlert(alert, { role: "dispatcher", nowMs });
    items.push(item({
      id: alert.id,
      kind: "action",
      title: view.title,
      message: view.message,
      atMs: millisOf(alert.createdAt) ?? millisOf(alert.lastDetectedAt) ?? 0,
      path: view.path,
      rawAlert: alert,
    }));
  }
  for (const order of orders) {
    if (!order?.id) continue;
    const status = normalizeStatus(order.statusKey ?? order.status ?? order.rawStatus);
    const code = shipmentName(order);
    const clinic = orderDestination(order) || order.clinicName || "the destination";
    const atMs = millisOf(order.statusUpdatedAt) ?? millisOf(order.updatedAt) ?? 0;
    const path = shipmentPath(order);
    if (status === "delivery_failed") {
      items.push(item({ id: `failed:${order.id}:${millisOf(order.deliveryFailedAt) ?? atMs}`,
        kind: "action", title: "Delivery failed",
        message: `${riderName(order)} reported a failed delivery for ${code} to ${clinic}. Review the shipment and return decision.`,
        atMs: millisOf(order.deliveryFailedAt) ?? atMs, path }));
    } else if (status === "delayed" && !alertOrderIds.has(order.id)) {
      items.push(item({ id: `delayed:${order.id}:${atMs}`, kind: "action", title: "Delivery delayed",
        message: `${code} to ${clinic} is delayed. Review the shipment and requested arrival.`, atMs, path }));
    } else if (status === "delivered") {
      const deliveredMs = millisOf(order.deliveredAt) ?? atMs;
      if (deliveredMs && nowMs - deliveredMs <= RECENT_MS) {
        const offline = offlineCompletionNote(order);
        items.push(item({ id: `delivered:${order.id}`, kind: "update",
          title: offline ? "Delivery completed offline" : "Delivery completed",
          message: offline
            ? `${code} to ${clinic}: ${offline}`
            : `${code} to ${clinic} was marked delivered. Open the shipment for its recorded details.`,
          atMs: deliveredMs, path }));
      }
    }

    const nearState = near[order.id];
    if (!["in_transit", "delayed"].includes(status) || !Number.isFinite(nearState?.confirmedAtMs)
      || nearState.riderUid !== order.assignedRiderId || nowMs - nearState.lastFixMs > FRESHNESS.freshMs) continue;
    const confirmed = nearState.confirmedAtMs;
    items.push(item({ id: `near:${order.id}:${confirmed}`, kind: "update", title: "Rider near destination",
      message: `${riderName(order)} has remained within ${Math.round(nearState.radiusM)} m of ${clinic} based on recent GPS. Clinic arrival and handoff are not confirmed.`,
      atMs: confirmed, path }));
  }
  return {
    actions: items.filter((entry) => entry.kind === "action").sort((a, b) => b.atMs - a.atMs),
    updates: items.filter((entry) => entry.kind === "update").sort((a, b) => b.atMs - a.atMs),
  };
}
