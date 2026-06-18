import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Filter,
  Info,
  Search,
  Thermometer,
  Truck,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const activeAlerts = [
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
  },
  {
    id: "ALT-004",
    tone: "info",
    icon: <Info size={18} />,
    tag: "INFO",
    title: "Scheduled Maintenance",
    body: "System backend update scheduled for 02:00 AM PHT. Analytics module may be temporarily unavailable.",
    location: "",
    time: "3 hrs ago",
    primary: "Acknowledge",
  },
];

const historyAlerts = [
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
  },
];

function SalesRepAlerts() {
  const [activeTab, setActiveTab] = useState("active");
  const [activeFilter, setActiveFilter] = useState("all");

  const alerts = activeTab === "active" ? activeAlerts : historyAlerts;

  const filteredAlerts = useMemo(() => {
    if (activeFilter === "all") return alerts;

    return alerts.filter((alert) => alert.tone === activeFilter);
  }, [activeFilter, alerts]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setActiveFilter("all");
  };

  return (
    <SalesRepLayout
      active="alerts"
      title="Alerts & Notifications"
      showSearch={false}
    >
      <section className="sales-alerts-header">
        <div>
          <h1>Alerts & Notifications</h1>
          <p>Manage critical logistics issues and system warnings.</p>
        </div>

        <div className="request-search">
          <Search size={15} />
          <input placeholder="Search ID or location..." />
        </div>

        <button className="filter-square" type="button">
          <Filter size={16} />
        </button>
      </section>

      <div className="sales-alert-tabs">
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

      <div className="sales-alert-filters">
        <FilterButton
          label="All"
          value="all"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label="Critical"
          value="critical"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label="Warning"
          value="warning"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />

        <FilterButton
          label="Info"
          value="info"
          activeFilter={activeFilter}
          onClick={setActiveFilter}
        />
      </div>

      <section className="sales-alert-grid">
        {filteredAlerts.map((alert) => (
          <AlertCard key={alert.id} {...alert} isHistory={activeTab === "history"} />
        ))}
      </section>
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

function AlertCard({
  tone,
  icon,
  tag,
  title,
  body,
  location,
  time,
  primary,
  secondary,
  isHistory,
}) {
  return (
    <div className={`sales-alert-card ${tone} ${isHistory ? "history" : ""}`}>
      <div className="sales-alert-card-top">
        <span>{icon}</span>
        <b>{isHistory ? "RESOLVED" : tag}</b>
        <small>{time}</small>
      </div>

      <h2>{title}</h2>
      <p>{body}</p>

      {location && <div className="alert-location">{location}</div>}

      <div className="alert-actions">
        <button type="button">{primary}</button>
        {secondary && (
          <button type="button" className="outline">
            {secondary}
          </button>
        )}
      </div>
    </div>
  );
}

export default SalesRepAlerts;