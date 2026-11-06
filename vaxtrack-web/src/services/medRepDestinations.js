import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { toDoctorAddressRows } from "./doctorAddressService";

/**
 * Every doctor destination this Med Rep may order to, as `{ doctorId: rows }`.
 *
 * Doctor addresses (including private Home addresses) are not readable by a
 * Med Rep directly; the server returns only the links inside the caller's
 * territory (functions/src/medRepDestinations.js).
 */
export async function fetchMedRepDoctorAddresses() {
  const call = httpsCallable(getFunctions(app, "asia-southeast1"), "listMedRepDoctorAddresses");
  const result = await call({});
  const byDoctor = result.data?.addressesByDoctor;
  if (!byDoctor || typeof byDoctor !== "object" || Array.isArray(byDoctor)) return {};
  return Object.fromEntries(
    Object.entries(byDoctor).flatMap(([doctorId, links]) => {
      if (!doctorId || doctorId.includes("/") || !Array.isArray(links)) return [];
      const docs = links.flatMap((link) => {
        if (!link || typeof link.id !== "string" || !link.id || link.id.includes("/")) return [];
        const { id, ...data } = link;
        return [{ id, data }];
      });
      return [[doctorId, toDoctorAddressRows(doctorId, docs)]];
    })
  );
}
