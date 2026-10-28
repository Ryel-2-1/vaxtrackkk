import { useEffect, useMemo, useState } from "react";
import { subscribeDoctorAddresses } from "../../services/doctorAddressService";

/**
 * Every doctor's delivery addresses, live: { [doctorId]: rows }.
 *
 * A doctor's clinic links live under the doctor (doctors/{id}/deliveryAddresses)
 * and no collection-group read is allowed, so this keeps one listener per
 * doctor — the same reads the Delivery addresses panel already makes. Listeners
 * are opened once per doctor and closed when a doctor leaves the list.
 *
 * `ready` is false until every doctor has reported once; `failed` lists doctors
 * whose addresses could not be read (their links count as unknown, not as none).
 */
export default function useDoctorAddressLinks(doctors) {
  const ids = useMemo(
    () => [...new Set((doctors || []).map((d) => d?.id).filter((id) => typeof id === "string" && id))].sort(),
    [doctors]
  );
  const key = ids.join("|");
  const [state, setState] = useState({ key: "", byDoctor: {}, failed: [] });

  useEffect(() => {
    const doctorIds = key ? key.split("|") : [];
    let active = true;
    const byDoctor = {};
    const failed = new Set();
    const publish = () => active && setState({ key, byDoctor: { ...byDoctor }, failed: [...failed] });
    const unsubs = doctorIds.map((id) => {
      try {
        return subscribeDoctorAddresses(
          id,
          (rows) => {
            byDoctor[id] = rows;
            failed.delete(id);
            publish();
          },
          () => {
            failed.add(id);
            publish();
          }
        );
      } catch {
        failed.add(id);
        return null;
      }
    });
    publish();
    return () => {
      active = false;
      unsubs.forEach((u) => typeof u === "function" && u());
    };
  }, [key]);

  const current = state.key === key ? state : { byDoctor: {}, failed: [] };
  const reported = ids.filter((id) => current.byDoctor[id] || current.failed.includes(id)).length;
  return { addressesByDoctor: current.byDoctor, failed: current.failed, ready: reported === ids.length };
}
