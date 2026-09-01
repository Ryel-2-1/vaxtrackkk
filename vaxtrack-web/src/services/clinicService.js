import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { validateClinicLocation } from "./clinicLocation";

const CLINICS = "clinics";

// Re-exported so pages have a single import site for clinic location work.
export {
  DEFAULT_GEOFENCE_RADIUS_M,
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
  readClinicLocation,
  validateClinicLocation,
} from "./clinicLocation";

/**
 * Turn field-keyed validation errors into one operator-facing message.
 * Carries only the validation text — never clinic document contents.
 */
function formatLocationErrors(errors) {
  const message = Object.values(errors).join(" ");
  return message || "The location could not be saved.";
}

/**
 * True when the caller supplied something in either coordinate field.
 *
 * Type-aware rather than `String(v).trim() !== ""` — that coerces `[]` to an
 * empty string, which would treat a bad value as "no location entered" and
 * silently skip validation instead of reporting it.
 */
function hasCoordinateInput(latitude, longitude) {
  const filled = (v) =>
    v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
  return filled(latitude) || filled(longitude);
}

export function subscribeClinics(callback, onError) {
  return onSnapshot(
    collection(db, CLINICS),
    (snap) => {
      const docs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const aMs = a.createdAt?.toMillis?.() ?? 0;
          const bMs = b.createdAt?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      callback(docs);
    },
    (error) => {
      console.error("subscribeClinics error:", error);
      if (onError) onError(error);
    }
  );
}

export async function clinicNameExists(name) {
  const q = query(collection(db, CLINICS), where("name", "==", name.trim()));
  const snap = await getDocs(q);
  return !snap.empty;
}

export async function addClinic({
  clinicId,
  name,
  location,
  area,
  contact,
  phone,
  email,
  deliveryNotes,
  status,
  latitude,
  longitude,
  geofenceRadiusM,
}) {
  const clinic = {
    clinicId,
    name: name.trim(),
    location: location.trim(),
    area,
    contact: contact.trim(),
    phone: phone.trim(),
    email: email.trim(),
    deliveryNotes: deliveryNotes.trim(),
    status,
    lastDelivery: "No delivery yet",
    createdAt: serverTimestamp(),
  };

  // Location is OPTIONAL at registration: a clinic with no pin is a valid
  // record and simply reads as "Needs location". But a PARTIAL or invalid
  // entry is now an error rather than being silently dropped — previously an
  // out-of-range or half-filled coordinate pair vanished without telling the
  // admin, which is how clinics ended up permanently un-pinned.
  if (hasCoordinateInput(latitude, longitude)) {
    const { ok, errors, value } = validateClinicLocation({
      latitude,
      longitude,
      geofenceRadiusM,
    });
    if (!ok) throw new Error(formatLocationErrors(errors));

    clinic.latitude = value.latitude;
    clinic.longitude = value.longitude;
    clinic.geofenceRadiusM = value.geofenceRadiusM;
    clinic.locationVerified = true;
    clinic.locationUpdatedAt = serverTimestamp();
  }

  return addDoc(collection(db, CLINICS), clinic);
}

/**
 * Update ONLY the location/geofence fields of an existing clinic.
 *
 * Scope is deliberately narrow. It writes exactly five keys, so name, contact,
 * address, area, status, delivery notes and every other field are preserved
 * untouched — editing a pin can never disturb clinic master data, inventory or
 * orders.
 *
 * Identified by the Firestore DOCUMENT ID (`clinic.firestoreId`), not the
 * human `clinicId`. The document is read first and a missing one is a hard
 * error, so a bad id can never silently create a duplicate clinic.
 * `subscribeClinics` remains the source of truth — this returns the normalized
 * values but the UI re-renders from the subscription.
 *
 * @param {string} clinicId Firestore document id
 * @param {{latitude: unknown, longitude: unknown, geofenceRadiusM?: unknown}} input
 * @returns {Promise<{latitude:number, longitude:number, geofenceRadiusM:number}>}
 */
export async function updateClinicLocation(clinicId, input = {}) {
  const id = typeof clinicId === "string" ? clinicId.trim() : "";
  if (!id) {
    throw new Error("A clinic reference is required to save a location.");
  }

  const { ok, errors, value } = validateClinicLocation(input);
  if (!ok) throw new Error(formatLocationErrors(errors));

  const ref = doc(db, CLINICS, id);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    // Guard against updateDoc-style upserts and stale rows: never create a
    // clinic from a location save.
    throw new Error("That clinic no longer exists. The location was not saved.");
  }

  await updateDoc(ref, {
    latitude: value.latitude,
    longitude: value.longitude,
    geofenceRadiusM: value.geofenceRadiusM,
    locationVerified: true,
    locationUpdatedAt: serverTimestamp(),
  });

  return value;
}
