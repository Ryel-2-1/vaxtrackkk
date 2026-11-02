import { getOrderStatusValue, normalizeStatusKey } from "./deliveryService.js";
import { orderDestination, orderReference } from "./orderLabel.js";

function formatTime(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// The Alerts page and the top-bar bell describe the same current order state.
// A status-specific read key lets a later status change appear as a new update.
export function deriveSalesRepOrderAlert(order) {
  const rawStatus = getOrderStatusValue(order);
  const statusKey = normalizeStatusKey(rawStatus);
  const clinic = order.clinicName || "Unknown Clinic";
  const orderNum = orderReference(order, orderDestination(order) || "Order without a number");
  const vaccine = order.vaccineName || "Vaccine order";
  let tone = "info";
  let tag = "INFO";
  let title;
  let body;

  switch (statusKey) {
    case "delayed":
      tone = "critical";
      tag = "CRITICAL";
      title = `Delivery Delayed — ${orderNum}`;
      body = `Order to ${clinic} for ${vaccine} has been delayed. Check order tracking for updates.`;
      break;
    case "delivery_failed":
      tone = "critical";
      tag = "NEEDS ATTENTION";
      title = `Delivery Failed — ${orderNum}`;
      body = `The delivery of ${vaccine} to ${clinic} failed. Check order tracking for the next action.`;
      break;
    case "cancelled":
    case "canceled":
      tone = "critical";
      tag = "CRITICAL";
      title = `Order Cancelled — ${orderNum}`;
      body = `Order to ${clinic} for ${vaccine} has been cancelled.`;
      break;
    case "assigned":
      tag = "UPDATE";
      title = `Rider Assigned — ${orderNum}`;
      body = `A rider has been assigned to deliver ${vaccine} to ${clinic}.${order.assignedRiderName ? ` Rider: ${order.assignedRiderName}` : ""}`;
      break;
    case "in_transit":
      tag = "UPDATE";
      title = `In Transit — ${orderNum}`;
      body = `Your order of ${vaccine} to ${clinic} is now in transit.`;
      break;
    case "completed":
    case "delivered":
      tone = "success";
      tag = "DELIVERED";
      title = `Delivered — ${orderNum}`;
      body = `Order of ${vaccine} to ${clinic} has been delivered successfully.`;
      break;
    case "pending":
    case "pending_dispatch":
      tag = "PENDING";
      title = `Order Submitted — ${orderNum}`;
      body = `Your order of ${vaccine} to ${clinic} is pending dispatch.`;
      break;
    case "loading":
      tag = "UPDATE";
      title = `Loading — ${orderNum}`;
      body = `Order of ${vaccine} for ${clinic} is being loaded for dispatch.`;
      break;
    default:
      title = `Order Update — ${orderNum}`;
      body = `Order to ${clinic} status: ${rawStatus || "unknown"}.`;
  }

  const ts = order.updatedAt || order.createdAt;
  return {
    id: order.id,
    readId: `${order.id}:${statusKey}`,
    tone,
    tag,
    title,
    body,
    location: clinic,
    time: formatTime(ts),
    sortTime: (ts?.toMillis?.() ?? new Date(ts || 0).getTime()) || 0,
    statusKey,
    orderNumber: orderNum,
    priority: order.priority || "Standard",
    quantity: Number(order.quantity || 0),
    vaccineName: vaccine,
  };
}
