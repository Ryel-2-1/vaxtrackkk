import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Box,
  ChevronRight,
  ClipboardCheck,
  MapPin,
  PackageCheck,
  Phone,
  Search,
  Share2,
  Truck,
  X,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const defaultOrders = [
  {
    id: "VT-8803",
    destination: "St. Luke's Medical Center",
    city: "Quezon City, Metro Manila",
    date: "Oct 24, 2026",
    scheduled: "Oct 24, 02:00 PM",
    status: "Out for Delivery",
    progress: 75,
    progressText: "75% • 1.2km",
    driver: "RX-44",
    driverName: "Juan Dela Cruz",
    subtotal: 16700,
    logisticsFee: 150,
    items: [
      { name: "VaxGrip Tetra 2024", batch: "#990-2A", qty: "500 Units", price: 12500 },
      { name: "Prevenar 13", batch: "#990-2A", qty: "120 Units", price: 4200 },
    ],
  },
  {
    id: "VT-8801",
    destination: "Makati Medical Center",
    city: "Makati City, Metro Manila",
    date: "Oct 24, 2026",
    scheduled: "Oct 24, 04:30 PM",
    status: "Processing",
    progress: 25,
    progressText: "25% • Sorting",
    driver: "Pending",
    driverName: "Awaiting rider assignment",
    subtotal: 8400,
    logisticsFee: 150,
    items: [
      { name: "Influenza-Plus", batch: "INF-221-Z67", qty: "300 Units", price: 3600 },
      { name: "CoronaVac Plus", batch: "SNO-2023-C44", qty: "400 Units", price: 4800 },
    ],
  },
  {
    id: "VT-8867",
    destination: "Asian Hospital",
    city: "Alabang, Muntinlupa",
    date: "Oct 23, 2026",
    scheduled: "Oct 23, 09:45 AM",
    status: "Delivered",
    progress: 100,
    progressText: "100% • 09:45",
    driver: "RX-19",
    driverName: "Mark Santos",
    subtotal: 12300,
    logisticsFee: 150,
    items: [
      { name: "Polio-Zero", batch: "PO-882-V69", qty: "250 Units", price: 6000 },
      { name: "HepaGuard-B", batch: "HEP-2025-HB2", qty: "350 Units", price: 6300 },
    ],
  },
  {
    id: "VT-8869",
    destination: "Cardinal Santos",
    city: "San Juan City",
    date: "Oct 23, 2026",
    scheduled: "Oct 23, 03:00 PM",
    status: "Delayed",
    progress: 60,
    progressText: "60% • Traffic",
    driver: "RX-04",
    driverName: "Carlo Reyes",
    subtotal: 9650,
    logisticsFee: 250,
    items: [
      { name: "RabiesVac", batch: "RAB-2025-R01", qty: "200 Units", price: 5200 },
      { name: "TetanusCare", batch: "TET-2024-T11", qty: "150 Units", price: 4450 },
    ],
  },
];

function loadLatestOrder() {
  try {
    const savedOrder = JSON.parse(localStorage.getItem("latestSalesOrderDetails") || "null");

    if (!savedOrder?.id) return null;

    const items = Array.isArray(savedOrder.items)
      ? savedOrder.items.map((item) => ({
          name: item.name,
          batch: item.sku || item.id || "N/A",
          qty: `${Number(item.quantity || 0).toLocaleString()} vials`,
          price: Number(item.quantity || 0) * Number(item.unitPrice || 0),
        }))
      : [];

    return {
      id: savedOrder.id,
      destination: savedOrder.clinicName || "Selected Clinic",
      city: savedOrder.clinicAddress || "Address unavailable",
      date: "Today",
      scheduled: "Pending dispatch schedule",
      status: savedOrder.status || "Processing",
      progress: 15,
      progressText: "15% • Order submitted",
      driver: "Pending",
      driverName: "Awaiting rider assignment",
      subtotal: Number(savedOrder.subtotal || 0),
      logisticsFee: Number(savedOrder.handlingFee || 0),
      items,
    };
  } catch {
    return null;
  }
}

function SalesRepOrderTracking() {
  const navigate = useNavigate();
  const latestOrder = loadLatestOrder();

  const orders = useMemo(() => {
    if (!latestOrder) return defaultOrders;
    const exists = defaultOrders.some((order) => order.id === latestOrder.id);
    return exists ? defaultOrders : [latestOrder, ...defaultOrders];
  }, [latestOrder]);

  const [activeTab, setActiveTab] = useState("active");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id || "");
  const [message, setMessage] = useState("");

  const selectedOrder = orders.find((order) => order.id === selectedOrderId) || orders[0];

  const filteredOrders = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return orders.filter((order) => {
      const isHistory = order.status === "Delivered";
      const matchesTab = activeTab === "history" ? isHistory : !isHistory;
      const matchesStatus =
        statusFilter === "all" ||
        order.status.toLowerCase().replaceAll(" ", "-") === statusFilter;
      const matchesSearch =
        order.id.toLowerCase().includes(query) ||
        order.destination.toLowerCase().includes(query) ||
        order.city.toLowerCase().includes(query) ||
        order.status.toLowerCase().includes(query);

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

    const text = `${selectedOrder.id} - ${selectedOrder.destination} (${selectedOrder.status})`;

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

  return (
    <SalesRepLayout active="request" title="Order Tracking Dashboard" showSearch={false}>
      <section className="tracking-v2-page">
        <div className="tracking-v2-header">
          <div>
            <h1>Order Tracking Dashboard</h1>
            <p>Monitor active deliveries, shipment progress, and completed orders.</p>
          </div>

          <div className="tracking-v2-search">
            <Search size={15} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search order ID, clinic, city, or status..."
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
                + New Delivery
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
                  <option value="processing">Processing</option>
                  <option value="out-for-delivery">Out for Delivery</option>
                  <option value="delayed">Delayed</option>
                  <option value="delivered">Delivered</option>
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
                    <th>Logistics Status</th>
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
                          No tracking records found.
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="draft-footer tracking-v2-draft-footer">
              <Truck size={28} />
              <div>
                <strong>Draft Order</strong>
                <p>{latestOrder ? "Latest order added" : "No new draft detected"}</p>
              </div>
              <div>
                <strong>Est. Delivery</strong>
                <p>Oct 26, 2026</p>
              </div>
              <button type="button" onClick={() => navigate("/sales-rep/place-order")}>
                Review Order
              </button>
            </div>
          </div>

          <aside className="tracking-side tracking-v2-side">
            {selectedOrder ? (
              <>
                <div className="tracking-side-title">
                  <div>
                    <span>Selected Order</span>
                    <h2>{selectedOrder.id}</h2>
                  </div>
                  <button type="button" onClick={() => setSelectedOrderId("")}>
                    ×
                  </button>
                </div>

                <p>Scheduled for {selectedOrder.scheduled}</p>

                <div className="tracking-v2-side-actions">
                  <button type="button" className="contact-driver" onClick={handleContactDriver}>
                    <Phone size={15} />
                    Contact Driver
                  </button>

                  <button type="button" className="share-btn" onClick={handleShare}>
                    <Share2 size={16} />
                  </button>
                </div>

                <h3>Live Tracking</h3>
                <div className={`mini-map tracking-v2-mini-map ${selectedOrder.status.toLowerCase().replaceAll(" ", "-")}`}>
                  <div className="tracking-v2-route-line" />
                  <span>LIVE • DRIVER ID: {selectedOrder.driver}</span>
                </div>

                <div className="tracking-v2-info-box">
                  <MapPin size={15} />
                  <div>
                    <strong>{selectedOrder.destination}</strong>
                    <p>{selectedOrder.city}</p>
                  </div>
                </div>

                <h3>Order Content</h3>

                {selectedOrder.items.map((item) => (
                  <OrderContent
                    key={`${selectedOrder.id}-${item.name}-${item.batch}`}
                    name={item.name}
                    batch={item.batch}
                    qty={item.qty}
                    price={formatCurrency(item.price)}
                  />
                ))}

                <div className="tracking-total">
                  <p>
                    Subtotal
                    <strong>{formatCurrency(selectedOrder.subtotal)}</strong>
                  </p>
                  <p>
                    Logistics Fee
                    <strong>{formatCurrency(selectedOrder.logisticsFee)}</strong>
                  </p>
                  <h2>
                    Total
                    <span>{formatCurrency(selectedOrder.subtotal + selectedOrder.logisticsFee)}</span>
                  </h2>
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
  const isDanger = order.status === "Delayed";
  const statusClass = order.status.toLowerCase().replaceAll(" ", "-");

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
        <strong>{order.id}</strong>
      </td>

      <td>
        <strong>{order.destination}</strong>
        <small>{order.city}</small>
      </td>

      <td>{order.date}</td>

      <td>
        <span className={`track-status ${statusClass}`}>{order.status}</span>
      </td>

      <td>
        <div className="track-progress">
          <span style={{ width: `${order.progress}%` }}></span>
        </div>
        <small>{order.progressText}</small>
      </td>
    </tr>
  );
}

function OrderContent({ name, batch, qty, price }) {
  return (
    <div className="order-content">
      <PackageCheck size={18} />
      <div>
        <strong>{name}</strong>
        <p>Batch: {batch} • {qty}</p>
      </div>
      <b>{price}</b>
    </div>
  );
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default SalesRepOrderTracking;
