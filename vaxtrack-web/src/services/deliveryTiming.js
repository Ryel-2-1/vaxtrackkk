/**
 * Display of the server's automatic delivery timing (functions/src/
 * deliveryTiming.js). Pure; no Firebase import.
 *
 * Two different things are never merged into one ambiguous "Delayed":
 *   * the LIFECYCLE status `delayed` — a Rider-reported hold (proof and
 *     completion wait until the rider resumes); and
 *   * the SCHEDULE condition `timingStatus` — on time, at risk, or
 *     automatically delayed (past the expected arrival plus grace). It never
 *     blocks proof or completion.
 * An order can be both: on hold AND behind schedule. The timing clock keeps
 * running during a hold.
 *
 * The condition shown is the one the SERVER recorded; the device clock only
 * fills in "delayed by N minutes".
 */

import { orderDestination, orderReference } from "./orderLabel.js";

export const TIMING_LABELS = Object.freeze({
  on_time: "On time",
  at_risk: "At risk",
  delayed: "Automatically delayed",
  unknown: "Timing unavailable",
});

/** The Rider-reported hold, named so it cannot be read as automatic lateness. */
export const HOLD_LABEL = "Rider-reported hold";

/** Why an attempt has no timing: it had no usable route ETA when it was dispatched. */
export const NO_ETA_DETAIL = "No route ETA at dispatch";

const TONES = Object.freeze({ on_time: "ok", at_risk: "warn", delayed: "late", unknown: "none" });

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** "6:30 PM" in Manila time. */
export function manilaTime(ms) {
  return new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
}

const minutesText = (m) => `${m} minute${m === 1 ? "" : "s"}`;

const normalized = (order) =>
  String(order?.statusKey ?? order?.status ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");

/**
 * The combined lifecycle + timing wording:
 *   in transit:  "In Transit" · "In Transit — At Risk" · "In Transit — Automatically delayed"
 *   on hold:     "Delayed — Rider-reported hold"
 *                "Delayed — Rider-reported hold · also behind schedule" (automatically late too)
 */
function combinedLabel(lifecycle, status) {
  if (lifecycle === "delayed") {
    return status === "delayed" ? `Delayed — ${HOLD_LABEL} · also behind schedule` : `Delayed — ${HOLD_LABEL}`;
  }
  if (status === "at_risk") return "In Transit — At Risk";
  if (status === "delayed") return "In Transit — Automatically delayed";
  return "In Transit";
}

/**
 * The timing indicator, or null when there is nothing to show: the order is
 * not in transit or on a Rider-reported hold, or it was dispatched before
 * timing existed (no timingStatus — a legacy order).
 *
 * @param {object} order   order data (raw or normalized; needs status/statusKey
 *                         and the timing fields)
 * @param {number} nowMs   the viewer's clock, for wording only
 * @returns {null | { status, lifecycle, onHold, tone, label, detail, combinedLabel }}
 */
export function deliveryTiming(order, nowMs = Date.now()) {
  if (!order) return null;
  const lifecycle = normalized(order);
  if (lifecycle !== "in_transit" && lifecycle !== "delayed") return null;
  const stored = order.timingStatus;
  if (!Object.hasOwn(TIMING_LABELS, stored ?? "")) return null;

  const expected = millisOf(order.expectedArrivalAt);
  const deadline = millisOf(order.automaticDelayedAt);
  // Without both baseline times nothing can be said about arrival.
  const status = expected === null || deadline === null ? "unknown" : stored;
  let detail;
  if (status === "unknown") {
    detail = NO_ETA_DETAIL;
  } else if (status === "on_time") {
    detail = `Expected by ${manilaTime(expected)}`;
  } else if (status === "at_risk") {
    detail = `At risk — grace period ends at ${manilaTime(deadline)}`;
  } else {
    const late = Math.max(0, Math.floor((nowMs - expected) / 60000));
    detail = late > 0 ? `Delayed by ${minutesText(late)} (expected by ${manilaTime(expected)})` : `Delayed (expected by ${manilaTime(expected)})`;
  }
  return {
    status,
    lifecycle,
    onHold: lifecycle === "delayed",
    tone: TONES[status],
    label: TIMING_LABELS[status],
    detail,
    combinedLabel: combinedLabel(lifecycle, status),
  };
}

/**
 * The Dispatcher notification's live line for an automatic-late alert:
 * "Now 18 minutes past expected arrival". Null for other alerts.
 */
export function lateAlertLiveText(alert, nowMs = Date.now()) {
  if (alert?.type !== "delivery_delay") return null;
  const expected = millisOf(alert.expectedArrivalAt);
  if (expected === null) return null;
  const late = Math.max(0, Math.floor((nowMs - expected) / 60000));
  return `Now ${minutesText(late)} past expected arrival`;
}

// ---------------------------------------------------------------- dispatch-time ETA check
//
// Would this order get a timing baseline if it were dispatched now? A faithful
// mirror of the server's decision (functions/src/deliveryTiming.js plannedEta
// over riderTracking.routeForOrder), parity-tested in tests/deliveryTiming
// .test.js. It only WARNS before Finalize Dispatch; the server decides.

const MAX_ETA_SECONDS = 24 * 60 * 60;

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

/** Strict precision-5 decode: malformed input or any invalid point → []. */
function decodeStrict(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 200000) return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (index >= encoded.length || shift > 30) return null;
      b = encoded.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    if (!isValidCoordinate(lat / 1e5, lng / 1e5)) return [];
    points.push(lat);
  }
  return points;
}

/**
 * { ok: true, etaSeconds, source } when the order has a usable route ETA for
 * its current assignment and destination; else { ok: false, reason }.
 */
export function dispatchEtaCheck(order) {
  const onTrip = typeof order?.tripId === "string" && order.tripId !== "" && Number(order?.stopSequence ?? 0) > 0;
  const useTrip = onTrip && typeof order?.tripPolyline === "string" && order.tripPolyline !== "";
  const encoded = useTrip ? order.tripPolyline : order?.routePolyline;
  const source = useTrip ? "trip" : "order";
  if (typeof encoded !== "string" || encoded === "") return { ok: false, reason: "missing" };
  if (decodeStrict(encoded).length < 2) return { ok: false, reason: "malformed" };
  const generatedMs = millisOf(useTrip ? order.tripGeneratedAt : order.routeGeneratedAt);
  const assignedMs = millisOf(order.assignedAt);
  if (generatedMs === null || assignedMs === null || generatedMs < assignedMs) {
    return { ok: false, reason: "generated_before_assignment" };
  }
  if (useTrip) {
    const correctedMs = millisOf(order.destinationCorrectedAt);
    if (correctedMs !== null && generatedMs < correctedMs) return { ok: false, reason: "destination_changed" };
  } else if ((order.routeDestinationRevision ?? 0) !== (order.destinationRevision ?? 0)) {
    return { ok: false, reason: "destination_changed" };
  }
  const raw = useTrip ? order.stopEtaSeconds : order.routeDurationSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_ETA_SECONDS) {
    return { ok: false, reason: "invalid_eta" };
  }
  return { ok: true, etaSeconds: Math.round(raw), source };
}

/** The non-blocking Finalize Dispatch warning for a group, or null when every order has an ETA. */
export function missingEtaWarning(orders) {
  const missing = (orders || []).filter((o) => !dispatchEtaCheck(o).ok);
  if (missing.length === 0) return null;
  const n = missing.length;
  return {
    count: n,
    // What the Dispatcher reads: the order number, else where it goes.
    orderLabels: missing.map((o) => orderReference(o, orderDestination(o) || "an order without a number")),
    text: `${n} order${n === 1 ? " has" : "s have"} no valid route ETA. Automatic arrival timing will be unavailable for ${
      n === 1 ? "it" : "them"} on this dispatch. You can still dispatch; generate a route first if you want timing.`,
  };
}
