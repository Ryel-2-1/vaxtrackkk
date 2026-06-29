import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Bike,
  CheckCircle2,
  CircleHelp,
  Clock3,
  MapPin,
  Minus,
  Navigation,
  PhoneCall,
  Plus,
  Search,
  Truck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import { subscribeRiders } from "../../services/riderService";
import "./Riders.css";

const FIRESTORE_TO_UI_STATUS = {
  approved: "standby",
  pending: "offduty",
  pending_approval: "offduty",
  rejected: "offduty",
  disabled: "offduty",
};

const FIRESTORE_TO_STATUS_TEXT = {
  approved: "Standby",
  pending: "Pending Approval",
  pending_approval: "Pending Approval",
  rejected: "Inactive",
  disabled: "Inactive",
};

function normalizeRider(raw) {
  const firestoreStatus = raw.status || "pending";
  const uiStatus = FIRESTORE_TO_UI_STATUS[firestoreStatus] || "offduty";
  const statusText = FIRESTORE_TO_STATUS_TEXT[firestoreStatus] || "Unknown";
  const nameStr = typeof raw.name === "string" ? raw.name : "";
  const initials =
    nameStr
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return {
    uid: raw.id,
    id: raw.employeeId || raw.id.slice(0, 8).toUpperCase(),
    name: nameStr || "—",
    email: raw.email || "—",
    initials,
    vehicle: raw.vehicle || "Motorcycle",
    phone: raw.phone || "—",
    status: uiStatus,
    statusText,
    assignment: uiStatus === "standby" ? "Available at Hub" : statusText,
    currentDelivery: "None",
    hub: raw.hub || "Manila Central Hub",
    lastActive: "—",
    onTimeRate: "—",
    routeCompliance: "—",
    deliveriesToday: 0,
    location: raw.location || "—",
  };
}

const pendingDeliveries = [
  "VAX-9821 - Sta. Lucia RHU",
  "VAX-8824 - PGH Manila",
  "VAX-8825 - St. Luke's BGC",
  "VAX-9001 - Quezon City Gen",
];

function Riders() {
  const navigate = useNavigate();

  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRider, setSelectedRider] = useState(null);
  const [assignTarget, setAssignTarget] = useState(null);
  const [showNewRiderModal, setShowNewRiderModal] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(pendingDeliveries[0]);
  const [toast, setToast] = useState("");
  const [mapZoom, setMapZoom] = useState(100);

  const [newRider, setNewRider] = useState({
    name: "",
    id: "",
    phone: "",
    vehicle: "Motorcycle",
    hub: "Manila Central Hub",
    status: "standby",
  });

  useEffect(() => {
    const unsubscribe = subscribeRiders(
      (raw) => {
        setRiders(raw.map(normalizeRider));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(error.message || "Failed to load riders.");
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const filteredRiders = useMemo(() => {
    return riders.filter((rider) => {
      const searchValue =
        `${rider.name} ${rider.id} ${rider.vehicle} ${rider.statusText} ${rider.assignment}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || rider.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [riders, searchTerm, statusFilter]);

  const activeCount = riders.filter(
    (rider) => rider.status === "active" || rider.status === "deviation"
  ).length;

  const standbyCount = riders.filter((rider) => rider.status === "standby").length;
  const offDutyCount = riders.filter((rider) => rider.status === "offduty").length;
  const alertCount = riders.filter((rider) => rider.status === "deviation").length;

  const handleAssignDelivery = () => {
    if (!assignTarget) return;

    setRiders((prev) =>
      prev.map((rider) =>
        rider.id === assignTarget.id
          ? {
              ...rider,
              status: "active",
              statusText: "Active",
              assignment: selectedDelivery,
              currentDelivery: selectedDelivery.split(" - ")[0],
              lastActive: "Assigned now",
            }
          : rider
      )
    );

    showToast(`${assignTarget.name} assigned to ${selectedDelivery}.`);
    setAssignTarget(null);
  };

  const handleCreateRider = (e) => {
    e.preventDefault();
    setShowNewRiderModal(false);
    showToast(
      "Rider accounts must be created via Firebase Authentication. Once registered and approved in Settings, riders appear here automatically."
    );
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="riders" onLogout={handleLogout} />

      <main className="riders-v2-page">
        {toast && <div className="riders-toast">{toast}</div>}

        <header className="riders-v2-header">
          <div>
            <h1>Riders Management</h1>
            <p>Monitor field personnel and cold-chain assignments.</p>
          </div>

          <div className="riders-v2-header-actions">
            <div className="riders-v2-search">
              <Search size={15} />
              <input
                placeholder="Search riders..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="riders-icon-btn"
              onClick={() => showToast("No new rider notifications.")}
            >
              <Bell size={15} />
              <span></span>
            </button>

            <button
              type="button"
              className="riders-icon-btn"
              onClick={() =>
                showToast("Tip: Click any rider row or map marker for details.")
              }
            >
              <CircleHelp size={15} />
            </button>

            <button
              type="button"
              className="riders-new-btn"
              onClick={() => setShowNewRiderModal(true)}
            >
              <Plus size={15} />
              New Rider
            </button>
          </div>
        </header>

        <section className="riders-summary-grid">
          <RiderSummaryCard
            icon={<Users size={19} />}
            value={activeCount}
            label="Active Riders"
            note="Currently available or delivering"
            type="blue"
            onClick={() => setStatusFilter("active")}
          />

          <RiderSummaryCard
            icon={<Clock3 size={19} />}
            value={standbyCount}
            label="Idle Riders"
            note="Waiting for assignment"
            type="green"
            onClick={() => setStatusFilter("standby")}
          />

          <RiderSummaryCard
            icon={<AlertTriangle size={19} />}
            value={alertCount}
            label="Route Alerts"
            note="Needs admin review"
            type="red"
            onClick={() => setStatusFilter("deviation")}
          />

          <RiderSummaryCard
            icon={<CheckCircle2 size={19} />}
            value="94.2%"
            label="On-Time Rate"
            note="+8% from last week"
            type="amber"
            onClick={() => showToast("Showing rider performance summary.")}
          />
        </section>

        <section className="riders-map-section">
          <div className="riders-map-card">
            <div className="riders-map-head">
              <div>
                <h2>Live Fleet Map</h2>
                <p>Click a marker to view rider details.</p>
              </div>

              <div className="riders-map-status">
                <span>{activeCount} Active</span>
                <span>{standbyCount} Idle</span>
                <span>{mapZoom}%</span>
              </div>
            </div>

            <div className="riders-fleet-map">
              <div className="riders-map-road one"></div>
              <div className="riders-map-road two"></div>
              <div className="riders-map-road three"></div>

              <strong className="riders-map-label manila">Manila</strong>
              <strong className="riders-map-label makati">Makati City</strong>
              <strong className="riders-map-label qc">Quezon City</strong>

              {filteredRiders.map((rider, index) => (
                <button
                  type="button"
                  key={rider.id}
                  className={`riders-map-marker marker-${index + 1} ${rider.status}`}
                  onClick={() => setSelectedRider(rider)}
                  title={rider.name}
                >
                  {rider.status === "standby" ? (
                    <Bike size={15} />
                  ) : (
                    <MapPin size={15} />
                  )}
                </button>
              ))}

              <div className="riders-map-controls">
                <button
                  type="button"
                  onClick={() => setMapZoom((prev) => Math.min(prev + 10, 160))}
                >
                  <Plus size={18} />
                </button>

                <button
                  type="button"
                  onClick={() => setMapZoom((prev) => Math.max(prev - 10, 70))}
                >
                  <Minus size={18} />
                </button>
              </div>

              <button
                type="button"
                className="riders-recenter-btn"
                onClick={() => {
                  setMapZoom(100);
                  showToast("Fleet map recentered.");
                }}
              >
                <Navigation size={14} />
                Recenter Map
              </button>
            </div>
          </div>
        </section>

        <section className="riders-filter-row">
          <button
            type="button"
            className={statusFilter === "all" ? "active" : ""}
            onClick={() => setStatusFilter("all")}
          >
            All
          </button>

          <button
            type="button"
            className={statusFilter === "active" ? "active" : ""}
            onClick={() => setStatusFilter("active")}
          >
            Active
          </button>

          <button
            type="button"
            className={statusFilter === "standby" ? "active" : ""}
            onClick={() => setStatusFilter("standby")}
          >
            Standby
          </button>

          <button
            type="button"
            className={statusFilter === "deviation" ? "active" : ""}
            onClick={() => setStatusFilter("deviation")}
          >
            Route Alert
          </button>

          <button
            type="button"
            className={statusFilter === "offduty" ? "active" : ""}
            onClick={() => setStatusFilter("offduty")}
          >
            Off Duty
          </button>
        </section>

        <section className="riders-personnel-card">
          <div className="riders-personnel-head">
            <div>
              <h2>Active Personnel</h2>
              <p>Showing {filteredRiders.length} of {riders.length} riders.</p>
            </div>
          </div>

          <div className="riders-list">
            {filteredRiders.map((rider) => (
              <article
                key={rider.id}
                className={`rider-row ${rider.status}`}
                onClick={() => setSelectedRider(rider)}
              >
                <div className="rider-main-info">
                  <div className={`rider-avatar ${rider.status}`}>
                    {rider.initials}
                  </div>

                  <div>
                    <h3>{rider.name}</h3>
                    <p>
                      {rider.vehicle}: {rider.id}
                    </p>
                  </div>
                </div>

                <div className="rider-assignment-box">
                  <strong>{rider.statusText}</strong>
                  <p>{rider.assignment}</p>
                  <small>Last active: {rider.lastActive}</small>
                </div>

                <div className="rider-performance">
                  <span>Today</span>
                  <strong>{rider.deliveriesToday}</strong>
                  <small>deliveries</small>
                </div>

                <div className="rider-performance">
                  <span>On-Time</span>
                  <strong>{rider.onTimeRate}</strong>
                  <small>rate</small>
                </div>

                <div className="rider-actions" onClick={(e) => e.stopPropagation()}>
                  <span className={`rider-status-pill ${rider.status}`}>
                    {rider.statusText}
                  </span>

                  <button type="button" onClick={() => setSelectedRider(rider)}>
                    Details
                  </button>

                  {(rider.status === "standby" || rider.status === "offduty") && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setAssignTarget(rider)}
                    >
                      Assign
                    </button>
                  )}

                  {rider.status === "deviation" && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setSelectedRider(rider)}
                    >
                      Review
                    </button>
                  )}
                </div>
              </article>
            ))}

            {loading && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>Loading riders...</strong>
              </div>
            )}

            {!loading && loadError && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>Could not load riders</strong>
                <p>{loadError}</p>
              </div>
            )}

            {!loading && !loadError && filteredRiders.length === 0 && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>
                  {riders.length === 0
                    ? "No rider accounts found"
                    : "No riders match your search"}
                </strong>
                <p>
                  {riders.length === 0
                    ? "Rider accounts are registered via the VaxTrack mobile app."
                    : "Try changing the search keyword or selected status filter."}
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      {selectedRider && (
        <RiderDetailsModal
          rider={selectedRider}
          onClose={() => setSelectedRider(null)}
          onContact={() => showToast(`Contacting ${selectedRider.name}...`)}
          onAssign={() => {
            setAssignTarget(selectedRider);
            setSelectedRider(null);
          }}
          onRoute={() => showToast(`Opening route for ${selectedRider.name}.`)}
          onOffDuty={() => {
            setRiders((prev) =>
              prev.map((rider) =>
                rider.id === selectedRider.id
                  ? {
                      ...rider,
                      status: "offduty",
                      statusText: "Off Duty",
                      assignment: "Marked off duty by admin",
                    }
                  : rider
              )
            );
            setSelectedRider(null);
            showToast(`${selectedRider.name} marked as off duty.`);
          }}
        />
      )}

      {assignTarget && (
        <AssignRiderModal
          rider={assignTarget}
          selectedDelivery={selectedDelivery}
          setSelectedDelivery={setSelectedDelivery}
          onClose={() => setAssignTarget(null)}
          onAssign={handleAssignDelivery}
        />
      )}

      {showNewRiderModal && (
        <NewRiderModal
          newRider={newRider}
          setNewRider={setNewRider}
          onClose={() => setShowNewRiderModal(false)}
          onSubmit={handleCreateRider}
        />
      )}
    </div>
  );
}

function RiderSummaryCard({ icon, value, label, note, type, onClick }) {
  return (
    <button type="button" className={`riders-summary-card ${type}`} onClick={onClick}>
      <div className="riders-summary-icon">{icon}</div>
      <div>
        <h2>{value}</h2>
        <p>{label}</p>
        <small>{note}</small>
      </div>
    </button>
  );
}

function RiderDetailsModal({ rider, onClose, onContact, onAssign, onRoute, onOffDuty }) {
  return (
    <div className="riders-modal-backdrop">
      <div className="riders-modal">
        <button type="button" className="riders-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <div className={`riders-modal-avatar ${rider.status}`}>
          {rider.initials}
        </div>

        <h2>{rider.name}</h2>
        <p>
          Rider ID: {rider.id} • {rider.vehicle}
        </p>

        <div className="riders-modal-grid">
          <div>
            <span>Status</span>
            <strong>{rider.statusText}</strong>
          </div>

          <div>
            <span>Current Delivery</span>
            <strong>{rider.currentDelivery}</strong>
          </div>

          <div>
            <span>Current Assignment</span>
            <strong>{rider.assignment}</strong>
          </div>

          <div>
            <span>Location</span>
            <strong>{rider.location}</strong>
          </div>

          <div>
            <span>Phone</span>
            <strong>{rider.phone}</strong>
          </div>

          <div>
            <span>On-Time Rate</span>
            <strong>{rider.onTimeRate}</strong>
          </div>

          <div>
            <span>Route Compliance</span>
            <strong>{rider.routeCompliance}</strong>
          </div>
        </div>

        <div className="riders-modal-actions">
          <button type="button" className="riders-primary-action" onClick={onRoute}>
            View Route
          </button>

          <button type="button" className="riders-light-action" onClick={onContact}>
            <PhoneCall size={15} />
            Contact Rider
          </button>

          <button type="button" className="riders-light-action" onClick={onAssign}>
            Assign Delivery
          </button>

          <button type="button" className="riders-danger-action" onClick={onOffDuty}>
            Mark Off Duty
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignRiderModal({
  rider,
  selectedDelivery,
  setSelectedDelivery,
  onClose,
  onAssign,
}) {
  return (
    <div className="riders-modal-backdrop">
      <div className="riders-modal small">
        <button type="button" className="riders-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <div className="riders-modal-avatar standby">
          <Truck size={24} />
        </div>

        <h2>Assign Delivery</h2>
        <p>Select a pending delivery for {rider.name}.</p>

        <label className="riders-form-label">
          Pending Delivery
          <select
            value={selectedDelivery}
            onChange={(e) => setSelectedDelivery(e.target.value)}
          >
            {pendingDeliveries.map((delivery) => (
              <option key={delivery}>{delivery}</option>
            ))}
          </select>
        </label>

        <div className="riders-modal-actions">
          <button type="button" className="riders-primary-action" onClick={onAssign}>
            Assign Rider
          </button>

          <button type="button" className="riders-light-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function NewRiderModal({ newRider, setNewRider, onClose, onSubmit }) {
  return (
    <div className="riders-modal-backdrop">
      <form className="riders-modal riders-form-modal" onSubmit={onSubmit}>
        <button type="button" className="riders-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <h2>New Rider</h2>
        <p>Create a field personnel account for cold-chain delivery operations.</p>

        <div className="riders-form-grid">
          <label>
            Full Name
            <input
              type="text"
              placeholder="Enter rider full name"
              value={newRider.name}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </label>

          <label>
            Rider ID
            <input
              type="text"
              placeholder="MCV-0000"
              value={newRider.id}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, id: e.target.value }))
              }
            />
          </label>

          <label>
            Phone Number
            <input
              type="text"
              placeholder="09XX-XXX-XXXX"
              value={newRider.phone}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, phone: e.target.value }))
              }
            />
          </label>

          <label>
            Vehicle Type
            <select
              value={newRider.vehicle}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, vehicle: e.target.value }))
              }
            >
              <option>Motorcycle</option>
              <option>Van</option>
              <option>Truck</option>
              <option>Auto</option>
            </select>
          </label>

          <label>
            Assigned Hub
            <select
              value={newRider.hub}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, hub: e.target.value }))
              }
            >
              <option>Manila Central Hub</option>
              <option>Quezon City Sub-Hub</option>
              <option>Makati Cold Hub</option>
            </select>
          </label>

          <label className="wide">
            Initial Status
            <select
              value={newRider.status}
              onChange={(e) =>
                setNewRider((prev) => ({ ...prev, status: e.target.value }))
              }
            >
              <option value="standby">Standby</option>
              <option value="active">Active</option>
              <option value="offduty">Off Duty</option>
            </select>
          </label>
        </div>

        <div className="riders-modal-actions">
          <button type="submit" className="riders-primary-action">
            Create Rider
          </button>

          <button type="button" className="riders-light-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default Riders;