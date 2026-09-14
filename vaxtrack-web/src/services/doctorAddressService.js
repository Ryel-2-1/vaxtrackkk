import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
  validateClinicLocation,
} from "./clinicLocation";
import { validateDoctorAddress } from "./doctorAddressModel";

const DOCTORS = "doctors";
const ADDRESSES = "deliveryAddresses";
const CLINICS = "clinics";
const AREAS = "areas";

function stableDocumentId(value, errorMessage) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.includes("/")) throw new Error(errorMessage);
  return id;
}

export function subscribeDoctorAddresses(doctorId, callback, onError) {
  const stableDoctorId = stableDocumentId(
    doctorId,
    "That doctor could not be identified."
  );

  return onSnapshot(
    collection(db, DOCTORS, stableDoctorId, ADDRESSES),
    (snapshot) => {
      const addresses = snapshot.docs
        // A destination's document id IS the linked clinic document id. Path
        // identity is assigned last so stored fields can never redirect it.
        .map((address) => {
          const data = address.data();
          return {
            ...data,
            legacyIndependentAddress:
              typeof data.label === "string" &&
              typeof data.addressLine === "string",
            doctorId: stableDoctorId,
            clinicDocId: address.id,
            id: address.id,
          };
        })
        .sort((a, b) => {
          if (Boolean(a.active) !== Boolean(b.active)) {
            return a.active ? -1 : 1;
          }
          return String(a.clinicDocId).localeCompare(String(b.clinicDocId));
        });
      callback(addresses);
    },
    (error) => {
      console.error("subscribeDoctorAddresses error:", error);
      if (onError) onError(error);
    }
  );
}

function validText(value, minimum) {
  return typeof value === "string" && value.trim().length >= minimum;
}

async function readActiveRelationships(transaction, doctorId, clinicDocId) {
  const doctorRef = doc(db, DOCTORS, doctorId);
  const clinicRef = doc(db, CLINICS, clinicDocId);
  const [doctorSnapshot, clinicSnapshot] = await Promise.all([
    transaction.get(doctorRef),
    transaction.get(clinicRef),
  ]);

  if (!doctorSnapshot.exists() || doctorSnapshot.data().active !== true) {
    throw new Error("Destinations can only be saved for an active doctor.");
  }
  if (!clinicSnapshot.exists()) {
    throw new Error("Select an existing registered clinic.");
  }

  const clinic = clinicSnapshot.data();
  const locationCheck = validateClinicLocation(clinic);
  const coordinatesStoredAsNumbers =
    Number.isFinite(clinic.latitude) && Number.isFinite(clinic.longitude);
  const radiusIsUsable =
    !Object.prototype.hasOwnProperty.call(clinic, "geofenceRadiusM") ||
    (Number.isInteger(clinic.geofenceRadiusM) &&
      clinic.geofenceRadiusM >= MIN_GEOFENCE_RADIUS_M &&
      clinic.geofenceRadiusM <= MAX_GEOFENCE_RADIUS_M);
  if (
    clinic.locationVerified !== true ||
    !locationCheck.ok ||
    !coordinatesStoredAsNumbers ||
    !radiusIsUsable ||
    !validText(clinic.name, 2) ||
    !validText(clinic.location, 5) ||
    !validText(clinic.area, 2)
  ) {
    throw new Error(
      "Select a registered clinic with a complete, verified location."
    );
  }

  const areaId = stableDocumentId(
    clinic.areaId,
    "That clinic must belong to an active area."
  );
  if (clinic.areaId !== areaId) {
    throw new Error("That clinic must belong to an active area.");
  }
  const areaRef = doc(db, AREAS, areaId);
  const areaSnapshot = await transaction.get(areaRef);
  if (
    !areaSnapshot.exists() ||
    areaSnapshot.data().active !== true ||
    String(areaSnapshot.data().name || "").trim() !==
      String(clinic.area || "").trim()
  ) {
    throw new Error("That clinic must belong to an active area.");
  }
}

export async function addDoctorAddress(doctorId, input) {
  const stableDoctorId = stableDocumentId(
    doctorId,
    "That doctor could not be identified."
  );
  const check = validateDoctorAddress(input);
  if (!check.ok) {
    const error = new Error("Select a clinic destination before saving.");
    error.validationErrors = check.errors;
    throw error;
  }

  // The clinic document id is also the nested relationship id. This makes one
  // doctor-to-clinic destination unique without trusting a display name or a
  // duplicated stored identifier.
  const addressRef = doc(
    db,
    DOCTORS,
    stableDoctorId,
    ADDRESSES,
    check.value.clinicDocId
  );

  await runTransaction(db, async (transaction) => {
    const existingSnapshot = await transaction.get(addressRef);
    if (existingSnapshot.exists()) {
      throw new Error(
        "That clinic is already linked to this doctor. Reactivate it instead."
      );
    }

    await readActiveRelationships(
      transaction,
      stableDoctorId,
      check.value.clinicDocId
    );

    transaction.set(addressRef, {
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return addressRef;
}

export async function setDoctorAddressActive(doctorId, clinicDocId, active) {
  const stableDoctorId = stableDocumentId(
    doctorId,
    "That doctor could not be identified."
  );
  const stableClinicDocId = stableDocumentId(
    clinicDocId,
    "That clinic destination could not be identified."
  );
  if (typeof active !== "boolean") {
    throw new Error("Clinic destination status must be active or inactive.");
  }

  const addressRef = doc(
    db,
    DOCTORS,
    stableDoctorId,
    ADDRESSES,
    stableClinicDocId
  );

  await runTransaction(db, async (transaction) => {
    const addressSnapshot = await transaction.get(addressRef);
    if (!addressSnapshot.exists()) {
      throw new Error("That clinic destination no longer exists.");
    }

    // Deactivation remains possible if the doctor, clinic, location or area is
    // later retired. Reactivation must re-check every live master record.
    if (active) {
      await readActiveRelationships(
        transaction,
        stableDoctorId,
        stableClinicDocId
      );
    }

    transaction.update(addressRef, {
      active,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function removeLegacyDoctorAddress(doctorId, addressId) {
  const stableDoctorId = stableDocumentId(
    doctorId,
    "That doctor could not be identified."
  );
  const stableAddressId = stableDocumentId(
    addressId,
    "That legacy delivery address could not be identified."
  );

  // Firestore rules permit this delete only for the retired standalone-address
  // schema. Valid doctor-to-clinic relationship documents remain immutable.
  return deleteDoc(
    doc(db, DOCTORS, stableDoctorId, ADDRESSES, stableAddressId)
  );
}
