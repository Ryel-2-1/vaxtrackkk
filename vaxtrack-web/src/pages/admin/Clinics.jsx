import { useMemo, useState } from "react";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Edit,
  Grid3X3,
  Plus,
  Search,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Clinics.css";

const initialClinics = [
  {
    name: "Quezon City General Hospital",
    id: "CLN-4829",
    location: "North Ave, Quezon City",
    area: "Metro Manila",
    contact: "Dr. Maria Santos",
    phone: "0917-555-0192",
    email: "maria.santos@qcgh.ph",
    initials: "MS",
    lastDelivery: "Today, 09:30 AM",
    note: "Via Cold-Chain Truck #4",
    status: "active",
    statusLabel: "Active",
    contactTone: "blue",
    deliveryNotes: "Priority pediatric vaccines.",
  },
  {
    name: "Makati Medical Center",
    id: "CLN-4830",
    location: "Amorsolo St, Makati",
    area: "Metro Manila",
    contact: "Juan Cruz",
    phone: "0920-123-4567",
    email: "juan.cruz@makatimed.ph",
    initials: "JC",
    lastDelivery: "2 Days Ago",
    note: "Pending Resupply",
    status: "pending",
    statusLabel: "Pending Resupply",
    contactTone: "amber",
    deliveryNotes: "Needs resupply confirmation.",
  },
  {
    name: "Pasig City Children’s Hospital",
    id: "CLN-4835",
    location: "Pasig Blvd, Pasig",
    area: "Metro Manila",
    contact: "Liza Torres",
    phone: "0918-987-6543",
    email: "liza.torres@pcch.ph",
    initials: "LT",
    lastDelivery: "1 Week Ago",
    note: "Delivery Overdue",
    status: "overdue",
    statusLabel: "Overdue",
    contactTone: "purple",
    deliveryNotes: "Requires delivery review.",
  },
  {
    name: "Sta. Lucia Rural Health Unit",
    id: "CLN-4841",
    location: "Sta. Lucia, Manila",
    area: "Metro Manila",
    contact: "Nina Flores",
    phone: "0916-222-8841",
    email: "nina.flores@slrhu.ph",
    initials: "NF",
    lastDelivery: "Yesterday, 02:15 PM",
    note: "Completed Delivery",
    status: "active",
    statusLabel: "Active",
    contactTone: "green",
    deliveryNotes: "Routine vaccine drop-off.",
  },
  {
    name: "Taguig Health Center",
    id: "CLN-4844",
    location: "32nd Street, Taguig",
    area: "Metro Manila",
    contact: "Ramon Lee",
    phone: "0915-332-1900",
    email: "ramon.lee@taguighc.ph",
    initials: "RL",
    lastDelivery: "4 Days Ago",
    note: "Pending Resupply",
    status: "pending",
    statusLabel: "Pending Resupply",
    contactTone: "blue",
    deliveryNotes: "Monitor stock request.",
  },
  {
    name: "Manila Central Clinic",
    id: "CLN-4850",
    location: "Taft Avenue, Manila",
    area: "Metro Manila",
    contact: "Andrea Cruz",
    phone: "0917-888-1290",
    email: "andrea.cruz@mcc.ph",
    initials: "AC",
    lastDelivery: "Today, 11:10 AM",
    note: "Via Cold-Chain Van #2",
    status: "active",
    statusLabel: "Active",
    contactTone: "amber",
    deliveryNotes: "Cold-chain priority.",
  },
];

const pageSize = 3;

function Clinics() {
  const [clinics, setClinics] = useState(initialClinics);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedClinic, setSelectedClinic] = useState(null);
  const [showNewClinicModal, setShowNewClinicModal] = useState(false);
  const [toast, setToast] = useState("");

  const [newClinic, setNewClinic] = useState({
    name: "",
    location: "",
    area: "Metro Manila",
    contact: "",
    phone: "",
    email: "",
    deliveryNotes: "",
    status: "active",
  });

  const handleLogout = async () => {
    await signOut(auth);
    window.location.href = "/login";
  };

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

  const activeCount = clinics.filter((clinic) => clinic.status === "active").length;
  const pendingCount = clinics.filter((clinic) => clinic.status === "pending").length;
  const overdueCount = clinics.filter((clinic) => clinic.status === "overdue").length;

  const handleStatusFilter = (status) => {
    setStatusFilter(status);
    setCurrentPage(1);
  };

  const handleCreateClinic = (e) => {
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

    const createdClinic = {
      name: newClinic.name,
      id: `CLN-${Math.floor(4900 + Math.random() * 90)}`,
      location: newClinic.location,
      area: newClinic.area,
      contact: newClinic.contact,
      phone: newClinic.phone,
      email: newClinic.email || "No email provided",
      initials: newClinic.contact
        .split(" ")
        .filter(Boolean)
        .map((word) => word[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      lastDelivery: "No delivery yet",
      note:
        newClinic.status === "pending"
          ? "Pending Resupply"
          : newClinic.status === "overdue"
          ? "Delivery Overdue"
          : "Ready for Delivery",
      status: newClinic.status,
      statusLabel:
        newClinic.status === "pending"
          ? "Pending Resupply"
          : newClinic.status === "overdue"
          ? "Overdue"
          : "Active",
      contactTone: "blue",
      deliveryNotes: newClinic.deliveryNotes || "No special notes.",
    };

    setClinics((prev) => [createdClinic, ...prev]);

    setNewClinic({
      name: "",
      location: "",
      area: "Metro Manila",
      contact: "",
      phone: "",
      email: "",
      deliveryNotes: "",
      status: "active",
    });

    setShowNewClinicModal(false);
    setCurrentPage(1);
    showToast(`${createdClinic.name} has been registered.`);
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
              onClick={() => showToast("Tip: Click any clinic row to view details.")}
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
          <ClinicSummaryCard
            icon={<Building2 size={19} />}
            value={clinics.length}
            label="Total Clinics"
            note="Affiliated facilities"
            type="blue"
            onClick={() => handleStatusFilter("all")}
          />

          <ClinicSummaryCard
            icon={<CheckCircle2 size={19} />}
            value={activeCount}
            label="Active Clinics"
            note="Ready for deliveries"
            type="green"
            onClick={() => handleStatusFilter("active")}
          />

          <ClinicSummaryCard
            icon={<Clock3 size={19} />}
            value={pendingCount}
            label="Pending Resupply"
            note="Needs stock review"
            type="amber"
            onClick={() => handleStatusFilter("pending")}
          />

          <ClinicSummaryCard
            icon={<Truck size={19} />}
            value={overdueCount}
            label="Overdue Delivery"
            note="Requires follow-up"
            type="red"
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
                <th>Clinic Name</th>
                <th>Location</th>
                <th>Contact Person</th>
                <th>Last Delivery</th>
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
                      <div className={`clinic-contact-avatar ${clinic.contactTone}`}>
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
                      <small className={clinic.status === "overdue" ? "danger" : ""}>
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
                      <button type="button" onClick={() => setSelectedClinic(clinic)}>
                        Details
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          showToast(`Delivery draft opened for ${clinic.name}.`)
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

          {filteredClinics.length === 0 && (
            <div className="clinics-empty">
              <Building2 size={28} />
              <strong>No clinics found</strong>
              <p>Try changing the search keyword or selected status filter.</p>
            </div>
          )}

          <div className="clinics-v2-pagination">
            <p>
              Showing {startItem} to {endItem} of {filteredClinics.length} clinics
            </p>

            <div>
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              >
                <ChevronLeft size={14} />
              </button>

              {Array.from({ length: totalPages }, (_, index) => index + 1).map(
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
        />
      )}
    </div>
  );
}

function ClinicSummaryCard({ icon, value, label, note, type, onClick }) {
  return (
    <button type="button" className={`clinics-summary-card ${type}`} onClick={onClick}>
      <div className="clinics-summary-icon">{icon}</div>

      <div>
        <h2>{value}</h2>
        <p>{label}</p>
        <small>{note}</small>
      </div>
    </button>
  );
}

function ClinicDetailsModal({ clinic, onClose, onCreateDelivery, onEdit }) {
  return (
    <div className="clinics-modal-backdrop">
      <div className="clinics-modal">
        <button type="button" className="clinics-modal-close" onClick={onClose}>
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
          <button type="button" className="clinics-primary-action" onClick={onCreateDelivery}>
            Create Delivery
          </button>

          <button type="button" className="clinics-light-action" onClick={onEdit}>
            <Edit size={15} />
            Edit Clinic
          </button>

          <button type="button" className="clinics-light-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function NewClinicModal({ newClinic, setNewClinic, onClose, onSubmit }) {
  return (
    <div className="clinics-modal-backdrop">
      <form className="clinics-modal clinics-form-modal" onSubmit={onSubmit}>
        <button type="button" className="clinics-modal-close" onClick={onClose}>
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
            />
          </label>

          <label>
            Contact Person
            <input
              type="text"
              placeholder="Dr. Maria Santos"
              value={newClinic.contact}
              onChange={(e) =>
                setNewClinic((prev) => ({ ...prev, contact: e.target.value }))
              }
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
            />
          </label>

          <label>
            Location
            <input
              type="text"
              placeholder="Street, City"
              value={newClinic.location}
              onChange={(e) =>
                setNewClinic((prev) => ({ ...prev, location: e.target.value }))
              }
            />
          </label>

          <label>
            Area
            <select
              value={newClinic.area}
              onChange={(e) =>
                setNewClinic((prev) => ({ ...prev, area: e.target.value }))
              }
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
                setNewClinic((prev) => ({ ...prev, status: e.target.value }))
              }
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
            />
          </label>
        </div>

        <div className="clinics-modal-actions">
          <button type="submit" className="clinics-primary-action">
            Register Clinic
          </button>

          <button type="button" className="clinics-light-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default Clinics;