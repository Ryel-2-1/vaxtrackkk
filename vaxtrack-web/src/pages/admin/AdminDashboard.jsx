import "./AdminDashboard.css";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { AlertTriangle, ArrowRight, CheckCircle2, Package } from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeAllAlerts } from "../../services/alertService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeInventory } from "../../services/inventoryService";
import KpiCard from "../../components/ui/KpiCard";
import StatusBadge from "../../components/ui/StatusBadge";

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

// Status rows shown in the delivery breakdown, in operational order.
const BREAKDOWN_ORDER = [
  "pending_dispatch",
  "assigned",
  "loading",
  "in_transit",
  "delayed",
  "delivered",
  "cancelled",
];

const ALERT_DOT = {
  critical: "var(--danger-text)",
  warning: "var(--warning-text)",
  success: "var(--success-text)",
};

function AdminDashboard() {
  const navigate = useNavigate();

  const [deliveryCount, setDeliveryCount] = useState(0);
  const [delayedCount, setDelayedCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [riderCount, setRiderCount] = useState(0);
  const [statusBreakdown, setStatusBreakdown] = useState({});
  const [recentOrders, setRecentOrders] = useState([]);
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
        // Derived from the same orders array — no extra Firestore read.
        const breakdown = {};
        orders.forEach((o) => {
          const key = o.statusKey === "canceled" ? "cancelled" : o.statusKey;
          breakdown[key] = (breakdown[key] || 0) + 1;
        });
        setStatusBreakdown(breakdown);
        setRecentOrders(
          orders.slice(0, 6).map((o) => ({
            id: o.id,
            orderNumber: o.orderNumber || o.id,
            clinicName: o.clinicName || "—",
            vaccineName: o.vaccineName || "—",
            statusKey: o.statusKey,
            time: formatRelativeTime(o.createdAt),
          }))
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

  const dash = loading ? "…" : undefined;
  const breakdownRows = BREAKDOWN_ORDER.filter((k) => statusBreakdown[k] > 0);
  const activeCount = deliveryCount;

  return (
    <div className="inventory-page">
      <AdminSidebar active="dashboard" onLogout={handleLogout} />

      <main className="adx-main">
        <header className="adx-header">
          <h1>Admin dashboard</h1>
          <p>Live overview of deliveries, alerts, riders, and stock.</p>
        </header>

        {loadError && (
          <div className="adx-banner">
            <AlertTriangle size={16} />
            <div>
              <strong>Could not load some dashboard data</strong>
              <p>{loadError}</p>
            </div>
          </div>
        )}

        <section className="adx-kpis">
          <KpiCard
            label="Total orders"
            value={dash ?? deliveryCount}
            context="All deliveries"
            tone="neutral"
            onClick={() => navigate("/admin/deliveries")}
          />
          <KpiCard
            label="Delayed / missing"
            value={dash ?? delayedCount}
            context={delayedCount > 0 ? "Needs review" : "None flagged"}
            tone="danger"
            attention={delayedCount > 0}
            onClick={() => navigate("/admin/deliveries")}
          />
          <KpiCard
            label="Critical stock"
            value={dash ?? criticalCount}
            context={criticalCount > 0 ? "Batches critical" : "Stock healthy"}
            tone="warning"
            attention={criticalCount > 0}
            onClick={() => navigate("/admin/inventory")}
          />
          <KpiCard
            label="Registered riders"
            value={dash ?? riderCount}
            context="On the platform"
            tone="success"
            onClick={() => navigate("/admin/riders")}
          />
        </section>

        <section className="adx-grid">
          <div className="adx-card">
            <div className="adx-card-head">
              <div>
                <h2>Delivery status breakdown</h2>
                <p>Live counts across all orders.</p>
              </div>
              <button
                type="button"
                className="adx-link"
                onClick={() => navigate("/admin/deliveries")}
              >
                Deliveries
                <ArrowRight size={14} />
              </button>
            </div>

            {breakdownRows.length === 0 ? (
              <div className="adx-empty">
                <span className="adx-empty-icon">
                  <Package size={18} />
                </span>
                <strong>No orders yet</strong>
                <p>Orders appear here as Sales Reps place them.</p>
              </div>
            ) : (
              <div className="adx-breakdown">
                {breakdownRows.map((key) => {
                  const count = statusBreakdown[key];
                  const pct = activeCount > 0 ? Math.round((count / activeCount) * 100) : 0;
                  return (
                    <div key={key} className="adx-breakdown-row">
                      <StatusBadge statusKey={key} />
                      <div className="adx-breakdown-bar">
                        <i className={`tone-${key}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="adx-breakdown-count tnum">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="adx-card">
            <div className="adx-card-head">
              <div>
                <h2>Alerts requiring attention</h2>
                <p>Unresolved alerts.</p>
              </div>
              <button
                type="button"
                className="adx-link"
                onClick={() => navigate("/admin/alerts")}
              >
                Alert center
                <ArrowRight size={14} />
              </button>
            </div>

            {recentAlerts.length === 0 ? (
              <div className="adx-empty compact">
                <span className="adx-empty-icon success">
                  <CheckCircle2 size={18} />
                </span>
                <strong>All clear</strong>
                <p>No active alerts right now.</p>
              </div>
            ) : (
              <div className="adx-alert-list">
                {recentAlerts.slice(0, 4).map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    className="adx-alert-row"
                    onClick={() => navigate("/admin/alerts")}
                  >
                    <span
                      className="adx-alert-dot"
                      style={{ background: ALERT_DOT[alert.type] || "var(--gray-400,#9ca3af)" }}
                    />
                    <div>
                      <strong>{alert.title}</strong>
                      <small>{alert.desc}</small>
                    </div>
                    <span className="adx-alert-time">{alert.time}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        </section>

        <section className="adx-card">
          <div className="adx-card-head">
            <div>
              <h2>Recent orders</h2>
              <p>Latest orders across all clinics.</p>
            </div>
            <button
              type="button"
              className="adx-link"
              onClick={() => navigate("/admin/deliveries")}
            >
              View all
              <ArrowRight size={14} />
            </button>
          </div>

          {recentOrders.length === 0 ? (
            <div className="adx-empty">
              <span className="adx-empty-icon">
                <Package size={18} />
              </span>
              <strong>No orders yet</strong>
              <p>Orders appear here as Sales Reps place them.</p>
            </div>
          ) : (
            <div className="adx-table-wrap">
              <table className="adx-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Clinic</th>
                    <th>Vaccine</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((o) => (
                    <tr key={o.id} onClick={() => navigate("/admin/deliveries")}>
                      <td>
                        <span className="adx-order-id">{o.orderNumber}</span>
                      </td>
                      <td>{o.clinicName}</td>
                      <td>{o.vaccineName}</td>
                      <td>
                        <StatusBadge statusKey={o.statusKey} />
                      </td>
                      <td className="adx-td-meta">{o.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default AdminDashboard;
