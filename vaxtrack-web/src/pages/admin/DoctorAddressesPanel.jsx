import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, MapPin, Plus, Trash2 } from "lucide-react";
import {
  addDoctorAddress,
  removeLegacyDoctorAddress,
  setDoctorAddressActive,
  subscribeDoctorAddresses,
} from "../../services/doctorAddressService";
import { validateDoctorAddress } from "../../services/doctorAddressModel";

const EMPTY_DESTINATION = { clinicDocId: "" };

function hasUsableClinicDestination(clinic, activeAreaById) {
  const location = clinic.locationInfo || {};
  const area = activeAreaById.get(clinic.areaId);
  const rawRadius = location.geofenceRadiusMStored;
  const radiusIsUsable =
    rawRadius === null ||
    (Number.isInteger(rawRadius) && rawRadius >= 50 && rawRadius <= 1000);

  return Boolean(
    clinic.firestoreId &&
      typeof clinic.name === "string" &&
      clinic.name.trim().length >= 2 &&
      typeof clinic.location === "string" &&
      clinic.location.trim().length >= 5 &&
      clinic.areaId &&
      typeof clinic.area === "string" &&
      clinic.area.trim().length >= 2 &&
      area?.name?.trim() === clinic.area.trim() &&
      clinic.destinationLocationValid === true &&
      location.locationVerified === true &&
      radiusIsUsable
  );
}

function DoctorAddressesPanel({
  doctor,
  clinics,
  clinicsLoading,
  clinicLoadError,
  areas,
  areasLoading,
  areaLoadError,
  onBack,
  onToast,
  onBusyChange,
}) {
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(EMPTY_DESTINATION);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const clinicSelectRef = useRef(null);
  const backButtonRef = useRef(null);
  const busy = saving || Boolean(updatingId);
  const masterDataLoading = clinicsLoading || areasLoading;
  const masterDataError = clinicLoadError || areaLoadError;

  const activeAreaById = useMemo(
    () =>
      new Map(
        areas
          .filter((area) => area.active === true)
          .map((area) => [area.id, area])
      ),
    [areas]
  );
  const clinicById = useMemo(
    () => new Map(clinics.map((clinic) => [clinic.firestoreId, clinic])),
    [clinics]
  );
  const linkedClinicIds = useMemo(
    () => new Set(addresses.map((address) => address.clinicDocId)),
    [addresses]
  );
  const availableClinics = useMemo(
    () =>
      clinics
        .filter(
          (clinic) =>
            hasUsableClinicDestination(clinic, activeAreaById) &&
            !linkedClinicIds.has(clinic.firestoreId)
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [activeAreaById, clinics, linkedClinicIds]
  );

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (doctor.active === true) clinicSelectRef.current?.focus();
    else backButtonRef.current?.focus();
  }, [doctor.active]);

  useEffect(() => {
    const unsubscribe = subscribeDoctorAddresses(
      doctor.id,
      (docs) => {
        setAddresses(docs);
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(error.message || "Failed to load clinic destinations.");
      }
    );
    return () => unsubscribe();
  }, [doctor.id]);

  useEffect(() => {
    if (
      draft.clinicDocId &&
      !availableClinics.some(
        (clinic) => clinic.firestoreId === draft.clinicDocId
      )
    ) {
      setDraft(EMPTY_DESTINATION);
    }
  }, [availableClinics, draft.clinicDocId]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy || doctor.active !== true) return;

    const check = validateDoctorAddress(draft);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      await addDoctorAddress(doctor.id, draft);
      onToast("Clinic destination added.");
      // The subscription remains the relationship-list source of truth.
      setDraft(EMPTY_DESTINATION);
      setTimeout(() => clinicSelectRef.current?.focus(), 0);
    } catch (error) {
      console.error("Save doctor clinic destination error:", error);
      setErrors(
        error.validationErrors || {
          form: error.message || "Failed to save the clinic destination.",
        }
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (address) => {
    if (busy) return;
    const clinic = clinicById.get(address.clinicDocId);
    setUpdatingId(address.id);
    setErrors({});
    try {
      await setDoctorAddressActive(
        doctor.id,
        address.clinicDocId,
        !address.active
      );
      onToast(
        `${clinic?.name || "Clinic destination"} is now ${
          address.active ? "inactive" : "active"
        }.`
      );
    } catch (error) {
      console.error("Update doctor clinic destination error:", error);
      setErrors({
        form: error.message || "Failed to update the clinic destination.",
      });
    } finally {
      setUpdatingId("");
    }
  };

  const handleRemoveLegacy = async (address) => {
    if (busy || address.legacyIndependentAddress !== true) return;
    const confirmed = window.confirm(
      "Remove this legacy standalone address? This cannot be undone."
    );
    if (!confirmed) return;

    setUpdatingId(address.id);
    setErrors({});
    try {
      await removeLegacyDoctorAddress(doctor.id, address.id);
      onToast("Legacy standalone address removed.");
    } catch (error) {
      console.error("Remove legacy doctor address error:", error);
      setErrors({
        form: error.message || "Failed to remove the legacy address.",
      });
    } finally {
      setUpdatingId("");
    }
  };

  return (
    <div className="clinics-address-panel">
      <button
        ref={backButtonRef}
        type="button"
        className="clinics-address-back"
        onClick={onBack}
        disabled={busy}
      >
        <ChevronLeft size={15} aria-hidden="true" />
        Back to doctors
      </button>

      <div className="clinics-address-doctor">
        <div>
          <strong>{doctor.name || "Unnamed doctor"}</strong>
          <span>Primary area: {doctor.area || "Unassigned"}</span>
        </div>
        <span className={doctor.active ? "active" : "inactive"}>
          {doctor.active ? "Active doctor" : "Inactive doctor"}
        </span>
      </div>

      {doctor.active !== true && (
        <p className="clinics-address-notice" role="status">
          Activate this doctor before adding or reactivating a clinic
          destination. Existing destinations can still be deactivated.
        </p>
      )}

      <form className="clinics-address-form" onSubmit={handleSubmit} noValidate>
        <div className="clinics-address-fields">
          <label htmlFor="doctor-address-clinic">
            Registered clinic destination
            <select
              ref={clinicSelectRef}
              id="doctor-address-clinic"
              value={draft.clinicDocId}
              onChange={(event) =>
                setDraft({ clinicDocId: event.target.value })
              }
              disabled={busy || masterDataLoading || doctor.active !== true}
              aria-invalid={errors.clinicDocId ? "true" : undefined}
              aria-describedby={
                errors.clinicDocId
                  ? "doctor-address-clinic-error"
                  : "doctor-address-clinic-note"
              }
            >
              <option value="">
                {masterDataLoading
                  ? "Loading clinics and areas..."
                  : "Select a verified clinic"}
              </option>
              {availableClinics.map((clinic) => (
                <option key={clinic.firestoreId} value={clinic.firestoreId}>
                  {clinic.name} — {clinic.location}
                </option>
              ))}
            </select>
            {errors.clinicDocId ? (
              <small
                id="doctor-address-clinic-error"
                className="clinic-loc-error"
              >
                {errors.clinicDocId}
              </small>
            ) : (
              <small id="doctor-address-clinic-note" className="clinics-field-note">
                The clinic&apos;s verified address, area, pin and radius remain the
                source of truth.
              </small>
            )}
          </label>
        </div>

        {!masterDataLoading && !masterDataError && availableClinics.length === 0 && (
          <p className="clinics-field-note">
            {addresses.length > 0
              ? "All eligible clinics are already linked to this doctor. Reactivate an inactive destination below instead of adding a duplicate."
              : "Register a clinic and verify its map location before linking it to this doctor."}
          </p>
        )}

        {(errors.form || masterDataError) && (
          <p className="clinics-area-error" role="alert">
            {errors.form || masterDataError}
          </p>
        )}

        <div className="clinics-address-form-actions">
          <button
            type="submit"
            className="clinics-v2-primary-btn"
            disabled={
              busy ||
              doctor.active !== true ||
              masterDataLoading ||
              availableClinics.length === 0
            }
          >
            <Plus size={15} aria-hidden="true" />
            {saving ? "Saving..." : "Add Clinic Destination"}
          </button>
        </div>
      </form>

      <div className="clinics-address-list" aria-live="polite">
        {loading && <p>Loading clinic destinations...</p>}
        {!loading && loadError && (
          <p className="clinics-area-error" role="alert">
            {loadError}
          </p>
        )}
        {!loading && !loadError && addresses.length === 0 && (
          <div className="clinics-area-empty">
            <MapPin size={22} aria-hidden="true" />
            <strong>No clinic destinations yet</strong>
            <span>Link the first registered clinic above.</span>
          </div>
        )}
        {!loading &&
          !loadError &&
          addresses.map((address) => {
            const clinic = clinicById.get(address.clinicDocId);
            const location = clinic?.locationInfo;
            const isLegacy = address.legacyIndependentAddress === true;
            const canActivate =
              doctor.active === true &&
              clinic &&
              hasUsableClinicDestination(clinic, activeAreaById);

            return (
              <article className="clinics-address-row" key={address.id}>
                <div className="clinics-address-summary">
                  <div>
                    <strong>
                      {isLegacy
                        ? address.label || "Legacy standalone address"
                        : clinic?.name || "Unavailable clinic"}
                    </strong>
                    <span className={address.active ? "active" : "inactive"}>
                      {isLegacy
                        ? "Legacy"
                        : address.active
                          ? "Active"
                          : "Inactive"}
                    </span>
                  </div>
                  <p>
                    {isLegacy
                      ? address.addressLine || "Standalone address"
                      : clinic?.location ||
                        "This registered clinic is missing or unavailable."}
                  </p>
                  {isLegacy ? (
                    <small>
                      Remove this retired standalone record, then link a
                      registered clinic above.
                    </small>
                  ) : clinic &&
                  hasUsableClinicDestination(clinic, activeAreaById) ? (
                    <small>
                      {clinic.area} · {location.latitude}, {location.longitude} ·{" "}
                      {location.geofenceRadiusM} m radius
                    </small>
                  ) : (
                    <small>
                      Repair this clinic&apos;s area or verified location before
                      reactivating it.
                    </small>
                  )}
                </div>
                <div className="clinics-address-row-actions">
                  {isLegacy ? (
                    <button
                      type="button"
                      onClick={() => handleRemoveLegacy(address)}
                      disabled={busy}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      {updatingId === address.id
                        ? "Removing..."
                        : "Remove legacy"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleToggle(address)}
                      disabled={busy || (!address.active && !canActivate)}
                    >
                      {updatingId === address.id
                        ? "Saving..."
                        : address.active
                          ? "Deactivate"
                          : "Activate"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
      </div>
    </div>
  );
}

export default DoctorAddressesPanel;
