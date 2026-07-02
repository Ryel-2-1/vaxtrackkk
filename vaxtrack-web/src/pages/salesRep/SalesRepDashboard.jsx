import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ClipboardList,
  Filter,
  Loader2,
  PackageCheck,
  Search,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { subscribeSalesRepOrders } from "../../services/orderService";
import { subscribeInventory } from "../../services/inventoryService";
import {
  normalizeStatusKey,
  getOrderStatusValue,
} from "../../services/deliveryService";
import { auth } from "../../firebase";
import SalesRepLayout from "./SalesRepLayout";

const PAGE_SIZE = 4;

function mapDashboardStatus(statusKey) {
  switch (statusKey) {
    case "pending":
    case "pending_dispatch":
      return "Pending";
    case "assigned":
    case "loading":
      return "Processing";
    case "in_transit":
      return "In Transit";
    case "delayed":
      return "Delayed";
    case "completed":
    case "delivered":
      return "Delivered";
    case "cancelled":
    case "canceled":
      return "Cancelled";
    case "rejected":
      return "Declined";
    default:
      return "Pending";
  }
}

function statusProgress(statusKey) {
  switch (statusKey) {
    case "pending":
    case "pending_dispatch":
      return 15;
    case "assigned":
      return 30;
    case "loading":
      return 45;
    case "in_transit":
      return 75;
    case "delayed":
      return 60;
    case "completed":
    case "delivered":
      return 100;
    default:
      return 10;
  }
}

function formatDate(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatExpiry(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getDaysUntilExpiry(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(dateStr + "T00:00:00");
  return Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeInventoryRow(raw) {
  const qty = raw.quantity != null ? Number(raw.quantity) : 0;
  const days = getDaysUntilExpiry(raw.expiryDate);

  let status = "Available";
  let statusClass = "available";
  let tone = "blue";

  if (qty <= 0) {
    status = "Out of Stock";
    statusClass = "out-of-stock";
    tone = "gray";
  } else if (days <= 30 && days >= 0) {
    status = "Near Expiry";
    statusClass = "near-expiry";
    tone = "gray";
  } else if (qty <= 100) {
    status = "Low Stock";
    statusClass = "low-stock";
    tone = "gold";
  }

  return {
    id: raw.id,
    vaccine: raw.vaccineName || "Unknown Vaccine",
    batchId: raw.batchId || raw.id,
    quantity: qty.toLocaleString(),
    quantityRaw: qty,
    expiry: formatExpiry(raw.expiryDate),
    status,
    statusClass,
    tone,
  };
}

function SalesRepDashboard() {
  const navigate = useNavigate();

  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState("");

  const [inventory, setInventory] = useState([]);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setOrdersError("Not logged in.");
      setOrdersLoading(false);
      return;
    }

    const unsubscribe = subscribeSalesRepOrders(
      user.uid,
      (raw) => {
        const normalized = raw.map((o) => {
          const rawStatus = getOrderStatusValue(o);
          const statusKey = normalizeStatusKey(rawStatus);
          return {
            id: o.id,
            orderNumber: o.orderNumber || o.id,
            clinicName: o.clinicName || "Unknown Clinic",
            clinicAddress: o.clinicAddress || "—",
            vaccineName: o.vaccineName || "—",
            status: mapDashboardStatus(statusKey),
            statusKey,
            progress: statusProgress(statusKey),
            date: formatDate(o.createdAt),
          };
        });
        setOrders(normalized);
        setOrdersLoading(false);
        setOrdersError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setOrdersError("Permission denied.");
        } else {
          setOrdersError("Unable to load orders.");
        }
        setOrdersLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        setInventory(raw.map(normalizeInventoryRow));
        setInvLoading(false);
        setInvError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setInvError("Permission denied.");
        } else {
          setInvError("Unable to load inventory.");
        }
        setInvLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const metrics = useMemo(() => {
    const total = orders.length;
    const pending = orders.filter((o) => o.statusKey === "pending" || o.statusKey === "pending_dispatch").length;
    const inTransit = orders.filter((o) => o.statusKey === "in_transit").length;
    const delivered = orders.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed").length;
    return { total, pending, inTransit, delivered };
  }, [orders]);

  const latestOrders = useMemo(() => orders.slice(0, 3), [orders]);
  const trackingOrders = useMemo(
    () => orders.filter((o) => o.statusKey !== "delivered" && o.statusKey !== "completed" && o.statusKey !== "cancelled" && o.statusKey !== "canceled").slice(0, 3),
    [orders]
  );

  const filteredInventory = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return inventory.filter((row) => {
      const matchesSearch =
        !keyword ||
        row.vaccine.toLowerCase().includes(keyword) ||
        row.batchId.toLowerCase().includes(keyword) ||
        row.status.toLowerCase().includes(keyword);
      const matchesStatus = statusFilter === "All" || row.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [inventory, searchTerm, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredInventory.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const visibleInventory = filteredInventory.slice(startIndex, startIndex + PAGE_SIZE);
  const showingStart = filteredInventory.length === 0 ? 0 : startIndex + 1;
  const showingEnd = Math.min(startIndex + PAGE_SIZE, filteredInventory.length);

  const updateFilter = (filter) => {
    setStatusFilter(filter);
    setCurrentPage(1);
  };

  const updateSearch = (event) => {
    setSearchTerm(event.target.value);
    setCurrentPage(1);
  };

  const goToPage = (page) => {
    setCurrentPage(Math.min(Math.max(page, 1), totalPages));
  };

  const quickActions = [
    {
      label: "Request New Order",
      text: "Create a vaccine request for approval.",
      route: "/sales-rep/request-order",
      icon: <ClipboardList size={19} />,
    },
    {
      label: "Place Order",
      text: "Prepare client order details.",
      route: "/sales-rep/request-order",
      icon: <ShoppingCart size={19} />,
    },
    {
      label: "Track Shipment",
      text: "Check delivery status and ETA.",
      route: "/sales-rep/order-tracking",
      icon: <Truck size={19} />,
    },
    {
      label: "View Alerts",
      text: "Review order and delivery alerts.",
      route: "/sales-rep/alerts",
      icon: <AlertTriangle size={19} />,
    },
  ];

  const isLoading = ordersLoading || invLoading;

  if (isLoading) {
    return (
      <SalesRepLayout active="dashboard" title="Sales Representative Dashboard">
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading dashboard...</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="dashboard" title="Sales Representative Dashboard">
      <section className="salesrep-metrics four">
        <MetricCard
          icon={<ShoppingCart size={28} />}
          label="Total Orders"
          value={metrics.total.toLocaleString()}
          note={`${metrics.delivered} delivered`}
          tone="blue"
        />
        <MetricCard
          icon={<ClipboardList size={28} />}
          label="Pending Dispatch"
          value={metrics.pending.toLocaleString()}
          note="awaiting dispatch"
          tone="gold"
        />
        <MetricCard
          icon={<CheckCircle2 size={28} />}
          label="Delivered"
          value={metrics.delivered.toLocaleString()}
          note="completed orders"
          tone="green"
        />
        <MetricCard
          icon={<Truck size={28} />}
          label="In Transit"
          value={metrics.inTransit.toLocaleString()}
          note="active shipments"
          tone="blue"
        />
      </section>

      <section className="salesrep-dashboard-grid">
        <div className="salesrep-card salesrep-table-card dashboard-table-card">
          <div className="dashboard-card-heading">
            <div>
              <h2>Available Vaccine Inventory</h2>
              <p>Quick preview of batches available for client orders.</p>
            </div>
            <button
              type="button"
              className="salesrep-view-link"
              onClick={() => navigate("/sales-rep/inventory")}
            >
              View Inventory <ArrowRight size={14} />
            </button>
          </div>

          {invError ? (
            <p style={{ padding: 16, color: "#94a3b8", fontSize: 13 }}>{invError}</p>
          ) : (
            <>
              <div className="salesrep-card-toolbar">
                <div className="salesrep-inline-search">
                  <Search size={15} />
                  <input
                    value={searchTerm}
                    onChange={updateSearch}
                    placeholder="Search vaccine or batch ID..."
                  />
                </div>

                <div className="salesrep-toolbar-actions">
                  <button
                    type="button"
                    className={`salesrep-pill ${statusFilter === "All" ? "primary" : ""}`}
                    onClick={() => updateFilter("All")}
                  >
                    All Vaccines
                  </button>
                  <button
                    type="button"
                    className={`salesrep-pill ${statusFilter === "Low Stock" ? "primary" : ""}`}
                    onClick={() => updateFilter("Low Stock")}
                  >
                    <Filter size={13} /> Low Stock
                  </button>
                  <button
                    type="button"
                    className={`salesrep-pill ${statusFilter === "Near Expiry" ? "primary" : ""}`}
                    onClick={() => updateFilter("Near Expiry")}
                  >
                    Near Expiry
                  </button>
                </div>
              </div>

              <table className="salesrep-data-table dashboard-inventory-table">
                <thead>
                  <tr>
                    <th>Vaccine Type</th>
                    <th>Batch ID</th>
                    <th>Quantity</th>
                    <th>Expiry Date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInventory.length > 0 ? (
                    visibleInventory.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="salesrep-product-cell">
                            <span className={`salesrep-product-icon ${row.tone}`}>
                              <PackageCheck size={15} />
                            </span>
                            <strong>{row.vaccine}</strong>
                          </div>
                        </td>
                        <td>{row.batchId}</td>
                        <td>{row.quantity}</td>
                        <td>{row.expiry}</td>
                        <td>
                          <span className={`inventory-status-chip ${row.statusClass}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr className="dashboard-empty-row">
                      <td colSpan="5">
                        {inventory.length === 0
                          ? "No inventory data available."
                          : "No vaccine batches match your search/filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="salesrep-pagination-row dashboard-pagination-row">
                <p>
                  Showing {showingStart} to {showingEnd} of {filteredInventory.length} batches
                </p>
                <div className="salesrep-pagination-controls">
                  <button type="button" onClick={() => goToPage(safePage - 1)} disabled={safePage === 1}>
                    &lt;
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                    <button
                      key={page}
                      type="button"
                      className={page === safePage ? "active" : ""}
                      onClick={() => goToPage(page)}
                    >
                      {page}
                    </button>
                  ))}
                  <button type="button" onClick={() => goToPage(safePage + 1)} disabled={safePage === totalPages}>
                    &gt;
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <aside className="salesrep-side-stack">
          <div className="salesrep-card">
            <div className="salesrep-section-title compact">
              <Clock3 size={16} />
              <h2>Recent Activity</h2>
              <button
                type="button"
                className="salesrep-view-link"
                onClick={() => navigate("/sales-rep/order-tracking")}
              >
                View All
              </button>
            </div>

            {ordersError ? (
              <p style={{ padding: "8px 0", color: "#94a3b8", fontSize: 13 }}>{ordersError}</p>
            ) : orders.length === 0 ? (
              <p style={{ padding: "8px 0", color: "#94a3b8", fontSize: 13 }}>
                No recent activity. Place your first order to get started.
              </p>
            ) : (
              latestOrders.map((o) => (
                <ActivityItem
                  key={o.id}
                  tone={o.statusKey === "delivered" || o.statusKey === "completed" ? "green" : o.statusKey === "delayed" ? "red" : "blue"}
                  title={`${o.orderNumber} — ${o.clinicName} (${o.status})`}
                  time={o.date}
                />
              ))
            )}
          </div>

          <div className="salesrep-card approvals-card">
            <h2>My Order Requests</h2>

            {ordersError ? (
              <p style={{ padding: "8px 0", color: "#94a3b8", fontSize: 13 }}>{ordersError}</p>
            ) : latestOrders.length === 0 ? (
              <p style={{ padding: "8px 0", color: "#94a3b8", fontSize: 13 }}>
                No orders yet.
              </p>
            ) : (
              latestOrders.map((o) => (
                <RequestStatus
                  key={o.id}
                  order={o.orderNumber}
                  city={o.clinicName}
                  status={o.status}
                />
              ))
            )}
          </div>
        </aside>
      </section>

      <section className="salesrep-dashboard-bottom">
        <div className="salesrep-card quick-actions-card">
          <div className="dashboard-card-heading no-border">
            <div>
              <h2>Quick Actions</h2>
              <p>Common Sales Representative tasks for faster order processing.</p>
            </div>
          </div>

          <div className="dashboard-action-grid">
            {quickActions.map((action) => (
              <QuickAction key={action.label} {...action} onNavigate={navigate} />
            ))}
          </div>
        </div>

        <div className="salesrep-card tracking-preview-card">
          <div className="dashboard-card-heading no-border">
            <div>
              <h2>Order Tracking Preview</h2>
              <p>Latest order movement and fulfillment progress.</p>
            </div>
          </div>

          <div className="tracking-preview-list">
            {trackingOrders.length > 0 ? (
              trackingOrders.map((o) => (
                <TrackingPreview
                  key={o.id}
                  order={o.orderNumber}
                  destination={o.clinicName}
                  status={o.status}
                  progress={`${o.progress}%`}
                />
              ))
            ) : (
              <p style={{ padding: 12, color: "#94a3b8", fontSize: 13 }}>
                {orders.length === 0 ? "No orders yet." : "No active orders to track."}
              </p>
            )}
          </div>
        </div>
      </section>
    </SalesRepLayout>
  );
}

function MetricCard({ icon, label, value, note, tone }) {
  return (
    <div className="salesrep-metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <h2>{value}</h2>
        <p>{note}</p>
      </div>
    </div>
  );
}

function ActivityItem({ tone, title, time }) {
  return (
    <div className="activity-item">
      <span className={tone}></span>
      <div>
        <strong>{title}</strong>
        <p>{time}</p>
      </div>
    </div>
  );
}

function RequestStatus({ order, city, status }) {
  const statusClass = status.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="approval-row">
      <div>
        <strong>{order}</strong>
        <p>{city}</p>
      </div>
      <span className={statusClass}>{status}</span>
    </div>
  );
}

function QuickAction({ icon, label, text, route, onNavigate }) {
  return (
    <button type="button" className="dashboard-action-card" onClick={() => onNavigate(route)}>
      <span className="dashboard-action-icon">{icon}</span>
      <div>
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
      <ArrowRight size={16} />
    </button>
  );
}

function TrackingPreview({ order, destination, status, progress }) {
  const statusClass = status.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="tracking-preview-row">
      <div>
        <strong>{order}</strong>
        <p>{destination}</p>
      </div>
      <div className="tracking-preview-progress">
        <span className={`mini-status ${statusClass}`}>{status}</span>
        <div className="mini-progress-bar">
          <i style={{ width: progress }}></i>
        </div>
      </div>
    </div>
  );
}

export default SalesRepDashboard;
