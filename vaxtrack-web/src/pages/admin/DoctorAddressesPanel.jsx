import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronLeft,
  Edit,
  House,
  MapPin,
  Plus,
  Trash2,
} from "lucide-react";
import {
  addDoctorAddress,
  removeLegacyDoctorAddress,
  saveDoctorHomeAddress,
  setDoctorAddressActive,
  setDoctorHomeAddressActive,
  subscribeDoctorAddresses,
} from "../../services/doctorAddressService";
import {
  validateDoctorClinicDestination,
  validateDoctorHomeAddress,
} from "../../services/doctorAddressModel";
import ClinicLocationSection from "./ClinicLocationSection";

const EMPTY_CLINIC_DESTINATION = { clinicDocId: "" };
const EMPTY_HOME_ADDRESS = {
  addressLine: "",
  areaId: "",
  latitude: "",
  longitude: "",
  geofenceRadiusM: "",
};

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
  const [clinicDraft, setClinicDraft] = useState(EMPTY_CLINIC_DESTINATION);
  const [clinicErrors, setClinicErrors] = useState({});
  const [homeDraft, setHomeDraft] = useState(EMPTY_HOME_ADDRESS);
  const [homeErrors, setHomeErrors] = useState({});
  const [editingHome, setEditingHome] = useState(false);
  const [savingTarget, setSavingTarget] = useState("");
  const [updatingId, setUpdatingId] = useState("");
  const clinicSelectRef = useRef(null);
  const homeAddressRef = useRef(null);
  const backButtonRef = useRef(null);
  const busy = Boolean(savingTarget || updatingId);
  const masterDataLoading = clinicsLoading || areasLoading;
  const clinicMasterDataError = clinicLoadError || areaLoadError;

  const activeAreas = useMemo(
    () => areas.filter((area) => area.active === true),
    [areas]
  );
  const activeAreaById = useMemo(
    () => new Map(activeAreas.map((area) => [area.id, area])),
    [activeAreas]
  );
  const clinicById = useMemo(
    () => new Map(clinics.map((clinic) => [clinic.firestoreId, clinic])),
    [clinics]
  );
  const homeAddress = useMemo(
    () => addresses.find((address) => address.homeAddress === true) || null,
    [addresses]
  );
  const clinicDestinations = useMemo(
    () => addresses.filter((address) => address.destinationType === "clinic"),
    [addresses]
  );
  const legacyAddresses = useMemo(
    () =>
      addresses.filter(
        (address) => address.legacyIndependentAddress === true
      ),
    [addresses]
  );
  const linkedClinicIds = useMemo(
    () => new Set(clinicDestinations.map((address) => address.clinicDocId)),
    [clinicDestinations]
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
        setLoadError(error.message || "Failed to load delivery destinations.");
      }
    );
    return () => unsubscribe();
  }, [doctor.id]);

  useEffect(() => {
    if (
      clinicDraft.clinicDocId &&
      !availableClinics.some(
        (clinic) => clinic.firestoreId === clinicDraft.clinicDocId
      )
    ) {
      setClinicDraft(EMPTY_CLINIC_DESTINATION);
    }
  }, [availableClinics, clinicDraft.clinicDocId]);

  useEffect(() => {
    if (
      homeDraft.areaId &&
      !activeAreas.some((area) => area.id === homeDraft.areaId)
    ) {
      setHomeDraft((current) => ({ ...current, areaId: "" }));
    }
  }, [activeAreas, homeDraft.areaId]);

  const openHomeEditor = () => {
    if (busy || doctor.active !== true) return;
    setHomeErrors({});
    setHomeDraft(
      homeAddress
        ? {
            addressLine: homeAddress.addressLine || "",
            areaId: homeAddress.areaId || "",
            latitude: String(homeAddress.latitude ?? ""),
            longitude: String(homeAddress.longitude ?? ""),
            geofenceRadiusM: String(homeAddress.geofenceRadiusM ?? ""),
          }
        : EMPTY_HOME_ADDRESS
    );
    setEditingHome(true);
    setTimeout(() => homeAddressRef.current?.focus(), 0);
  };

  const closeHomeEditor = () => {
    setEditingHome(false);
    setHomeDraft(EMPTY_HOME_ADDRESS);
    setHomeErrors({});
  };

  const handleHomeSubmit = async (event) => {
    event.preventDefault();
    if (busy || doctor.active !== true) return;

    const check = validateDoctorHomeAddress(homeDraft);
    if (!check.ok) {
      setHomeErrors(check.errors);
      return;
    }

    setSavingTarget("home");
    setHomeErrors({});
    try {
      await saveDoctorHomeAddress(doctor.id, homeDraft);
      onToast(homeAddress ? "Home address updated." : "Home address added.");
      closeHomeEditor();
    } catch (error) {
      console.error("Save doctor Home address error:", error);
      setHomeErrors(
        error.validationErrors || {
          form: error.message || "Failed to save the Home address.",
        }
      );
    } finally {
      setSavingTarget("");
    }
  };

  const handleHomeToggle = async () => {
    if (busy || !homeAddress) return;
    setUpdatingId(homeAddress.id);
    setHomeErrors({});
    try {
      await setDoctorHomeAddressActive(doctor.id, !homeAddress.active);
      onToast(
        `Home address is now ${homeAddress.active ? "inactive" : "active"}.`
      );
    } catch (error) {
      console.error("Update doctor Home address error:", error);
      setHomeErrors({
        form: error.message || "Failed to update the Home address.",
      });
    } finally {
      setUpdatingId("");
    }
  };

  const handleClinicSubmit = async (event) => {
    event.preventDefault();
    if (busy || doctor.active !== true || loading) return;

    const check = validateDoctorClinicDestination(clinicDraft);
    if (!check.ok) {
      setClinicErrors(check.errors);
      return;
    }

    setSavingTarget("clinic");
    setClinicErrors({});
    try {
      await addDoctorAddress(doctor.id, clinicDraft);
      onToast("Clinic destination added.");
      setClinicDraft(EMPTY_CLINIC_DESTINATION);
      setTimeout(() => clinicSelectRef.current?.focus(), 0);
    } catch (error) {
      console.error("Save doctor clinic destination error:", error);
      setClinicErrors(
        error.validationErrors || {
          form: error.message || "Failed to save the clinic destination.",
        }
      );
    } finally {
      setSavingTarget("");
    }
  };

  const handleClinicToggle = async (address) => {
    if (busy) return;
    const clinic = clinicById.get(address.clinicDocId);
    setUpdatingId(address.id);
    setClinicErrors({});
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
      setClinicErrors({
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
    setClinicErrors({});
    try {
      await removeLegacyDoctorAddress(doctor.id, address.id);
      onToast("Legacy standalone address removed.");
    } catch (error) {
      console.error("Remove legacy doctor address error:", error);
      setClinicErrors({
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
          Activate this doctor before adding, editing, or reactivating a
          destination. Existing destinations can still be deactivated.
        </p>
      )}

      {loading && <p>Loading delivery destinations...</p>}
      {!loading && loadError && (
        <p className="clinics-area-error" role="alert">
          {loadError}
        </p>
      )}

      {!loading && !loadError && (
        <>
          <section className="clinics-address-section">
            <div className="clinics-address-section-head">
              <div>
                <House size={18} aria-hidden="true" />
                <h3>Home / doorstep</h3>
              </div>
              <p>
                Private delivery destination for this doctor. It is never
                shown as a clinic location.
              </p>
            </div>

            {editingHome ? (
              <form
                className="clinics-address-form clinics-home-form"
                onSubmit={handleHomeSubmit}
                noValidate
              >
                <div className="clinics-address-fields">
                  <label htmlFor="doctor-home-area">
                    Area
                    <select
                      id="doctor-home-area"
                      value={homeDraft.areaId}
                      onChange={(event) =>
                        setHomeDraft((current) => ({
                          ...current,
                          areaId: event.target.value,
                        }))
                      }
                      disabled={busy || areasLoading || doctor.active !== true}
                      aria-invalid={homeErrors.areaId ? "true" : undefined}
                      aria-describedby={
                        homeErrors.areaId ? "doctor-home-area-error" : undefined
                      }
                    >
                      <option value="">
                        {areasLoading
                          ? "Loading areas..."
                          : "Select an active area"}
                      </option>
                      {activeAreas.map((area) => (
                        <option key={area.id} value={area.id}>
                          {area.name}
                        </option>
                      ))}
                    </select>
                    {homeErrors.areaId && (
                      <small
                        id="doctor-home-area-error"
                        className="clinic-loc-error"
                      >
                        {homeErrors.areaId}
                      </small>
                    )}
                  </label>

                  <label className="wide" htmlFor="doctor-home-address-line">
                    Full home address
                    <textarea
                      ref={homeAddressRef}
                      id="doctor-home-address-line"
                      value={homeDraft.addressLine}
                      onChange={(event) =>
                        setHomeDraft((current) => ({
                          ...current,
                          addressLine: event.target.value,
                        }))
                      }
                      placeholder="House/unit, street, barangay, city or municipality"
                      maxLength={200}
                      disabled={busy || doctor.active !== true}
                      aria-invalid={
                        homeErrors.addressLine ? "true" : undefined
                      }
                      aria-describedby={
                        homeErrors.addressLine
                          ? "doctor-home-address-line-error"
                          : undefined
                      }
                    />
                    {homeErrors.addressLine && (
                      <small
                        id="doctor-home-address-line-error"
                        className="clinic-loc-error"
                      >
                        {homeErrors.addressLine}
                      </small>
                    )}
                  </label>
                </div>

                <ClinicLocationSection
                  value={homeDraft}
                  onChange={(patch) =>
                    setHomeDraft((current) => ({ ...current, ...patch }))
                  }
                  errors={homeErrors}
                  disabled={busy || doctor.active !== true}
                  idPrefix="doctor-home-loc"
                  helpText="Place the pin on the home entrance the rider should reach. This private destination is available only under the doctor's delivery choices."
                  mapAriaLabel="Doctor Home address location picker. Click the map to place the pin, or use the latitude and longitude fields below."
                  emptyMessage="No pin placed yet. A verified map location is required before the Home address can be saved."
                />

                {(homeErrors.form || areaLoadError) && (
                  <p className="clinics-area-error" role="alert">
                    {homeErrors.form || areaLoadError}
                  </p>
                )}

                <div className="clinics-address-form-actions">
                  <button
                    type="button"
                    className="clinics-light-action"
                    onClick={closeHomeEditor}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="clinics-v2-primary-btn"
                    disabled={
                      busy ||
                      doctor.active !== true ||
                      areasLoading ||
                      activeAreas.length === 0
                    }
                  >
                    <Plus size={15} aria-hidden="true" />
                    {savingTarget === "home"
                      ? "Saving..."
                      : homeAddress
                        ? "Save Home Address"
                        : "Add Home Address"}
                  </button>
                </div>
              </form>
            ) : homeAddress ? (
              <article className="clinics-address-row clinics-home-row">
                <div className="clinics-address-summary">
                  <div>
                    <strong>Home / Doorstep</strong>
                    <span className={homeAddress.active ? "active" : "inactive"}>
                      {homeAddress.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p>{homeAddress.addressLine || "No home address entered"}</p>
                  <small>
                    {homeAddress.area || "Unassigned area"} ·{" "}
                    {homeAddress.latitude}, {homeAddress.longitude} ·{" "}
                    {homeAddress.geofenceRadiusM} m radius
                  </small>
                </div>
                <div className="clinics-address-row-actions">
                  <button
                    type="button"
                    onClick={openHomeEditor}
                    disabled={busy || doctor.active !== true}
                  >
                    <Edit size={13} aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={handleHomeToggle}
                    disabled={
                      busy ||
                      (doctor.active !== true && homeAddress.active !== true)
                    }
                  >
                    {updatingId === homeAddress.id
                      ? "Saving..."
                      : homeAddress.active
                        ? "Deactivate"
                        : "Activate"}
                  </button>
                </div>
              </article>
            ) : (
              <div className="clinics-address-empty-row">
                <div>
                  <strong>No Home address saved</strong>
                  <span>Add the doctor&apos;s private doorstep destination.</span>
                </div>
                <button
                  type="button"
                  className="clinics-v2-primary-btn"
                  onClick={openHomeEditor}
                  disabled={busy || doctor.active !== true}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add Home Address
                </button>
              </div>
            )}

            {!editingHome && homeErrors.form && (
              <p className="clinics-area-error" role="alert">
                {homeErrors.form}
              </p>
            )}
          </section>

          <section className="clinics-address-section">
            <div className="clinics-address-section-head">
              <div>
                <Building2 size={18} aria-hidden="true" />
                <h3>Linked clinics</h3>
              </div>
              <p>
                Clinic address, area, pin, and radius always come from the
                registered clinic record.
              </p>
            </div>

            <form
              className="clinics-address-form clinics-clinic-link-form"
              onSubmit={handleClinicSubmit}
              noValidate
            >
              <div className="clinics-address-fields">
                <label htmlFor="doctor-address-clinic">
                  Registered clinic destination
                  <select
                    ref={clinicSelectRef}
                    id="doctor-address-clinic"
                    value={clinicDraft.clinicDocId}
                    onChange={(event) =>
                      setClinicDraft({ clinicDocId: event.target.value })
                    }
                    disabled={
                      busy || masterDataLoading || doctor.active !== true
                    }
                    aria-invalid={
                      clinicErrors.clinicDocId ? "true" : undefined
                    }
                    aria-describedby={
                      clinicErrors.clinicDocId
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
                  {clinicErrors.clinicDocId ? (
                    <small
                      id="doctor-address-clinic-error"
                      className="clinic-loc-error"
                    >
                      {clinicErrors.clinicDocId}
                    </small>
                  ) : (
                    <small
                      id="doctor-address-clinic-note"
                      className="clinics-field-note"
                    >
                      A clinic can be linked once and reactivated later.
                    </small>
                  )}
                </label>
              </div>

              {!masterDataLoading &&
                !clinicMasterDataError &&
                availableClinics.length === 0 && (
                  <p className="clinics-field-note">
                    {clinicDestinations.length > 0
                      ? "All eligible clinics are already linked to this doctor. Reactivate an inactive destination below instead of adding a duplicate."
                      : "Register a clinic and verify its map location before linking it to this doctor."}
                  </p>
                )}

              {(clinicErrors.form || clinicMasterDataError) && (
                <p className="clinics-area-error" role="alert">
                  {clinicErrors.form || clinicMasterDataError}
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
                  {savingTarget === "clinic"
                    ? "Saving..."
                    : "Add Clinic Destination"}
                </button>
              </div>
            </form>

            <div className="clinics-address-list" aria-live="polite">
              {clinicDestinations.length === 0 &&
                legacyAddresses.length === 0 && (
                  <div className="clinics-area-empty">
                    <MapPin size={22} aria-hidden="true" />
                    <strong>No linked clinics yet</strong>
                    <span>Link the first registered clinic above.</span>
                  </div>
                )}

              {clinicDestinations.map((address) => {
                const clinic = clinicById.get(address.clinicDocId);
                const location = clinic?.locationInfo;
                const canActivate =
                  doctor.active === true &&
                  clinic &&
                  hasUsableClinicDestination(clinic, activeAreaById);

                return (
                  <article className="clinics-address-row" key={address.id}>
                    <div className="clinics-address-summary">
                      <div>
                        <strong>{clinic?.name || "Unavailable clinic"}</strong>
                        <span className={address.active ? "active" : "inactive"}>
                          {address.active ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <p>
                        {clinic?.location ||
                          "This registered clinic is missing or unavailable."}
                      </p>
                      {clinic &&
                      hasUsableClinicDestination(clinic, activeAreaById) ? (
                        <small>
                          {clinic.area} · {location.latitude},{" "}
                          {location.longitude} · {location.geofenceRadiusM} m
                          radius
                        </small>
                      ) : (
                        <small>
                          Repair this clinic&apos;s area or verified location
                          before reactivating it.
                        </small>
                      )}
                    </div>
                    <div className="clinics-address-row-actions">
                      <button
                        type="button"
                        onClick={() => handleClinicToggle(address)}
                        disabled={busy || (!address.active && !canActivate)}
                      >
                        {updatingId === address.id
                          ? "Saving..."
                          : address.active
                            ? "Deactivate"
                            : "Activate"}
                      </button>
                    </div>
                  </article>
                );
              })}

              {legacyAddresses.map((address) => (
                <article className="clinics-address-row" key={address.id}>
                  <div className="clinics-address-summary">
                    <div>
                      <strong>
                        {address.label || "Legacy standalone address"}
                      </strong>
                      <span className="inactive">Legacy</span>
                    </div>
                    <p>{address.addressLine || "Standalone address"}</p>
                    <small>
                      Remove this retired standalone record, then add the Home
                      destination or link a registered clinic.
                    </small>
                  </div>
                  <div className="clinics-address-row-actions">
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
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default DoctorAddressesPanel;
