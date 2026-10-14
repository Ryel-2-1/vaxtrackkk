"use strict";

/**
 * Clinic delivery geofence — the one rule deciding whether a Rider is at the
 * delivery destination when proof is submitted and the delivery completed.
 *
 * Pure: no Firebase. Used by the preflight callable
 * (validateDeliveryCompletionGeofence) and, authoritatively, inside the
 * completion transaction (markOrderDeliveredWithInventoryConsumption).
 *
 * Inputs are ONLY server-held documents:
 *   - the order's destination snapshot (destinationLat / destinationLng /
 *     destinationGeofenceRadiusM / destinationLocationVerified, or the
 *     clinic-prefixed aliases on orders created before that contract);
 *   - riderLocations/{uid} — the Rider's latest location. The rules let only
 *     that Rider write it and stamp updatedAt with the server's request time.
 * Nothing the client sends (coordinates, distance, verdict, time, accuracy,
 * uid) is ever an input.
 *
 * This is NOT route deviation (functions/src/riderTracking.js), and the
 * route-deviation state is never read here.
 */

const { PolicyError, MIN_GEOFENCE_RADIUS_M, MAX_GEOFENCE_RADIUS_M } = require("./policy");

/** A position older than this cannot prove where the Rider is now. */
const MAX_LOCATION_AGE_MS = 3 * 60 * 1000;

/** GPS accuracy worse than this cannot place the Rider inside a geofence. */
const MAX_ACCURACY_M = 100;

const RIDER_LOCATIONS = "riderLocations";

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Stable domain codes (also mapped in index.js and the Rider app). */
const GEOFENCE_CODES = Object.freeze({
  OUTSIDE: "delivery-outside-geofence",
  STALE: "rider-location-stale",
  INACCURATE: "rider-location-inaccurate",
  UNAVAILABLE: "rider-location-unavailable",
  DESTINATION_INVALID: "delivery-destination-invalid",
});

function isValidCoordinate(lat, lng) {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Great-circle distance in metres between two { lat, lng } points. */
function haversineMeters(a, b) {
  let dLng = b.lng - a.lng;
  while (dLng > 180) dLng -= 360;
  while (dLng < -180) dLng += 360;
  const dLat = (b.lat - a.lat) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin((dLng * DEG) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Epoch millis from a Firestore Timestamp / Date / number; else null. */
function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);

/**
 * The order's authoritative destination, or null when it is missing or
 * invalid. The canonical destination* fields win whenever any is present;
 * the clinic* aliases are read only for orders that never had them. Nothing
 * is defaulted: no fallback coordinates, no assumed radius.
 */
function normalizeOrderDestination(order) {
  const canonical = ["destinationLat", "destinationLng", "destinationGeofenceRadiusM", "destinationLocationVerified"]
    .some((k) => has(order, k));
  const lat = canonical ? order?.destinationLat : order?.clinicLat;
  const lng = canonical ? order?.destinationLng : order?.clinicLng;
  const radiusM = canonical ? order?.destinationGeofenceRadiusM : order?.clinicGeofenceRadiusM;
  const verified = canonical ? order?.destinationLocationVerified : order?.clinicLocationVerified;
  if (verified !== true) return null;
  if (!isValidCoordinate(lat, lng)) return null;
  if (!Number.isInteger(radiusM) || radiusM < MIN_GEOFENCE_RADIUS_M || radiusM > MAX_GEOFENCE_RADIUS_M) return null;
  return { lat, lng, radiusM };
}

/**
 * The Rider's latest trusted position, or { problem } explaining why it cannot
 * be used. Age is measured from the EARLIER of the capture time and the
 * server's write time, so neither a phone clock running ahead nor a late
 * upload of an old fix can make it look fresh.
 */
function trustedRiderPosition(location, { uid, nowMs }) {
  if (!location || location.trackingState !== "active" || (has(location, "riderUid") && location.riderUid !== uid)) {
    return { problem: GEOFENCE_CODES.UNAVAILABLE };
  }
  if (!isValidCoordinate(location.latitude, location.longitude)) return { problem: GEOFENCE_CODES.UNAVAILABLE };
  const captured = millisOf(location.capturedAt);
  const written = millisOf(location.updatedAt);
  if (captured === null || written === null) return { problem: GEOFENCE_CODES.STALE };
  const ageMs = Math.max(0, nowMs - Math.min(captured, written));
  if (ageMs > MAX_LOCATION_AGE_MS) return { problem: GEOFENCE_CODES.STALE, ageMs };
  const accuracyM = location.accuracyMeters;
  if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > MAX_ACCURACY_M) {
    return { problem: GEOFENCE_CODES.INACCURATE, ageMs };
  }
  return { lat: location.latitude, lng: location.longitude, accuracyM, ageMs };
}

const MESSAGES = Object.freeze({
  [GEOFENCE_CODES.STALE]: "Your location is out of date. Wait for VaxTrack to refresh your location, then try again.",
  [GEOFENCE_CODES.INACCURATE]:
    "Your GPS accuracy is too low to confirm that you are at the clinic. Move to an open area and try again.",
  [GEOFENCE_CODES.UNAVAILABLE]: "Location sharing must be active before completing this delivery.",
  [GEOFENCE_CODES.DESTINATION_INVALID]: "This order's clinic location is not configured correctly. Contact the Dispatcher.",
});

/** Rounded for display only; never used for the decision. */
const shownDistance = (d) => Math.ceil(d);

/**
 * Decide whether the Rider is inside the order's delivery geofence. Returns
 * the safe summary or throws a PolicyError with a stable code. Inside means
 * distance <= radius, using unrounded metres; GPS accuracy is never added to
 * the radius (that would silently enlarge the geofence).
 *
 * Assignment and status are checked by the callers, which already hold the
 * order; this only decides the location question.
 */
function evaluateDeliveryGeofence({ order, location, uid, nowMs }) {
  const destination = normalizeOrderDestination(order);
  if (!destination) {
    throw new PolicyError(GEOFENCE_CODES.DESTINATION_INVALID, MESSAGES[GEOFENCE_CODES.DESTINATION_INVALID]);
  }
  const rider = trustedRiderPosition(location, { uid, nowMs });
  if (rider.problem) throw new PolicyError(rider.problem, MESSAGES[rider.problem]);
  const distanceM = haversineMeters({ lat: rider.lat, lng: rider.lng }, destination);
  const summary = {
    distanceM: shownDistance(distanceM),
    radiusM: destination.radiusM,
    locationAgeSeconds: Math.floor(rider.ageMs / 1000),
    accuracyM: Math.round(rider.accuracyM),
  };
  if (!(distanceM <= destination.radiusM)) {
    throw new PolicyError(
      GEOFENCE_CODES.OUTSIDE,
      `You are ${summary.distanceM} m from the clinic. Move within the ${destination.radiusM} m delivery area before submitting.`,
      { distanceM: summary.distanceM, radiusM: destination.radiusM },
    );
  }
  return { eligible: true, ...summary };
}

module.exports = {
  MAX_LOCATION_AGE_MS,
  MAX_ACCURACY_M,
  RIDER_LOCATIONS,
  GEOFENCE_CODES,
  haversineMeters,
  normalizeOrderDestination,
  trustedRiderPosition,
  evaluateDeliveryGeofence,
};
