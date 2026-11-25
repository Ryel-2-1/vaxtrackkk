import { validateClientId } from "./clientId.js";
import { validateDoctorName } from "./doctorModel.js";

export const CLINIC_DETAIL_LABELS = {
  clinicId: "Client ID",
  name: "Clinic name",
  contact: "Doctor (contact person)",
  phone: "Phone number",
  email: "Email",
  location: "Street address",
  areaId: "Area",
  status: "Status",
  deliveryNotes: "Delivery notes",
};

export const CLINIC_STATUS_LABELS = { active: "Active", pending: "Pending Resupply", overdue: "Overdue" };

export const limitClinicPhone = (text) => text.replace(/\D/g, "").slice(0, 11);

/** Actual stored values, without the display fallbacks used by the directory. */
export function clinicDetailsDraft(clinic) {
  return Object.fromEntries(Object.keys(CLINIC_DETAIL_LABELS).map((key) => [
    key, typeof clinic?.[key] === "string" ? clinic[key] : "",
  ]));
}

/** Validate only edits so an old, incomplete record can be repaired field by field. */
export function clinicDetailsPatch(draft, expected) {
  const patch = {};
  const errors = {};
  for (const key of Object.keys(CLINIC_DETAIL_LABELS)) {
    const before = expected?.[key];
    const entered = draft?.[key];
    if (typeof entered !== "string" || entered === before) continue;
    const value = entered.trim();
    if (value === before) continue;
    switch (key) {
      case "clinicId": {
        const result = validateClientId(value);
        if (!result.ok) errors[key] = result.error;
        else if (result.value !== before) patch[key] = result.value;
        continue;
      }
      case "contact": {
        const result = validateDoctorName(value);
        if (!result.ok) errors[key] = result.error;
        else if (result.value.name !== before) patch[key] = result.value.name;
        continue;
      }
      case "name":
        if (value.length < 2) errors[key] = "Enter a clinic name with at least 2 characters.";
        break;
      case "phone":
        if (!/^[0-9]{1,11}$/.test(value)) errors[key] = "Enter a phone number with up to 11 digits.";
        break;
      case "email":
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[key] = "Enter a valid email address.";
        break;
      case "location":
        if (value.length < 5) errors[key] = "Enter a clinic address with at least 5 characters.";
        break;
      case "areaId":
        if (value.length < 2 || value.length > 960 || value.includes("/")) errors[key] = "Select an active area for this clinic.";
        break;
      case "status":
        if (!Object.hasOwn(CLINIC_STATUS_LABELS, value)) errors[key] = "Select a clinic status.";
        break;
    }
    if (!errors[key]) patch[key] = value;
  }
  return { patch, errors };
}
