import { useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Users, X, XCircle } from "lucide-react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import {
  currentSelections,
  medRepCoversArea,
  medRepName,
  planClinicAccess,
} from "../../services/clinicAccess";
import { applyClinicAccess } from "../../services/clinicAccessService";
import "./ClinicAccess.css";

/**
 * "Who can order here" — the Med Reps and doctors linked to one clinic.
 *
 * ClinicAccessFields is the two checklists, used inside Register Clinic and the
 * Manage access dialog. Ticking a Med Rep adds the clinic (and its area, when
 * missing) to their territory; ticking a doctor makes the clinic one of the
 * doctor's active delivery addresses. Both views edit the same records as the
 * Territory dialog and Delivery addresses, so they always agree.
 */
export function ClinicAccessFields({
  idPrefix,
  areaId,
  areaName,
  medReps,
  doctors,
  repUids,
  doctorIds,
  onChange,
  disabled = false,
  disabledReason = "",
}) {
  const [doctorFilter, setDoctorFilter] = useState("");
  // Med Reps who already cover the area first: ticking them adds only this clinic.
  const reps = useMemo(
    () => [...(medReps || [])].sort((a, b) => Number(medRepCoversArea(b, areaId)) - Number(medRepCoversArea(a, areaId))),
    [medReps, areaId]
  );
  // Active doctors can be linked; an inactive one is listed only while still linked (so it can be removed).
  const listedDoctors = (doctors || []).filter((d) => d.active === true || doctorIds.includes(d.id));
  const filter = doctorFilter.trim().toLowerCase();
  const shownDoctors = filter ? listedDoctors.filter((d) => String(d.name || "").toLowerCase().includes(filter)) : listedDoctors;
  const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <section className="clinic-access" aria-labelledby={`${idPrefix}-heading`}>
      <h4 id={`${idPrefix}-heading`}>
        <Users size={15} aria-hidden="true" /> Who can order here
      </h4>
      <p className="clinic-access-help">
        A clinic appears for ordering only when a Med Rep and a doctor are both linked to it.
      </p>
      {disabledReason && (
        <p className="clinic-access-blocked" role="status">
          {disabledReason}
        </p>
      )}

      <fieldset className="clinic-access-group" disabled={disabled}>
        <legend>Med Reps</legend>
        {reps.length === 0 ? (
          <p className="clinic-access-empty">No approved Med Reps yet.</p>
        ) : (
          <ul>
            {reps.map((user) => {
              const covers = medRepCoversArea(user, areaId);
              const id = `${idPrefix}-rep-${user.uid}`;
              return (
                <li key={user.uid}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={repUids.includes(user.uid)}
                    onChange={() => onChange({ repUids: toggle(repUids, user.uid), doctorIds })}
                  />
                  <label htmlFor={id}>
                    <strong>{medRepName(user)}</strong>
                    <small>
                      {!areaId
                        ? "Select the clinic's area first"
                        : covers
                          ? `Covers ${areaName || "this area"}`
                          : `Will also get ${areaName || "this area"}`}
                    </small>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <fieldset className="clinic-access-group" disabled={disabled}>
        <legend>Doctors who receive deliveries here</legend>
        {listedDoctors.length > 8 && (
          <input
            type="search"
            className="clinic-access-filter"
            placeholder="Filter doctors"
            aria-label="Filter doctors"
            value={doctorFilter}
            onChange={(e) => setDoctorFilter(e.target.value)}
          />
        )}
        {listedDoctors.length === 0 ? (
          <p className="clinic-access-empty">No active doctors yet. Add them under Doctors.</p>
        ) : (
          <ul>
            {shownDoctors.map((doctor) => {
              const id = `${idPrefix}-doc-${doctor.id}`;
              return (
                <li key={doctor.id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={doctorIds.includes(doctor.id)}
                    onChange={() => onChange({ repUids, doctorIds: toggle(doctorIds, doctor.id) })}
                  />
                  <label htmlFor={id}>
                    <strong>{doctor.name || "Doctor"}</strong>
                    {doctor.active !== true && <small>Inactive — untick to remove the link</small>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
    </section>
  );
}

/** One line per link that was saved or failed. */
export function ClinicAccessResults({ results }) {
  if (!results?.length) return null;
  return (
    <ul className="clinic-access-results" aria-label="Link results">
      {results.map((r, i) => (
        <li key={`${r.kind}-${r.name}-${i}`} className={r.ok ? "ok" : "failed"}>
          {r.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
          <span>
            <strong>{r.name}</strong> — {r.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Admin → Clinics → Manage access, for one clinic. Starts from who reaches the
 * clinic now; saving applies only the differences.
 */
export function ManageAccessModal({ clinic, medReps, doctors, addressesByDoctor, linksReady, orders, onClose, onSaved }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const accessClinic = useMemo(
    () => ({ id: clinic.firestoreId, areaId: clinic.areaId, locationVerified: clinic.locationVerified === true }),
    [clinic.firestoreId, clinic.areaId, clinic.locationVerified]
  );
  // The Admin's edits; null = follow the stored links (live), so after a save
  // the dialog shows what is really linked now.
  const [edited, setSelection] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemovals, setConfirmRemovals] = useState(false);
  const [results, setResults] = useState(null);
  useDialogFocus({ dialogRef, onDismiss: onClose, busy: saving });

  // Start from the stored links once every doctor's addresses have loaded.
  const selection =
    edited ?? (linksReady ? currentSelections(accessClinic, medReps, addressesByDoctor, doctors) : null);

  const plan = selection
    ? planClinicAccess({
        clinic: accessClinic,
        medReps,
        selectedRepUids: selection.repUids,
        doctors,
        addressesByDoctor,
        selectedDoctorIds: selection.doctorIds,
        orders: orders || [],
      })
    : null;
  const losing = plan ? plan.repRemovals.filter((r) => r.losingOrders.length > 0) : [];

  async function save(event) {
    event.preventDefault();
    if (!plan || plan.empty || plan.blocked.length || saving) return;
    if (losing.length && !confirmRemovals) {
      setConfirmRemovals(true);
      return;
    }
    setSaving(true);
    try {
      const out = await applyClinicAccess(accessClinic.id, plan);
      setResults(out);
      setConfirmRemovals(false);
      // Re-read who is linked now, so a retry only touches what still differs.
      setSelection(null);
      onSaved?.(out);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="clinics-modal-backdrop">
      <form ref={dialogRef} className="clinics-modal clinics-access-modal" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <button type="button" className="clinics-modal-close" onClick={onClose} disabled={saving} aria-label="Close manage access">
          <X size={16} />
        </button>
        <h3 id={headingId}>Manage access</h3>
        <p className="clinics-modal-sub">
          {clinic.name} · {clinic.area}
        </p>

        <div className="clinics-modal-body">
          {!selection ? (
            <p className="clinic-access-empty" role="status">Loading who is linked…</p>
          ) : (
            <ClinicAccessFields
              idPrefix={`access-${clinic.firestoreId}`}
              areaId={clinic.areaId}
              areaName={clinic.area}
              medReps={medReps}
              doctors={doctors}
              repUids={selection.repUids}
              doctorIds={selection.doctorIds}
              onChange={(next) => {
                setSelection(next);
                setConfirmRemovals(false);
              }}
              disabled={saving}
              disabledReason={plan?.blocked.join(" ") || ""}
            />
          )}

          {confirmRemovals && losing.length > 0 && (
            <div className="clinic-access-warning" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <p>
                {losing.map((r) => `${r.name} has ${r.losingOrders.length} open order${r.losingOrders.length === 1 ? "" : "s"} to this clinic`).join("; ")}.
                Those orders are not changed, but new orders here will no longer be possible for them. Save again to confirm.
              </p>
            </div>
          )}

          <ClinicAccessResults results={results} />
        </div>

        <div className="clinics-modal-actions">
          <button
            type="submit"
            className="clinics-primary-action"
            disabled={!plan || plan.empty || plan.blocked.length > 0 || saving}
          >
            {saving ? "Saving..." : confirmRemovals ? "Confirm and save" : "Save access"}
          </button>
          <button type="button" className="clinics-light-action" onClick={onClose} disabled={saving}>
            {results ? "Done" : "Cancel"}
          </button>
        </div>
      </form>
    </div>
  );
}
