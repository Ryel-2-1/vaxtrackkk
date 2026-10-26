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

// A Firestore auto id (20) or Firebase Auth uid (28): letters and digits only.
const ID_TOKEN = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20}(?:[A-Za-z0-9]{8})?\b/g;

/**
 * Stored alert text with identifiers replaced by what a reader understands:
 * the alert's own order / rider / delivery ids become the order code or
 * rider name (or "this order" / "the rider"), and any other id-shaped token
 * becomes "a record". Server wording that carries no id is unchanged.
 */
export function withoutIds(text, raw) {
  if (typeof text !== "string" || text === "") return text;
  const code = orderCodeOf(raw?.orderNumber);
  const usable = (id) => typeof id === "string" && id.length >= 8;
  let out = text;
  for (const id of [raw?.orderId, raw?.deliveryId]) {
    if (!usable(id)) continue;
    if (code) {
      out = out.split(id).join(code);
    } else {
      // "Order <id> is late" → "This order is late", not "Order this order".
      out = out.split(`Order ${id}`).join("This order").split(`order ${id}`).join("this order").split(id).join("this order");
    }
  }
  if (usable(raw?.riderId)) out = out.split(raw.riderId).join(nameOr(raw?.riderName, "the rider"));
  if (usable(raw?.id)) out = out.split(raw.id).join("this alert");
  return out.replace(ID_TOKEN, "a record");
}

const TITLES = Object.freeze({
  route_deviation: { active: "Route deviation", resolved: "Route deviation resolved" },
  delivery_delay: { active: "Delivery running late", resolved: "Late delivery resolved" },
  rider_location_stale: { active: "Rider location not updating", resolved: "Rider location updating again" },
});

const STALE_MINUTES = 10;

/** The stale-location sentence (mirror of the server's staleAlertText — parity-tested). */
export function staleLocationText({ status, riderName, minutes, resolutionReason }) {
  const rider = nameOr(riderName, "The rider");
  if (status === "resolved") {
    if (resolutionReason === "location_updating") return `${rider}'s location is updating again.`;
    return `${rider}'s trip has ended, so location monitoring stopped.`;
  }
  const mins = Number.isFinite(minutes) && minutes >= STALE_MINUTES ? Math.floor(minutes) : STALE_MINUTES;
  return `${rider}'s location hasn't updated for ${mins} minutes during a delivery trip. ` +
    "Check that the rider app is open and has signal.";
}

/** How a late-delivery alert ended, by the server's resolution reason. */
function lateResolvedText(reason, code) {
  const order = code ? `Order ${code}` : "This order";
  if (reason === "delivered") return `${order} was delivered.`;
  if (reason === "delivery_failed") return `${order} was reported as a failed delivery.`;
  if (reason === "cancelled") return `${order} was cancelled.`;
  return `The late delivery alert for ${code ? `Order ${code}` : "this order"} was resolved.`;
}

/** The fleet map focused on the Rider, for the viewer's role. */
function riderPathFor(raw, role) {
  const riderId = typeof raw?.riderId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw.riderId) ? raw.riderId : null;
  const base = role === "admin" ? "/admin/live-tracking" : "/dispatcher/live-tracking";
  return riderId ? `${base}?rider=${encodeURIComponent(riderId)}` : base;
}

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
  const riderLinked = type === "rider_location_stale";
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
      ? lateResolvedText(raw.resolutionReason, code)
      : withoutIds(nameOr(raw.message, "A delivery passed its expected arrival and grace period."), raw);
  } else if (type === "rider_location_stale") {
    // Rebuilt from the stored fields, never shown from `message`.
    title = TITLES.rider_location_stale[resolved ? "resolved" : "active"];
    message = staleLocationText({
      status: resolved ? "resolved" : "active",
      riderName: raw.riderName,
      minutes: raw.staleMinutesAtDetection,
      resolutionReason: raw.resolutionReason,
    });
  } else {
    title = withoutIds(nameOr(raw?.title, fallbackTitle), raw);
    message = withoutIds(nameOr(raw?.message, ""), raw);
  }

  const when = resolved && resolvedMs !== null
    ? `Resolved ${friendlyTime(resolvedMs, nowMs)}`
    : friendlyTime(createdMs, nowMs);
  const meta = [
    (orderLinked || riderLinked) && rider ? `Rider: ${rider}` : null,
    orderLinked && code ? `Order: ${code}` : null,
    when,
  ].filter(Boolean);

  const details = [];
  if (orderLinked) {
    details.push({ label: "Rider", value: rider ?? "Not recorded" });
    details.push({ label: "Order", value: nameOr(raw?.orderNumber, "Not recorded") });
  }
  if (riderLinked) {
    details.push({ label: "Rider", value: rider ?? "Not recorded" });
    if (Number.isInteger(raw?.orderCount) && raw.orderCount > 0) {
      details.push({ label: "Orders on the trip", value: String(raw.orderCount) });
    }
    const lastFixMs = millisOf(raw?.lastFixAt);
    details.push({ label: "Last location update", value: lastFixMs !== null ? friendlyTime(lastFixMs, nowMs) : "None since the trip left" });
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
    path: orderLinked ? pathFor(raw, role) : riderLinked ? riderPathFor(raw, role) : null,
    searchText: [title, message, rider, raw?.orderNumber].filter(Boolean).join(" ").toLowerCase(),
  };
}
