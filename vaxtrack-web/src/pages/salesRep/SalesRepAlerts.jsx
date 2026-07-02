import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  Loader2,
  Search,
  Truck,
  X,
} from "lucide-react";
import { subscribeSalesRepOrders } from "../../services/orderService";
import {
  normalizeStatusKey,
  getOrderStatusValue,
} from "../../services/deliveryService";
import { auth } from "../../firebase";
import SalesRepLayout from "./SalesRepLayout";

function deriveAlertFromOrder(order) {
  const rawStatus = getOrderStatusValue(order);
  const statusKey = normalizeStatusKey(rawStatus);

  let tone = "info";
  let tag = "INFO";
  let icon = <Info size={18} />;
  let title = "";
  let body = "";

  const clinic = order.clinicName || "Unknown Clinic";
  const orderNum = order.orderNumber || order.id;
  const vaccine = order.vaccineName || "Vaccine order";

  switch (statusKey) {
    case "delayed":
      tone = "critical";
      tag = "CRITICAL";
      icon = <AlertTriangle size={18} />;
      title = `Delivery Delayed — ${orderNum}`;
      body = `Order to ${clinic} for ${vaccine} has been delayed. Check order tracking for updates.`;
      break;
    case "cancelled":
    case "canceled":
      tone = "critical";
      tag = "CRITICAL";
      icon = <AlertTriangle size={18} />;
      title = `Order Cancelled — ${orderNum}`;
      body = `Order to ${clinic} for ${vaccine} has been cancelled.`;
      break;
    case "assigned":
      tone = "info";
      tag = "UPDATE";
      icon = <Truck size={18} />;
      title = `Rider Assigned — ${orderNum}`;
      body = `A rider has been assigned to deliver ${vaccine} to ${clinic}.${order.assignedRiderName ? ` Rider: ${order.assignedRiderName}` : ""}`;
      break;
    case "in_transit":
      tone = "info";
      tag = "UPDATE";
      icon = <Truck size={18} />;
      title = `In Transit — ${orderNum}`;
      body = `Your order of ${vaccine} to ${clinic} is now in transit.`;
      break;
    case "completed":
    case "delivered":
      tone = "success";
      tag = "DELIVERED";
      icon = <CheckCircle size={18} />;
      title = `Delivered — ${orderNum}`;
      body = `Order of ${vaccine} to ${clinic} has been delivered successfully.`;
      break;
    case "pending":
    case "pending_dispatch":
      tone = "info";
      tag = "PENDING";
      icon = <Info size={18} />;
      title = `Order Submitted — ${orderNum}`;
      body = `Your order of ${vaccine} to ${clinic} is pending dispatch.`;
      break;
    case "loading":
      tone = "info";
      tag = "UPDATE";
      icon = <Truck size={18} />;
      title = `Loading — ${orderNum}`;
      body = `Order of ${vaccine} for ${clinic} is being loaded for dispatch.`;
      break;
    default:
      title = `Order Update — ${orderNum}`;
      body = `Order to ${clinic} status: ${rawStatus || "unknown"}.`;
      break;
  }

  const ts = order.updatedAt || order.createdAt;

  return {
    id: order.id,
    tone,
    tag,
    icon,
    title,
    body,
    location: clinic,
    time: formatTime(ts),
    statusKey,
    orderNumber: orderNum,
    priority: order.priority || "Standard",
    quantity: Number(order.quantity || 0),
    vaccineName: vaccine,
  };
}

function formatTime(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(date.getTime())) return "—";

  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SalesRepAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [activeTab, setActiveTab] = useState("active");
  const [activeFilter, setActiveFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [message, setMessage] = useState("");
  const [selectedAlert, setSelectedAlert] = useState(null);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setError("You must be logged in to view alerts.");
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeSalesRepOrders(
      user.uid,
      (raw) => {
        const derived = raw.map(deriveAlertFromOrder);
        setAlerts(derived);
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view alerts. Please contact your administrator.");
        } else {
          setError("Unable to load alerts. Please try again later.");
        }
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const activeAlerts = useMemo(
    () => alerts.filter((a) => a.statusKey !== "completed" && a.statusKey !== "delivered" && a.statusKey !== "cancelled" && a.statusKey !== "canceled"),
    [alerts]
  );

  const historyAlerts = useMemo(
    () => alerts.filter((a) => a.statusKey === "completed" || a.statusKey === "delivered" || a.statusKey === "cancelled" || a.statusKey === "canceled"),
    [alerts]
  );

  const currentAlerts = activeTab === "active" ? activeAlerts : historyAlerts;

  const filteredAlerts = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return currentAlerts.filter((alert) => {
      const matchesFilter = activeFilter === "all" || alert.tone === activeFilter;
      const matchesSearch =
        alert.orderNumber.toLowerCase().includes(search) ||
        alert.title.toLowerCase().includes(search) ||
        alert.body.toLowerCase().includes(search) ||
        alert.location.toLowerCase().includes(search);
      return matchesFilter && matchesSearch;
    });
  }, [activeFilter, currentAlerts, searchTerm]);

  const filterCounts = useMemo(() => ({
    all: currentAlerts.length,
    critical: currentAlerts.filter((a) => a.tone === "critical").length,
    info: currentAlerts.filter((a) => a.tone === "info").length,
    success: currentAlerts.filter((a) => a.tone === "success").length,
  }), [currentAlerts]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setActiveFilter("all");
    setSearchTerm("");
    setMessage("");
  };

  if (loading) {
    return (
      <SalesRepLayout active="alerts" title="Alerts & Notifications" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading alerts...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="alerts" title="Alerts & Notifications" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="alerts" title="Alerts & Notifications" showSearch={false}>
      <section className="sales-alerts-header alerts-v2-header no-filter-icon">
        <div>
          <h1>Alerts & Notifications</h1>
          <p>Order status updates and delivery alerts for your orders.</p>
        </div>

        <div className="alerts-v2-search">
          <Search size={15} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search order ID, title, or clinic..."
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
          Active ({activeAlerts.length})
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
        <FilterButton label={`All (${filterCounts.all})`} value="all" activeFilter={activeFilter} onClick={setActiveFilter} />
        <FilterButton label={`Critical (${filterCounts.critical})`} value="critical" activeFilter={activeFilter} onClick={setActiveFilter} />
        <FilterButton label={`Updates (${filterCounts.info})`} value="info" activeFilter={activeFilter} onClick={setActiveFilter} />
        {activeTab === "history" && (
          <FilterButton label={`Delivered (${filterCounts.success})`} value="success" activeFilter={activeFilter} onClick={setActiveFilter} />
        )}
      </div>

      <section className="sales-alert-grid alerts-v2-grid">
        {filteredAlerts.length > 0 ? (
          filteredAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              isHistory={activeTab === "history"}
              onViewDetails={() => setSelectedAlert(alert)}
            />
          ))
        ) : (
          <div className="alerts-v2-empty">
            <Info size={34} />
            <strong>No alerts found</strong>
            <p>
              {alerts.length === 0
                ? "Place your first order to start receiving alerts."
                : "Try changing the search keyword or filter."}
            </p>
          </div>
        )}
      </section>

      {selectedAlert && (
        <div className="alerts-v2-modal-backdrop" onClick={() => setSelectedAlert(null)}>
          <div className="alerts-v2-modal" onClick={(event) => event.stopPropagation()}>
            <div className="alerts-v2-modal-head">
              <div>
                <span>{selectedAlert.orderNumber}</span>
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
                <span>Priority</span>
                <strong>{selectedAlert.priority}</strong>
              </div>
              <div>
                <span>Clinic</span>
                <strong>{selectedAlert.location}</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>{selectedAlert.time}</strong>
              </div>
              <div>
                <span>Vaccine</span>
                <strong>{selectedAlert.vaccineName}</strong>
              </div>
              <div>
                <span>Quantity</span>
                <strong>{selectedAlert.quantity.toLocaleString()} vials</strong>
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
      className={`alert-filter-btn ${value} ${activeFilter === value ? "active" : ""}`}
      onClick={() => onClick(value)}
    >
      {value !== "all" && <span className="filter-dot"></span>}
      {label}
    </button>
  );
}

function AlertCard({ alert, isHistory, onViewDetails }) {
  return (
    <div className={`sales-alert-card alerts-v2-card ${alert.tone} ${isHistory ? "history" : ""}`}>
      <div className="sales-alert-card-top">
        <span>{alert.icon}</span>
        <b>{isHistory ? (alert.statusKey === "cancelled" || alert.statusKey === "canceled" ? "CANCELLED" : "DELIVERED") : alert.tag}</b>
        <small>{alert.time}</small>
      </div>

      <h2>{alert.title}</h2>
      <p>{alert.body}</p>

      {alert.location && <div className="alert-location">{alert.location}</div>}

      <div className="alert-actions">
        <button type="button" onClick={onViewDetails}>
          View Details
        </button>
      </div>
    </div>
  );
}

export default SalesRepAlerts;
