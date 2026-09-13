export const MIN_DOCTOR_NAME_LENGTH = 2;
export const MAX_DOCTOR_NAME_LENGTH = 120;

/** Canonical comparison form used for searching and later duplicate review. */
export function normalizeDoctorName(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validate a doctor's display name without pretending that names are unique. */
export function validateDoctorName(value) {
  const name =
    typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
      : "";

  if (name.length < MIN_DOCTOR_NAME_LENGTH) {
    return {
      ok: false,
      error: `Doctor name must be at least ${MIN_DOCTOR_NAME_LENGTH} characters.`,
    };
  }
  if (name.length > MAX_DOCTOR_NAME_LENGTH) {
    return {
      ok: false,
      error: `Doctor name must be ${MAX_DOCTOR_NAME_LENGTH} characters or fewer.`,
    };
  }
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return {
      ok: false,
      error: "Doctor name must contain at least one letter or number.",
    };
  }

  return {
    ok: true,
    value: {
      name,
      nameNormalized: normalizeDoctorName(name),
    },
  };
}
