/**
 * Med Rep territory — pure rules, no Firebase import, so they run under
 * `node --test` and stay identical wherever they are used.
 *
 * Stored on the Med Rep's own `users/{uid}` document (role `salesrep`), written
 * only by an Admin:
 *
 *   assignedAreaIds    string[]  area document ids
 *   assignedClinicIds  string[]  clinic document ids, each inside an assigned area
 *
 * What a territory permits (the server enforces the same rule in
 * functions/src/policy.js — this copy only shapes the UI):
 *
 *   - a doctor's HOME destination when its area is assigned;
 *   - a CLINIC destination when that clinic is assigned AND the clinic's area
 *     is assigned. Assigning an area alone does not open every clinic in it —
 *     clinics are chosen explicitly.
 *
 * No assigned area means no territory: nothing is permitted.
 */

import { buildDoctorDestinationOptions } from "./doctorAddressModel.js";

export const TERRITORY_FIELDS = Object.freeze([
  "assignedAreaIds",
  "assignedClinicIds",
  "territoryUpdatedAt",
  "territoryUpdatedByUid",
]);

/** Upper bounds, mirrored by the Firestore rules. */
export const MAX_ASSIGNED_AREAS = 50;
export const MAX_ASSIGNED_CLINICS = 200;

export const NO_TERRITORY_MESSAGE =
  "No territory has been assigned to your account. Contact an administrator.";

/** Statuses after which an order no longer travels anywhere. */
const CLOSED_ORDER_STATUSES = new Set(["delivered", "completed", "cancelled", "canceled"]);

function cleanId(value) {
  return typeof value === "string" && value.trim() && !value.includes("/") ? value.trim() : "";
}

/** De-duplicated, trimmed ids; anything that is not a usable id is dropped. */
export function uniqueIds(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const id = cleanId(v);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The territory stored on a user document (or `null`). */
export function readTerritory(profile) {
  const areaIds = uniqueIds(profile?.assignedAreaIds);
  const clinicIds = uniqueIds(profile?.assignedClinicIds);
  return { areaIds, clinicIds, assigned: areaIds.length > 0 };
}

/**
 * Is one destination option (as built by buildDoctorDestinationOptions) inside
 * the territory? Options carry `type`, `areaId` and, for clinics, `clinicDocId`.
 */
export function isDestinationPermitted(option, territory) {
  if (!option || !territory?.assigned) return false;
  const areaId = cleanId(option.areaId);
  if (!areaId || !territory.areaIds.includes(areaId)) return false;
  if (option.type === "home") return true;
  if (option.type === "clinic") {
    const clinicId = cleanId(option.clinicDocId) || cleanId(option.id);
    return Boolean(clinicId) && territory.clinicIds.includes(clinicId);
  }
  return false;
}

export function filterDestinationsToTerritory(options, territory) {
  return (Array.isArray(options) ? options : []).filter((o) => isDestinationPermitted(o, territory));
}

/**
 * Validate an Admin's proposed assignment against the loaded areas and clinics.
 *
 * Returns { ok, value: { areaIds, clinicIds }, errors[] }. Duplicates are
 * normalised away. Newly added areas must exist and be active; newly added
 * clinics must exist, have a verified location and belong to a selected area.
 * An area or clinic that was ALREADY assigned and has since been deactivated
 * may stay (removing it is the Admin's choice), but a clinic must always sit
 * inside one of the selected areas, and a deleted record can never stay.
 */
export function validateTerritoryAssignment({ areaIds, clinicIds, areas = [], clinics = [], previous = null }) {
  const errors = [];
  const nextAreas = uniqueIds(areaIds);
  const nextClinics = uniqueIds(clinicIds);
  const before = readTerritory(previous);
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const clinicById = new Map(clinics.map((c) => [c.id, c]));

  if (nextAreas.length > MAX_ASSIGNED_AREAS) errors.push(`Assign at most ${MAX_ASSIGNED_AREAS} areas.`);
  if (nextClinics.length > MAX_ASSIGNED_CLINICS) errors.push(`Assign at most ${MAX_ASSIGNED_CLINICS} clinics.`);

  for (const id of nextAreas) {
    const area = areaById.get(id);
    if (!area) errors.push(`Area ${id} no longer exists.`);
    else if (area.active !== true && !before.areaIds.includes(id)) {
      errors.push(`${area.name || id} is inactive and cannot be newly assigned.`);
    }
  }
  for (const id of nextClinics) {
    const clinic = clinicById.get(id);
    if (!clinic) {
      errors.push(`Clinic ${id} no longer exists.`);
      continue;
    }
    if (!nextAreas.includes(clinic.areaId)) {
      errors.push(`${clinic.name || id} is not inside a selected area.`);
    } else if (clinic.locationVerified !== true && !before.clinicIds.includes(id)) {
      errors.push(`${clinic.name || id} has no verified location and cannot be newly assigned.`);
    }
  }
  return { ok: errors.length === 0, value: { areaIds: nextAreas, clinicIds: nextClinics }, errors };
}

/** Clinics that fall out when their area is no longer selected. */
export function clinicsOutsideAreas(clinicIds, areaIds, clinics) {
  const areas = new Set(uniqueIds(areaIds));
  const byId = new Map((clinics || []).map((c) => [c.id, c]));
  return uniqueIds(clinicIds).filter((id) => !areas.has(byId.get(id)?.areaId));
}

/**
 * Open orders this Med Rep placed whose destination the proposed territory
 * would no longer permit. Used only to WARN the Admin — removing an assignment
 * never rewrites an existing order.
 */
export function openOrdersLosingTerritory(orders, medRepUid, nextTerritory) {
  const t = { areaIds: uniqueIds(nextTerritory?.areaIds), clinicIds: uniqueIds(nextTerritory?.clinicIds) };
  t.assigned = t.areaIds.length > 0;
  return (orders || []).filter((o) => {
    if (o?.createdByUid !== medRepUid) return false;
    const status = String(o.status || "").trim().toLowerCase();
    if (CLOSED_ORDER_STATUSES.has(status)) return false;
    const option = {
      type: o.destinationType === "home" ? "home" : "clinic",
      areaId: o.destinationAreaId,
      clinicDocId: o.clinicDocId,
    };
    // Orders created before destinations were snapshotted carry no area; they
    // are not claimed to be affected.
    if (!cleanId(option.areaId)) return false;
    return !isDestinationPermitted(option, t);
  });
}

/**
 * Whether the Staff Directory offers "Manage territory" for a row: a Med Rep
 * (stored role exactly `salesrep`, as the Firestore rule requires) who is
 * Active or Inactive. Pending and Rejected applicants, and every other role,
 * get no territory controls.
 */
export function canManageTerritory(person) {
  const role = String(person?.rawRole || "").trim().toLowerCase();
  return role === "salesrep" && (person?.status === "active" || person?.status === "inactive");
}

/** One doctor's orderable destinations: active, valid, and inside the territory. */
export function territoryDestinationOptions(addresses, clinics, territory) {
  return filterDestinationsToTerritory(buildDoctorDestinationOptions(addresses || [], clinics || []), territory);
}

/**
 * The doctors a Med Rep may order for: active, and with at least one permitted
 * active destination. `addressesByDoctor` maps doctor id → that doctor's
 * deliveryAddresses documents. No territory → no doctors.
 */
export function permittedDoctors(doctors, addressesByDoctor, clinics, territory) {
  if (!territory?.assigned) return [];
  return (doctors || []).filter(
    (doctor) =>
      doctor?.active === true &&
      territoryDestinationOptions(addressesByDoctor?.[doctor.id], clinics, territory).length > 0
  );
}
