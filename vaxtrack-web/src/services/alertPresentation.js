/**
 * How an alert is PRESENTED, on every notification surface (Admin Alerts,
 * its detail dialog, the Dispatcher notification bell). Pure; no Firebase.
 *
 * Built from display fields only. Never rendered: the alert document id, a
 * rider's Firebase uid, an order's Firestore document id, a raw Firestore
 * path or a street address. Route-deviation wording mirrors the server
 * (functions/src/riderTracking.js deviationAlertText — parity-tested), and is
 * rebuilt from the stored fields rather than shown from `message`, so an
 * older alert (written before these fields existed, or with an id in its
 * message) falls back to safe generic wording, and a resolved one never still
 * says the rider is off route.
 */

export const ALERT_ACTION_LABEL = "View details";

const DEVIATION_THRESHOLD_METERS = 500;
const DEVIATION_MINUTES = 3;

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const nameOr = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

/** The official short code of a VT-ORD-<time>-<CODE> order number, else the number; never a document id. */
export function orderCodeOf(orderNumber) {
  if (typeof orderNumber !== "string" || orderNumber.trim() === "") return null;
  const n = orderNumber.trim();
  const m = /^VT-ORD-\d+-([A-Z0-9]{3,8})$/.exec(n);
  return m ? m[1] : n;
}

/** "650 m" below a kilometre (after rounding), else "1.65 km". */
export function formatDistanceMeters(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return null;
  if (Math.round(meters) < 1000) return `${Math.round(meters)} m`;
  return `${Number((meters / 1000).toFixed(2))} km`;
}

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", else a date. */
export function friendlyTime(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms)) return null;
  const mins = Math.floor((nowMs - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (hours < 48) return "yesterday";
  return new Date(ms).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
}

/** The route-deviation sentence (mirror of the server's deviationAlertText). */
export function deviationAlertText({ status, riderName, orderNumber, distanceMeters, resolutionReason }) {
  const rider = nameOr(riderName, "The rider");
  const code = orderCodeOf(orderNumber);
  const orderText = code ? `Order ${code}` : "this order";
  if (status === "resolved") {
    if (resolutionReason === "returned_to_route") return `${rider} returned to the planned route for ${orderText}.`;
    return `Route monitoring for ${orderText} has ended.`;
  }
  const distance = formatDistanceMeters(distanceMeters);
  return `${rider} is ${distance ?? `more than ${DEVIATION_THRESHOLD_METERS} m`} away from the planned route for ${orderText}. ` +
    `The deviation has continued for at least ${DEVIATION_MINUTES} minutes.`;
}

const TITLES = Object.freeze({
  route_deviation: { active: "Route deviation", resolved: "Route deviation resolved" },
  delivery_delay: { active: "Delivery running late", resolved: "Late delivery resolved" },
});

/** The screen that acts on an order-linked alert, for the viewer's role. */
function pathFor(raw, role) {
  const orderId = typeof raw?.orderId === "string" && raw.orderId ? raw.orderId : null;
  if (!orderId) return null;
  if (role === "admin") return `/admin/deliveries?order=${encodeURIComponent(orderId)}`;
  const stored = typeof raw.path === "string" && raw.path.startsWith("/dispatcher/") ? raw.path : null;
  return stored ?? `/dispatcher/shipments?order=${encodeURIComponent(orderId)}`;
}

/**
 * @param {object} raw   the alert document data
 * @param {{ role?: "admin" | "dispatcher", nowMs?: number, fallbackTitle?: string }} [opts]
 */
export function presentAlert(raw, { role = "admin", nowMs = Date.now(), fallbackTitle = "Alert" } = {}) {
  const resolved = raw?.status === "resolved";
  const type = raw?.type;
  const orderLinked = type === "route_deviation" || type === "delivery_delay";
  const rider = nameOr(raw?.riderName, null);
  const code = orderCodeOf(raw?.orderNumber);
  const createdMs = millisOf(raw?.createdAt) ?? millisOf(raw?.lastDetectedAt);
  const resolvedMs = millisOf(raw?.resolvedAt);

  let title;
  let message;
  if (type === "route_deviation") {
    title = TITLES.route_deviation[resolved ? "resolved" : "active"];
    message = deviationAlertText({
      status: resolved ? "resolved" : "active",
      riderName: raw.riderName,
      orderNumber: raw.orderNumber,
      distanceMeters: raw.distanceMeters,
      resolutionReason: raw.resolutionReason,
    });
  } else if (type === "delivery_delay") {
    title = TITLES.delivery_delay[resolved ? "resolved" : "active"];
    message = resolved
      ? `The late delivery alert for ${code ? `Order ${code}` : "this order"} was resolved.`
      : nameOr(raw.message, "A delivery passed its expected arrival and grace period.");
  } else {
    title = nameOr(raw?.title, fallbackTitle);
    message = nameOr(raw?.message, "");
  }

  const when = resolved && resolvedMs !== null
    ? `Resolved ${friendlyTime(resolvedMs, nowMs)}`
    : friendlyTime(createdMs, nowMs);
  const meta = [
    orderLinked && rider ? `Rider: ${rider}` : null,
    orderLinked && code ? `Order: ${code}` : null,
    when,
  ].filter(Boolean);

  const details = [];
  if (orderLinked) {
    details.push({ label: "Rider", value: rider ?? "Not recorded" });
    details.push({ label: "Order", value: nameOr(raw?.orderNumber, "Not recorded") });
  }
  if (type === "route_deviation") {
    const distance = formatDistanceMeters(raw.distanceMeters);
    if (distance) details.push({ label: "Distance from route", value: `${distance} (limit ${raw.thresholdMeters ?? DEVIATION_THRESHOLD_METERS} m)` });
  }
  if (createdMs !== null) details.push({ label: "Detected", value: friendlyTime(createdMs, nowMs) });
  if (resolved && resolvedMs !== null) details.push({ label: "Resolved", value: friendlyTime(resolvedMs, nowMs) });

  return {
    title,
    message,
    resolved,
    statusLabel: resolved ? "Resolved" : "Active",
    unread: raw?.read !== true,
    orderCode: orderLinked ? code : null,
    meta,
    metaText: meta.join(" · "),
    details,
    actionLabel: ALERT_ACTION_LABEL,
    path: orderLinked ? pathFor(raw, role) : null,
    searchText: [title, message, rider, raw?.orderNumber].filter(Boolean).join(" ").toLowerCase(),
  };
}
