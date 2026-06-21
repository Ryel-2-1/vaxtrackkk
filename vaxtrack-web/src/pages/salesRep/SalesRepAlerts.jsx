import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  Phone,
  Search,
  Thermometer,
  Truck,
  X,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const initialActiveAlerts = [
  {
    id: "ALT-001",
    tone: "critical",
    icon: <Thermometer size={18} />,
    tag: "CRITICAL",
    title: "Temperature Deviation in Hub Alpha",
    body: "Freezer Unit #3 dropped below -70°C threshold. Current temp: -62°C. Pfizer-BioNTech batch at risk.",
    location: "Hub Alpha, North Wing",
    time: "Just now",
    primary: "Dispatch Tech",
    secondary: "Details",
    status: "Open",
  },
  {
    id: "ALT-002",
    tone: "critical",
    icon: <Truck size={18} />,
    tag: "CRITICAL",
    title: "Rider #104 Route Delay",
    body: "Vehicle breakdown reported on EDSA. Cold chain integrity expires in 45 minutes.",
    location: "Mark Santos • 45m left",
    time: "12 mins ago",
    primary: "Re-route Backup",
    secondary: "Call",
    status: "Open",
  },
  {
    id: "ALT-003",
    tone: "warning",
    icon: <AlertTriangle size={18} />,
    tag: "WARNING",
    title: "Low Stock: Pfizer-BioNTech",
    body: "Inventory in Manila Central has dropped below 15% threshold. Replenishment needed within 48 hours.",
    location: "Current Stock 14% (250 vials)",
    time: "1 hr ago",
    primary: "Request Transfer",
    secondary: "Dismiss",
    status: "Open",
  },
  {
    id: "ALT-004",
    tone: "info",
    icon: <Info size={18} />,
    tag: "INFO",
    title: "Scheduled Maintenance",
    body: "System backend update scheduled for 02:00 AM PHT. Analytics module may be temporarily unavailable.",
    location: "System Update",
    time: "3 hrs ago",
    primary: "Acknowledge",
    secondary: "",
    status: "Open",
  },
];

const initialHistoryAlerts = [
  {
    id: "HIS-001",
    tone: "critical",
    icon: <CheckCircle size={18} />,
    tag: "CRITICAL",
    title: "Temperature Alert Resolved",
    body: "Cold-chain temperature returned to normal after freezer recalibration.",
    location: "Hub Alpha, North Wing",
    time: "Yesterday",
    primary: "View Details",
    secondary: "",
    status: "Resolved",
  },
  {
    id: "HIS-002",
    tone: "warning",
    icon: <CheckCircle size={18} />,
    tag: "WARNING",
    title: "Low Stock Replenished",
    body: "Pfizer-BioNTech stock was replenished and is now above the minimum threshold.",
    location: "Manila Central Hub",
    time: "2 days ago",
    primary: "View Details",
    secondary: "",
    status: "Resolved",
  },
  {
    id: "HIS-003",
    tone: "info",
    icon: <CheckCircle size={18} />,
    tag: "INFO",
    title: "Maintenance Completed",
    body: "Scheduled backend maintenance was completed successfully.",
    location: "System Update",
    time: "3 days ago",
    primary: "View Details",
    secondary: "",
    status: "Resolved",
  },
];

function SalesRepAlerts() {
  const [activeAlerts, setActiveAlerts] = useState(initialActiveAlerts);
  const [historyAlerts, setHistoryAlerts] = useState(initialHistoryAlerts);
  const [activeTab, setActiveTab] = useState("active");
  const [activeFilter, setActiveFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [message, setMessage] = useState("");
  const [selectedAlert, setSelectedAlert] = useState(null);

  const alerts = activeTab === "active" ? activeAlerts : historyAlerts;

  const filteredAlerts = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();

    return alerts.filter((alert) => {
      const matchesFilter = activeFilter === "all" || alert.tone === activeFilter;
      const matchesSearch =
        alert.id.toLowerCase().includes(search) ||
        alert.title.toLowerCase().includes(search) ||
        alert.body.toLowerCase().includes(search) ||
        alert.location.toLowerCase().includes(search) ||
        alert.status.toLowerCase().includes(search);

      return matchesFilter && matchesSearch;
    });
  }, [activeFilter, alerts, searchTerm]);

  const filterCounts = useMemo(() => {
    return {
      all: alerts.length,
      critical: alerts.filter((alert) => alert.tone === "critical").length,
      warning: alerts.filter((alert) => alert.tone === "warning").length,
      info: alerts.filter((alert) => alert.tone === "info").length,
    };
  }, [alerts]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setActiveFilter("all");
    setSearchTerm("");
    setMessage("");
  };

  const updateAlertStatus = (alertId, status, successMessage) => {
    setActiveAlerts((current) =>
      current.map((alert) =>
        alert.id === alertId ? { ...alert, status } : alert
      )
    );
    setMessage(successMessage);
  };

  const moveToHistory = (alert, status) => {
    const resolvedAlert = {
      ...alert,
      icon: <CheckCircle size={18} />,
      status,
      time: "Just now",
      primary: "View Details",
      secondary: "",
    };

    setActiveAlerts((current) => current.filter((item) => item.id !== alert.id));
    setHistoryAlerts((current) => [resolvedAlert, ...current]);
    setMessage(`${alert.id} was moved to History as ${status}.`);
  };

  const handlePrimaryAction = (alert) => {
    if (activeTab === "history") {
      setSelectedAlert(alert);
      return;
    }

    if (alert.primary === "Dispatch Tech") {
      updateAlertStatus(alert.id, "Technician Dispatched", "Technician dispatch recorded.");
      return;
    }

    if (alert.primary === "Re-route Backup") {
      updateAlertStatus(alert.id, "Backup Rider Requested", "Backup rider request recorded.");
      return;
    }

    if (alert.primary === "Request Transfer") {
      localStorage.setItem(
        "salesRepAlertTransferDraft",
        JSON.stringify({
          alertId: alert.id,
          title: alert.title,
          location: alert.location,
          createdAt: new Date().toISOString(),
        })
      );

      updateAlertStatus(alert.id, "Transfer Requested", "Transfer request draft saved.");
      return;
    }

    if (alert.primary === "Acknowledge") {
      moveToHistory(alert, "Acknowledged");
    }
  };

  const handleSecondaryAction = (alert) => {
    if (alert.secondary === "Details") {
      setSelectedAlert(alert);
      return;
    }

    if (alert.secondary === "Call") {
      setMessage("Calling assigned rider/support contact...");
      return;
    }

    if (alert.secondary === "Dismiss") {
      moveToHistory(alert, "Dismissed");
    }
  };

  return (
    <SalesRepLayout
      active="alerts"
      title="Alerts & Notifications"
      showSearch={false}
    >
      <section className="sales-alerts-header alerts-v2-header no-filter-icon">
        <div>
          <h1>Alerts & Notifications</h1>
          <p>Manage critical logistics issues and system warnings.</p>
        </div>

        <div className="alerts-v2-search">
          <Search size={15} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search alert ID, title, or location..."
          />
        </div>
      </section>

      {message && (
        <div className="alerts-v2-toast">
          <CheckCircle size={16} />
          <span>{message}</span>
          <button type="button" onClick={() => setMessage("")}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="sales-alert-tabs alerts-v2-tabs">
        <button
          type="button"
          className={activeTab === "active" ? "active" : ""}
          onClick={() => handleTabChange("active")}
        >
          Active Alerts ({activeAlerts.length})
        </button>

        <button
          type="button"
          className={activeTab === "history" ? "active" : ""}
          onClick={() => handleTabChange("history")}
        >
          History ({historyAlerts.length})
        </button>
      </div>

      <div className="sales-alert-filters alerts-v2-filters">
        <FilterButton
          label={`All (${filterCounts.all})`}
          value="all"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label={`Critical (${filterCounts.critical})`}
          value="critical"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label={`Warning (${filterCounts.warning})`}
          value="warning"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label={`Info (${filterCounts.info})`}
          value="info"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />
      </div>

      <section className="sales-alert-grid alerts-v2-grid">
        {filteredAlerts.length > 0 ? (
          filteredAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              isHistory={activeTab === "history"}
              onPrimaryAction={handlePrimaryAction}
              onSecondaryAction={handleSecondaryAction}
            />
          ))
        ) : (
          <div className="alerts-v2-empty">
            <Info size={34} />
            <strong>No alerts found</strong>
            <p>Try changing the search keyword or filter.</p>
          </div>
        )}
      </section>

      {selectedAlert && (
        <div className="alerts-v2-modal-backdrop" onClick={() => setSelectedAlert(null)}>
          <div className="alerts-v2-modal" onClick={(event) => event.stopPropagation()}>
            <div className="alerts-v2-modal-head">
              <div>
                <span>{selectedAlert.id}</span>
                <h2>{selectedAlert.title}</h2>
              </div>

              <button type="button" onClick={() => setSelectedAlert(null)}>
                <X size={18} />
              </button>
            </div>

            <p>{selectedAlert.body}</p>

            <div className="alerts-v2-modal-details">
              <div>
                <span>Severity</span>
                <strong>{selectedAlert.tag}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{selectedAlert.status}</strong>
              </div>
              <div>
                <span>Location</span>
                <strong>{selectedAlert.location || "N/A"}</strong>
              </div>
              <div>
                <span>Reported</span>
                <strong>{selectedAlert.time}</strong>
              </div>
            </div>

            <button type="button" onClick={() => setSelectedAlert(null)}>
              Close Details
            </button>
          </div>
        </div>
      )}
    </SalesRepLayout>
  );
}

function FilterButton({ label, value, activeFilter, onClick }) {
  return (
    <button
      type="button"
      className={`alert-filter-btn ${value} ${
        activeFilter === value ? "active" : ""
      }`}
      onClick={() => onClick(value)}
    >
      {value !== "all" && <span className="filter-dot"></span>}
      {label}
    </button>
  );
}

function AlertCard({ alert, isHistory, onPrimaryAction, onSecondaryAction }) {
  return (
    <div className={`sales-alert-card alerts-v2-card ${alert.tone} ${isHistory ? "history" : ""}`}>
      <div className="sales-alert-card-top">
        <span>{alert.icon}</span>
        <b>{isHistory ? "RESOLVED" : alert.tag}</b>
        <small>{alert.time}</small>
      </div>

      <h2>{alert.title}</h2>
      <p>{alert.body}</p>

      {alert.location && <div className="alert-location">{alert.location}</div>}

      <div className="alerts-v2-status-row">
        <span>Status</span>
        <strong>{alert.status}</strong>
      </div>

      <div className="alert-actions">
        <button type="button" onClick={() => onPrimaryAction(alert)}>
          {alert.primary}
        </button>

        {alert.secondary && (
          <button type="button" className="outline" onClick={() => onSecondaryAction(alert)}>
            {alert.secondary === "Call" && <Phone size={14} />}
            {alert.secondary}
          </button>
        )}
      </div>
    </div>
  );
}

export default SalesRepAlerts;
