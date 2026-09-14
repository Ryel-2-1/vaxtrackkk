import { validateClinicLocation } from "./clinicLocation.js";

export const HOME_ADDRESS_ID = "home";
export const MIN_HOME_ADDRESS_LENGTH = 5;
export const MAX_HOME_ADDRESS_LENGTH = 200;

function cleanText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
    : "";
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
