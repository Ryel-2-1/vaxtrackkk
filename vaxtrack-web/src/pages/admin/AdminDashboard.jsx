import "./AdminDashboard.css";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
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
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeAllAlerts } from "../../services/alertService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeInventory } from "../../services/inventoryService";

function formatRelativeTime(timestamp) {
  if (!timestamp) return "—";
  const ms = timestamp.toMillis ? timestamp.toMillis() : timestamp;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const ALERT_TYPE_MAP = {
  temperature_breach: "critical",
  stock_expiry: "warning",
  route_deviation: "critical",
  delivery_delay: "warning",
  resolved: "success",
};

function normalizeAlert(raw) {
  return {
    id: raw.id,
    type: ALERT_TYPE_MAP[raw.type] || (raw.status === "resolved" ? "success" : "warning"),
    title: raw.title || raw.type || "Alert",
    desc: raw.message || raw.description || "—",
    time: formatRelativeTime(raw.createdAt),
  };
}

function AdminDashboard() {
  const navigate = useNavigate();

  const [showAlertBanner, setShowAlertBanner] = useState(true);
  const [showInspectModal, setShowInspectModal] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showRiderTooltip, setShowRiderTooltip] = useState(false);
  const [mapZoom, setMapZoom] = useState(100);
  const [mapLayer, setMapLayer] = useState("Standard");
  const [toast, setToast] = useState("");

  const [deliveryCount, setDeliveryCount] = useState(0);
  const [delayedCount, setDelayedCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [riderCount, setRiderCount] = useState(0);
  const [recentAlerts, setRecentAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let loaded = { deliveries: false, alerts: false, riders: false, inventory: false };

    const checkAllLoaded = () => {
      if (loaded.deliveries && loaded.alerts && loaded.riders && loaded.inventory) {
        setLoading(false);
      }
    };

    const handleError = (error) => {
      console.error("Dashboard subscription error:", error);
      setLoadError(error.message || "Failed to load dashboard data.");
      setLoading(false);
    };

    const unsubDeliveries = subscribeDeliveries(
      (orders) => {
        setDeliveryCount(orders.length);
        setDelayedCount(
          orders.filter((o) => {
            return o.statusKey === "delayed" || o.statusKey === "cancelled" || o.statusKey === "canceled";
          }).length
        );
        loaded.deliveries = true;
        checkAllLoaded();
      },
      handleError
    );

    let unsubAlerts = () => {};
    try {
      unsubAlerts = subscribeAllAlerts((raw) => {
        setRecentAlerts(
          raw
            .filter((a) => a.status !== "resolved")
            .slice(0, 5)
            .map(normalizeAlert)
        );
        loaded.alerts = true;
        checkAllLoaded();
      });
    } catch (e) {
      console.error("Dashboard alerts subscription error:", e);
      loaded.alerts = true;
      checkAllLoaded();
    }

    const unsubRiders = subscribeRiders(
      (riders) => {
        setRiderCount(riders.length);
        loaded.riders = true;
        checkAllLoaded();
      },
      handleError
    );

    let unsubInventory = () => {};
    try {
      unsubInventory = subscribeInventory((batches) => {
        setCriticalCount(
          batches.filter((b) => {
            const s = (b.status || "").toLowerCase();
            return s === "critical";
          }).length
        );
        loaded.inventory = true;
        checkAllLoaded();
      });
    } catch (e) {
      console.error("Dashboard inventory subscription error:", e);
      loaded.inventory = true;
      checkAllLoaded();
    }

    return () => {
      unsubDeliveries();
      unsubAlerts();
      unsubRiders();
      unsubInventory();
    };
  }, []);

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

  const displayAlerts =
    recentAlerts.length > 0
      ? recentAlerts.slice(0, 3)
      : [
          {
            id: "empty",
            type: "success",
            title: "All Clear",
            desc: "No active alerts at this time.",
            time: "Now",
          },
        ];

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
              {recentAlerts.length > 0 && (
                <span className="v2-notification-dot"></span>
              )}
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

        {showAlertBanner && recentAlerts.some((a) => a.type === "critical") && (
          <section className="v2-alert-banner">
            <div className="v2-alert-icon">
              <AlertTriangle size={18} />
            </div>

            <div>
              <strong>
                {recentAlerts.find((a) => a.type === "critical")?.title ||
                  "Critical Alert"}
              </strong>
              <p>
                {recentAlerts.find((a) => a.type === "critical")?.desc ||
                  "A critical alert requires your attention."}
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
                    onClick={() =>
                      setMapZoom((prev) => Math.min(prev + 10, 160))
                    }
                    aria-label="Zoom in"
                  >
                    <Plus size={22} strokeWidth={2.4} />
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMapZoom((prev) => Math.max(prev - 10, 60))
                    }
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
                value={loading ? "..." : String(deliveryCount)}
                label="Active Deliveries"
                trend=""
                type="blue"
                onClick={() => navigate("/admin/deliveries")}
              />

              <MetricCard
                icon={<Clock size={18} />}
                value={loading ? "..." : String(delayedCount)}
                label="Delayed / Missing"
                trend=""
                type="amber"
                onClick={() => navigate("/admin/deliveries")}
              />

              <MetricCard
                icon={<AlertTriangle size={18} />}
                value={loading ? "..." : String(criticalCount)}
                label="Low Stock / Critical"
                trend=""
                type="red"
                onClick={() => navigate("/admin/inventory")}
              />

              <MetricCard
                icon={<Users size={18} />}
                value={loading ? "..." : String(riderCount)}
                label="Registered Riders"
                trend=""
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

              {displayAlerts.map((alert) => (
                <AlertItem
                  key={alert.id}
                  {...alert}
                  onReview={() => navigate("/admin/alerts")}
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
              <button
                type="button"
                className="v2-red-btn"
                onClick={handleContactRider}
              >
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

          {displayAlerts.map((alert) => (
            <div
              key={alert.id}
              className={`v2-notification-item ${alert.type}`}
            >
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
    <button
      type="button"
      className={`v2-metric-card ${type}`}
      onClick={onClick}
    >
      <div className="v2-metric-icon">{icon}</div>

      {trend && <div className="v2-trend">{trend}</div>}

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
