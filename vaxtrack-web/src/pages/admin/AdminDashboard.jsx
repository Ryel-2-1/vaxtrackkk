import "./AdminDashboard.css";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, Package } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeAllAlerts } from "../../services/alertService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeInventory } from "../../services/inventoryService";
import { deriveExpiryCondition, manilaToday } from "../../services/expiry";
import { ORDER_STATUSES } from "../../services/orderWorkflow";
import StatusBadge from "../../components/ui/StatusBadge";

// Small shimmer placeholder used while the first snapshots load, so sections
// don't flash their empty state before real data arrives.
function Skel({ w = "100%", h = 12, radius = 6 }) {
  return (
    <span
      className="adx-skel"
      style={{ width: w, height: h, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

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
};

function normalizeAlert(raw) {
  return {
    id: raw.id,
    // An unrecognised type falls back to "unknown", which paints the neutral
    // dot. It used to fall back to "warning", which assigned a severity the
    // alert never declared — an alert of an unmapped type was shown to an admin
    // as amber on nothing more than the absence of a mapping. (The old
    // `status === "resolved" ? "success"` arm was unreachable: this list is
    // filtered to unresolved alerts before it gets here.)
    type: ALERT_TYPE_MAP[raw.type] || "unknown",
    title: raw.title || raw.type || "Alert",
    desc: raw.message || raw.description || "—",
    time: formatRelativeTime(raw.createdAt),
  };
}

// Status rows shown in the delivery breakdown, in operational order.
//
// Derived from the canonical list rather than retyped. The hardcoded copy that
// stood here omitted `delivery_failed`, so a failed delivery was counted in the
// total — and in the percentage denominator — but had no row of its own and
// never appeared. The one status that most needs an admin's attention was the
// one the breakdown silently dropped. Taking the order from ORDER_STATUSES
// means a status added there cannot go missing here again.
const BREAKDOWN_ORDER = ORDER_STATUSES;

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
        // Derived from each batch's expiry date, not from the stored `status`
        // that Add Stock stamped once and nothing recomputes. Resolved here,
        // where the snapshot arrives, so no render reads the clock.
        const today = manilaToday(Date.now());
        setCriticalCount(
          batches.filter((b) => {
            const { level } = deriveExpiryCondition(b, today);
            return level === "expired" || level === "critical";
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

  const breakdownRows = BREAKDOWN_ORDER.filter((k) => statusBreakdown[k] > 0);
  const activeCount = deliveryCount;

  const ledgerCells = [
    { label: "Total orders", value: deliveryCount, note: "All deliveries", to: "/admin/deliveries", tone: "" },
    // Was "Delayed / missing". Nothing here is missing: the figure is delayed
    // plus cancelled orders, and a cancelled order is one somebody closed on
    // purpose. The system does have a status for a delivery that stopped —
    // `delivery_failed` — and calling cancelled orders "missing" both named the
    // wrong thing and implied that status was covered when it was not.
    { label: "Delayed / cancelled", value: delayedCount, note: delayedCount > 0 ? "Needs review" : "None flagged", to: "/admin/deliveries", tone: delayedCount > 0 ? " is-exception" : "" },
    // Counts batches that are expired or within 30 days of expiring, worked out
    // from each batch's expiry date. It used to count the stored `status`,
    // which Add Stock stamps once at creation and nothing recomputes — so a
    // batch that had since expired still counted as healthy stock. The label
    // says what is measured; quantity and reserved figures are separate
    // concerns and are not folded into it.
    { label: "Expiring or expired stock", value: criticalCount, note: criticalCount > 0 ? "Within 30 days or past expiry" : "None within 30 days", to: "/admin/inventory", tone: criticalCount > 0 ? " is-attention" : "" },
    { label: "Registered riders", value: riderCount, note: "On the platform", to: "/admin/riders", tone: "" },
  ];

  return (
    <AdminLayout
      active="dashboard"
      eyebrow="Cold-chain operations"
      title="Dashboard"
      description="Live overview of deliveries, alerts, riders, and stock."
    >
      {loadError && (
        <div className="adx-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>Could not load some dashboard data</strong>
            <p>{loadError}</p>
          </div>
        </div>
      )}

      {/* Operational status strip — the same real KPI values presented as one
          connected ledger rather than four floating cards. */}
      <section className="adx-ledger" aria-label="Operational status summary">
        {ledgerCells.map((c) => (
          <button
            key={c.label}
            type="button"
            className={`adx-ledger-cell${c.tone}`}
            onClick={() => navigate(c.to)}
            aria-label={`${c.label}: ${loading ? "loading" : c.value}. Open ${c.label.toLowerCase()}.`}
          >
            <span className="adx-ledger-label">{c.label}</span>
            <span className="adx-ledger-value tnum">
              {loading ? <Skel w="42px" h={20} /> : c.value}
            </span>
            <span className="adx-ledger-note">{loading ? "Loading…" : c.note}</span>
          </button>
        ))}
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
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>

          {loading ? (
            <div className="adx-breakdown" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="adx-breakdown-row">
                  <Skel w="120px" h={22} radius={999} />
                  <Skel h={8} radius={999} />
                  <Skel w="24px" h={14} />
                </div>
              ))}
            </div>
          ) : breakdownRows.length === 0 ? (
            <div className="adx-empty">
              <span className="adx-empty-icon">
                <Package size={18} aria-hidden="true" />
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
                    {/* purely decorative: the count is already announced as
                        text in the adjacent cell, so the bar is hidden from AT */}
                    <div className="adx-breakdown-bar" aria-hidden="true">
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
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>

          {loading ? (
            <div className="adx-alert-list" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="adx-alert-row" style={{ cursor: "default" }}>
                  <Skel w="8px" h={8} radius={999} />
                  <div style={{ flex: 1 }}>
                    <Skel w="60%" h={13} />
                    <div style={{ height: 6 }} />
                    <Skel w="85%" h={11} />
                  </div>
                </div>
              ))}
            </div>
          ) : recentAlerts.length === 0 ? (
            <div className="adx-empty compact">
              <span className="adx-empty-icon success">
                <CheckCircle2 size={18} aria-hidden="true" />
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
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>

        {loading ? (
          <div className="adx-skel-rows" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="adx-skel-row">
                <Skel w="140px" h={14} />
                <Skel w="30%" h={14} />
                <Skel w="60px" h={14} />
              </div>
            ))}
          </div>
        ) : recentOrders.length === 0 ? (
          <div className="adx-empty">
            <span className="adx-empty-icon">
              <Package size={18} aria-hidden="true" />
            </span>
            <strong>No orders yet</strong>
            <p>Orders appear here as Sales Reps place them.</p>
          </div>
        ) : (
          <div className="adx-table-wrap">
            <table className="adx-table">
              {/* The last column was headed "Updated" and the caption said
                  "time since the last update", but the value has always been
                  `createdAt` — when the order was placed, not when it last
                  changed. The column is named for the value it carries. */}
              <caption className="adx-sr-only">
                Recent orders across all clinics, with delivery status and how
                long ago each order was placed.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Clinic</th>
                  <th scope="col">Vaccine</th>
                  <th scope="col">Status</th>
                  <th scope="col">Placed</th>
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
    </AdminLayout>
  );
}

export default AdminDashboard;
