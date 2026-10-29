import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Edit,
  LayoutGrid,
  List,
  MapPin,
  Plus,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  subscribeClinics,
  clinicNameExists,
  addClinic,
  updateClinicLocation,
  readClinicLocation,
  validateClinicLocation,
  validateEntranceDetails,
  MIN_GEOFENCE_RADIUS_M,
  MAX_GEOFENCE_RADIUS_M,
} from "../../services/clinicService";
import {
  addArea,
  setAreaActive,
  subscribeAreas,
} from "../../services/areaService";
import {
  addDoctor,
  setDoctorActive,
  subscribeDoctors,
} from "../../services/doctorService";
import { subscribeDoctorAddresses } from "../../services/doctorAddressService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { lastDeliveryIndex, lastDeliveryMs, lastDeliveryText } from "../../services/clinicDeliveries";
import KpiCard from "../../components/ui/KpiCard";
import { Notice, ToastRegion } from "../../components/ui/Feedback";
import StaleEditNotice from "../../components/ui/StaleEditNotice";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { useLiveDraft } from "../../components/useLiveDraft";
import { useToast } from "../../components/ui/useToast";
import { errorIdFor, fieldA11y, focusFirstInvalid, hasErrors } from "../../services/formValidation";
import ClinicLocationSection from "./ClinicLocationSection";
import DoctorAddressesPanel from "./DoctorAddressesPanel";
import { ClinicAccessFields, ClinicAccessResults, ManageAccessModal } from "./ClinicAccess";
import useDoctorAddressLinks from "./useDoctorAddressLinks";
import { subscribeUsers } from "../../services/userService";
import { activeDoctorLinks, approvedMedReps, clinicReach, planClinicAccess, reachLabel } from "../../services/clinicAccess";
import { applyClinicAccess } from "../../services/clinicAccessService";
import { friendlyErrorMessage, kpiValue, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import {
  CLINIC_VIEWS,
  clinicCardFields,
  clinicViewAnnouncement,
  paginateClinics,
  readClinicView,
  selectVisibleClinics,
  writeClinicView,
} from "../../services/clinicsView";
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
  const storedRadiusIsValid =
    !Object.prototype.hasOwnProperty.call(raw, "geofenceRadiusM") ||
    (Number.isInteger(raw.geofenceRadiusM) &&
      raw.geofenceRadiusM >= MIN_GEOFENCE_RADIUS_M &&
      raw.geofenceRadiusM <= MAX_GEOFENCE_RADIUS_M);
  return {
    id: raw.clinicId || raw.id || "—",
    firestoreId: raw.id || "",
    name: raw.name || "—",
    location: raw.location || "—",
    areaId: raw.areaId || "",
    // Missing values read "—" in both views — never a made-up default.
    area: raw.area || "—",
    contact: contactStr || "—",
    phone: raw.phone || "—",
    email: raw.email || "—",
    deliveryNotes: raw.deliveryNotes || "No special notes.",
    status,
    statusLabel: STATUS_LABEL[status],
    note: STATUS_NOTE[status],
    // Filled in from the orders (services/clinicDeliveries.js). The stored
    // `lastDelivery` field is a registration-time placeholder nothing updates.
    lastDelivery: "—",
    initials,
    contactTone: raw.contactTone || "blue",
    // Canonical coordinates (top-level `latitude`/`longitude` numbers), read
    // backward-compatibly: pre-radius clinics report the 300 m default, and a
    // clinic with no pin reports hasCoordinates: false rather than a fake one.
    locationInfo: readClinicLocation(raw),
    // Med Reps and doctors can only be linked to a clinic with a verified pin.
    locationVerified: raw.locationVerified === true,
    // The pin was confirmed as the entrance riders use (Manage location).
    entranceConfirmed: raw.entranceConfirmed === true,
    accessNotes: typeof raw.accessNotes === "string" ? raw.accessNotes : "",
    // Preserve whether the raw stored location passes the write contract. The
    // normalized radius alone cannot distinguish a missing radius (valid,
    // defaults to 300 m) from malformed legacy data (invalid).
    destinationLocationValid:
      Number.isFinite(raw.latitude) &&
      Number.isFinite(raw.longitude) &&
      validateClinicLocation(raw).ok &&
      storedRadiusIsValid,
  };
}

// Register-clinic validation: required fields, the order they appear on
// screen (to focus the first problem) and each input's id.
const CLINIC_REQUIRED_FIELDS = [
  ["name", "Enter the clinic or hospital name."],
  ["contact", "Enter the contact person."],
  ["phone", "Enter a phone number."],
  ["location", "Enter the clinic address."],
];
const CLINIC_FIELD_ORDER = ["name", "contact", "phone", "email", "location", "areaId", "latitude", "longitude", "geofenceRadiusM", "entranceConfirmed", "accessNotes"];
const CLINIC_FIELD_IDS = {
  name: "new-clinic-name",
  contact: "new-clinic-contact",
  phone: "new-clinic-phone",
  email: "new-clinic-email",
  location: "new-clinic-location",
  areaId: "new-clinic-area",
  latitude: "new-clinic-lat",
  longitude: "new-clinic-lng",
  geofenceRadiusM: "new-clinic-radius",
  entranceConfirmed: "new-clinic-entrance",
  accessNotes: "new-clinic-access-notes",
};

const EMPTY_CLINIC = {
  name: "",
  location: "",
  areaId: "",
  area: "",
  contact: "",
  phone: "",
  email: "",
  deliveryNotes: "",
  status: "active",
  latitude: "",
  longitude: "",
  geofenceRadiusM: "",
  entranceConfirmed: false,
  accessNotes: "",
};

const NO_LINKED_DOCTORS = Object.freeze({ doctors: [], loading: false, error: "" });
const LINKED_DOCTORS_LOADING = Object.freeze({ doctors: [], loading: true, error: "" });

function useLinkedDoctorsForClinic(
  clinicDocId,
  doctors,
  doctorsLoading,
  doctorLoadError
) {
  // What the per-doctor subscriptions last reported, tagged with the clinic and
  // doctor list they were opened for. Every other state is derived below during
  // render, so the effect only ever sets state from a subscription callback.
  const [reported, setReported] = useState({
    clinicDocId: "",
    doctors: null,
    result: NO_LINKED_DOCTORS,
  });
  const subscribing =
    Boolean(clinicDocId) && !doctorsLoading && !doctorLoadError && doctors.length > 0;

  useEffect(() => {
    if (!subscribing) return undefined;
    let mounted = true;

    const linkedByDoctorId = new Map();
    const settledDoctorIds = new Set();
    const failedDoctorIds = new Set();

    const publish = () => {
      if (!mounted) return;
      const linkedDoctors = doctors
        .filter((doctor) => linkedByDoctorId.get(doctor.id) === true)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      setReported({
        clinicDocId,
        doctors,
        result: {
          doctors: linkedDoctors,
          loading: settledDoctorIds.size < doctors.length,
          error:
            failedDoctorIds.size > 0
              ? "Some doctor links could not be loaded. Close and reopen this clinic to try again."
              : "",
        },
      });
    };

    const unsubscribes = doctors.map((doctor) =>
      subscribeDoctorAddresses(
        doctor.id,
        (destinations) => {
          settledDoctorIds.add(doctor.id);
          failedDoctorIds.delete(doctor.id);
          linkedByDoctorId.set(
            doctor.id,
            destinations.some(
              (destination) =>
                destination.destinationType === "clinic" &&
                destination.clinicDocId === clinicDocId &&
                destination.active === true
            )
          );
          publish();
        },
        () => {
          settledDoctorIds.add(doctor.id);
          failedDoctorIds.add(doctor.id);
          linkedByDoctorId.set(doctor.id, false);
          publish();
        }
      )
    );

    return () => {
      mounted = false;
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [clinicDocId, doctors, subscribing]);

  if (!clinicDocId) return NO_LINKED_DOCTORS;
  if (doctorsLoading) return LINKED_DOCTORS_LOADING;
  if (doctorLoadError) return { doctors: [], loading: false, error: doctorLoadError };
  if (doctors.length === 0) return NO_LINKED_DOCTORS;
  // Subscriptions for this clinic + doctor list have not reported yet.
  if (reported.clinicDocId !== clinicDocId || reported.doctors !== doctors) {
    return LINKED_DOCTORS_LOADING;
  }
  return reported.result;
}

function Clinics() {
  const [baseClinics, setClinics] = useState([]);
  // Delivered orders give each clinic its real last delivery date. Until they
  // load (or if they cannot be read) the column reads "—", never a guess.
  const [deliveredOrders, setDeliveredOrders] = useState(null);
  useEffect(() => {
    const unsubscribe = subscribeDeliveries(setDeliveredOrders, (error) => {
      logSafeError("Clinic last delivery", error);
      setDeliveredOrders(null);
    });
    return () => unsubscribe();
  }, []);
  const clinics = useMemo(() => {
    if (deliveredOrders === null) return baseClinics;
    const index = lastDeliveryIndex(deliveredOrders);
    return baseClinics.map((c) => ({ ...c, lastDelivery: lastDeliveryText(lastDeliveryMs(index, c)) }));
  }, [baseClinics, deliveredOrders]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  // List / Grid: a per-browser UI preference (services/clinicsView.js). It
  // only changes the markup; the clinics shown come from the same live list.
  const [view, setView] = useState(() => readClinicView());
  const [viewAnnouncement, setViewAnnouncement] = useState("");
  // Bumped by Retry: a failed listener is closed for good, so retrying opens
  // a new one rather than only clearing the message.
  const [retryKey, setRetryKey] = useState(0);
  const [selectedClinic, setSelectedClinic] = useState(null);
  const [showNewClinicModal, setShowNewClinicModal] = useState(false);
  const [showAreasModal, setShowAreasModal] = useState(false);
  const [showDoctorsModal, setShowDoctorsModal] = useState(false);
  const [areas, setAreas] = useState([]);
  const [areasLoading, setAreasLoading] = useState(true);
  const [areaLoadError, setAreaLoadError] = useState("");
  const [doctors, setDoctors] = useState([]);
  const [doctorsLoading, setDoctorsLoading] = useState(true);
  const [doctorLoadError, setDoctorLoadError] = useState("");
  const { toast, showToast, dismissToast } = useToast();
  const creatingRef = useRef(false);
  const [newClinic, setNewClinic] = useState(EMPTY_CLINIC);
  const [newClinicErrors, setNewClinicErrors] = useState({});
  // The clinic whose location is being managed, plus the element to restore
  // focus to when the dialog closes.
  const [managedClinic, setManagedClinic] = useState(null);
  const manageTriggerRef = useRef(null);
  // "Who can order here": the clinic whose Med Reps/doctors are being managed,
  // and the selections made while registering a new clinic.
  const [accessClinic, setAccessClinic] = useState(null);
  const accessTriggerRef = useRef(null);
  const [newClinicAccess, setNewClinicAccess] = useState({ repUids: [], doctorIds: [] });
  const [newClinicResults, setNewClinicResults] = useState(null);
  const [users, setUsers] = useState([]);
  useEffect(
    () =>
      subscribeUsers(setUsers, (error) => {
        logSafeError("Clinic access: users", error);
        setUsers([]);
      }),
    []
  );
  const medReps = useMemo(() => approvedMedReps(users), [users]);
  const { addressesByDoctor, ready: linksReady } = useDoctorAddressLinks(doctors);
  const doctorLinks = useMemo(() => activeDoctorLinks(addressesByDoctor), [addressesByDoctor]);
  const reachOf = (clinic) =>
    linksReady ? reachLabel(clinicReach({ id: clinic.firestoreId, areaId: clinic.areaId }, medReps, doctorLinks, doctors)) : null;

  const openManageAccess = (clinic, triggerEl) => {
    accessTriggerRef.current = triggerEl;
    setAccessClinic(clinic);
  };
  const closeManageAccess = useCallback(() => {
    setAccessClinic(null);
    if (accessTriggerRef.current) {
      accessTriggerRef.current.focus();
      accessTriggerRef.current = null;
    }
  }, []);
  // The control that opened the registration dialog, so focus can be handed
  // back to it on dismissal.
  const newClinicTriggerRef = useRef(null);
  const areasTriggerRef = useRef(null);
  const doctorsTriggerRef = useRef(null);
  const linkedDoctors = useLinkedDoctorsForClinic(
    selectedClinic?.firestoreId || "",
    doctors,
    doctorsLoading,
    doctorLoadError
  );

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

  const openAreas = (triggerEl) => {
    areasTriggerRef.current = triggerEl;
    setShowAreasModal(true);
  };

  const closeAreas = useCallback(() => {
    setShowAreasModal(false);
    if (areasTriggerRef.current) {
      areasTriggerRef.current.focus();
      areasTriggerRef.current = null;
    }
  }, []);

  const openDoctors = (triggerEl) => {
    doctorsTriggerRef.current = triggerEl;
    setShowDoctorsModal(true);
  };

  const closeDoctors = useCallback(() => {
    setShowDoctorsModal(false);
    if (doctorsTriggerRef.current) {
      doctorsTriggerRef.current.focus();
      doctorsTriggerRef.current = null;
    }
  }, []);

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
    setNewClinicAccess({ repUids: [], doctorIds: [] });
    setNewClinicResults(null);
    // Return focus to the button that opened the dialog. Without this, focus
    // falls back to <body> and a keyboard user restarts from the top of the
    // page — the dialog declares aria-modal, so it owed them that focus back.
    if (newClinicTriggerRef.current) {
      newClinicTriggerRef.current.focus();
      newClinicTriggerRef.current = null;
    }
  }, [setNewClinicAccess, setNewClinicResults]);

  const handleSaveLocation = async (clinic, draft) => {
    // subscribeClinics remains the source of truth — no local clinic list
    // mutation here; the snapshot re-renders the row.
    await updateClinicLocation(clinic.firestoreId, draft);
    showToast(`Location saved for ${clinic.name}.`, "success");
    closeManageLocation();
  };

  // The ONE clinics listener. It depends on retryKey only — changing the view,
  // search, filter or page never opens another one.
  useEffect(() => {
    const unsubscribe = subscribeClinics(
      (raw) => {
        setClinics(raw.map(normalizeClinic));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(liveErrorMessage(error, "clinics"));
      }
    );
    return () => unsubscribe();
  }, [retryKey]);

  const retryClinics = () => {
    setLoadError("");
    setLoading(true);
    setRetryKey((k) => k + 1);
  };

  // Switching views keeps search, filter, page, the selected clinic and the
  // scroll position; it is announced politely, never with a toast.
  const changeView = (next) => {
    if (!CLINIC_VIEWS.includes(next) || next === view) return;
    setView(next);
    writeClinicView(next);
    setViewAnnouncement(clinicViewAnnouncement(next));
  };

  useEffect(() => {
    const unsubscribe = subscribeAreas(
      (docs) => {
        setAreas(docs);
        setAreasLoading(false);
        setAreaLoadError("");
      },
      (error) => {
        setAreasLoading(false);
        setAreaLoadError(liveErrorMessage(error, "areas"));
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeDoctors(
      (docs) => {
        setDoctors(docs);
        setDoctorsLoading(false);
        setDoctorLoadError("");
      },
      (error) => {
        setDoctorsLoading(false);
        setDoctorLoadError(liveErrorMessage(error, "doctors"));
      }
    );
    return () => unsubscribe();
  }, []);

  // One collection for both views: same search, same filter, same order,
  // same page. Only the markup below differs between List and Grid.
  const filteredClinics = useMemo(
    () => selectVisibleClinics(clinics, { searchTerm, statusFilter }),
    [clinics, searchTerm, statusFilter]
  );
  const paging = paginateClinics(filteredClinics, currentPage);
  const { totalPages, startItem, endItem } = paging;
  const pageNow = paging.page;
  const paginatedClinics = paging.items;
  const activeCount = clinics.filter((c) => c.status === "active").length;
  const pendingCount = clinics.filter((c) => c.status === "pending").length;
  const overdueCount = clinics.filter((c) => c.status === "overdue").length;

  const handleStatusFilter = (status) => {
    setStatusFilter(status);
    setCurrentPage(1);
  };

  const handleCreateClinic = async (e) => {
    e.preventDefault();
    if (creatingRef.current) return;

    if (areasLoading) {
      setNewClinicErrors({ form: "Areas are still loading. Wait a moment, then register the clinic." });
      return;
    }
    const selectedArea = areas.find(
      (area) => area.id === newClinic.areaId && area.active === true
    );

    // Every problem at once, each beside its own field; focus goes to the
    // first one. Nothing typed is cleared.
    const fieldErrors = {};
    for (const [key, message] of CLINIC_REQUIRED_FIELDS) {
      if (!String(newClinic[key] ?? "").trim()) fieldErrors[key] = message;
    }
    if (!selectedArea) fieldErrors.areaId = "Select an active area for this clinic.";

    // Location stays optional, but a PARTIAL or out-of-range entry is caught
    // here so the admin is told, rather than the coordinates being dropped.
    const enteredLocation =
      String(newClinic.latitude).trim() !== "" ||
      String(newClinic.longitude).trim() !== "";
    if (enteredLocation) {
      const check = validateClinicLocation(newClinic);
      if (!check.ok) Object.assign(fieldErrors, check.errors);
      // A pin is saved only with the entrance confirmation.
      const entrance = validateEntranceDetails(newClinic);
      if (!entrance.ok) Object.assign(fieldErrors, entrance.errors);
    }
    if (hasErrors(fieldErrors)) {
      setNewClinicErrors({ ...fieldErrors, form: "Check the highlighted fields. Nothing was saved." });
      focusFirstInvalid(CLINIC_FIELD_ORDER, fieldErrors, (key) => document.getElementById(CLINIC_FIELD_IDS[key]));
      return;
    }
    setNewClinicErrors({});

    creatingRef.current = true;
    setSaving(true);
    try {
      if (await clinicNameExists(newClinic.name)) {
        const duplicate = { name: "A clinic with this name already exists. Use a different name." };
        setNewClinicErrors({ ...duplicate, form: "Nothing was saved." });
        focusFirstInvalid(CLINIC_FIELD_ORDER, duplicate, (key) => document.getElementById(CLINIC_FIELD_IDS[key]));
        return;
      }

      const clinicId = `CLN-${Math.floor(1000 + Math.random() * 8999)}`;
      const clinicRef = await addClinic({
        clinicId,
        name: newClinic.name,
        location: newClinic.location,
        areaId: selectedArea.id,
        area: selectedArea.name,
        contact: newClinic.contact,
        phone: newClinic.phone,
        email: newClinic.email,
        deliveryNotes: newClinic.deliveryNotes,
        status: newClinic.status,
        latitude: newClinic.latitude,
        longitude: newClinic.longitude,
        geofenceRadiusM: newClinic.geofenceRadiusM,
        entranceConfirmed: newClinic.entranceConfirmed,
        accessNotes: newClinic.accessNotes,
      });

      // "Who can order here": link the ticked Med Reps and doctors now. Each link
      // is its own transaction after the clinic exists; a failed link never
      // undoes the registration and is reported so it can be retried from
      // Manage access.
      const name = newClinic.name.trim();
      const wantsLinks = newClinicAccess.repUids.length > 0 || newClinicAccess.doctorIds.length > 0;
      const pinned = String(newClinic.latitude).trim() !== "" && String(newClinic.longitude).trim() !== "";
      let results = [];
      if (wantsLinks && pinned && clinicRef?.id) {
        const plan = planClinicAccess({
          clinic: { id: clinicRef.id, areaId: selectedArea.id, locationVerified: true },
          medReps,
          selectedRepUids: newClinicAccess.repUids,
          doctors,
          addressesByDoctor: {},
          selectedDoctorIds: newClinicAccess.doctorIds,
        });
        results = await applyClinicAccess(clinicRef.id, plan);
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        // Keep the dialog open on the results: the clinic IS registered.
        setNewClinicResults(results);
        setNewClinicErrors({
          form: `${name} has been registered, but ${failed.length} link${failed.length === 1 ? "" : "s"} could not be saved. Close this and use Manage access on the clinic to retry.`,
        });
        setCurrentPage(1);
        return;
      }
      // Same dismissal path as Escape/Cancel/close, so a successful
      // registration also resets the draft and hands focus back to the opener.
      closeNewClinic();
      setCurrentPage(1);
      const count = (kind, one) => {
        const n = results.filter((r) => r.kind === kind).length;
        return n ? `${n} ${one}${n === 1 ? "" : "s"}` : "";
      };
      const linkedParts = [count("rep-add", "Med Rep"), count("doctor-link", "doctor")].filter(Boolean);
      const linked = linkedParts.length ? ` Linked ${linkedParts.join(" and ")}.` : "";
      showToast(`${name} has been registered.${linked}`, "success");
    } catch (error) {
      logSafeError("Register clinic", error);
      // The dialog stays open with everything the admin typed.
      setNewClinicErrors({
        form: friendlyErrorMessage(
          error,
          "The clinic could not be registered. Your entries are still here — please try again."
        ),
      });
    } finally {
      creatingRef.current = false;
      setSaving(false);
    }
  };

  const handleAddArea = async (name) => {
    try {
      await addArea(name);
      showToast("Area added.", "success");
      return "";
    } catch (error) {
      logSafeError("Add area", error);
      return friendlyErrorMessage(error, "Failed to add area. Please try again.");
    }
  };

  const handleAreaStatus = async (area) => {
    try {
      await setAreaActive(area.id, !area.active);
      showToast(`${area.name} is now ${area.active ? "inactive" : "active"}.`, "success");
      return "";
    } catch (error) {
      logSafeError("Update area", error);
      return friendlyErrorMessage(error, "Failed to update the area. Please try again.");
    }
  };

  const handleAddDoctor = async ({ name, areaId }) => {
    try {
      await addDoctor({ name, areaId });
      showToast("Doctor added.", "success");
      return "";
    } catch (error) {
      logSafeError("Add doctor", error);
      return friendlyErrorMessage(error, "Failed to add doctor. Please try again.");
    }
  };

  const handleDoctorStatus = async (doctor) => {
    try {
      await setDoctorActive(doctor.id, !doctor.active);
      showToast(
        `${doctor.name} is now ${doctor.active ? "inactive" : "active"}.`,
        "success"
      );
      return "";
    } catch (error) {
      logSafeError("Update doctor", error);
      return friendlyErrorMessage(error, "Failed to update the doctor. Please try again.");
    }
  };

  return (
    <>
    <main className="clinics-v2-main">
        <ToastRegion toast={toast} onDismiss={dismissToast} />

        <header className="clinics-v2-topbar">
          <div className="clinics-v2-search">
            <Search size={15} />
            <input
              aria-label="Search clinics"
              placeholder="Search clinics..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>

          <div className="clinics-v2-top-actions">
            <button
              type="button"
              className="clinics-icon-btn"
              aria-label="How to view a clinic's details"
              onClick={() =>
                showToast("Tip: select any clinic row to view its details, doctors and location.", "info")
              }
            >
              <CircleHelp size={15} />
            </button>

            <button
              type="button"
              className="clinics-v2-secondary-btn"
              onClick={(e) => openAreas(e.currentTarget)}
            >
              <MapPin size={15} />
              Manage Areas
            </button>

            <button
              type="button"
              className="clinics-v2-secondary-btn"
              onClick={(e) => openDoctors(e.currentTarget)}
            >
              <UserRound size={15} />
              Manage Doctors
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
            value={kpiValue(clinics.length, { loading, error: loadError })}
            context="Affiliated facilities"
            tone="neutral"
            onClick={() => handleStatusFilter("all")}
          />
          <KpiCard
            label="Active clinics"
            value={kpiValue(activeCount, { loading, error: loadError })}
            context="Ready for deliveries"
            tone="success"
            onClick={() => handleStatusFilter("active")}
          />
          <KpiCard
            label="Pending resupply"
            value={kpiValue(pendingCount, { loading, error: loadError })}
            context="Needs stock review"
            tone="warning"
            onClick={() => handleStatusFilter("pending")}
          />
          <KpiCard
            label="Overdue delivery"
            value={kpiValue(overdueCount, { loading, error: loadError })}
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

          {/* Two real views of the same clinics. Visible labels, aria-pressed
              for the selected one, native buttons for keyboard use. */}
          <div className="clinics-view-toggle" role="group" aria-label="Clinic display view">
            <button
              type="button"
              aria-pressed={view === "list"}
              className={view === "list" ? "active" : ""}
              onClick={() => changeView("list")}
            >
              <List size={15} aria-hidden="true" />
              List
            </button>
            <button
              type="button"
              aria-pressed={view === "grid"}
              className={view === "grid" ? "active" : ""}
              onClick={() => changeView("grid")}
            >
              <LayoutGrid size={15} aria-hidden="true" />
              Grid
            </button>
          </div>
          <p className="m-visually-hidden" aria-live="polite">
            {viewAnnouncement}
          </p>
        </section>

        <section className={`clinics-v2-table-card${view === "grid" ? " is-grid" : ""}`}>
          {view === "list" ? (
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
                        <ReachChip reach={reachOf(clinic)} />
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
                      {clinic.locationInfo.hasCoordinates && !clinic.entranceConfirmed && (
                        <span className="clinic-reach-chip warn">Entrance not confirmed</span>
                      )}
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
                      <button
                        type="button"
                        onClick={(e) => openManageAccess(clinic, e.currentTarget)}
                      >
                        Manage access
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          ) : (
            <ul className="clinics-grid" aria-label="Clinics">
              {paginatedClinics.map((clinic) => (
                <ClinicCard
                  key={clinic.id}
                  clinic={clinic}
                  onDetails={() => setSelectedClinic(clinic)}
                  onManageLocation={(trigger) => openManageLocation(clinic, trigger)}
                  onManageAccess={(trigger) => openManageAccess(clinic, trigger)}
                  reach={reachOf(clinic)}
                />
              ))}
            </ul>
          )}

          {loading && (
            <div className="clinics-empty" role="status">
              <Building2 size={28} aria-hidden="true" />
              <strong>Loading clinics...</strong>
            </div>
          )}

          {!loading && loadError && (
            <div className="clinics-load-error">
              <Notice tone="error" title="Could not load clinics">
                {loadError}
              </Notice>
              <button type="button" className="clinics-v2-secondary-btn" onClick={retryClinics}>
                Try again
              </button>
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

          {/* No "Showing 0 of 0" while loading or after a failed read. */}
          {!loading && !loadError && (
          <div className="clinics-v2-pagination">
            <p>
              Showing {startItem} to {endItem} of {filteredClinics.length}{" "}
              clinics
            </p>

            <div>
              <button
                type="button"
                disabled={pageNow === 1}
                aria-label="Previous page"
                onClick={() => setCurrentPage(Math.max(pageNow - 1, 1))}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                (page) => (
                  <button
                    key={page}
                    type="button"
                    className={pageNow === page ? "active" : ""}
                    aria-current={pageNow === page ? "page" : undefined}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                )
              )}

              <button
                type="button"
                disabled={pageNow === totalPages}
                aria-label="Next page"
                onClick={() => setCurrentPage(Math.min(pageNow + 1, totalPages))}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          )}
        </section>
      </main>

      {selectedClinic && (
        <ClinicDetailsModal
          clinic={{
            ...selectedClinic,
            linkedDoctors: linkedDoctors.doctors,
            linkedDoctorsLoading: linkedDoctors.loading,
            linkedDoctorsError: linkedDoctors.error,
          }}
          onClose={() => setSelectedClinic(null)}
        />
      )}

      {showNewClinicModal && (
        <NewClinicModal
          newClinic={newClinic}
          setNewClinic={setNewClinic}
          areas={areas}
          areasLoading={areasLoading}
          areaLoadError={areaLoadError}
          errors={newClinicErrors}
          onFieldEdit={(key) =>
            setNewClinicErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev))
          }
          onClose={closeNewClinic}
          onSubmit={handleCreateClinic}
          saving={saving}
          medReps={medReps}
          doctors={doctors}
          access={newClinicAccess}
          onAccessChange={setNewClinicAccess}
          accessResults={newClinicResults}
        />
      )}

      {accessClinic && (
        <ManageAccessModal
          clinic={clinics.find((c) => c.firestoreId === accessClinic.firestoreId) ?? accessClinic}
          medReps={medReps}
          doctors={doctors}
          addressesByDoctor={addressesByDoctor}
          linksReady={linksReady}
          orders={deliveredOrders}
          onClose={closeManageAccess}
        />
      )}

      {showAreasModal && (
        <AreasModal
          areas={areas}
          loading={areasLoading}
          loadError={areaLoadError}
          onAdd={handleAddArea}
          onToggle={handleAreaStatus}
          onClose={closeAreas}
        />
      )}

      {showDoctorsModal && (
        <DoctorsModal
          doctors={doctors}
          loading={doctorsLoading}
          loadError={doctorLoadError}
          clinics={clinics}
          clinicsLoading={loading}
          clinicLoadError={loadError}
          areas={areas}
          areasLoading={areasLoading}
          areaLoadError={areaLoadError}
          onAdd={handleAddDoctor}
          onToggle={handleDoctorStatus}
          onToast={showToast}
          onClose={closeDoctors}
        />
      )}

      {managedClinic && (
        <ManageLocationModal
          clinic={managedClinic}
          live={clinics.find((c) => c.firestoreId === managedClinic.firestoreId) ?? null}
          onClose={closeManageLocation}
          onSave={handleSaveLocation}
        />
      )}
    </>
  );
}

/**
 * One clinic in Grid view. It shows the same values the List row shows (plus
 * the stored email) and offers the same actions — Details and Manage
 * location. A missing value reads "—". Clicking the card body opens Details,
 * as clicking a List row does; the buttons are the keyboard path.
 */
/** "2 Med Reps · 1 doctor", or a warning that nobody can order for this clinic yet. */
function ReachChip({ reach }) {
  if (!reach) return null;
  return <span className={`clinic-reach-chip ${reach.tone}`}>{reach.text}</span>;
}

function ClinicCard({ clinic, onDetails, onManageLocation, onManageAccess, reach }) {
  const card = clinicCardFields(clinic);
  const headingId = `clinic-card-${clinic.firestoreId || clinic.id}`;
  return (
    <li className={`clinic-card clinic-card-${clinic.status}`}>
      <article aria-labelledby={headingId} onClick={onDetails}>
        <header className="clinic-card-head">
          <div className="clinic-icon" aria-hidden="true">
            <Building2 size={17} />
          </div>
          <div className="clinic-card-title">
            <h3 id={headingId}>{card.name}</h3>
            <small>ID: {card.clinicId}</small>
          </div>
          <span className={`clinic-status-pill ${clinic.status}`}>{card.statusLabel}</span>
        </header>

        <dl className="clinic-card-fields">
          <div>
            <dt>Contact person</dt>
            <dd>{card.contact}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{card.phone}</dd>
          </div>
          <div className="clinic-card-field-wide">
            <dt>Email</dt>
            <dd>{card.email}</dd>
          </div>
          <div className="clinic-card-field-wide">
            <dt>Location</dt>
            <dd>{card.location}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{card.area}</dd>
          </div>
          <div>
            <dt>Last delivery</dt>
            <dd>{card.lastDelivery}</dd>
          </div>
        </dl>

        <p className="clinic-card-meta">
          <span className={`clinic-geo-chip ${card.locationVerified ? "verified" : "missing"}`}>
            <MapPin size={11} aria-hidden="true" />
            {card.locationVerified ? "Location verified" : "Needs location"}
          </span>
          <span className={clinic.status === "overdue" ? "clinic-card-note danger" : "clinic-card-note"}>
            {card.note}
          </span>
        </p>

        <div className="clinic-row-actions clinic-card-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={onDetails} aria-label={`Details for ${card.name}`}>
            Details
          </button>
          <button
            type="button"
            onClick={(e) => onManageLocation(e.currentTarget)}
            aria-label={`Manage location for ${card.name}`}
          >
            Manage location
          </button>
          <button
            type="button"
            onClick={(e) => onManageAccess(e.currentTarget)}
            aria-label={`Manage access for ${card.name}`}
          >
            Manage access
          </button>
        </div>
        <ReachChip reach={reach} />
      </article>
    </li>
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
/** The editable location fields of a clinic as stored now. */
function locationFields(clinic) {
  return {
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
    entranceConfirmed: clinic.entranceConfirmed === true,
    accessNotes: clinic.accessNotes || "",
  };
}

const LOCATION_FIELD_LABELS = {
  latitude: "Latitude",
  longitude: "Longitude",
  geofenceRadiusM: "Geofence radius",
  entranceConfirmed: "Entrance confirmation",
  accessNotes: "Rider access notes",
};

/**
 * `clinic` is the clinic as opened; `live` is the same clinic from the live
 * list (null once it is deleted). The form follows `live` while untouched;
 * once edited, a location saved elsewhere is flagged and saving is blocked
 * until the Admin loads it or keeps their own.
 */
function ManageLocationModal({ clinic, live, onClose, onSave }) {
  const liveDraft = useLiveDraft(live ? locationFields(live) : null);
  const draft = liveDraft.draft;
  const staleLabels = liveDraft.stale.map((f) => LOCATION_FIELD_LABELS[f] ?? f);
  const blocked = staleLabels.length > 0 || liveDraft.gone;
  const savingRef = useRef(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dialogRef = useRef(null);
  const headingId = `manage-location-${clinic.firestoreId}`;

  const isDirty = liveDraft.dirty;

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
    liveDraft.setDraft((prev) => ({ ...prev, ...patch }));
    setSaveError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (savingRef.current || blocked) return;
    const check = validateClinicLocation(draft);
    const entrance = validateEntranceDetails(draft);
    if (!check.ok || !entrance.ok) {
      setErrors({ ...check.errors, ...entrance.errors });
      return;
    }
    setErrors({});
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      await onSave(clinic, draft);
    } catch (error) {
      logSafeError("Update clinic location", error);
      setSaveError(
        friendlyErrorMessage(error, "The location could not be saved. Your entries are still here — please try again.")
      );
    } finally {
      savingRef.current = false;
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
            showEntrance
            errors={errors}
            disabled={saving}
            idPrefix={`manage-${clinic.firestoreId}`}
          />

          <StaleEditNotice
            labels={staleLabels}
            gone={liveDraft.gone}
            what="this clinic's location"
            disabled={saving}
            onLoadLatest={liveDraft.loadLatest}
            onKeepMine={liveDraft.keepMine}
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
            disabled={saving || blocked}
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

function ClinicDetailsModal({ clinic, onClose }) {
  const linkedDoctors = clinic.linkedDoctors || [];
  const linkedDoctorsLoading = clinic.linkedDoctorsLoading === true;
  const linkedDoctorsError = clinic.linkedDoctorsError || "";
  // Like the other clinic dialogs: focus moves in, Tab stays inside, Escape
  // closes, focus returns to the row or card that opened it.
  const dialogRef = useRef(null);
  useDialogFocus({ dialogRef, onDismiss: onClose });

  return (
    <div className="clinics-modal-backdrop">
      <div
        className="clinics-modal clinics-details-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clinic-details-title"
      >
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

        <h2 id="clinic-details-title">{clinic.name}</h2>
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

        <section
          className="clinics-linked-doctors"
          aria-labelledby="clinic-linked-doctors-heading"
        >
          <div className="clinics-linked-doctors-head">
            <h3 id="clinic-linked-doctors-heading">Linked doctors</h3>
            {!linkedDoctorsLoading && !linkedDoctorsError && (
              <span>{linkedDoctors.length}</span>
            )}
          </div>

          {linkedDoctorsLoading && <p>Loading linked doctors...</p>}
          {!linkedDoctorsLoading && linkedDoctorsError && (
            <p className="clinics-area-error" role="alert">
              {linkedDoctorsError}
            </p>
          )}
          {!linkedDoctorsLoading &&
            !linkedDoctorsError &&
            linkedDoctors.length === 0 && (
              <p>No doctors have an active link to this clinic.</p>
            )}
          {!linkedDoctorsLoading && linkedDoctors.length > 0 && (
            <ul>
              {linkedDoctors.map((doctor) => (
                <li key={doctor.id}>
                  <UserRound size={17} aria-hidden="true" />
                  <div>
                    <strong>{doctor.name || "Unnamed doctor"}</strong>
                    <small>Primary area: {doctor.area || "Unassigned"}</small>
                  </div>
                  <span className={doctor.active ? "active" : "inactive"}>
                    {doctor.active ? "Active" : "Inactive"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Deliveries are not started from Admin Clinics. They originate in the
            normal order workflow: Sales Rep order → Dispatcher assignment →
            Rider delivery. The former delivery-draft action here only showed a
            toast and drafted nothing, so it was removed rather than replaced. */}
        <div className="clinics-modal-actions">
          {/* Not built yet. Shown disabled, with the reason, rather than
              clickable with a toast that implies something happened. */}
          <button
            type="button"
            className="clinics-light-action"
            disabled
            aria-describedby="clinic-edit-unavailable"
          >
            <Edit size={15} aria-hidden="true" />
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
        <p id="clinic-edit-unavailable" className="clinics-unavailable-note">
          Editing clinic details isn't available yet. Use Manage location to change where deliveries go.
        </p>
      </div>
    </div>
  );
}

function AreasModal({ areas, loading, loadError, onAdd, onToggle, onClose }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const dialogRef = useRef(null);
  const nameInputRef = useRef(null);
  const headingId = "manage-areas-heading";
  const busy = adding || Boolean(updatingId);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const items = [
        ...root.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((element) => !element.disabled && element.getClientRects().length > 0);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (!root.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;

    setAdding(true);
    setError("");
    const message = await onAdd(name);
    if (message) {
      setError(message);
    } else {
      setName("");
      nameInputRef.current?.focus();
    }
    setAdding(false);
  };

  const handleToggle = async (area) => {
    if (busy) return;

    setUpdatingId(area.id);
    setError("");
    const message = await onToggle(area);
    if (message) setError(message);
    setUpdatingId("");
  };

  return (
    <div className="clinics-modal-backdrop">
      <section
        ref={dialogRef}
        className="clinics-modal clinics-areas-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <button
          type="button"
          className="clinics-modal-close"
          onClick={onClose}
          disabled={busy}
          aria-label="Close manage areas"
        >
          <X size={18} />
        </button>

        <h2 id={headingId}>Manage Areas</h2>
        <p>
          Areas organize clinics now and will later drive doctor and delivery
          destination choices.
        </p>

        <form className="clinics-area-create" onSubmit={handleSubmit} noValidate>
          <label htmlFor="new-area-name">Area name</label>
          <div>
            <input
              ref={nameInputRef}
              id="new-area-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Metro Manila"
              maxLength={80}
              disabled={busy}
            />
            <button type="submit" disabled={busy}>
              {adding ? "Adding..." : "Add Area"}
            </button>
          </div>
        </form>

        {(error || loadError) && (
          <p className="clinics-area-error" role="alert">
            {error || loadError}
          </p>
        )}

        <div className="clinics-area-list" aria-live="polite">
          {loading && <p>Loading areas...</p>}
          {!loading && !loadError && areas.length === 0 && (
            <div className="clinics-area-empty">
              <MapPin size={22} />
              <strong>No areas yet</strong>
              <span>Add the first service area above.</span>
            </div>
          )}
          {!loading &&
            areas.map((area) => (
              <div className="clinics-area-row" key={area.id}>
                <div>
                  <strong>{area.name}</strong>
                  <span className={area.active ? "active" : "inactive"}>
                    {area.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle(area)}
                  disabled={busy}
                >
                  {updatingId === area.id
                    ? "Saving..."
                    : area.active
                      ? "Deactivate"
                      : "Activate"}
                </button>
              </div>
            ))}
        </div>

        <div className="clinics-modal-actions">
          <button
            type="button"
            className="clinics-light-action"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

function DoctorsModal({
  doctors,
  loading,
  loadError,
  clinics,
  clinicsLoading,
  clinicLoadError,
  areas,
  areasLoading,
  areaLoadError,
  onAdd,
  onToggle,
  onToast,
  onClose,
}) {
  const [name, setName] = useState("");
  const [chosenAreaId, setChosenAreaId] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const [managedDoctorId, setManagedDoctorId] = useState("");
  const [addressBusy, setAddressBusy] = useState(false);
  const dialogRef = useRef(null);
  const nameInputRef = useRef(null);
  const addressReturnIdRef = useRef("");
  const headingId = "manage-doctors-heading";
  const busy = adding || Boolean(updatingId) || addressBusy;
  const activeAreas = useMemo(
    () => areas.filter((area) => area.active === true),
    [areas]
  );
  // An area deactivated (or deleted) while the dialog is open drops out of the
  // selection, so a doctor is never registered under an inactive area. Derived
  // here rather than reset in an effect.
  const areaId = activeAreas.some((area) => area.id === chosenAreaId)
    ? chosenAreaId
    : "";
  const managedDoctor = doctors.find(
    (doctor) => doctor.id === managedDoctorId
  );

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const items = [
        ...root.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((element) => !element.disabled && element.getClientRects().length > 0);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (!root.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;

    setAdding(true);
    setError("");
    const message = await onAdd({ name, areaId });
    if (message) {
      setError(message);
    } else {
      setName("");
      setChosenAreaId("");
      nameInputRef.current?.focus();
    }
    setAdding(false);
  };

  const handleToggle = async (doctor) => {
    if (busy) return;

    setUpdatingId(doctor.id);
    setError("");
    const message = await onToggle(doctor);
    if (message) setError(message);
    setUpdatingId("");
  };

  const openAddresses = (doctor) => {
    addressReturnIdRef.current = doctor.id;
    setManagedDoctorId(doctor.id);
  };

  const backToDoctors = () => {
    const returnId = addressReturnIdRef.current;
    setManagedDoctorId("");
    setTimeout(() => {
      const trigger = [...document.querySelectorAll("[data-doctor-address-id]")]
        .find((element) => element.dataset.doctorAddressId === returnId);
      trigger?.focus();
    }, 0);
  };

  return (
    <div className="clinics-modal-backdrop">
      <section
        ref={dialogRef}
        className="clinics-modal clinics-areas-modal clinics-doctors-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <button
          type="button"
          className="clinics-modal-close"
          onClick={onClose}
          disabled={busy}
          aria-label="Close manage doctors"
        >
          <X size={18} />
        </button>

        <h2 id={headingId}>
          {managedDoctor ? "Manage Delivery Addresses" : "Manage Doctors"}
        </h2>

        {managedDoctor ? (
          <DoctorAddressesPanel
            doctor={managedDoctor}
            clinics={clinics}
            clinicsLoading={clinicsLoading}
            clinicLoadError={clinicLoadError}
            areas={areas}
            areasLoading={areasLoading}
            areaLoadError={areaLoadError}
            onBack={backToDoctors}
            onToast={onToast}
            onBusyChange={setAddressBusy}
          />
        ) : (
          <>
            <p>
              Register doctors under a primary area, then add one private Home
              destination and link one or more registered clinics.
            </p>

            <form className="clinics-doctor-create" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="new-doctor-name">Doctor name</label>
            <input
              ref={nameInputRef}
              id="new-doctor-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Dr. Maria Santos"
              maxLength={120}
              disabled={busy}
            />
          </div>

          <div>
            <label htmlFor="new-doctor-area">Primary area</label>
            <select
              id="new-doctor-area"
              value={areaId}
              onChange={(event) => setChosenAreaId(event.target.value)}
              disabled={busy || areasLoading}
              required
            >
              <option value="">
                {areasLoading ? "Loading areas..." : "Select an active area"}
              </option>
              {activeAreas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>

            {!areasLoading && !areaLoadError && activeAreas.length === 0 && (
              <small className="clinics-field-note">
                Add or activate an area from Manage Areas first.
              </small>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || areasLoading || activeAreas.length === 0}
          >
            {adding ? "Adding..." : "Add Doctor"}
          </button>
            </form>

            {(error || loadError || areaLoadError) && (
              <p className="clinics-area-error" role="alert">
                {error || loadError || areaLoadError}
              </p>
            )}

            <div className="clinics-doctor-list" aria-live="polite">
          {loading && <p>Loading doctors...</p>}
          {!loading && !loadError && doctors.length === 0 && (
            <div className="clinics-area-empty">
              <UserRound size={22} />
              <strong>No doctors yet</strong>
              <span>Add the first doctor above.</span>
            </div>
          )}
          {!loading &&
            doctors.map((doctor) => (
              <div className="clinics-doctor-row" key={doctor.id}>
                <div className="clinics-doctor-summary">
                  <strong>{doctor.name || "Unnamed doctor"}</strong>
                  <small>{doctor.area || "Unassigned area"}</small>
                  <span className={doctor.active ? "active" : "inactive"}>
                    {doctor.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="clinics-doctor-row-actions">
                  <button
                    type="button"
                    data-doctor-address-id={doctor.id}
                    onClick={() => openAddresses(doctor)}
                    disabled={busy}
                  >
                    Manage addresses
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggle(doctor)}
                    disabled={busy}
                  >
                    {updatingId === doctor.id
                      ? "Saving..."
                      : doctor.active
                        ? "Deactivate"
                        : "Activate"}
                  </button>
                </div>
              </div>
            ))}
            </div>

            <div className="clinics-modal-actions">
              <button
                type="button"
                className="clinics-light-action"
                onClick={onClose}
                disabled={busy}
              >
                Close
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function NewClinicModal({
  newClinic,
  setNewClinic,
  areas,
  areasLoading,
  areaLoadError,
  errors = {},
  onFieldEdit = () => {},
  onClose,
  onSubmit,
  saving,
  medReps = [],
  doctors = [],
  access = { repUids: [], doctorIds: [] },
  onAccessChange = () => {},
  accessResults = null,
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // An edited field's message clears as the admin fixes it; the others stay.
  const editField = (key, value) => {
    setNewClinic((prev) => ({ ...prev, [key]: value }));
    onFieldEdit(key);
  };
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
            <label htmlFor={CLINIC_FIELD_IDS.name}>
              Clinic Name
              <input
                id={CLINIC_FIELD_IDS.name}
                type="text"
                placeholder="Enter clinic or hospital name"
                value={newClinic.name}
                onChange={(e) => editField("name", e.target.value)}
                disabled={saving}
                {...fieldA11y("new-clinic", "name", errors)}
              />
              <FieldError form="new-clinic" field="name" errors={errors} />
            </label>

            <label htmlFor={CLINIC_FIELD_IDS.contact}>
              Contact Person
              <input
                id={CLINIC_FIELD_IDS.contact}
                type="text"
                placeholder="Dr. Maria Santos"
                value={newClinic.contact}
                onChange={(e) => editField("contact", e.target.value)}
                disabled={saving}
                {...fieldA11y("new-clinic", "contact", errors)}
              />
              <FieldError form="new-clinic" field="contact" errors={errors} />
            </label>

            <label htmlFor={CLINIC_FIELD_IDS.phone}>
              Phone Number
              <input
                id={CLINIC_FIELD_IDS.phone}
                type="text"
                placeholder="0917-000-0000"
                value={newClinic.phone}
                onChange={(e) => editField("phone", e.target.value)}
                disabled={saving}
                {...fieldA11y("new-clinic", "phone", errors)}
              />
              <FieldError form="new-clinic" field="phone" errors={errors} />
            </label>

            <label htmlFor={CLINIC_FIELD_IDS.email}>
              Email (optional)
              <input
                id={CLINIC_FIELD_IDS.email}
                type="email"
                placeholder="clinic@email.com"
                value={newClinic.email}
                onChange={(e) => editField("email", e.target.value)}
                disabled={saving}
                {...fieldA11y("new-clinic", "email", errors)}
              />
              <FieldError form="new-clinic" field="email" errors={errors} />
            </label>

            <label htmlFor={CLINIC_FIELD_IDS.location}>
              Location
              <input
                id={CLINIC_FIELD_IDS.location}
                type="text"
                placeholder="Street, City"
                value={newClinic.location}
                onChange={(e) => editField("location", e.target.value)}
                disabled={saving}
                {...fieldA11y("new-clinic", "location", errors)}
              />
              <FieldError form="new-clinic" field="location" errors={errors} />
            </label>

            <label htmlFor={CLINIC_FIELD_IDS.areaId}>
              Area
              <select
                id={CLINIC_FIELD_IDS.areaId}
                value={newClinic.areaId}
                onChange={(e) => {
                  const selected = areas.find(
                    (area) => area.id === e.target.value
                  );
                  setNewClinic((prev) => ({
                    ...prev,
                    areaId: selected?.id || "",
                    area: selected?.name || "",
                  }));
                  onFieldEdit("areaId");
                }}
                disabled={saving || areasLoading}
                required
                {...fieldA11y("new-clinic", "areaId", errors)}
              >
                <option value="">
                  {areasLoading ? "Loading areas..." : "Select an active area"}
                </option>
                {areas
                  .filter((area) => area.active === true)
                  .map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
              </select>
              <FieldError form="new-clinic" field="areaId" errors={errors} />
              {!areasLoading && areaLoadError && (
                <small className="clinics-field-error" role="alert">{areaLoadError}</small>
              )}
              {!areasLoading && !areaLoadError && areas.every((area) => !area.active) && (
                <small className="clinics-field-note">
                  Add or activate an area from Manage Areas first.
                </small>
              )}
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
            showEntrance
            errors={errors}
            disabled={saving}
            idPrefix="new-clinic"
          />

          {(() => {
            const area = areas.find((a) => a.id === newClinic.areaId);
            const pinned = String(newClinic.latitude ?? "").trim() !== "" && String(newClinic.longitude ?? "").trim() !== "";
            const reason = !area
              ? "Select the clinic's area above to link Med Reps and doctors."
              : !pinned
                ? "Place the clinic on the map above to link Med Reps and doctors now — or link them later with Manage access."
                : "";
            return (
              <ClinicAccessFields
                idPrefix="new-clinic-access"
                areaId={newClinic.areaId}
                areaName={area?.name}
                medReps={medReps}
                doctors={doctors}
                repUids={access.repUids}
                doctorIds={access.doctorIds}
                onChange={onAccessChange}
                disabled={saving || Boolean(reason)}
                disabledReason={reason}
              />
            );
          })()}
          <ClinicAccessResults results={accessResults} />
        </div>

        {/* Deliberately OUTSIDE the scrolling body, unlike the Manage-location
            dialog: this form is ~1467px tall, so a confirmation rendered inside
            the scroll area could sit far off-screen — the same class of
            unreachable-control bug the viewport fix addressed. Pinned above the
            actions, it is always visible. role="alert" announces it. */}
        {errors.form && (
          <Notice tone="error" className="clinics-form-notice">
            {errors.form}
          </Notice>
        )}

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

/** One field's validation message, tied to its input by id. */
function FieldError({ form, field, errors }) {
  if (!errors?.[field]) return null;
  return (
    <small id={errorIdFor(form, field)} className="clinics-field-error">
      {errors[field]}
    </small>
  );
}

export default Clinics;
