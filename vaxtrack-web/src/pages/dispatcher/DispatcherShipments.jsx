import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Filter,
  Loader2,
  Package,
  Truck,
  X,
  XCircle,
} from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { updateOrderStatus } from "../../services/orderService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";

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

function statusTone(key) {
  switch (key) {
    case "assigned": return "assigned";
    case "loading": return "loading";
    case "in_transit": return "transit";
    case "delayed": return "delayed";
    case "delivered":
    case "completed": return "delivered";
    case "cancelled":
    case "canceled": return "cancelled";
    default: return "pending";
  }
}

function nextActions(statusKey) {
  switch (statusKey) {
    case "assigned": return [
      { label: "Start Loading", next: "loading", tone: "primary" },
      { label: "Mark Delayed", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "loading": return [
      { label: "Dispatch", next: "in_transit", tone: "primary" },
      { label: "Mark Delayed", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "in_transit": return [
      { label: "Mark Delivered", next: "delivered", tone: "primary" },
      { label: "Mark Delayed", next: "delayed", tone: "warning" },
      { label: "Cancel", next: "cancelled", tone: "danger" },
    ];
    case "delayed": return [
      { label: "Resume Transit", next: "in_transit", tone: "primary" },
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
  const totalCancelled = grouped.cancelled.length;

  if (loading) {
    return (
      <DispatcherLayout active="shipments" title="VaxTrack Logistics">
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading shipments...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="shipments" title="VaxTrack Logistics">
        <div className="dispatcher-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="shipments" title="VaxTrack Logistics">
      <div className="dispatcher-v2-page">
        <div className="dispatcher-v2-header split">
          <div>
            <h1>Cargo Loading Queue</h1>
            <p>
              Monitor and manage the real-time loading process for assigned
              vaccine shipments. Ensure cold-chain integrity before dispatch.
            </p>
          </div>

          <div className="dispatcher-v2-top-cards">
            <div className="queue-status-card">
              <p>
                QUEUE STATUS <span>{orders.length} Total</span>
              </p>

              <div className="queue-bar">
                {totalActive > 0 && (
                  <span
                    className="seg waiting"
                    style={{ flex: totalActive }}
                  ></span>
                )}
                {totalDone > 0 && (
                  <span
                    className="seg done"
                    style={{ flex: totalDone }}
                  ></span>
                )}
                {totalCancelled > 0 && (
                  <span
                    className="seg cancelled-seg"
                    style={{ flex: totalCancelled }}
                  ></span>
                )}
              </div>

              <div className="queue-legend">
                <span>{totalActive} ACTIVE</span>
                <span>{totalDone} DELIVERED</span>
                <span>{totalCancelled} CANCELLED</span>
              </div>
            </div>
          </div>
        </div>

        {toast && (
          <div className={`alerts-v2-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{toast}</span>
            <button type="button" onClick={() => setToast("")}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="shipments-filter-bar">
          <FilterBtn label={`Active (${totalActive})`} value="active" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`Assigned (${grouped.assigned.length})`} value="assigned" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`Loading (${grouped.loading.length})`} value="loading" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`In Transit (${grouped.transit.length})`} value="in_transit" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`Delayed (${grouped.delayed.length})`} value="delayed" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`Delivered (${totalDone})`} value="delivered" current={filterStatus} onClick={setFilterStatus} />
          <FilterBtn label={`Cancelled (${totalCancelled})`} value="cancelled" current={filterStatus} onClick={setFilterStatus} />
        </div>

        <div className="dispatcher-shipments-grid">
          <div className="shipments-left">
            {activeOrders.length > 0 ? (
              <div className="pending-loads-list">
                {activeOrders.map((order) => (
                  <ShipmentCard
                    key={order.id}
                    order={order}
                    updating={updating === order.id}
                    onStatusUpdate={handleStatusUpdate}
                  />
                ))}
              </div>
            ) : (
              <div className="dispatcher-empty-queue">
                <Package size={28} />
                <p>No shipments match this filter.</p>
              </div>
            )}
          </div>

          <aside className="shipments-right">
            <div className="logistics-efficiency-card">
              <div className="logistics-card-head">
                <Clock3 size={14} />
                <span>Shipment Summary</span>
              </div>

              <div className="efficiency-main">
                <h2>{totalActive}</h2>
                <small>active</small>
              </div>

              <p className="efficiency-sub">Orders Being Processed</p>

              <div className="efficiency-list">
                <div>
                  <span>Assigned</span>
                  <strong>{grouped.assigned.length}</strong>
                </div>

                <div>
                  <span>Loading</span>
                  <strong>{grouped.loading.length}</strong>
                </div>

                <div>
                  <span>In Transit</span>
                  <strong>{grouped.transit.length}</strong>
                </div>

                <div>
                  <span>Delayed</span>
                  <strong>{grouped.delayed.length}</strong>
                </div>

                <div>
                  <span>Delivered</span>
                  <strong>{totalDone}</strong>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="dispatcher-v2-footer">
          <span>&copy; 2026 VaxTrack Logistics. All rights reserved.</span>

          <div>
            <a href="/">Privacy Policy</a>
            <a href="/">Terms of Service</a>
            <a href="/">Help Center</a>
          </div>
        </footer>
      </div>
    </DispatcherLayout>
  );
}

function FilterBtn({ label, value, current, onClick }) {
  return (
    <button
      type="button"
      className={`shipment-filter-btn ${current === value ? "active" : ""}`}
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

function ShipmentCard({ order, updating, onStatusUpdate }) {
  const sKey = order.statusKey;
  const tone = statusTone(sKey);
  const label = statusLabel(sKey);
  const actions = nextActions(sKey);
  const isTerminal = sKey === "delivered" || sKey === "completed" || sKey === "cancelled" || sKey === "canceled";

  const riderName = order.assignedRiderName || "Unassigned";
  const riderPhone = order.assignedRiderPhone || "";
  const orderNum = order.orderNumber || order.id;
  const vaccine = order.vaccineName || "—";
  const clinic = order.clinicName || "—";
  const qty = order.quantity || 0;
  const unit = order.unit || "vials";
  const priority = order.priority || "Standard";
  const assignedTime = formatTime(order.assignedAt);

  return (
    <div className={`sc-card ${tone} ${isTerminal ? "terminal" : ""}`}>
      <div className="sc-top">
        <div className="sc-icon-wrap">
          {isTerminal ? (
            sKey === "cancelled" || sKey === "canceled" ? <XCircle size={16} /> : <CheckCircle2 size={16} />
          ) : (
            <Truck size={16} />
          )}
        </div>

        <div className="sc-id">{orderNum}</div>

        <div className="shipment-tag-row">
          <span className={`load-tag ${priority.toLowerCase() === "urgent" ? "priority" : "standard"}`}>
            {priority}
          </span>
          <span className={`load-tag status-tag ${tone}`}>
            {label}
          </span>
        </div>

        <span className="sc-time">{isTerminal ? "Done" : assignedTime}</span>
      </div>

      <div className="sc-body">
        <div className="sc-detail">
          <strong>{vaccine}</strong>
          <span>{clinic}</span>
        </div>

        <div className="sc-meta-row">
          <span className="load-meta"><Package size={11} /> {qty.toLocaleString()} {unit}</span>
          <span className="load-meta"><Truck size={11} /> {riderName}{riderPhone ? ` · ${riderPhone}` : ""}</span>
        </div>
      </div>

      {!isTerminal && actions.length > 0 && (
        <div className="sc-actions">
          {actions.map((action) => (
            <button
              key={action.next}
              type="button"
              className={`shipment-action-btn ${action.tone}`}
              disabled={updating}
              onClick={() => onStatusUpdate(order.id, action.next)}
            >
              {updating ? <Loader2 size={12} className="spin" /> : null}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default DispatcherShipments;
