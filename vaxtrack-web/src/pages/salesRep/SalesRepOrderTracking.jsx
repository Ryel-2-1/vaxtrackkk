import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Box,
  ClipboardCheck,
  Loader2,
  MapPin,
  PackageCheck,
  Phone,
  Search,
  Share2,
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
import StatusBadge from "../../components/ui/StatusBadge";

function mapTrackingLabel(statusKey) {
  switch (statusKey) {
    case "processing":
    case "requested":
    case "approved":
    case "pending":
    case "pending_dispatch":
      return "Pending Dispatch";
    case "assigned":
      return "Assigned";
    case "loading":
    case "ready_for_dispatch":
      return "Loading";
    case "in_transit":
    case "out_for_delivery":
      return "Out for Delivery";
    case "delayed":
      return "Delayed";
    case "delivered":
    case "completed":
      return "Delivered";
    case "cancelled":
    case "canceled":
      return "Cancelled";
    default:
      return "Processing";
  }
}

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Progress is derived from the normalized lifecycle status — the single source
// of truth — never a timer, animation, or fabricated value. Orders carry no
// trustworthy numeric progress field, so each stage maps to one explicit
// percentage; bar width and label read from the same returned value.
//
// Every KNOWN status is listed explicitly; `default` is a safety net for truly
// unknown values only, and does not silently cover any known status. The
// shared `normalizeStatusKey` (deliveryService) only trims/lowercases and turns
// dashes+spaces into underscores, so we alias the raw wording variants here
// (e.g. `out_for_delivery` ≡ `in_transit`, `ready_for_dispatch` ≡ `loading`,
// `processing`/`requested`/`approved` ≡ `pending`).
// Returns { progress, indeterminate }.
function deriveProgress(raw, statusKey) {
  switch (statusKey) {
    case "processing":
    case "requested":
    case "approved":
    case "pending":
    case "pending_dispatch":
      return { progress: 15, indeterminate: false };
    case "assigned":
      return { progress: 30, indeterminate: false };
    case "loading":
    case "ready_for_dispatch":
      return { progress: 50, indeterminate: false };
    case "in_transit":
    case "out_for_delivery":
      return { progress: 75, indeterminate: false };
    case "delivered":
    case "completed":
      return { progress: 100, indeterminate: false };
    case "cancelled":
    case "canceled":
      return { progress: 0, indeterminate: false };
    case "delayed": {
      // A delayed order keeps its LAST legitimate stage — recovered from the
      // audit fields the dispatch/cargo/rider flow writes — rather than an
      // invented percentage. If no stage signal exists it is indeterminate
      // (paused), never a made-up number.
      if (raw.startedAt || raw.dispatchedAt || raw.loadingFinalizedAt)
        return { progress: 75, indeterminate: false };
      if (raw.loadedAt || raw.isLoaded)
        return { progress: 50, indeterminate: false };
      if (raw.assignedRiderId || raw.assignedAt)
        return { progress: 30, indeterminate: false };
      return { progress: 0, indeterminate: true };
    }
    default:
      // Truly unknown status only. Show the earliest stage without pretending
      // any known lifecycle progress has occurred.
      return { progress: 15, indeterminate: false };
  }
}

function formatDate(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function normalizeOrder(raw) {
  const rawStatus = getOrderStatusValue(raw);
  const statusKey = normalizeStatusKey(rawStatus);
  const label = mapTrackingLabel(statusKey);
  const { progress: rawProgress, indeterminate: progressIndeterminate } =
    deriveProgress(raw, statusKey);
  const progress = clampPct(rawProgress);

  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => ({
        name: item.name || "Unknown",
        batch: item.sku || item.batchId || "—",
        qty: `${Number(item.quantity || 0).toLocaleString()} ${
          Number(item.quantity || 0) === 1 ? "vial" : "vials"
        }`,
      }))
    : [];

  return {
    id: raw.id,
    orderNumber: raw.orderNumber || raw.id,
    destination: raw.clinicName || "Unknown Clinic",
    city: raw.clinicAddress || "—",
    date: formatDate(raw.createdAt),
    status: label,
    statusKey,
    progress,
    progressIndeterminate,
    progressText: progressIndeterminate ? "Delayed" : `${progress}%`,
    driver: raw.assignedRiderId || "Pending",
    driverName: raw.assignedRiderName || "Awaiting rider assignment",
    vaccineName: raw.vaccineName || "—",
    quantity: Number(raw.quantity || 0),
    priority: raw.priority || "Standard",
    instructions: raw.deliveryInstructions || "",
    items,
  };
}

function SalesRepOrderTracking() {
  const navigate = useNavigate();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [activeTab, setActiveTab] = useState("active");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setError("You must be logged in to view orders.");
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeSalesRepOrders(
      user.uid,
      (raw) => {
        const normalized = raw.map(normalizeOrder);
        setOrders(normalized);
        setLoading(false);
        setError("");

        if (!selectedOrderId && normalized.length > 0) {
          setSelectedOrderId(normalized[0].id);
        }
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view orders. Please contact your administrator.");
        } else {
          setError("Unable to load orders. Please try again later.");
        }
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const selectedOrder = orders.find((o) => o.id === selectedOrderId) || null;

  const filteredOrders = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return orders.filter((order) => {
      const isHistory = order.statusKey === "completed" || order.statusKey === "delivered" || order.statusKey === "cancelled" || order.statusKey === "canceled";
      const matchesTab = activeTab === "history" ? isHistory : !isHistory;
      const matchesStatus =
        statusFilter === "all" ||
        order.status.toLowerCase().replaceAll(" ", "-") === statusFilter;
      const matchesSearch =
        order.orderNumber.toLowerCase().includes(query) ||
        order.destination.toLowerCase().includes(query) ||
        order.city.toLowerCase().includes(query) ||
        order.status.toLowerCase().includes(query) ||
        order.vaccineName.toLowerCase().includes(query);

      return matchesTab && matchesStatus && matchesSearch;
    });
  }, [activeTab, orders, searchTerm, statusFilter]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setStatusFilter("all");
    setSearchTerm("");
    setMessage("");
  };

  const handleShare = async () => {
    if (!selectedOrder) return;

    const text = `${selectedOrder.orderNumber} - ${selectedOrder.destination} (${selectedOrder.status})`;

    try {
      await navigator.clipboard.writeText(text);
      setMessage("Tracking details copied to clipboard.");
    } catch {
      setMessage("Tracking details ready to share.");
    }
  };

  const handleContactDriver = () => {
    if (!selectedOrder || selectedOrder.driver === "Pending") {
      setMessage("Driver is not yet assigned for this order.");
      return;
    }

    setMessage(`Contact request sent to driver ${selectedOrder.driverName}.`);
  };

  if (loading) {
    return (
      <SalesRepLayout active="tracking" title="Order Tracking" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading your orders...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="tracking" title="Order Tracking" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="tracking" title="Order Tracking" showSearch={false}>
      <section className="tracking-v2-page">
        <div className="tracking-v2-header">
          <div>
            <h2>Deliveries overview</h2>
            <p>Monitor active deliveries, shipment progress, and completed orders.</p>
          </div>

          <div className="tracking-v2-search">
            <Search size={15} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search order ID, clinic, vaccine, or status..."
            />
          </div>
        </div>

        {message && (
          <div className="tracking-v2-message">
            <ClipboardCheck size={16} />
            <span>{message}</span>
            <button type="button" onClick={() => setMessage("")}>
              <X size={14} />
            </button>
          </div>
        )}

        <section className="tracking-layout tracking-v2-layout">
          <div className="tracking-left">
            <div className="tracking-toolbar tracking-v2-toolbar">
              <button
                type="button"
                className="primary"
                onClick={() => navigate("/sales-rep/request-order")}
              >
                + New Order
              </button>

              <div className="tracking-v2-tabs">
                <button
                  type="button"
                  className={activeTab === "active" ? "active" : ""}
                  onClick={() => handleTabChange("active")}
                >
                  Active
                </button>

                <button
                  type="button"
                  className={activeTab === "history" ? "active" : ""}
                  onClick={() => handleTabChange("history")}
                >
                  History
                </button>
              </div>

              <label className="tracking-v2-status-filter">
                <span>Filter by Status</span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="all">All Status</option>
                  <option value="pending-dispatch">Pending Dispatch</option>
                  <option value="assigned">Assigned</option>
                  <option value="out-for-delivery">Out for Delivery</option>
                  <option value="delayed">Delayed</option>
                  <option value="delivered">Delivered</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
            </div>

            <div className="tracking-v2-table-wrap">
              <table className="tracking-table tracking-v2-table">
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Destination</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Progress</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredOrders.length > 0 ? (
                    filteredOrders.map((order) => (
                      <TrackingRow
                        key={order.id}
                        order={order}
                        selected={selectedOrder?.id === order.id}
                        onSelect={() => setSelectedOrderId(order.id)}
                      />
                    ))
                  ) : (
                    <tr>
                      <td colSpan="5">
                        <div className="tracking-v2-empty">
                          {orders.length === 0
                            ? "You haven't placed any orders yet."
                            : "No matching orders found."}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="tracking-side tracking-v2-side">
            {selectedOrder ? (
              <>
                <div className="tracking-side-title">
                  <div>
                    <span>Selected Order</span>
                    <h2>{selectedOrder.orderNumber}</h2>
                  </div>
                  <button type="button" onClick={() => setSelectedOrderId("")}>
                    ×
                  </button>
                </div>

                <p>
                  {selectedOrder.priority === "Urgent" ? "Urgent" : "Standard"} · {selectedOrder.date}
                </p>

                <div className="tracking-v2-side-actions">
                  <button type="button" className="contact-driver" onClick={handleContactDriver}>
                    <Phone size={15} />
                    Contact Driver
                  </button>

                  <button type="button" className="share-btn" onClick={handleShare}>
                    <Share2 size={16} />
                  </button>
                </div>

                <h3>Delivery Status</h3>
                <div className="tracking-v2-status-strip">
                  <StatusBadge statusKey={selectedOrder.statusKey} label={selectedOrder.status} />
                  <span>Rider: {selectedOrder.driverName}</span>
                </div>

                <div className="tracking-v2-info-box">
                  <MapPin size={15} />
                  <div>
                    <strong>{selectedOrder.destination}</strong>
                    <p>{selectedOrder.city}</p>
                  </div>
                </div>

                {selectedOrder.instructions && (
                  <div className="tracking-v2-info-box">
                    <ClipboardCheck size={15} />
                    <div>
                      <strong>Instructions</strong>
                      <p>{selectedOrder.instructions}</p>
                    </div>
                  </div>
                )}

                <h3>Order Content</h3>

                {selectedOrder.items.length > 0 ? (
                  selectedOrder.items.map((item, i) => (
                    <OrderContent
                      key={`${selectedOrder.id}-${i}`}
                      name={item.name}
                      batch={item.batch}
                      qty={item.qty}
                    />
                  ))
                ) : (
                  <div className="tracking-v2-info-box">
                    <PackageCheck size={15} />
                    <div>
                      <strong>{selectedOrder.vaccineName}</strong>
                      <p>{selectedOrder.quantity.toLocaleString()} {selectedOrder.quantity === 1 ? "vial" : "vials"}</p>
                    </div>
                  </div>
                )}

                <div className="tracking-total">
                  <p>
                    Total Quantity
                    <strong>{selectedOrder.quantity.toLocaleString()} {selectedOrder.quantity === 1 ? "vial" : "vials"}</strong>
                  </p>
                </div>
              </>
            ) : (
              <div className="tracking-v2-no-selected">
                <Truck size={34} />
                <strong>No order selected</strong>
                <p>Select an order from the table to view tracking details.</p>
              </div>
            )}
          </aside>
        </section>
      </section>
    </SalesRepLayout>
  );
}

function TrackingRow({ selected, order, onSelect }) {
  const isDanger = order.statusKey === "delayed";

  return (
    <tr
      className={selected ? "selected" : ""}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
    >
      <td>
        {isDanger ? <AlertTriangle size={17} /> : <Box size={17} />}
        <strong>{order.orderNumber}</strong>
      </td>

      <td>
        <strong>{order.destination}</strong>
        <small>{order.vaccineName}</small>
      </td>

      <td>{order.date}</td>

      <td>
        <StatusBadge statusKey={order.statusKey} label={order.status} />
      </td>

      <td>
        <div
          className={`track-progress${isDanger ? " is-delayed" : ""}${
            order.progressIndeterminate ? " is-indeterminate" : ""
          }`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={order.progressIndeterminate ? undefined : order.progress}
          aria-label={`${order.status} — ${order.progressText}`}
        >
          <span
            style={{
              width: order.progressIndeterminate ? "100%" : `${order.progress}%`,
            }}
          ></span>
        </div>
        <small>{order.progressText}</small>
      </td>
    </tr>
  );
}

function OrderContent({ name, batch, qty }) {
  return (
    <div className="order-content">
      <PackageCheck size={18} />
      <div>
        <strong>{name}</strong>
        <p>Batch: {batch} · {qty}</p>
      </div>
    </div>
  );
}

export default SalesRepOrderTracking;
