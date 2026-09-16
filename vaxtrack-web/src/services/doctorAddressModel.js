import { validateClinicLocation } from "./clinicLocation.js";

export const HOME_ADDRESS_ID = "home";
export const MIN_HOME_ADDRESS_LENGTH = 5;
export const MAX_HOME_ADDRESS_LENGTH = 200;

function cleanText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
    : "";
}

/**
 * Build the checkout choices for one doctor from live Firestore subscriptions.
 *
 * This is a display/selection guard only. The callable re-reads and validates
 * the same doctor, relationship, clinic, and area records inside the inventory
 * reservation transaction before an order can be created.
 */
export function buildDoctorDestinationOptions(addresses = [], clinics = []) {
  const clinicById = new Map(
    clinics
      .filter((clinic) => typeof clinic?.id === "string" && clinic.id.trim())
      .map((clinic) => [clinic.id, clinic])
  );

  return addresses.flatMap((destination) => {
    if (destination?.active !== true || destination.legacyIndependentAddress) {
      return [];
    }

    if (
      destination.id === HOME_ADDRESS_ID &&
      destination.homeAddress === true &&
      destination.kind === HOME_ADDRESS_ID
    ) {
      const check = validateDoctorHomeAddress(destination);
      const area = cleanText(destination.area);
      if (!check.ok || !area) return [];

      return [{
        id: HOME_ADDRESS_ID,
        type: "home",
        name: "Home / Doorstep",
        address: check.value.addressLine,
        areaId: check.value.areaId,
        area,
        latitude: check.value.latitude,
        longitude: check.value.longitude,
        geofenceRadiusM: check.value.geofenceRadiusM,
        clinicDocId: null,
      }];
    }

    if (destination.destinationType !== "clinic") return [];

    const clinicDocId =
      typeof destination.clinicDocId === "string"
        ? destination.clinicDocId.trim()
        : "";
    const clinic = clinicById.get(clinicDocId);
    const locationCheck = clinic ? validateClinicLocation(clinic) : null;
    const name = cleanText(clinic?.name);
    const address = cleanText(clinic?.location);
    const areaId =
      typeof clinic?.areaId === "string" ? clinic.areaId.trim() : "";
    const area = cleanText(clinic?.area);
    const coordinatesAreStoredNumbers =
      Number.isFinite(clinic?.latitude) && Number.isFinite(clinic?.longitude);

    if (
      !clinic ||
      clinic.locationVerified !== true ||
      !locationCheck?.ok ||
      !coordinatesAreStoredNumbers ||
      !name ||
      !address ||
      !areaId ||
      areaId.includes("/") ||
      !area
    ) {
      return [];
    }

    return [{
      id: clinicDocId,
      type: "clinic",
      name,
      address,
      areaId,
      area,
      latitude: locationCheck.value.latitude,
      longitude: locationCheck.value.longitude,
      geofenceRadiusM: locationCheck.value.geofenceRadiusM,
      clinicDocId,
    }];
  });
}

/** Validate one doctor-to-clinic delivery destination relationship. */
export function validateDoctorClinicDestination(input = {}) {
  const clinicDocId =
    typeof input.clinicDocId === "string" ? input.clinicDocId.trim() : "";
  const errors = {};

  if (
    !clinicDocId ||
    clinicDocId.includes("/") ||
    clinicDocId === HOME_ADDRESS_ID
  ) {
    errors.clinicDocId = "Select a registered clinic with a verified location.";
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok ? { clinicDocId } : null,
  };
}

// Keep the original export name for callers/tests created by the clinic-link
// checkpoint. It now names the clinic-link validator explicitly above.
export const validateDoctorAddress = validateDoctorClinicDestination;

/** Validate the doctor's one private Home / doorstep delivery destination. */
export function validateDoctorHomeAddress(input = {}) {
  const errors = {};
  const addressLine = cleanText(input.addressLine);
  const areaId = typeof input.areaId === "string" ? input.areaId.trim() : "";

  if (addressLine.length < MIN_HOME_ADDRESS_LENGTH) {
    errors.addressLine = `Home address must be at least ${MIN_HOME_ADDRESS_LENGTH} characters.`;
  } else if (addressLine.length > MAX_HOME_ADDRESS_LENGTH) {
    errors.addressLine = `Home address must be ${MAX_HOME_ADDRESS_LENGTH} characters or fewer.`;
  } else if (!/[\p{L}\p{N}]/u.test(addressLine)) {
    errors.addressLine = "Home address must contain at least one letter or number.";
  }

  if (!areaId || areaId.includes("/")) {
    errors.areaId = "Select an active area for this home address.";
  }

  const locationCheck = validateClinicLocation(input);
  Object.assign(errors, locationCheck.errors);

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value:
      ok && locationCheck.value
        ? {
            addressLine,
            areaId,
            ...locationCheck.value,
          }
        : null,
  };
}
