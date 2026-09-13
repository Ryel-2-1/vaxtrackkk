import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Edit,
  Grid3X3,
  MapPin,
  Plus,
  Search,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "../../components/admin/AdminSidebar";
import {
  subscribeClinics,
  clinicNameExists,
  addClinic,
  updateClinicLocation,
  readClinicLocation,
  validateClinicLocation,
} from "../../services/clinicService";
import KpiCard from "../../components/ui/KpiCard";
import ClinicLocationSection from "./ClinicLocationSection";
import "./Clinics.css";

const STATUS_LABEL = {
  active: "Active",
  pending: "Pending Resupply",
  overdue: "Overdue",
};

const STATUS_NOTE = {
  active: "Ready for Delivery",
  pending: "Pending Resupply",
  overdue: "Delivery Overdue",
};

function normalizeClinic(raw) {
  const status =
    raw.status && STATUS_LABEL[raw.status] ? raw.status : "active";
  const contactStr = typeof raw.contact === "string" ? raw.contact : "";
  const initials =
    contactStr
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return {
    id: raw.clinicId || raw.id || "—",
    firestoreId: raw.id || "",
    name: raw.name || "—",
    location: raw.location || "—",
    area: raw.area || "Metro Manila",
    contact: contactStr || "—",
    phone: raw.phone || "—",
    email: raw.email || "—",
    deliveryNotes: raw.deliveryNotes || "No special notes.",
    status,
    statusLabel: STATUS_LABEL[status],
    note: STATUS_NOTE[status],
    lastDelivery: raw.lastDelivery || "No delivery yet",
    initials,
    contactTone: raw.contactTone || "blue",
    // Canonical coordinates (top-level `latitude`/`longitude` numbers), read
    // backward-compatibly: pre-radius clinics report the 300 m default, and a
    // clinic with no pin reports hasCoordinates: false rather than a fake one.
    locationInfo: readClinicLocation(raw),
  };
}

const pageSize = 3;

const EMPTY_CLINIC = {
  name: "",
  location: "",
  area: "Metro Manila",
  contact: "",
  phone: "",
  email: "",
  deliveryNotes: "",
  status: "active",
  latitude: "",
  longitude: "",
  geofenceRadiusM: "",
};

function Clinics() {
  const navigate = useNavigate();
  const [clinics, setClinics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedClinic, setSelectedClinic] = useState(null);
  const [showNewClinicModal, setShowNewClinicModal] = useState(false);
  const [toast, setToast] = useState("");
  const [newClinic, setNewClinic] = useState(EMPTY_CLINIC);
  const [newClinicErrors, setNewClinicErrors] = useState({});
  // The clinic whose location is being managed, plus the element to restore
  // focus to when the dialog closes.
  const [managedClinic, setManagedClinic] = useState(null);
  const manageTriggerRef = useRef(null);
  // The control that opened the registration dialog, so focus can be handed
  // back to it on dismissal.
  const newClinicTriggerRef = useRef(null);

  const openManageLocation = (clinic, triggerEl) => {
    manageTriggerRef.current = triggerEl;
    setManagedClinic(clinic);
  };

  const closeManageLocation = useCallback(() => {
    setManagedClinic(null);
    // Return focus to the row action that opened the dialog.
    if (manageTriggerRef.current) {
      manageTriggerRef.current.focus();
      manageTriggerRef.current = null;
    }
  }, []);

  const openNewClinic = (triggerEl) => {
    newClinicTriggerRef.current = triggerEl;
    setShowNewClinicModal(true);
  };

  // The single dismissal path for the registration dialog: used by Escape, the
  // close control, Cancel and a completed registration, so the reset and the
  // focus hand-back cannot drift apart between them.
  //
  // The draft is cleared HERE and nowhere else, which is what makes "reset only
  // after a confirmed dismissal" true: while the dialog is open — including
  // while the discard confirmation is showing — `newClinic` is left untouched,
  // so backing out of the confirmation returns the admin to their typed values.
  const closeNewClinic = useCallback(() => {
    setShowNewClinicModal(false);
    setNewClinicErrors({});
    setNewClinic(EMPTY_CLINIC);
    // Return focus to the button that opened the dialog. Without this, focus
    // falls back to <body> and a keyboard user restarts from the top of the
    // page — the dialog declares aria-modal, so it owed them that focus back.
    if (newClinicTriggerRef.current) {
      newClinicTriggerRef.current.focus();
      newClinicTriggerRef.current = null;
    }
  }, []);

  const handleSaveLocation = async (clinic, draft) => {
    // subscribeClinics remains the source of truth — no local clinic list
    // mutation here; the snapshot re-renders the row.
    await updateClinicLocation(clinic.firestoreId, draft);
    showToast(`Location saved for ${clinic.name}.`);
    closeManageLocation();
  };

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  useEffect(() => {
    const unsubscribe = subscribeClinics(
      (raw) => {
        setClinics(raw.map(normalizeClinic));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(error.message || "Failed to load clinics.");
      }
    );
    return () => unsubscribe();
  }, []);

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const filteredClinics = useMemo(() => {
    return clinics.filter((clinic) => {
      const searchValue =
        `${clinic.name} ${clinic.id} ${clinic.location} ${clinic.contact} ${clinic.phone} ${clinic.note} ${clinic.statusLabel}`.toLowerCase();
      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || clinic.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [clinics, searchTerm, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredClinics.length / pageSize));
  const paginatedClinics = filteredClinics.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );
  const startItem =
    filteredClinics.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, filteredClinics.length);
  const activeCount = clinics.filter((c) => c.status === "active").length;
  const pendingCount = clinics.filter((c) => c.status === "pending").length;
  const overdueCount = clinics.filter((c) => c.status === "overdue").length;

  const handleStatusFilter = (status) => {
    setStatusFilter(status);
    setCurrentPage(1);
  };

  const handleCreateClinic = async (e) => {
    e.preventDefault();

    if (
      !newClinic.name.trim() ||
      !newClinic.location.trim() ||
      !newClinic.contact.trim() ||
      !newClinic.phone.trim()
    ) {
      showToast("Please complete the required clinic fields.");
      return;
    }

    // Location stays optional, but a PARTIAL or out-of-range entry is caught
    // here so the admin is told, rather than the coordinates being dropped.
    const enteredLocation =
      String(newClinic.latitude).trim() !== "" ||
      String(newClinic.longitude).trim() !== "";
    if (enteredLocation) {
      const check = validateClinicLocation(newClinic);
      if (!check.ok) {
        setNewClinicErrors(check.errors);
        showToast("Check the clinic location before saving.");
        return;
      }
    }
    setNewClinicErrors({});

    setSaving(true);
    try {
      if (await clinicNameExists(newClinic.name)) {
        showToast("A clinic with this name already exists.");
        return;
      }

      const clinicId = `CLN-${Math.floor(1000 + Math.random() * 8999)}`;
      await addClinic({
        clinicId,
        name: newClinic.name,
        location: newClinic.location,
        area: newClinic.area,
        contact: newClinic.contact,
        phone: newClinic.phone,
        email: newClinic.email,
        deliveryNotes: newClinic.deliveryNotes,
        status: newClinic.status,
        latitude: newClinic.latitude,
        longitude: newClinic.longitude,
        geofenceRadiusM: newClinic.geofenceRadiusM,
      });

      // Same dismissal path as Escape/Cancel/close, so a successful
      // registration also resets the draft and hands focus back to the opener.
      closeNewClinic();
      setCurrentPage(1);
      showToast(`${newClinic.name.trim()} has been registered.`);
    } catch (error) {
      console.error("Add clinic error:", error);
      showToast("Failed to register clinic. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inventory-page clinics-shell">
      <AdminSidebar active="clinics" onLogout={handleLogout} />

      <main className="clinics-v2-main">
        {toast && <div className="clinics-toast">{toast}</div>}

        <header className="clinics-v2-topbar">
          <div>
            <h1>Clinic Management</h1>
            <p>Manage and monitor affiliated healthcare facilities.</p>
          </div>

          <div className="clinics-v2-top-actions">
            <div className="clinics-v2-search">
              <Search size={15} />
              <input
                placeholder="Search clinics..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
              />
            </div>

            <button
              type="button"
              className="clinics-icon-btn"
              onClick={() => showToast("No new clinic notifications.")}
            >
              <Bell size={15} />
              <span></span>
            </button>

            <button
              type="button"
              className="clinics-icon-btn"
              onClick={() =>
                showToast("Tip: Click any clinic row to view details.")
              }
            >
              <CircleHelp size={15} />
            </button>

            <button
              type="button"
              className="clinics-v2-primary-btn"
              onClick={(e) => openNewClinic(e.currentTarget)}
            >
              <Plus size={15} />
              Register New Clinic
            </button>
          </div>
        </header>

        <section className="clinics-summary-grid">
          <KpiCard
            label="Total clinics"
            value={clinics.length}
            context="Affiliated facilities"
            tone="neutral"
            onClick={() => handleStatusFilter("all")}
          />
          <KpiCard
            label="Active clinics"
            value={activeCount}
            context="Ready for deliveries"
            tone="success"
            onClick={() => handleStatusFilter("active")}
          />
          <KpiCard
            label="Pending resupply"
            value={pendingCount}
            context="Needs stock review"
            tone="warning"
            onClick={() => handleStatusFilter("pending")}
          />
          <KpiCard
            label="Overdue delivery"
            value={overdueCount}
            context="Requires follow-up"
            tone="danger"
            attention
            onClick={() => handleStatusFilter("overdue")}
          />
        </section>

        <section className="clinics-v2-toolbar">
          <div className="clinics-filter-buttons">
            <button
              type="button"
              className={statusFilter === "all" ? "active" : ""}
              onClick={() => handleStatusFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={statusFilter === "active" ? "active" : ""}
              onClick={() => handleStatusFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              className={statusFilter === "pending" ? "active" : ""}
              onClick={() => handleStatusFilter("pending")}
            >
              Pending Resupply
            </button>
            <button
              type="button"
              className={statusFilter === "overdue" ? "active" : ""}
              onClick={() => handleStatusFilter("overdue")}
            >
              Overdue
            </button>
          </div>

          <button
            type="button"
            className="clinics-view-btn"
            onClick={() => showToast("Grid view can be added later.")}
          >
            <Grid3X3 size={15} />
          </button>
        </section>

        <section className="clinics-v2-table-card">
          <table className="clinics-v2-table">
            <thead>
              <tr>
                <th>Clinic name</th>
                <th>Location</th>
                <th>Contact person</th>
                <th>Last delivery</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {paginatedClinics.map((clinic) => (
                <tr
                  key={clinic.id}
                  className={`clinic-row-${clinic.status}`}
                  onClick={() => setSelectedClinic(clinic)}
                >
                  <td>
                    <div className="clinic-name-cell">
                      <div className="clinic-icon">
                        <Building2 size={17} />
                      </div>
                      <div>
                        <strong>{clinic.name}</strong>
                        <small>ID: {clinic.id}</small>
                      </div>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-location-cell">
                      <strong>{clinic.location}</strong>
                      <small>{clinic.area}</small>
                      <span
                        className={`clinic-geo-chip ${
                          clinic.locationInfo.hasCoordinates
                            ? "verified"
                            : "missing"
                        }`}
                      >
                        <MapPin size={11} aria-hidden="true" />
                        {clinic.locationInfo.hasCoordinates
                          ? "Location verified"
                          : "Needs location"}
                      </span>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-contact-cell">
                      <div
                        className={`clinic-contact-avatar ${clinic.contactTone}`}
                      >
                        {clinic.initials}
                      </div>
                      <div>
                        <strong>{clinic.contact}</strong>
                        <small>{clinic.phone}</small>
                      </div>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-delivery-cell">
                      <strong>{clinic.lastDelivery}</strong>
                      <small
                        className={
                          clinic.status === "overdue" ? "danger" : ""
                        }
                      >
                        {clinic.note}
                      </small>
                    </div>
                  </td>

                  <td>
                    <span className={`clinic-status-pill ${clinic.status}`}>
                      {clinic.statusLabel}
                    </span>
                  </td>

                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="clinic-row-actions">
                      <button
                        type="button"
                        onClick={() => setSelectedClinic(clinic)}
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        onClick={(e) =>
                          openManageLocation(clinic, e.currentTarget)
                        }
                      >
                        Manage location
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {loading && (
            <div className="clinics-empty">
              <Building2 size={28} />
              <strong>Loading clinics...</strong>
            </div>
          )}

          {!loading && loadError && (
            <div className="clinics-empty">
              <Building2 size={28} />
              <strong>Could not load clinics</strong>
              <p>{loadError}</p>
            </div>
          )}

          {!loading && !loadError && filteredClinics.length === 0 && (
            <div className="clinics-empty">
              <Building2 size={28} />
              <strong>
                {clinics.length === 0
                  ? "No clinics registered yet."
                  : "No clinics found"}
              </strong>
              <p>
                {clinics.length === 0
                  ? "Register a clinic to get started."
                  : "Try changing the search keyword or selected status filter."}
              </p>
            </div>
          )}

          <div className="clinics-v2-pagination">
            <p>
              Showing {startItem} to {endItem} of {filteredClinics.length}{" "}
              clinics
            </p>

            <div>
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() =>
                  setCurrentPage((prev) => Math.max(prev - 1, 1))
                }
              >
                <ChevronLeft size={14} />
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                (page) => (
                  <button
                    key={page}
                    type="button"
                    className={currentPage === page ? "active" : ""}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                )
              )}

              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() =>
                  setCurrentPage((prev) => Math.min(prev + 1, totalPages))
                }
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
      </main>

      {selectedClinic && (
        <ClinicDetailsModal
          clinic={selectedClinic}
          onClose={() => setSelectedClinic(null)}
          onEdit={() => showToast(`Editing ${selectedClinic.name}.`)}
        />
      )}

      {showNewClinicModal && (
        <NewClinicModal
          newClinic={newClinic}
          setNewClinic={setNewClinic}
          errors={newClinicErrors}
          onClose={closeNewClinic}
          onSubmit={handleCreateClinic}
          saving={saving}
        />
      )}

      {managedClinic && (
        <ManageLocationModal
          clinic={managedClinic}
          onClose={closeManageLocation}
          onSave={handleSaveLocation}
        />
      )}
    </div>
  );
}

/**
 * Edit the location of an EXISTING clinic.
 *
 * Reuses [ClinicLocationSection] rather than restating the picker, so the map,
 * the numeric fallback and the radius rules stay in one place. Saves through
 * `updateClinicLocation`, which writes only the location fields — clinic name,
 * contact, status and notes are untouched, and no new clinic can be created.
 */
function ManageLocationModal({ clinic, onClose, onSave }) {
  const initial = useMemo(
    () => ({
      latitude:
        clinic.locationInfo.latitude === null
          ? ""
          : String(clinic.locationInfo.latitude),
      longitude:
        clinic.locationInfo.longitude === null
          ? ""
          : String(clinic.locationInfo.longitude),
      // Seed from the RAW stored radius when there is one, so a corrupt value
      // is visible and rejected rather than silently shown as the default.
      geofenceRadiusM: String(
        clinic.locationInfo.geofenceRadiusMStored ??
          clinic.locationInfo.geofenceRadiusM
      ),
    }),
    [clinic]
  );

  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dialogRef = useRef(null);
  const headingId = `manage-location-${clinic.firestoreId}`;

  const isDirty =
    draft.latitude !== initial.latitude ||
    draft.longitude !== initial.longitude ||
    draft.geofenceRadiusM !== initial.geofenceRadiusM;

  const requestClose = useCallback(() => {
    if (saving) return; // never abandon an in-flight write
    if (isDirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [saving, isDirty, onClose]);

  // Escape closes when safe (unsaved edits ask first), and Tab is cycled inside
  // the dialog. The trap is not optional decoration: this element declares
  // aria-modal="true", which tells assistive tech the rest of the page is
  // inert. Letting Tab walk out into the clinics table behind would make that
  // promise false.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const items = [
        ...root.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => !el.disabled && el.getClientRects().length > 0);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  // Move focus into the dialog on open.
  useEffect(() => {
    const first = dialogRef.current?.querySelector(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    );
    first?.focus();
  }, []);

  const patchDraft = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSaveError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const check = validateClinicLocation(draft);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveError("");
    try {
      await onSave(clinic, draft);
    } catch (error) {
      console.error("Update clinic location error:", error);
      setSaveError(
        error?.message || "The location could not be saved. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="clinics-modal-backdrop">
      <form
        ref={dialogRef}
        // `clinics-location-modal` scopes the viewport-aware height + scrolling
        // rules to THIS dialog. `.clinics-form-modal` is shared with the
        // Register-Clinic modal, so styling that class instead would silently
        // restyle an unrelated dialog.
        className="clinics-modal clinics-form-modal clinics-location-modal"
        onSubmit={handleSubmit}
        // Native constraint validation is disabled so `validateClinicLocation`
        // is the SINGLE authority. Without this, the radius input's min/max
        // silently blocked submission before React ran, so an out-of-range
        // radius produced a browser tooltip instead of the styled,
        // aria-describedby-linked error — and only for radius, since the
        // coordinate inputs have no native bounds. The min/max attributes stay
        // as affordances (spinner steps, mobile keypad), not as gatekeepers.
        noValidate
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <button
          type="button"
          className="clinics-modal-close"
          onClick={requestClose}
          disabled={saving}
          aria-label="Close manage location"
        >
          <X size={16} />
        </button>

        <h3 id={headingId}>Manage location</h3>
        <p className="clinics-modal-sub">
          {clinic.name} · {clinic.location}
        </p>

        {/* Scrollable body. The dialog is capped to the viewport height, so
            without this the map + fields push the footer off-screen and Save
            becomes unreachable on short viewports — and the page cannot be
            scrolled to it, because the backdrop is position:fixed. Keeping the
            actions OUTSIDE this element pins them, so Save stays reachable even
            while the pointer is over the map (Leaflet consumes wheel events to
            zoom, which is preserved deliberately). */}
        <div className="clinics-modal-body">
          <ClinicLocationSection
            value={draft}
            onChange={patchDraft}
            errors={errors}
            disabled={saving}
            idPrefix={`manage-${clinic.firestoreId}`}
          />

          {saveError && (
            <p className="clinic-loc-save-error" role="alert">
              {saveError}
            </p>
          )}

          {confirmingDiscard && (
            <div className="clinic-loc-discard" role="alert">
              <p>Discard the unsaved location changes?</p>
              <div className="clinic-loc-discard-actions">
                <button
                  type="button"
                  className="clinics-light-action"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="clinics-danger-action"
                  onClick={onClose}
                >
                  Discard changes
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="clinics-modal-actions">
          <button
            type="submit"
            className="clinics-primary-action"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save location"}
          </button>
          <button
            type="button"
            className="clinics-light-action"
            onClick={requestClose}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function ClinicDetailsModal({ clinic, onClose, onEdit }) {
  return (
    <div className="clinics-modal-backdrop">
      <div className="clinics-modal">
        <button
          type="button"
          className="clinics-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className={`clinics-modal-icon ${clinic.status}`}>
          <Building2 size={24} />
        </div>

        <h2>{clinic.name}</h2>
        <p>
          Clinic ID: {clinic.id} • {clinic.area}
        </p>

        <div className="clinics-modal-grid">
          <div>
            <span>Location</span>
            <strong>{clinic.location}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong>{clinic.statusLabel}</strong>
          </div>
          <div>
            <span>Contact Person</span>
            <strong>{clinic.contact}</strong>
          </div>
          <div>
            <span>Phone</span>
            <strong>{clinic.phone}</strong>
          </div>
          <div>
            <span>Email</span>
            <strong>{clinic.email}</strong>
          </div>
          <div>
            <span>Last Delivery</span>
            <strong>{clinic.lastDelivery}</strong>
          </div>
          <div className="wide">
            <span>Delivery Notes</span>
            <strong>{clinic.deliveryNotes}</strong>
          </div>
        </div>

        {/* Deliveries are not started from Admin Clinics. They originate in the
            normal order workflow: Sales Rep order → Dispatcher assignment →
            Rider delivery. The former delivery-draft action here only showed a
            toast and drafted nothing, so it was removed rather than replaced. */}
        <div className="clinics-modal-actions">
          <button
            type="button"
            className="clinics-light-action"
            onClick={onEdit}
          >
            <Edit size={15} />
            Edit Clinic
          </button>
          <button
            type="button"
            className="clinics-light-action"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function NewClinicModal({
  newClinic,
  setNewClinic,
  errors = {},
  onClose,
  onSubmit,
  saving,
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dialogRef = useRef(null);
  const headingId = "new-clinic-heading";

  // Dirty = ANY user-editable registration or location field differs from the
  // values the dialog opens with. Comparing key-by-key against EMPTY_CLINIC,
  // rather than tracking a "touched" flag, gets two things right: opening the
  // dialog and changing nothing stays pristine even though `area` and `status`
  // are pre-filled, and no field can be forgotten — EMPTY_CLINIC is the same
  // object the draft is seeded from, so a field added there is covered here.
  const isDirty = Object.keys(EMPTY_CLINIC).some(
    (key) => String(newClinic[key] ?? "") !== String(EMPTY_CLINIC[key] ?? "")
  );

  // The single dismissal gate. Escape, the close control and Cancel all route
  // through it, so one keystroke or misclick can never throw away a partially
  // typed registration — and there is only ever one close path to reason about.
  const requestClose = useCallback(() => {
    if (saving) return; // never abandon an in-flight write
    if (isDirty) {
      // Setting an already-true boolean is a no-op, so repeated Escapes cannot
      // stack confirmations.
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [saving, isDirty, onClose]);

  // Escape closes when safe (unsaved edits ask first), and Tab is cycled inside
  // the dialog. The trap is not optional decoration: this element declares
  // aria-modal="true", which tells assistive tech the rest of the page is
  // inert. Letting Tab walk out into the clinics table behind would make that
  // promise false.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const items = [
        ...root.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => !el.disabled && el.getClientRects().length > 0);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  // Move focus into the dialog on open.
  useEffect(() => {
    const first = dialogRef.current?.querySelector(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    );
    first?.focus();
  }, []);

  return (
    <div className="clinics-modal-backdrop">
      {/* noValidate: the clinic + location validators own all feedback, so a
          native tooltip can never pre-empt the styled inline errors. */}
      <form
        ref={dialogRef}
        // `clinics-register-modal` scopes the viewport-aware height + scrolling
        // rules to THIS dialog. `.clinics-form-modal` is shared with the
        // Manage-location dialog, so styling that class would couple the two.
        className="clinics-modal clinics-form-modal clinics-register-modal"
        onSubmit={onSubmit}
        noValidate
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <button
          type="button"
          className="clinics-modal-close"
          onClick={requestClose}
          disabled={saving}
          aria-label="Close register new clinic"
        >
          <X size={18} />
        </button>

        <h2 id={headingId}>Register New Clinic</h2>
        <p>Add a healthcare facility to the VaxTrack delivery network.</p>

        {/* Scrollable body. Same structure as the Manage-location dialog, and
            needed more here: this modal is taller (registration fields PLUS the
            same location picker), so without a viewport cap its footer - and
            therefore Register - fell outside a short viewport with no way to
            reach it. The backdrop is position:fixed so the page cannot scroll to
            it, and wheel input over the map is consumed by Leaflet for zooming.
            The action row stays OUTSIDE this element so it remains pinned. */}
        <div className="clinics-modal-body">
          <div className="clinics-form-grid">
            <label>
              Clinic Name
              <input
                type="text"
                placeholder="Enter clinic or hospital name"
                value={newClinic.name}
                onChange={(e) =>
                  setNewClinic((prev) => ({ ...prev, name: e.target.value }))
                }
                disabled={saving}
              />
            </label>

            <label>
              Contact Person
              <input
                type="text"
                placeholder="Dr. Maria Santos"
                value={newClinic.contact}
                onChange={(e) =>
                  setNewClinic((prev) => ({
                    ...prev,
                    contact: e.target.value,
                  }))
                }
                disabled={saving}
              />
            </label>

            <label>
              Phone Number
              <input
                type="text"
                placeholder="0917-000-0000"
                value={newClinic.phone}
                onChange={(e) =>
                  setNewClinic((prev) => ({ ...prev, phone: e.target.value }))
                }
                disabled={saving}
              />
            </label>

            <label>
              Email
              <input
                type="email"
                placeholder="clinic@email.com"
                value={newClinic.email}
                onChange={(e) =>
                  setNewClinic((prev) => ({ ...prev, email: e.target.value }))
                }
                disabled={saving}
              />
            </label>

            <label>
              Location
              <input
                type="text"
                placeholder="Street, City"
                value={newClinic.location}
                onChange={(e) =>
                  setNewClinic((prev) => ({
                    ...prev,
                    location: e.target.value,
                  }))
                }
                disabled={saving}
              />
            </label>

            <label>
              Area
              <select
                value={newClinic.area}
                onChange={(e) =>
                  setNewClinic((prev) => ({ ...prev, area: e.target.value }))
                }
                disabled={saving}
              >
                <option>Metro Manila</option>
                <option>Laguna</option>
                <option>Cavite</option>
                <option>Batangas</option>
              </select>
            </label>

            <label>
              Status
              <select
                value={newClinic.status}
                onChange={(e) =>
                  setNewClinic((prev) => ({
                    ...prev,
                    status: e.target.value,
                  }))
                }
                disabled={saving}
              >
                <option value="active">Active</option>
                <option value="pending">Pending Resupply</option>
                <option value="overdue">Overdue</option>
              </select>
            </label>

            <label className="wide">
              Delivery Notes
              <input
                type="text"
                placeholder="Special delivery notes or cold-chain instructions"
                value={newClinic.deliveryNotes}
                onChange={(e) =>
                  setNewClinic((prev) => ({
                    ...prev,
                    deliveryNotes: e.target.value,
                  }))
                }
                disabled={saving}
              />
            </label>
          </div>

          <ClinicLocationSection
            value={newClinic}
            onChange={(patch) => setNewClinic((prev) => ({ ...prev, ...patch }))}
            errors={errors}
            disabled={saving}
            idPrefix="new-clinic"
          />
        </div>

        {/* Deliberately OUTSIDE the scrolling body, unlike the Manage-location
            dialog: this form is ~1467px tall, so a confirmation rendered inside
            the scroll area could sit far off-screen — the same class of
            unreachable-control bug the viewport fix addressed. Pinned above the
            actions, it is always visible. role="alert" announces it. */}
        {confirmingDiscard && (
          <div className="clinic-loc-discard" role="alert">
            <p>Discard this clinic registration?</p>
            <div className="clinic-loc-discard-actions">
              <button
                type="button"
                className="clinics-light-action"
                onClick={() => setConfirmingDiscard(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="clinics-danger-action"
                onClick={onClose}
              >
                Discard changes
              </button>
            </div>
          </div>
        )}

        <div className="clinics-modal-actions">
          <button
            type="submit"
            className="clinics-primary-action"
            disabled={saving}
          >
            {saving ? "Registering..." : "Register Clinic"}
          </button>

          <button
            type="button"
            className="clinics-light-action"
            onClick={requestClose}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default Clinics;
