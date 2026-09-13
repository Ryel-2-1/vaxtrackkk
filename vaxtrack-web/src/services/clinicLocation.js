// Pure clinic location + geofence rules. No Firebase import, so this module can
// be unit-tested directly with `node --test` (same split as invoiceModel.js vs
// invoiceService.js).
//
// CANONICAL COORDINATE REPRESENTATION
// -----------------------------------
// A clinic's coordinates are the two top-level NUMBER fields on the clinic
// document: `latitude` and `longitude`. That is what `addClinic` has always
// written and what `SalesRepPlaceOrder` reads when copying `clinicLat`/
// `clinicLng` onto a new order. This module does not introduce a GeoPoint, a
// `coordinates` object, or a `clinicLocation` field — one representation only.
//
// Note `clinic.location` is the human-readable ADDRESS STRING ("Street, City"),
// not a coordinate. It is unrelated to the fields here and is never written by
// the location update.

export const DEFAULT_GEOFENCE_RADIUS_M = 300;
export const MIN_GEOFENCE_RADIUS_M = 50;
export const MAX_GEOFENCE_RADIUS_M = 1000;

/**
 * Strict numeric coercion.
 *
 * Accepts a finite number, or a non-empty numeric string (form inputs always
 * hand back strings). Rejects everything else — empty string, whitespace,
 * non-numeric text, null, undefined, booleans, objects, NaN and Infinity — so
 * an invalid value can never be silently coerced into a stored coordinate.
 * `Number("")` is 0, which is a real coordinate, so the empty case is rejected
 * explicitly before conversion.
 *
 * @returns {number|null} the finite number, or null when the input is not one.
 */
export function toFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Validate and normalize a clinic location edit.
 *
 * @param {{latitude?: unknown, longitude?: unknown, geofenceRadiusM?: unknown}} input
 * @returns {{ok: boolean, errors: Record<string,string>, value: {latitude:number, longitude:number, geofenceRadiusM:number}|null}}
 *
 * An omitted/blank radius falls back to DEFAULT_GEOFENCE_RADIUS_M. Coordinates
 * have no default: a clinic without them stays without them.
 */
export function validateClinicLocation(input = {}) {
  const errors = {};

  const latitude = toFiniteNumber(input.latitude);
  const longitude = toFiniteNumber(input.longitude);

  if (latitude === null) {
    errors.latitude = "Enter a latitude between -90 and 90.";
  } else if (latitude < -90 || latitude > 90) {
    errors.latitude = "Latitude must be between -90 and 90.";
  }

  if (longitude === null) {
    errors.longitude = "Enter a longitude between -180 and 180.";
  } else if (longitude < -180 || longitude > 180) {
    errors.longitude = "Longitude must be between -180 and 180.";
  }

  // Radius is REJECTED when out of range — never clamped. Silently snapping
  // 5000 to 1000 would change the service area the admin chose without telling
  // them. The range check runs on the ORIGINAL finite number, so 49.9 and
  // 1000.1 are errors; rounding happens only after the value is known valid.
  //
  // A blank radius means "use the default", not "invalid".
  // "Blank" means genuinely absent: undefined, null, or an empty/whitespace
  // STRING. It is deliberately not `String(v).trim() === ""`, because that
  // coerces `[]` to "" and would hand an array the 300 m default instead of
  // rejecting it. Any other value counts as provided and must parse.
  const rawRadius = input.geofenceRadiusM;
  const radiusProvided =
    rawRadius !== undefined &&
    rawRadius !== null &&
    !(typeof rawRadius === "string" && rawRadius.trim() === "");

  let geofenceRadiusM = DEFAULT_GEOFENCE_RADIUS_M;
  if (radiusProvided) {
    const parsed = toFiniteNumber(rawRadius);
    if (parsed === null) {
      errors.geofenceRadiusM = `Enter a radius between ${MIN_GEOFENCE_RADIUS_M} and ${MAX_GEOFENCE_RADIUS_M} metres.`;
    } else if (
      parsed < MIN_GEOFENCE_RADIUS_M ||
      parsed > MAX_GEOFENCE_RADIUS_M
    ) {
      errors.geofenceRadiusM = `Radius must be between ${MIN_GEOFENCE_RADIUS_M} and ${MAX_GEOFENCE_RADIUS_M} metres.`;
    } else {
      geofenceRadiusM = Math.round(parsed);
    }
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    // A location is only ever verified together with valid coordinates — there
    // is no path here that returns a value without both.
    value: ok ? { latitude, longitude, geofenceRadiusM } : null,
  };
}

/**
 * Backward-compatible read of a clinic document's location.
 *
 * Existing clinics predate `geofenceRadiusM` and `locationVerified`:
 *  - a missing radius reads as the 300 m default;
 *  - `hasCoordinates` is the single source of the UI's verified / needs-location
 *    state, so clinics saved before the flag existed still read correctly.
 *
 * This never invents coordinates: a clinic without them reports
 * `hasCoordinates: false` and null lat/lng.
 */
export function readClinicLocation(clinic = {}) {
  const latitude = toFiniteNumber(clinic.latitude);
  const longitude = toFiniteNumber(clinic.longitude);
  const inRange =
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  const storedRadius = toFiniteNumber(clinic.geofenceRadiusM);
  const geofenceRadiusM =
    storedRadius !== null &&
    storedRadius >= MIN_GEOFENCE_RADIUS_M &&
    storedRadius <= MAX_GEOFENCE_RADIUS_M
      ? Math.round(storedRadius)
      : DEFAULT_GEOFENCE_RADIUS_M;

  return {
    hasCoordinates: inRange,
    latitude: inRange ? latitude : null,
    longitude: inRange ? longitude : null,
    // Effective radius for CONSUMERS: always a usable number.
    geofenceRadiusM,
    // Raw stored radius (null when absent or non-numeric). The editor seeds
    // from this so an out-of-range stored value is shown to the admin and
    // rejected on save, rather than silently displayed as the default.
    geofenceRadiusMStored: storedRadius,
    // Explicit provenance flag written on save. Never used to claim a clinic
    // WITHOUT coordinates is verified.
    locationVerified: inRange && clinic.locationVerified === true,
  };
}
