import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useLiveDraft } from "../../components/useLiveDraft";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import DialogLayer from "../../components/ui/DialogLayer";
import { Notice } from "../../components/ui/Feedback";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import {
  CLINIC_DETAIL_LABELS,
  CLINIC_STATUS_LABELS,
  clinicDetailsPatch,
  limitClinicPhone,
} from "../../services/clinicDetails";
import { updateClinicDetails } from "../../services/clinicService";
import { errorIdFor, fieldA11y, focusFirstInvalid, hasErrors } from "../../services/formValidation";
import { friendlyErrorMessage } from "../../services/liveDataErrors";

const FORM_ID = "edit-clinic";
const fieldId = (field) => `${FORM_ID}-${field}`;
const FIELDS = ["name", "clinicId", "contact", "phone", "email", "location", "areaId", "status", "deliveryNotes"];
const INPUT_PROPS = {
  phone: { type: "tel", inputMode: "numeric", autoComplete: "tel-national" },
  email: { type: "email" },
};

export default function EditClinicDetailsModal({ clinic, areas, areasLoading, areaLoadError, onClose, onSaved }) {
  const latest = clinic?.detailFields ?? null;
  const { draft, setField, dirty, stale, gone, loadLatest } = useLiveDraft(latest);
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const savingRef = useRef(false);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);

  const activeAreas = areas.filter((area) => area.active === true);
  const areaAvailable = (id) => activeAreas.some((area) => area.id === id);
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  useDialogFocus({ dialogRef, initialRef: nameRef, onDismiss: requestClose, busy: saving });

  const changeField = (field, value) => {
    setField(field, field === "phone" ? limitClinicPhone(value) : value);
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaveError("");
  };

  const save = async (event) => {
    event.preventDefault();
    if (savingRef.current || !dirty || gone || stale.length) return;

    const { patch, errors: fieldErrors } = clinicDetailsPatch(draft, latest);
    if (patch.areaId && (areasLoading || areaLoadError || !areaAvailable(patch.areaId))) {
      fieldErrors.areaId = "Select an active area for this clinic.";
    }
    setErrors(fieldErrors);
    setSaveError("");
    if (hasErrors(fieldErrors)) {
      focusFirstInvalid(FIELDS, fieldErrors, (field) => document.getElementById(fieldId(field)));
      return;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await updateClinicDetails(clinic.firestoreId, draft, latest);
      onSaved();
    } catch (error) {
      setSaveError(friendlyErrorMessage(error, "Clinic details could not be saved. Please try again."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const areaOptions = activeAreas.map(({ id, name }) => ({ value: id, label: name }));
  if (draft.areaId && !areaAvailable(draft.areaId)) {
    const storedArea = areas.find((area) => area.id === draft.areaId);
    const label = storedArea?.name || (draft.areaId === latest?.areaId ? clinic?.area : "Unavailable area");
    areaOptions.unshift({ value: draft.areaId, label, disabled: true });
  }
  const statusOptions = Object.entries(CLINIC_STATUS_LABELS).map(([value, label]) => ({ value, label }));
  if (draft.status && !Object.hasOwn(CLINIC_STATUS_LABELS, draft.status)) {
    statusOptions.unshift({ value: draft.status, label: "Unrecognized status", disabled: true });
  }
  const addressChanged = latest && (draft.location ?? "").trim() !== latest.location;
  const areaChanged = latest && draft.areaId !== latest.areaId;
  const contactChanged = latest && (draft.contact ?? "").trim() !== latest.contact;
  const hintByField = {
    location: addressChanged ? "If the clinic moved, update its pin in Manage location too." : "",
    areaId: areaLoadError || (areaChanged ? "Review Med Rep access after changing the area." : ""),
    contact: contactChanged ? "Use Manage access to update linked doctors." : "",
  };

  return (
    <DialogLayer>
      <div className="clinics-modal-backdrop">
        <form
          ref={dialogRef}
          className="clinics-modal clinics-form-modal clinics-edit-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-clinic-heading"
          aria-busy={saving || undefined}
          onSubmit={save}
          noValidate
        >
          <button type="button" className="clinics-modal-close" onClick={requestClose} disabled={saving} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
          <h2 id="edit-clinic-heading">Edit clinic details</h2>
          <div className="clinics-modal-body">
            {gone ? (
              <Notice tone="error" title="Clinic unavailable">The clinic record could not be loaded.</Notice>
            ) : stale.length > 0 && (
              <Notice tone="warning" title="Clinic details changed in another session">
                <p>{stale.map((field) => CLINIC_DETAIL_LABELS[field]).join(", ")} changed. Loading the latest values keeps your edits to other fields.</p>
                <button
                  type="button"
                  className="clinics-light-action"
                  onClick={() => {
                    loadLatest();
                    setErrors({});
                    setSaveError("");
                    nameRef.current?.focus();
                  }}
                  disabled={saving}
                >
                  Load latest
                </button>
              </Notice>
            )}
            <div className="clinics-form-grid">
              {FIELDS.map((field) => {
                const options = field === "areaId" ? areaOptions : field === "status" ? statusOptions : null;
                const hint = hintByField[field];
                const hintId = hint ? `${fieldId(field)}-hint` : undefined;
                const props = {
                  id: fieldId(field),
                  value: draft[field] ?? "",
                  disabled: saving || gone || (field === "areaId" && (areasLoading || Boolean(areaLoadError))),
                  onChange: (event) => changeField(field, event.target.value),
                  ...fieldA11y(FORM_ID, field, errors, { hint: hintId }),
                };
                return (
                  <label key={field} htmlFor={props.id} className={field === "location" || field === "deliveryNotes" ? "wide" : undefined}>
                    {CLINIC_DETAIL_LABELS[field]}
                    {options ? (
                      <select {...props}>
                        <option value="" disabled>
                          {field === "status" ? "Select a status" : areasLoading ? "Loading areas…" : "Select an active area"}
                        </option>
                        {options.map(({ value, label, disabled }) => <option key={value} value={value} disabled={disabled}>{label}</option>)}
                      </select>
                    ) : (
                      <input ref={field === "name" ? nameRef : undefined} type="text" {...INPUT_PROPS[field]} {...props} />
                    )}
                    {hint && <small id={hintId} className="clinics-field-note">{hint}</small>}
                    {errors[field] && <small id={errorIdFor(FORM_ID, field)} className="clinics-field-error">{errors[field]}</small>}
                  </label>
                );
              })}
            </div>
          </div>
          {saveError && <Notice tone="error">{saveError}</Notice>}
          <div className="clinics-modal-actions">
            <button type="button" className="clinics-light-action" onClick={requestClose} disabled={saving}>Cancel</button>
            <button type="submit" className="clinics-primary-action" disabled={saving || !dirty || gone || stale.length > 0}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          target={clinic?.name || "Clinic details"}
          consequence="Your edits will be lost."
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={onClose}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </DialogLayer>
  );
}
