"use strict";
/**
 * The delivery addresses a Med Rep may order to — and nothing else.
 *
 * A doctor's addresses live under doctors/{doctorId}/deliveryAddresses: the
 * private Home ("home": street address and coordinates) and one link per
 * clinic. Firestore rules let only Admin and Dispatcher read them directly
 * (audit finding 2: every approved account could read every Home). A Med Rep
 * gets them here instead, filtered by the same territory rule order creation
 * enforces (policy.linkWithinTerritory): a Home only when its area is
 * assigned, a clinic link only when that clinic is assigned. Read-only.
 */
const { PolicyError, HOME_ADDRESS_ID, territoryOf, linkWithinTerritory } = require("./policy");

/** Doctors scanned per call — far above the real roster; refuses rather than truncating silently. */
const MAX_DOCTORS = 500;

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Only the fields a destination needs (doctorAddressModel.js) — no timestamps or audit fields. */
function addressFields(id, data) {
  if (id === HOME_ADDRESS_ID) {
    return {
      kind: HOME_ADDRESS_ID,
      active: data.active === true,
      addressLine: text(data.addressLine),
      areaId: text(data.areaId),
      area: text(data.area),
      latitude: num(data.latitude),
      longitude: num(data.longitude),
      ...(num(data.geofenceRadiusM) !== null ? { geofenceRadiusM: data.geofenceRadiusM } : {}),
    };
  }
  return { active: data.active === true };
}

async function listMedRepDoctorAddresses({ db, uid, payload }) {
  if (payload && (typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length > 0)) {
    throw new PolicyError("unknown-field", "This lookup takes no input.");
  }
  const callerSnap = await db.collection("users").doc(uid).get();
  const caller = callerSnap.exists ? callerSnap.data() : null;
  if (!caller) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (text(caller.role)?.toLowerCase() !== "salesrep") {
    throw new PolicyError("wrong-role", "Only a Med Rep can look up delivery addresses here.");
  }
  if (text(caller.status)?.toLowerCase() !== "approved") {
    throw new PolicyError("not-approved", "Your account is not approved.");
  }
  const territory = territoryOf(caller);
  if (!territory.assigned) return { addressesByDoctor: {} };

  const doctors = await db.collection("doctors").where("active", "==", true).limit(MAX_DOCTORS + 1).get();
  if (doctors.size > MAX_DOCTORS) {
    throw new PolicyError("too-many-doctors", "There are too many doctors to list. Ask an Admin for help.");
  }
  const addressesByDoctor = {};
  for (const doctor of doctors.docs) {
    const links = await doctor.ref.collection("deliveryAddresses").get();
    const permitted = [];
    for (const link of links.docs) {
      const data = link.data();
      // A legacy free-text address is never a destination (doctorAddressModel.js).
      const legacy = link.id !== HOME_ADDRESS_ID && typeof data.label === "string" && typeof data.addressLine === "string";
      if (legacy) continue;
      if (link.id === HOME_ADDRESS_ID && data.kind !== HOME_ADDRESS_ID) continue;
      if (!linkWithinTerritory({ ...data, id: link.id }, territory)) continue;
      permitted.push({ id: link.id, ...addressFields(link.id, data) });
    }
    if (permitted.length > 0) addressesByDoctor[doctor.id] = permitted;
  }
  return { addressesByDoctor };
}

module.exports = { MAX_DOCTORS, listMedRepDoctorAddresses };
