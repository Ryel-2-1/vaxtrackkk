import "./AdminDashboard.css";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Layers,
  MapPin,
  Minus,
  Navigation,
  PhoneCall,
  Plus,
  Search,
  ShieldAlert,
  Truck,
  Users,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

const alerts = [
  {
    id: "ALT-001",
    type: "critical",
    title: "Route Deviation",
    desc: "Delivery moved outside the expected delivery path.",
    time: "3 min ago",
  },
  {
    id: "ALT-002",
    type: "warning",
    title: "Late Arrival",
    desc: "ETA delayed by 15 minutes due to traffic.",
    time: "8 min ago",
  },
  {
    id: "ALT-003",
    type: "success",
    title: "Cold Storage",
    desc: "Temperature successfully stabilized to 3.8°C.",
    time: "15 min ago",
  },
];

function AdminDashboard() {
  const navigate = useNavigate();

  const [showAlertBanner, setShowAlertBanner] = useState(true);
  const [showInspectModal, setShowInspectModal] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showRiderTooltip, setShowRiderTooltip] = useState(false);
  const [mapZoom, setMapZoom] = useState(100);
  const [mapLayer, setMapLayer] = useState("Standard");
  const [toast, setToast] = useState("");

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const handleDismissAlert = () => {
    setShowAlertBanner(false);
    showToast("Route deviation alert dismissed.");
  };

  const handleContactRider = () => {
    showToast("Calling rider Arby Barruevo...");
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="dashboard" onLogout={handleLogout} />

      <main className="v2-admin-main">
        {toast && <div className="v2-toast">{toast}</div>}

        <header className="v2-admin-topbar">
          <p>VaxTrack Logistics Command</p>

          <div className="v2-admin-search">
            <Search size={14} />
            <input placeholder="Search health unit, shipment, or rider..." />
          </div>

          <div className="v2-admin-icons">
            <button
              type="button"
              aria-label="Open notifications"
              onClick={() => setShowNotifications(true)}
            >
              <Bell size={15} />
              <span className="v2-notification-dot"></span>
            </button>

            <button
              type="button"
              aria-label="Open alerts"
              onClick={() => navigate("/admin/alerts")}
            >
              <ShieldAlert size={15} />
            </button>
          </div>
        </header>

        {showAlertBanner && (
          <section className="v2-alert-banner">
            <div className="v2-alert-icon">
              <AlertTriangle size={18} />
            </div>

            <div>
              <strong>Route Deviation Detected</strong>
              <p>
                Shipment RTX-9824 has moved 1.2km outside the assigned delivery
                perimeter in Quezon City.
              </p>
            </div>

            <button
              type="button"
              className="v2-red-btn"
              onClick={() => setShowInspectModal(true)}
            >
              Inspect Now
            </button>

            <button
              type="button"
              className="v2-dismiss-btn"
              onClick={handleDismissAlert}
            >
              Dismiss
            </button>
          </section>
        )}

        <section className="v2-admin-grid">
          <div className="v2-tracking-column">
            <div className="v2-map-card">
              <div className="v2-map-card-head">
                <div className="v2-map-title">
                  <span></span>
                  Live Tracking: Arby Barruevo
                </div>

                <div className="v2-map-status">
                  <strong>{mapLayer}</strong>
                  <small>{mapZoom}% zoom</small>
                </div>
              </div>

              <div className="v2-live-map">
                <div className="v2-planned-route"></div>
                <div className="v2-current-route"></div>

                <span className="v2-map-dot start"></span>
                <span className="v2-map-dot middle"></span>

                <button
                  type="button"
                  className="v2-map-dot rider"
                  onClick={() => setShowRiderTooltip((prev) => !prev)}
                  aria-label="Show rider location details"
                >
                  <Truck size={15} />
                </button>

                {showRiderTooltip && (
                  <div className="v2-rider-tooltip">
                    <strong>Arby Barruevo</strong>
                    <p>Route deviation detected</p>
                    <small>Quezon City • RTX-9824</small>
                  </div>
                )}

                <div className="v2-map-controls">
                  <button
                    type="button"
                    onClick={() => setMapZoom((prev) => Math.min(prev + 10, 160))}
                    aria-label="Zoom in"
                  >
                    <Plus size={22} strokeWidth={2.4} />
                  </button>

                  <button
                    type="button"
                    onClick={() => setMapZoom((prev) => Math.max(prev - 10, 60))}
                    aria-label="Zoom out"
                  >
                    <Minus size={22} strokeWidth={2.4} />
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMapLayer((prev) =>
                        prev === "Standard" ? "Cold-chain layer" : "Standard"
                      )
                    }
                    aria-label="Toggle map layer"
                  >
                    <Layers size={21} strokeWidth={2.4} />
                  </button>
                </div>

                <button
                  type="button"
                  className="v2-recenter-btn"
                  onClick={() => {
                    setMapZoom(100);
                    showToast("Map recentered to rider location.");
                  }}
                >
                  <Navigation size={14} />
                  Recenter Rider
                </button>

                <div className="v2-map-legend">
                  <span>
                    <i className="planned"></i>
                    Planned Path
                  </span>

                  <span>
                    <i className="current"></i>
                    Current Deviation
                  </span>
                </div>
              </div>
            </div>

            <section className="v2-stats-grid">
              <MetricCard
                icon={<Truck size={18} />}
                value="42"
                label="Active Deliveries"
                trend="+15%"
                type="blue"
                onClick={() => navigate("/admin/deliveries")}
              />

              <MetricCard
                icon={<Clock size={18} />}
                value="3"
                label="Delayed / Missing"
                trend="-2%"
                type="amber"
                onClick={() => navigate("/admin/deliveries")}
              />

              <MetricCard
                icon={<AlertTriangle size={18} />}
                value="5"
                label="Low Stock / Critical"
                trend="-8.5%"
                type="red"
                onClick={() => navigate("/admin/inventory")}
              />

              <MetricCard
                icon={<Users size={18} />}
                value="28"
                label="Riders Online"
                trend="+6%"
                type="green"
                onClick={() => navigate("/admin/riders")}
              />
            </section>
          </div>

          <aside className="v2-rider-panel">
            <div className="v2-rider-avatar">AB</div>

            <div>
              <h3>Arby Barruevo</h3>
              <p>Rider ID: RTX-9824</p>
            </div>

            <div className="v2-rider-info">
              <div>
                <span>Delivery ID</span>
                <strong>RTX-9824</strong>
              </div>

              <div>
                <span>Current Location</span>
                <strong>Quezon City</strong>
              </div>
            </div>

            <button
              type="button"
              className="v2-outline-full"
              onClick={() => setShowInspectModal(true)}
            >
              View Full Route History
            </button>

            <button
              type="button"
              className="v2-contact-btn"
              onClick={handleContactRider}
            >
              <PhoneCall size={15} />
              Contact Rider
            </button>

            <div className="v2-recent-alerts">
              <div className="v2-section-head">
                <h4>Recent Alerts</h4>
                <button type="button" onClick={() => navigate("/admin/alerts")}>
                  All
                </button>
              </div>

              {alerts.map((alert) => (
                <AlertItem
                  key={alert.id}
                  {...alert}
                  onReview={() => setShowInspectModal(true)}
                />
              ))}
            </div>
          </aside>
        </section>
      </main>

      {showInspectModal && (
        <div className="v2-modal-backdrop" role="dialog" aria-modal="true">
          <div className="v2-inspect-modal">
            <button
              type="button"
              className="v2-modal-close"
              onClick={() => setShowInspectModal(false)}
              aria-label="Close modal"
            >
              <X size={18} />
            </button>

            <div className="v2-modal-icon">
              <MapPin size={24} />
            </div>

            <h2>Route Deviation Inspection</h2>
            <p>
              Shipment RTX-9824 is outside the expected delivery path. Review the
              rider status and decide the next action.
            </p>

            <div className="v2-inspection-grid">
              <div>
                <span>Rider</span>
                <strong>Arby Barruevo</strong>
              </div>

              <div>
                <span>Delivery ID</span>
                <strong>RTX-9824</strong>
              </div>

              <div>
                <span>Current Location</span>
                <strong>Quezon City</strong>
              </div>

              <div>
                <span>Deviation Distance</span>
                <strong>1.2 km</strong>
              </div>
            </div>

            <div className="v2-modal-actions">
              <button type="button" className="v2-red-btn" onClick={handleContactRider}>
                Contact Rider
              </button>

              <button
                type="button"
                className="v2-outline-action"
                onClick={() => {
                  setShowInspectModal(false);
                  navigate("/admin/deliveries");
                }}
              >
                Open Deliveries
              </button>

              <button
                type="button"
                className="v2-dismiss-btn"
                onClick={() => {
                  setShowInspectModal(false);
                  handleDismissAlert();
                }}
              >
                Mark Reviewed
              </button>
            </div>
          </div>
        </div>
      )}

      {showNotifications && (
        <div className="v2-notification-panel">
          <div className="v2-notification-head">
            <div>
              <h3>Notifications</h3>
              <p>Latest logistics activity</p>
            </div>

            <button type="button" onClick={() => setShowNotifications(false)}>
              <X size={18} />
            </button>
          </div>

          {alerts.map((alert) => (
            <div key={alert.id} className={`v2-notification-item ${alert.type}`}>
              <strong>{alert.title}</strong>
              <p>{alert.desc}</p>
              <small>{alert.time}</small>
            </div>
          ))}

          <button
            type="button"
            className="v2-outline-full"
            onClick={() => navigate("/admin/alerts")}
          >
            View Alert Center
          </button>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, value, label, trend, type, onClick }) {
  return (
    <button type="button" className={`v2-metric-card ${type}`} onClick={onClick}>
      <div className="v2-metric-icon">{icon}</div>

      <div className="v2-trend">{trend}</div>

      <h2>{value}</h2>
      <p>{label}</p>
    </button>
  );
}

function AlertItem({ title, desc, time, type, onReview }) {
  return (
    <div className={`v2-alert-item ${type}`}>
      <div>
        <strong>{title}</strong>
        <p>{desc}</p>
        <small>{time}</small>
      </div>

      <button type="button" onClick={onReview}>
        Review
      </button>
    </div>
  );
}

export default AdminDashboard;