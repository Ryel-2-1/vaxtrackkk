/** Validate one doctor-to-clinic delivery destination relationship. */
export function validateDoctorAddress(input = {}) {
  const clinicDocId =
    typeof input.clinicDocId === "string" ? input.clinicDocId.trim() : "";
  const errors = {};

  if (!clinicDocId || clinicDocId.includes("/")) {
    errors.clinicDocId = "Select a registered clinic with a verified location.";
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok ? { clinicDocId } : null,
  };
}
