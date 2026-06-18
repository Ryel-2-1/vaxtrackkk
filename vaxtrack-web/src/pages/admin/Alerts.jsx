import "./Alerts.css";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  MapPin,
  Package,
  PhoneCall,
  Route,
  Search,
  Settings,
  ShieldAlert,
  Thermometer,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

const initialAlerts = [
  {
    id: "ALT-001",
    type: "Route Deviation",
    message: "Rider 0412 moved outside the assigned delivery route.",
    source: "Delivery DEL-2026-002",
    deliveryId: "DEL-2026-002",
    rider: "Rider 0412",
    severity: "critical",
    status: "active",
    time: "2 mins ago",
    iconKey: "route",
    recommendation: "Contact the rider and inspect the delivery route immediately.",
    read: false,
  },
  {
    id: "ALT-002",
    type: "Temperature Warning",
    message: "Cold-chain temperature report requires admin validation.",
    source: "Batch BT-2026-001",
    deliveryId: "Batch BT-2026-001",
    rider: "Cold Storage Monitor",
    severity: "warning",
    status: "active",
    time: "8 mins ago",
    iconKey: "temperature",
    recommendation: "Validate the reported temperature and check storage compliance.",
    read: false,
  },
  {
    id: "ALT-003",
    type: "Low Stock",
    message: "Sinovac stock is below the safe inventory threshold.",
    source: "Inventory Module",
    deliveryId: "Inventory Module",
    rider: "Inventory System",
    severity: "warning",
    status: "active",
    time: "15 mins ago",
    iconKey: "package",
    recommendation: "Prepare a stock replenishment request for the affected vaccine.",
    read: false,
  },
  {
    id: "ALT-004",
    type: "Delayed Delivery",
    message: "Pagsanjan delivery is estimated to arrive later than expected.",
    source: "Delivery DEL-2026-002",
    deliveryId: "DEL-2026-002",
    rider: "Assigned Rider",
    severity: "notice",
    status: "active",
    time: "22 mins ago",
    iconKey: "truck",
    recommendation: "Monitor ETA and notify the receiving clinic if delay continues.",
    read: true,
  },
  {
    id: "ALT-005",
    type: "Delivery Completed",
    message: "Rider 0225 successfully completed delivery to Lumban Clinic.",
    source: "Delivery DEL-2026-003",
    deliveryId: "DEL-2026-003",
    rider: "Rider 0225",
    severity: "notice",
    status: "resolved",
    time: "35 mins ago",
    iconKey: "check",
    recommendation: "No further action required.",
    read: true,
  },
];

function Alerts() {
  const navigate = useNavigate();

  const [alerts, setAlerts] = useState(initialAlerts);
  const [searchTerm, setSearchTerm] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState("");

  const [alertSettings, setAlertSettings] = useState({
    routeDeviation: true,
    coldChain: true,
    inventory: true,
    deliveryDelay: true,
    push: true,
    email: false,
  });

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      const searchValue =
        `${alert.type} ${alert.message} ${alert.source} ${alert.deliveryId} ${alert.rider} ${alert.severity} ${alert.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());

      const matchesFilter =
        severityFilter === "all" ||
        (severityFilter === "resolved" && alert.status === "resolved") ||
        (severityFilter !== "resolved" &&
          alert.status !== "resolved" &&
          alert.severity === severityFilter);

      return matchesSearch && matchesFilter;
    });
  }, [alerts, searchTerm, severityFilter]);

  const criticalCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "critical"
  ).length;

  const warningCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "warning"
  ).length;

  const noticeCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "notice"
  ).length;

  const resolvedCount = alerts.filter((alert) => alert.status === "resolved").length;

  const priorityAlert =
    alerts.find((alert) => alert.status !== "resolved" && alert.severity === "critical") ||
    alerts.find((alert) => alert.status !== "resolved" && alert.severity === "warning") ||
    alerts.find((alert) => alert.status !== "resolved");

  const handleReviewAlert = (alert) => {
    setAlerts((prev) =>
      prev.map((item) => (item.id === alert.id ? { ...item, read: true } : item))
    );

    setSelectedAlert({ ...alert, read: true });
  };

  const handleMarkAllRead = () => {
    setAlerts((prev) => prev.map((alert) => ({ ...alert, read: true })));
    showToast("All alerts marked as read.");
  };

  const handleResolveAlert = (alertId) => {
    setAlerts((prev) =>
      prev.map((alert) =>
        alert.id === alertId
          ? {
              ...alert,
              status: "resolved",
              read: true,
              time: "Just now",
            }
          : alert
      )
    );

    setSelectedAlert(null);
    showToast("Alert marked as resolved.");
  };

  const handleSaveSettings = () => {
    setShowSettings(false);
    showToast("Alert settings saved.");
  };

  const categoryCounts = {
    route: alerts.filter(
      (alert) => alert.status !== "resolved" && alert.type === "Route Deviation"
    ).length,
    cold: alerts.filter(
      (alert) => alert.status !== "resolved" && alert.type === "Temperature Warning"
    ).length,
    inventory: alerts.filter(
      (alert) => alert.status !== "resolved" && alert.type === "Low Stock"
    ).length,
    delivery: alerts.filter((alert) => alert.type.includes("Delivery")).length,
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="alerts" onLogout={handleLogout} />

      <main className="alerts-v2-main">
        {toast && <div className="alerts-toast">{toast}</div>}

        <header className="alerts-v2-topbar">
          <div>
            <p>VaxTrack / Alert Center</p>
            <h1>Alerts</h1>
            <small>
              Review route deviations, cold-chain warnings, stock issues, and delivery
              notifications.
            </small>
          </div>

          <div className="alerts-v2-actions">
            <button type="button" className="alerts-outline-btn" onClick={handleMarkAllRead}>
              <CheckCircle2 size={16} />
              Mark All Read
            </button>

            <button
              type="button"
              className="alerts-blue-btn"
              onClick={() => setShowSettings(true)}
            >
              <Bell size={16} />
              Alert Settings
            </button>
          </div>
        </header>

        <section className="alert-kpi-grid">
          <AlertKpi
            icon={<ShieldAlert size={22} />}
            label="Critical Alerts"
            value={criticalCount}
            note="Needs immediate action"
            type="red"
            active={severityFilter === "critical"}
            onClick={() => setSeverityFilter("critical")}
          />

          <AlertKpi
            icon={<AlertTriangle size={22} />}
            label="Warnings"
            value={warningCount}
            note="Requires review"
            type="orange"
            active={severityFilter === "warning"}
            onClick={() => setSeverityFilter("warning")}
          />

          <AlertKpi
            icon={<Clock size={22} />}
            label="Pending Notices"
            value={noticeCount}
            note="For monitoring"
            type="blue"
            active={severityFilter === "notice"}
            onClick={() => setSeverityFilter("notice")}
          />

          <AlertKpi
            icon={<CheckCircle2 size={22} />}
            label="Resolved Today"
            value={resolvedCount}
            note="Completed alerts"
            type="green"
            active={severityFilter === "resolved"}
            onClick={() => setSeverityFilter("resolved")}
          />
        </section>

        <section className="alerts-layout-grid">
          <div className="alerts-list-card">
            <div className="alerts-list-toolbar">
              <div>
                <h2>Recent Alerts</h2>
                <p>Latest system-generated admin notifications</p>
              </div>

              <div className="alerts-search">
                <Search size={16} />
                <input
                  placeholder="Search alert type, rider, batch, delivery ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="alerts-filter-tabs">
              <button
                type="button"
                className={severityFilter === "all" ? "active" : ""}
                onClick={() => setSeverityFilter("all")}
              >
                All
              </button>

              <button
                type="button"
                className={severityFilter === "critical" ? "active" : ""}
                onClick={() => setSeverityFilter("critical")}
              >
                Critical
              </button>

              <button
                type="button"
                className={severityFilter === "warning" ? "active" : ""}
                onClick={() => setSeverityFilter("warning")}
              >
                Warning
              </button>

              <button
                type="button"
                className={severityFilter === "notice" ? "active" : ""}
                onClick={() => setSeverityFilter("notice")}
              >
                Notice
              </button>

              <button
                type="button"
                className={severityFilter === "resolved" ? "active" : ""}
                onClick={() => setSeverityFilter("resolved")}
              >
                Resolved
              </button>
            </div>

            <div className="alerts-list">
              {filteredAlerts.map((alert) => (
                <div
                  className={`alert-row ${getAlertClass(alert)} ${
                    alert.read ? "" : "unread"
                  }`}
                  key={alert.id}
                  onClick={() => handleReviewAlert(alert)}
                >
                  <div className="alert-row-icon">{getAlertIcon(alert.iconKey)}</div>

                  <div className="alert-row-content">
                    <div className="alert-row-title">
                      <h3>{alert.type}</h3>
                      <span>{getSeverityLabel(alert)}</span>
                    </div>

                    <p>{alert.message}</p>

                    <div className="alert-row-meta">
                      <small>{alert.id}</small>
                      <small>{alert.source}</small>
                      <small>{alert.time}</small>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="alert-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReviewAlert(alert);
                    }}
                  >
                    Review
                  </button>
                </div>
              ))}

              {filteredAlerts.length === 0 && (
                <div className="alerts-empty">
                  <AlertTriangle size={28} />
                  <strong>No alerts found</strong>
                  <p>Try changing the search keyword or selected filter.</p>
                </div>
              )}
            </div>
          </div>

          <aside className="alerts-side-panel">
            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Alert Categories</h2>
                <p>System areas being monitored</p>
              </div>

              <div className="alert-category-stack">
                <CategoryItem
                  icon={<Route size={18} />}
                  title="Route Deviation"
                  count={`${categoryCounts.route} active`}
                  type="red"
                  onClick={() => {
                    setSearchTerm("Route Deviation");
                    setSeverityFilter("all");
                  }}
                />

                <CategoryItem
                  icon={<Thermometer size={18} />}
                  title="Cold-chain Warning"
                  count={`${categoryCounts.cold} active`}
                  type="orange"
                  onClick={() => {
                    setSearchTerm("Temperature");
                    setSeverityFilter("all");
                  }}
                />

                <CategoryItem
                  icon={<Package size={18} />}
                  title="Inventory Warning"
                  count={`${categoryCounts.inventory} active`}
                  type="blue"
                  onClick={() => {
                    setSearchTerm("Low Stock");
                    setSeverityFilter("all");
                  }}
                />

                <CategoryItem
                  icon={<Truck size={18} />}
                  title="Delivery Status"
                  count={`${categoryCounts.delivery} updates`}
                  type="green"
                  onClick={() => {
                    setSearchTerm("Delivery");
                    setSeverityFilter("all");
                  }}
                />
              </div>
            </div>

            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Priority Action</h2>
                <p>Most urgent alert to review</p>
              </div>

              {priorityAlert ? (
                <div className={`priority-alert-card ${getAlertClass(priorityAlert)}`}>
                  <div>{getAlertIcon(priorityAlert.iconKey)}</div>

                  <h3>{priorityAlert.type}</h3>
                  <p>{priorityAlert.message}</p>

                  <button type="button" onClick={() => handleReviewAlert(priorityAlert)}>
                    <MapPin size={15} />
                    Review Alert
                  </button>
                </div>
              ) : (
                <div className="priority-alert-card resolved">
                  <div>
                    <CheckCircle2 size={24} />
                  </div>

                  <h3>No active priority alert</h3>
                  <p>All critical alerts are currently resolved.</p>
                </div>
              )}
            </div>
          </aside>
        </section>
      </main>

      {selectedAlert && (
        <AlertReviewModal
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onResolve={() => handleResolveAlert(selectedAlert.id)}
          onContact={() => showToast(`Contacting ${selectedAlert.rider}...`)}
          onRoute={() => showToast(`Opening route for ${selectedAlert.deliveryId}.`)}
        />
      )}

      {showSettings && (
        <AlertSettingsModal
          settings={alertSettings}
          setSettings={setAlertSettings}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
        />
      )}
    </div>
  );
}

function AlertKpi({ icon, label, value, note, type, active, onClick }) {
  return (
    <button
      type="button"
      className={`alert-kpi ${type} ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <div className="alert-kpi-icon">{icon}</div>

      <div>
        <p>{label}</p>
        <h2>{value}</h2>
        <small>{note}</small>
      </div>
    </button>
  );
}

function CategoryItem({ icon, title, count, type, onClick }) {
  return (
    <button type="button" className={`alert-category-item ${type}`} onClick={onClick}>
      <div>{icon}</div>

      <section>
        <strong>{title}</strong>
        <p>{count}</p>
      </section>
    </button>
  );
}

function AlertReviewModal({ alert, onClose, onResolve, onContact, onRoute }) {
  return (
    <div className="alerts-modal-backdrop">
      <div className="alerts-modal">
        <button type="button" className="alerts-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <div className={`alerts-modal-icon ${getAlertClass(alert)}`}>
          {getAlertIcon(alert.iconKey)}
        </div>

        <h2>{alert.type}</h2>
        <p>{alert.message}</p>

        <div className="alerts-modal-grid">
          <div>
            <span>Severity</span>
            <strong>{getSeverityLabel(alert)}</strong>
          </div>

          <div>
            <span>Status</span>
            <strong>{alert.status === "resolved" ? "Resolved" : "Needs Review"}</strong>
          </div>

          <div>
            <span>Alert ID</span>
            <strong>{alert.id}</strong>
          </div>

          <div>
            <span>Source</span>
            <strong>{alert.source}</strong>
          </div>

          <div>
            <span>Rider / Module</span>
            <strong>{alert.rider}</strong>
          </div>

          <div>
            <span>Time</span>
            <strong>{alert.time}</strong>
          </div>

          <div className="wide">
            <span>Recommended Action</span>
            <strong>{alert.recommendation}</strong>
          </div>
        </div>

        <div className="alerts-modal-actions">
          {alert.status !== "resolved" && (
            <button type="button" className="alerts-primary-action" onClick={onResolve}>
              Mark Resolved
            </button>
          )}

          <button type="button" className="alerts-light-action" onClick={onContact}>
            <PhoneCall size={15} />
            Contact Rider
          </button>

          <button type="button" className="alerts-light-action" onClick={onRoute}>
            <MapPin size={15} />
            View Route
          </button>

          <button type="button" className="alerts-light-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AlertSettingsModal({ settings, setSettings, onClose, onSave }) {
  const settingItems = [
    ["routeDeviation", "Route deviation alerts", "Notify when a rider leaves the assigned route."],
    ["coldChain", "Cold-chain warnings", "Notify when temperature reports require review."],
    ["inventory", "Inventory warnings", "Notify for low stock and expiring batches."],
    ["deliveryDelay", "Delivery delay alerts", "Notify when ETA is delayed or missing."],
    ["push", "Push notifications", "Show alerts inside the VaxTrack dashboard."],
    ["email", "Email notifications", "Send important alert summaries by email."],
  ];

  return (
    <div className="alerts-modal-backdrop">
      <div className="alerts-modal settings-modal">
        <button type="button" className="alerts-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <div className="alerts-modal-icon settings">
          <Settings size={24} />
        </div>

        <h2>Alert Settings</h2>
        <p>Choose which system alerts should be monitored by the admin dashboard.</p>

        <div className="alerts-settings-list">
          {settingItems.map(([key, title, description]) => (
            <div className="alerts-setting-row" key={key}>
              <div>
                <strong>{title}</strong>
                <p>{description}</p>
              </div>

              <button
                type="button"
                className={`alerts-toggle ${settings[key] ? "on" : ""}`}
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    [key]: !prev[key],
                  }))
                }
              >
                <span></span>
              </button>
            </div>
          ))}
        </div>

        <div className="alerts-modal-actions">
          <button type="button" className="alerts-primary-action" onClick={onSave}>
            Save Settings
          </button>

          <button type="button" className="alerts-light-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function getAlertIcon(iconKey) {
  if (iconKey === "route") return <Route size={17} />;
  if (iconKey === "temperature") return <Thermometer size={17} />;
  if (iconKey === "package") return <Package size={17} />;
  if (iconKey === "truck") return <Truck size={17} />;
  if (iconKey === "check") return <CheckCircle2 size={17} />;
  return <AlertTriangle size={17} />;
}

function getSeverityLabel(alert) {
  if (alert.status === "resolved") return "Resolved";
  if (alert.severity === "critical") return "Critical";
  if (alert.severity === "warning") return "Warning";
  return "Notice";
}

function getAlertClass(alert) {
  if (alert.status === "resolved") return "resolved";
  if (alert.severity === "critical") return "critical";
  if (alert.severity === "warning") return "warning";
  return "notice";
}

export default Alerts;