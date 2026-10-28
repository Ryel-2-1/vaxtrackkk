import { updateMedRepTerritory } from "./userService";
import { addDoctorAddress, setDoctorAddressActive } from "./doctorAddressService";
import { friendlyErrorMessage, logSafeError } from "./liveDataErrors.js";

/**
 * Apply a planClinicAccess() result. Each link is its own transaction in the
 * service the rest of the app already uses (the Territory dialog's
 * updateMedRepTerritory, Delivery addresses' doctor link writes), so every
 * check is unchanged. They are applied one after another and never rolled
 * back: one failure does not undo or block the others, and each result says
 * exactly what happened, so a retry touches only what is still missing.
 *
 * @returns {Promise<Array<{kind: "rep-add"|"rep-remove"|"doctor-link"|"doctor-unlink", name: string, ok: boolean, message: string}>>}
 */
export async function applyClinicAccess(clinicDocId, plan) {
  const results = [];
  const run = async (kind, name, fn, okText) => {
    try {
      await fn();
      results.push({ kind, name, ok: true, message: okText });
    } catch (err) {
      logSafeError(`Clinic access (${kind})`, err);
      results.push({ kind, name, ok: false, message: friendlyErrorMessage(err, "This link could not be saved. Try again.") });
    }
  };

  for (const rep of plan.repAdds) {
    await run("rep-add", rep.name, () => updateMedRepTerritory(rep.uid, rep.territory),
      rep.addsArea ? "Can now order here (the clinic's area was added to their territory)." : "Can now order here.");
  }
  for (const rep of plan.repRemovals) {
    await run("rep-remove", rep.name, () => updateMedRepTerritory(rep.uid, rep.territory), "Can no longer order here.");
  }
  for (const link of plan.doctorLinks) {
    await run(
      "doctor-link",
      link.name,
      () => (link.action === "reactivate"
        ? setDoctorAddressActive(link.doctorId, clinicDocId, true)
        : addDoctorAddress(link.doctorId, { clinicDocId })),
      "Delivers here now."
    );
  }
  for (const link of plan.doctorUnlinks) {
    await run("doctor-unlink", link.name, () => setDoctorAddressActive(link.doctorId, clinicDocId, false), "No longer delivers here.");
  }
  return results;
}
