import { useEffect, useMemo, useState } from "react";
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
  Plus,
  Search,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import {
  subscribeClinics,
  clinicNameExists,
  addClinic,
} from "../../services/clinicService";
import KpiCard from "../../components/ui/KpiCard";
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
      });

      setNewClinic(EMPTY_CLINIC);
      setShowNewClinicModal(false);
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
              onClick={() => setShowNewClinicModal(true)}
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
                        onClick={() =>
                          showToast(
                            `Delivery draft opened for ${clinic.name}.`
                          )
                        }
                      >
                        Create Delivery
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
          onCreateDelivery={() => {
            showToast(`Delivery draft opened for ${selectedClinic.name}.`);
            setSelectedClinic(null);
          }}
          onEdit={() => showToast(`Editing ${selectedClinic.name}.`)}
        />
      )}

      {showNewClinicModal && (
        <NewClinicModal
          newClinic={newClinic}
          setNewClinic={setNewClinic}
          onClose={() => setShowNewClinicModal(false)}
          onSubmit={handleCreateClinic}
          saving={saving}
        />
      )}
    </div>
  );
}

function ClinicDetailsModal({ clinic, onClose, onCreateDelivery, onEdit }) {
  return (
    <div className="clinics-modal-backdrop">
      <div className="clinics-modal">
        <button
          type="button"
          className="clinics-modal-close"
          onClick={onClose}
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

        <div className="clinics-modal-actions">
          <button
            type="button"
            className="clinics-primary-action"
            onClick={onCreateDelivery}
          >
            Create Delivery
          </button>
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

function NewClinicModal({ newClinic, setNewClinic, onClose, onSubmit, saving }) {
  return (
    <div className="clinics-modal-backdrop">
      <form className="clinics-modal clinics-form-modal" onSubmit={onSubmit}>
        <button
          type="button"
          className="clinics-modal-close"
          onClick={onClose}
          disabled={saving}
        >
          <X size={18} />
        </button>

        <h2>Register New Clinic</h2>
        <p>Add a healthcare facility to the VaxTrack delivery network.</p>

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
            onClick={onClose}
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
