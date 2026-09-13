import {
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
  readClinicLocation,
  // Explicit .js extension: this module is exercised by `node --test` directly
  // (no bundler in that path), and Node's ESM resolver does not guess it.
} from "./clinicLocation.js";

/**
 * Order-time snapshot of a clinic's verified delivery location.
 *
 * WHY A SNAPSHOT AT ALL: an order's destination is a fact about that order at
 * the moment it was placed. If a clinic is later re-pinned, historical orders
 * must keep the location they were dispatched against — reading the clinic live
 * would silently rewrite where a completed delivery was supposed to go.
 *
 * WHY THIS MODULE IS PURE: no Firestore import, so the mapping and its
 * eligibility rules are testable without mocks. The two server-generated values
 * (`clinicLocationSnapshotAt`, and Firestore's own document id) are supplied by
 * the caller rather than invented here.
 *
 * TRUST BOUNDARY: everything except the document id is derived from the clinic
 * record ALONE. Callers cannot pass coordinates, a radius or a verification
 * flag alongside it — see `buildClinicLocationSnapshot`. Firestore rules
 * re-verify the result against the real clinic document, so a forged clinic
 * object client-side still cannot place a false destination on an order.
 */

/** Latitude/longitude bounds — the same ones Admin clinic validation applies. */
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

/** A non-empty trimmed string, or null. Never coerces objects/arrays. */
function toIdString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Was a radius actually supplied on the clinic record?
 *
 * Distinguishes "absent" (inherit the 300 m default) from "present but
 * unusable" (reject). Type-aware on purpose: `String(v).trim() !== ""` would
 * read `[]` as absent and hand a corrupt value the default, which is the same
 * bug `clinicLocation.hasCoordinateInput` guards against.
 */
function radiusWasSupplied(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.trim() !== "";
  return true;
}

/**
 * Build the clinic-location fields for a new order.
 *
 * @param {string} clinicDocId  Firestore DOCUMENT id of the clinic. Authoritative
 *   and required. This is `clinic.id` as produced by `subscribeClinics`
 *   (`{ ...d.data(), id: d.id }` — id last, so stored data cannot shadow it) —
 *   NOT the business `clinicId`, and never derived from a name or address.
 * @param {object} clinicRecord The selected clinic's raw Firestore data. Only
 *   `clinicId`, `latitude`, `longitude`, `geofenceRadiusM`, `locationVerified`
 *   and `locationUpdatedAt` are read; nothing else is copied onto the order.
 * @returns {{fields: object, eligible: boolean, reason: string|null}}
 *   `fields` never includes `clinicLocationSnapshotAt` — that is a
 *   `serverTimestamp()` sentinel and belongs to the writing service.
 */
export function buildClinicLocationSnapshot(clinicDocId, clinicRecord = {}) {
  const docId = toIdString(clinicDocId);
  if (!docId) {
    // A programming error, not a user error: every order must carry a stable
    // reference to the clinic it is going to. Failing loudly here is what stops
    // the previous silent-drop bug from recurring in a new form.
    throw new Error("A clinic document id is required to create an order.");
  }

  const record =
    clinicRecord && typeof clinicRecord === "object" ? clinicRecord : {};

  const fields = { clinicDocId: docId };

  // Business/display id is a SEPARATE identifier. It is copied only when the
  // clinic genuinely has one — never defaulted to the document id, and never
  // derived from the clinic name or address. Clinics registered before the id
  // existed simply omit it.
  const businessId = toIdString(record.clinicId);
  if (businessId) {
    fields.clinicId = businessId;
  }

  // Coordinates + effective radius come from the SAME reader Admin uses, so the
  // 300 m default and the range checks cannot drift between the two surfaces.
  const location = readClinicLocation(record);

  const latOk =
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    location.latitude >= LAT_MIN &&
    location.latitude <= LAT_MAX;
  const lngOk =
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude) &&
    location.longitude >= LNG_MIN &&
    location.longitude <= LNG_MAX;

  // A radius that was never stored inherits the validated 300 m default. One
  // that WAS stored but is unusable makes the snapshot ineligible rather than
  // quietly becoming 300 — an order must not claim a geofence the admin did
  // not configure.
  const suppliedRadius = radiusWasSupplied(record.geofenceRadiusM);
  const storedRadius = location.geofenceRadiusMStored;
  const radiusOk =
    !suppliedRadius ||
    (storedRadius !== null &&
      storedRadius >= MIN_GEOFENCE_RADIUS_M &&
      storedRadius <= MAX_GEOFENCE_RADIUS_M);

  // `readClinicLocation` never reports verified without in-range coordinates,
  // so this inherits that guarantee instead of re-deriving it.
  const verified = location.locationVerified === true;

  let reason = null;
  if (!verified) reason = "clinic-location-not-verified";
  else if (!latOk || !lngOk) reason = "coordinates-out-of-range";
  else if (!radiusOk) reason = "radius-out-of-range";

  const eligible = reason === null;

  if (!eligible) {
    // No coordinates, no radius, no source timestamp. Never 0,0; never a
    // placeholder; never an implied 300 m geofence. The order is still created
    // and still references its clinic — it is simply not geofence-eligible.
    fields.clinicLocationVerified = false;
    return { fields, eligible: false, reason };
  }

  fields.clinicLat = location.latitude;
  fields.clinicLng = location.longitude;
  fields.clinicGeofenceRadiusM = location.geofenceRadiusM;
  fields.clinicLocationVerified = true;

  // Source provenance: when the clinic pin itself was last saved. Passed
  // through as the stored value (a Firestore Timestamp) rather than
  // reconstructed, and only when the clinic actually has one.
  if (record.locationUpdatedAt !== undefined && record.locationUpdatedAt !== null) {
    fields.clinicLocationUpdatedAt = record.locationUpdatedAt;
  }

  return { fields, eligible: true, reason: null };
}
