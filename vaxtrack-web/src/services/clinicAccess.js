/**
 * Clinic access — who can order for a clinic, seen FROM the clinic. Pure (no
 * Firebase), so the rules below are unit-tested and shared by the Register
 * Clinic form, the Manage access dialog and the clinic list.
 *
 * A clinic is orderable when BOTH hold (the server enforces the same at order
 * creation — functions/src/policy.js; the web copy is services/territory.js):
 *   - a Med Rep's territory includes the clinic AND the clinic's area;
 *   - a doctor has the clinic as an ACTIVE delivery address
 *     (doctors/{doctorId}/deliveryAddresses/{clinicDocId}).
 *
 * Nothing here writes. The writes go through the existing, transactional
 * services — updateMedRepTerritory and the doctor address service — so the
 * checks are exactly those of the Territory dialog and Delivery addresses.
 */
import { MAX_ASSIGNED_CLINICS, openOrdersLosingTerritory, readTerritory, uniqueIds } from "./territory.js";

export const MED_REP_ROLE = "salesrep";

/** Approved Med Reps from the users list, by name. */
export function approvedMedReps(users) {
  return (users || [])
    .filter((u) => String(u?.role || "").trim().toLowerCase() === MED_REP_ROLE && u?.status === "approved")
    // The document id is the uid; a stored `uid` field is never trusted (subscribeUsers puts `id` last for this).
    .map((u) => ({ ...u, uid: u.id }))
    .filter((u) => typeof u.uid === "string" && u.uid)
    .sort((a, b) => medRepName(a).localeCompare(medRepName(b)));
}

export function medRepName(user) {
  return user?.fullName || user?.name || user?.displayName || user?.email || "Med Rep";
}

/** Does this Med Rep's territory reach the clinic (clinic AND its area)? */
export function medRepReachesClinic(user, clinic) {
  const t = readTerritory(user);
  return Boolean(clinic?.id && clinic?.areaId) && t.areaIds.includes(clinic.areaId) && t.clinicIds.includes(clinic.id);
}

/** Does this Med Rep already cover the clinic's area (so ticking adds only the clinic)? */
export function medRepCoversArea(user, areaId) {
  return Boolean(areaId) && readTerritory(user).areaIds.includes(areaId);
}

/** The territory with this clinic added — and its area, when missing. */
export function territoryWithClinic(user, clinic) {
  const t = readTerritory(user);
  return {
    areaIds: uniqueIds([...t.areaIds, clinic.areaId]),
    clinicIds: uniqueIds([...t.clinicIds, clinic.id]),
  };
}

/** The territory without this clinic. The area stays: other clinics and home visits may use it. */
export function territoryWithoutClinic(user, clinic) {
  const t = readTerritory(user);
  return { areaIds: t.areaIds, clinicIds: t.clinicIds.filter((id) => id !== clinic.id) };
}

/**
 * Who reaches a clinic now.
 * @param {object} clinic  { id (document id), areaId }
 * @param {Array} medReps  approvedMedReps(...)
 * @param {Map<string, Set<string>>} activeLinks  doctorId → active clinic ids (activeDoctorLinks)
 * @param {Array} doctors  [{ id, name, active }]
 */
export function clinicReach(clinic, medReps, activeLinks, doctors = []) {
  const reps = (medReps || []).filter((u) => medRepReachesClinic(u, clinic));
  const activeDoctorIds = new Set((doctors || []).filter((d) => d?.active === true).map((d) => d.id));
  const doctorIds = [];
  for (const [doctorId, clinicIds] of activeLinks || []) {
    if (activeDoctorIds.has(doctorId) && clinicIds.has(clinic.id)) doctorIds.push(doctorId);
  }
  return {
    medRepUids: reps.map((u) => u.uid),
    doctorIds,
    orderable: reps.length > 0 && doctorIds.length > 0,
  };
}

/** "2 Med Reps · 1 doctor" / "Not orderable yet — …" for the clinic list. */
export function reachLabel(reach) {
  const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const counts = `${plural(reach.medRepUids.length, "Med Rep")} · ${plural(reach.doctorIds.length, "doctor")}`;
  if (reach.orderable) return { tone: "ok", text: counts };
  const missing = [
    reach.medRepUids.length === 0 ? "no Med Rep" : null,
    reach.doctorIds.length === 0 ? "no doctor" : null,
  ].filter(Boolean).join(" or ");
  return { tone: "warn", text: `Not orderable yet — ${missing} linked` };
}

/**
 * doctorId → Set of ACTIVE linked clinic ids, from each doctor's addresses
 * (subscribeDoctorAddresses rows: destinationType "clinic", id = clinic id).
 */
export function activeDoctorLinks(addressesByDoctor) {
  const out = new Map();
  for (const [doctorId, rows] of Object.entries(addressesByDoctor || {})) {
    const ids = new Set();
    for (const row of rows || []) {
      if (row?.destinationType === "clinic" && row.active === true && typeof row.id === "string") ids.add(row.id);
    }
    out.set(doctorId, ids);
  }
  return out;
}

/**
 * The changes to make, from what is ticked now versus what is stored.
 *
 * @returns {{
 *   repAdds: Array<{uid, name, territory, addsArea: boolean}>,
 *   repRemovals: Array<{uid, name, territory, losingOrders: Array}>,
 *   doctorLinks: Array<{doctorId, name, action: "add"|"reactivate"}>,
 *   doctorUnlinks: Array<{doctorId, name}>,
 *   blocked: string[],     // reasons nothing can be linked yet
 *   empty: boolean,
 * }}
 */
export function planClinicAccess({ clinic, medReps, selectedRepUids, doctors, addressesByDoctor, selectedDoctorIds, orders = [] }) {
  const wantedReps = new Set(selectedRepUids || []);
  const wantedDoctors = new Set(selectedDoctorIds || []);
  const blocked = [];
  if (!clinic?.id) blocked.push("Save the clinic first.");
  if (!clinic?.areaId) blocked.push("Give the clinic an area first.");
  if (clinic && clinic.locationVerified !== true) {
    blocked.push("Place and save the clinic's map pin first: Med Reps and doctors can only be linked to a clinic with a verified location.");
  }

  const repAdds = [];
  const repRemovals = [];
  for (const user of medReps || []) {
    const reaches = medRepReachesClinic(user, clinic);
    if (wantedReps.has(user.uid) && !reaches) {
      const territory = territoryWithClinic(user, clinic);
      const before = readTerritory(user);
      const clinicLimitReached = territory.clinicIds.length > MAX_ASSIGNED_CLINICS;
      if (clinicLimitReached) blocked.push(`${medRepName(user)} already has the maximum of ${MAX_ASSIGNED_CLINICS} clinics.`);
      repAdds.push({ uid: user.uid, name: medRepName(user), territory, addsArea: !before.areaIds.includes(clinic.areaId) });
    } else if (!wantedReps.has(user.uid) && reaches) {
      const territory = territoryWithoutClinic(user, clinic);
      repRemovals.push({
        uid: user.uid,
        name: medRepName(user),
        territory,
        losingOrders: openOrdersLosingTerritory(orders, user.uid, territory),
      });
    }
  }

  const doctorLinks = [];
  const doctorUnlinks = [];
  for (const doctor of doctors || []) {
    const row = (addressesByDoctor?.[doctor.id] || []).find((a) => a?.destinationType === "clinic" && a.id === clinic?.id);
    const active = row?.active === true;
    if (wantedDoctors.has(doctor.id) && !active) {
      if (doctor.active !== true) continue; // an inactive doctor is never newly linked
      doctorLinks.push({ doctorId: doctor.id, name: doctor.name || "Doctor", action: row ? "reactivate" : "add" });
    } else if (!wantedDoctors.has(doctor.id) && active) {
      doctorUnlinks.push({ doctorId: doctor.id, name: doctor.name || "Doctor" });
    }
  }

  const empty = !repAdds.length && !repRemovals.length && !doctorLinks.length && !doctorUnlinks.length;
  // Removing is always possible; only ADDING needs a complete, verified clinic.
  const addBlocked = repAdds.length > 0 || doctorLinks.length > 0 ? blocked : [];
  return { repAdds, repRemovals, doctorLinks, doctorUnlinks, blocked: addBlocked, empty };
}

/** The selections a dialog starts from: who reaches the clinic now. */
export function currentSelections(clinic, medReps, addressesByDoctor, doctors) {
  const reach = clinicReach(clinic, medReps, activeDoctorLinks(addressesByDoctor), doctors);
  // Include inactive doctors that still hold an active link, so unticking them is possible.
  const linkedDoctorIds = (doctors || [])
    .filter((d) => (addressesByDoctor?.[d.id] || []).some((a) => a?.destinationType === "clinic" && a.id === clinic.id && a.active === true))
    .map((d) => d.id);
  return { repUids: reach.medRepUids, doctorIds: uniqueIds(linkedDoctorIds) };
}
