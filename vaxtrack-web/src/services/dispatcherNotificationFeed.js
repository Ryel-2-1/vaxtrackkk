import { orderDestination, orderReference } from "./orderLabel.js";
import {
  FRESHNESS,
  isValidCoordinate,
  locationFreshness,
  locationTimeMs,
  millisOf,
  normalizeStatus,
} from "./riderTracking.js";
import { presentAlert } from "./alertPresentation.js";

export const NEAR_DWELL_MS = 2 * 60 * 1000;
export const NEAR_WAIT_MS = 15 * 60 * 1000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACCURACY_M = 100;
const DEFAULT_RADIUS_M = 300;

function radiusOf(order) {
  const value = order.destinationGeofenceRadiusM ?? order.clinicGeofenceRadiusM;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RADIUS_M;
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const rad = (n) => n * Math.PI / 180;
  const deltaLat = rad(bLat - aLat);
  const deltaLng = rad(bLng - aLng);
  const sin = Math.sin(deltaLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(sin));
}

// Two distinct, accurate fixes at least two minutes apart must stay inside
// the destination radius. A stale/poor fix or a gap in tracking resets the
// candidate; one GPS point never claims a Rider reached the clinic.
export function advanceNearDestinations(previous, orders, locations, nowMs) {
  const next = {};
  for (const order of orders) {
    if (!order?.id || !["in_transit", "delayed"].includes(normalizeStatus(order.statusKey ?? order.status ?? order.rawStatus))) continue;
    const riderUid = order.assignedRiderId;
    const loc = riderUid ? locations[riderUid] : null;
    if (!isValidCoordinate(order.clinicLat, order.clinicLng)
      || locationFreshness(loc, nowMs) !== "fresh"
      || !Number.isFinite(loc?.accuracyMeters) || loc.accuracyMeters > MAX_ACCURACY_M) continue;
    const fixMs = locationTimeMs(loc);
    if (fixMs === null || fixMs > nowMs + 30_000) continue;
    if (distanceMeters(loc.latitude, loc.longitude, order.clinicLat, order.clinicLng) > radiusOf(order)) continue;

    const prior = previous[order.id];
    const continuous = prior && prior.riderUid === riderUid
      && fixMs >= prior.lastFixMs && fixMs - prior.lastFixMs <= FRESHNESS.freshMs;
    const firstFixMs = continuous ? prior.firstFixMs : fixMs;
    const confirmedAtMs = continuous
      ? prior.confirmedAtMs ?? (fixMs > prior.lastFixMs && fixMs - firstFixMs >= NEAR_DWELL_MS ? fixMs : null)
      : null;
    next[order.id] = { riderUid, firstFixMs, lastFixMs: fixMs, confirmedAtMs };
  }
  return next;
}

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
        items.push(item({ id: `delivered:${order.id}`, kind: "update", title: "Delivery completed",
          message: `${code} to ${clinic} was marked delivered. Open the shipment for its recorded details.`,
          atMs: deliveredMs, path }));
      }
    }

    const nearState = near[order.id];
    if (!["in_transit", "delayed"].includes(status) || !nearState?.confirmedAtMs
      || nowMs - nearState.lastFixMs > FRESHNESS.freshMs) continue;
    const confirmed = nearState.confirmedAtMs;
    items.push(item({ id: `near:${order.id}:${confirmed}`, kind: "update", title: "Rider near destination",
      message: `${riderName(order)} has remained within ${Math.round(radiusOf(order))} m of ${clinic} based on recent GPS. Clinic arrival and handoff are not confirmed.`,
      atMs: confirmed, path }));
    if (nowMs - confirmed >= NEAR_WAIT_MS) {
      items.push(item({ id: `near-wait:${order.id}:${confirmed}`, kind: "action",
        title: "Delivery still awaiting completion",
        message: `${code} was near ${clinic} at least 15 minutes ago, but no completion is recorded. Check with the rider.`,
        atMs: confirmed + NEAR_WAIT_MS, path }));
    }
  }
  return {
    actions: items.filter((entry) => entry.kind === "action").sort((a, b) => b.atMs - a.atMs),
    updates: items.filter((entry) => entry.kind === "update").sort((a, b) => b.atMs - a.atMs),
  };
}
