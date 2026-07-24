import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  CircleHelp,
  PhoneCall,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import { subscribeRiders, updateRiderStatus } from "../../services/riderService";
import KpiCard from "../../components/ui/KpiCard";
import "./Riders.css";

const UI_STATUS_MAP = {
  approved: { uiStatus: "standby", statusText: "Standby" },
  pending: { uiStatus: "offduty", statusText: "Pending Approval" },
  pending_approval: { uiStatus: "offduty", statusText: "Pending Approval" },
  disabled: { uiStatus: "offduty", statusText: "Off Duty" },
  rejected: { uiStatus: "offduty", statusText: "Rejected" },
};

function normalizeRider(raw) {
  const statusRaw = (raw.status || "pending").trim().toLowerCase();
  const mapped = UI_STATUS_MAP[statusRaw] || {
    uiStatus: "offduty",
    statusText: "Unknown",
  };

  const name =
    raw.fullName || raw.name || raw.displayName || raw.email || "Unnamed Rider";

  const vehicle =
    raw.vehiclePlate ||
    raw.motorcycle ||
    raw.motorcycleId ||
    raw.vehicle ||
    "Not assigned";

  const initials =
    name
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

  return {
    uid: raw.uid,
    displayId: raw.employeeId || "—",
    name,
    email: raw.email || "—",
    phone: raw.phone || raw.contactNumber || "—",
    initials,
    vehicle,
    statusRaw,
    status: mapped.uiStatus,
    statusText: mapped.statusText,
    assignment: mapped.uiStatus === "standby" ? "Available at Hub" : mapped.statusText,
    currentDelivery: "None",
    hub: raw.hub || "Manila Central Hub",
    lastActive: "—",
    onTimeRate: "—",
    routeCompliance: "—",
    deliveriesToday: 0,
    location: raw.location || "—",
  };
}

function Riders() {
  const navigate = useNavigate();

  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRider, setSelectedRider] = useState(null);
  const [showNewRiderModal, setShowNewRiderModal] = useState(false);
  const [toast, setToast] = useState("");

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

  const handleStatusChange = async (rider, newStatus, successMsg) => {
    try {
      await updateRiderStatus(rider.uid, newStatus);
      showToast(successMsg);
    } catch (error) {
      console.error("Update rider status error:", error);
      showToast(`Failed to update ${rider.name}: ${error.message}`);
    }
  };

  const filteredRiders = useMemo(() => {
    return riders.filter((rider) => {
      const searchValue =
        `${rider.name} ${rider.displayId} ${rider.vehicle} ${rider.statusText} ${rider.assignment}`.toLowerCase();
      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || rider.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [riders, searchTerm, statusFilter]);

  const standbyCount = riders.filter((r) => r.status === "standby").length;
  const offDutyCount = riders.filter((r) => r.status === "offduty").length;

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
          <KpiCard
            label="Total riders"
            value={riders.length}
            context="Registered rider accounts"
            tone="neutral"
            onClick={() => setStatusFilter("all")}
          />

          <KpiCard
            label="Standby"
            value={standbyCount}
            context="Available for assignment"
            tone="success"
            onClick={() => setStatusFilter("standby")}
          />

          <KpiCard
            label="Off duty / pending"
            value={offDutyCount}
            context="Not currently available"
            tone="warning"
            onClick={() => setStatusFilter("offduty")}
          />

          <KpiCard
            label="On-time rate"
            value="—"
            context="Delivery data not yet available"
            tone="neutral"
            onClick={() => showToast("Delivery performance data not yet available.")}
          />
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
            className={statusFilter === "standby" ? "active" : ""}
            onClick={() => setStatusFilter("standby")}
          >
            Standby
          </button>

          <button
            type="button"
            className={statusFilter === "offduty" ? "active" : ""}
            onClick={() => setStatusFilter("offduty")}
          >
            Off Duty / Pending
          </button>
        </section>

        <section className="riders-personnel-card">
          <div className="riders-personnel-head">
            <div>
              <h2>Active Personnel</h2>
              <p>
                Showing {filteredRiders.length} of {riders.length} riders.
              </p>
            </div>
          </div>

          <div className="riders-list">
            {filteredRiders.map((rider) => (
              <article
                key={rider.uid}
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
                      {rider.vehicle} • ID: {rider.displayId}
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

                <div
                  className="rider-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className={`rider-status-pill ${rider.status}`}>
                    {rider.statusText}
                  </span>

                  <button
                    type="button"
                    onClick={() => setSelectedRider(rider)}
                  >
                    Details
                  </button>
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
                    : "No riders match your filter"}
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
          onRoute={() => showToast(`Opening route for ${selectedRider.name}.`)}
          onOffDuty={() => {
            const rider = selectedRider;
            setSelectedRider(null);
            handleStatusChange(rider, "disabled", `${rider.name} marked as off duty.`);
          }}
          onReactivate={() => {
            const rider = selectedRider;
            setSelectedRider(null);
            handleStatusChange(rider, "approved", `${rider.name} set to standby.`);
          }}
          onReject={() => {
            const rider = selectedRider;
            setSelectedRider(null);
            handleStatusChange(rider, "rejected", `${rider.name} has been rejected.`);
          }}
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

function RiderDetailsModal({
  rider,
  onClose,
  onContact,
  onRoute,
  onOffDuty,
  onReactivate,
  onReject,
}) {
  const isPending =
    rider.statusRaw === "pending" || rider.statusRaw === "pending_approval";
  const isApproved = rider.statusRaw === "approved";
  const isDisabled = rider.statusRaw === "disabled";

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
          ID: {rider.displayId} • {rider.vehicle}
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
          <button
            type="button"
            className="riders-primary-action"
            onClick={onRoute}
          >
            View Route
          </button>

          <button
            type="button"
            className="riders-light-action"
            onClick={onContact}
          >
            <PhoneCall size={15} />
            Contact Rider
          </button>

          {isApproved && (
            <button
              type="button"
              className="riders-danger-action"
              onClick={onOffDuty}
            >
              Mark Off Duty
            </button>
          )}

          {isPending && (
            <button
              type="button"
              className="riders-primary-action"
              onClick={onReactivate}
            >
              Approve
            </button>
          )}

          {isPending && (
            <button
              type="button"
              className="riders-danger-action"
              onClick={onReject}
            >
              Reject
            </button>
          )}

          {isDisabled && (
            <button
              type="button"
              className="riders-primary-action"
              onClick={onReactivate}
            >
              Set Available
            </button>
          )}
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
        <p>
          Create a field personnel account for cold-chain delivery operations.
        </p>

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

          <button
            type="button"
            className="riders-light-action"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default Riders;
