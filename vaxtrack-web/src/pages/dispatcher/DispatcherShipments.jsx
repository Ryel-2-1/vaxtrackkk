import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Package, X } from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { updateOrderStatus } from "../../services/orderService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";
import StatusBadge from "../../components/ui/StatusBadge";
import KpiCard from "../../components/ui/KpiCard";

function statusLabel(key) {
  switch (key) {
    case "pending_dispatch": return "Pending Dispatch";
    case "assigned": return "Assigned";
    case "loading": return "Loading";
    case "in_transit": return "In Transit";
    case "delayed": return "Delayed";
    case "delivered":
    case "completed": return "Delivered";
    case "cancelled":
    case "canceled": return "Cancelled";
    default: return key || "Unknown";
  }
}

// Shipments is a monitoring + exception-handling surface, not a dispatch path.
// Cargo Loading is the canonical route for assigned → loading → in_transit,
// so "Start loading" and "Dispatch" are intentionally absent here.
// Delay / Cancel / Resume transit remain as exception handling, and
// "Mark delivered" stays as a dispatcher override — the normal completion
// path is the Rider mobile app.
function nextActions(statusKey) {
  switch (statusKey) {
    case "assigned": return [
      { label: "Delay", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "loading": return [
      { label: "Delay", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "in_transit": return [
      { label: "Mark delivered (override)", next: "delivered", tone: "primary" },
      { label: "Delay", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "delayed": return [
      { label: "Resume transit", next: "in_transit", tone: "primary" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    default: return [];
  }
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function DispatcherShipments() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState("success");
  const [updating, setUpdating] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");

  useEffect(() => {
    const unsub = subscribeDeliveries(
      (all) => {
        setOrders(all);
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view shipments.");
        } else {
          setError("Unable to load shipments.");
        }
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const grouped = useMemo(() => {
    const assigned = orders.filter((o) => o.statusKey === "assigned");
    const loadingO = orders.filter((o) => o.statusKey === "loading");
    const transit = orders.filter((o) => o.statusKey === "in_transit");
    const delayed = orders.filter((o) => o.statusKey === "delayed");
    const delivered = orders.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed");
    const cancelled = orders.filter((o) => o.statusKey === "cancelled" || o.statusKey === "canceled");
    return { assigned, loading: loadingO, transit, delayed, delivered, cancelled };
  }, [orders]);

  const activeOrders = useMemo(() => {
    if (filterStatus === "active") {
      return [...grouped.assigned, ...grouped.loading, ...grouped.transit, ...grouped.delayed];
    }
    if (filterStatus === "assigned") return grouped.assigned;
    if (filterStatus === "loading") return grouped.loading;
    if (filterStatus === "in_transit") return grouped.transit;
    if (filterStatus === "delayed") return grouped.delayed;
    if (filterStatus === "delivered") return grouped.delivered;
    if (filterStatus === "cancelled") return grouped.cancelled;
    return orders;
  }, [filterStatus, grouped, orders]);

  const handleStatusUpdate = async (orderId, newStatus) => {
    setUpdating(orderId);
    setToast("");
    try {
      const user = auth.currentUser;
      await updateOrderStatus(
        orderId,
        newStatus,
        { uid: user?.uid || null, email: user?.email || null }
      );
      showToast(`Order updated to ${statusLabel(newStatus)}.`, "success");
    } catch (err) {
      console.error("Status update error:", err);
      showToast(err.message || "Failed to update status.", "error");
    } finally {
      setUpdating("");
    }
  };

  const showToast = (msg, type) => {
    setToast(msg);
    setToastType(type);
  };

  const totalActive = grouped.assigned.length + grouped.loading.length + grouped.transit.length + grouped.delayed.length;
  const totalDone = grouped.delivered.length;

  const FILTERS = [
    { id: "active", label: "Active", count: totalActive },
    { id: "assigned", label: "Assigned", count: grouped.assigned.length },
    { id: "loading", label: "Loading", count: grouped.loading.length },
    { id: "in_transit", label: "In transit", count: grouped.transit.length },
    { id: "delayed", label: "Delayed", count: grouped.delayed.length },
    { id: "delivered", label: "Delivered", count: totalDone },
    { id: "cancelled", label: "Cancelled", count: grouped.cancelled.length },
  ];

  if (loading) {
    return (
      <DispatcherLayout active="shipments" title="VaxTrack Logistics">
        <div className="shp-state">
          <Loader2 size={30} className="spin" />
          <p>Loading shipments...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="shipments" title="VaxTrack Logistics">
        <div className="shp-state">
          <span className="shp-state-icon">
            <AlertTriangle size={18} />
          </span>
          <strong>Could not load shipments</strong>
          <p>{error}</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="shipments" title="VaxTrack Logistics">
      <div className="shp-page">
        <header className="shp-header">
          <h1>Shipments</h1>
          <p>Track and update the status of assigned shipments.</p>
        </header>

        <section className="shp-kpis">
          <KpiCard label="Active" value={totalActive} context="In progress" tone="neutral" />
          <KpiCard label="In transit" value={grouped.transit.length} context="On the road" tone="info" />
          <KpiCard
            label="Delayed"
            value={grouped.delayed.length}
            context={grouped.delayed.length > 0 ? "Needs attention" : "None delayed"}
            tone="danger"
            attention={grouped.delayed.length > 0}
          />
          <KpiCard label="Delivered" value={totalDone} context="Completed" tone="success" />
        </section>

        {toast && (
          <div className={`shp-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{toast}</span>
            <button type="button" onClick={() => setToast("")} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="shp-filterbar">
          <div className="shp-segmented">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`shp-segment ${filterStatus === f.id ? "active" : ""}`}
                onClick={() => setFilterStatus(f.id)}
              >
                {f.label} · {f.count}
              </button>
            ))}
          </div>
        </div>

        <section className="shp-card">
          {activeOrders.length === 0 ? (
            <div className="shp-empty">
              <span className="shp-empty-icon">
                <Package size={18} />
              </span>
              <strong>No shipments match this filter</strong>
              <p>Try a different status filter above.</p>
            </div>
          ) : (
            <div className="shp-table-wrap">
              <table className="shp-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Destination</th>
                    <th>Vaccine</th>
                    <th>Rider</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeOrders.map((order) => (
                    <ShipmentRow
                      key={order.id}
                      order={order}
                      updating={updating === order.id}
                      onStatusUpdate={handleStatusUpdate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </DispatcherLayout>
  );
}

function ShipmentRow({ order, updating, onStatusUpdate }) {
  const sKey = order.statusKey;
  const actions = nextActions(sKey);
  const isDelayed = sKey === "delayed";

  const riderName = order.assignedRiderName || "Unassigned";
  const riderPhone = order.assignedRiderPhone || "";
  const orderNum = order.orderNumber || order.id;
  const vaccine = order.vaccineName || "—";
  const clinic = order.clinicName || "—";
  const address = order.clinicAddress || "";
  const qty = order.quantity || 0;
  const unit = order.unit || "vials";
  const updated = formatTime(order.updatedAt || order.assignedAt || order.createdAt);

  return (
    <tr className={isDelayed ? "shp-row-delayed" : ""}>
      <td>
        <span className="shp-order-id">{orderNum}</span>
      </td>
      <td>
        <div className="shp-cell">
          <strong>{clinic}</strong>
          {address && <small>{address}</small>}
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong>{vaccine}</strong>
          <small className="tnum">{qty.toLocaleString()} {unit}</small>
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong className={riderName === "Unassigned" ? "shp-muted" : ""}>{riderName}</strong>
          {riderPhone && <small>{riderPhone}</small>}
        </div>
      </td>
      <td>
        <StatusBadge statusKey={sKey} />
      </td>
      <td className="shp-td-meta">{updated}</td>
      <td>
        {actions.length > 0 ? (
          <div className="shp-actions">
            {actions.map((action) => (
              <button
                key={action.next}
                type="button"
                className={`shp-act-btn ${action.tone}`}
                disabled={updating}
                onClick={() => onStatusUpdate(order.id, action.next)}
              >
                {updating && action.tone === "primary" ? (
                  <Loader2 size={12} className="spin" />
                ) : null}
                {action.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="shp-muted">—</span>
        )}
      </td>
    </tr>
  );
}

export default DispatcherShipments;
