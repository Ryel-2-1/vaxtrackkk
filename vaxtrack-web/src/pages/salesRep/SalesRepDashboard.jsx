import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ClipboardList,
  Filter,
  PackageCheck,
  Search,
  ShoppingCart,
  Truck,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const PAGE_SIZE = 4;

function SalesRepDashboard() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);

  const inventoryRows = [
    {
      vaccine: "Pfizer-BioNTech",
      batchId: "PFZ-2023-A01",
      quantity: "85,000",
      expiry: "Aug 18, 2026",
      status: "Available",
      statusClass: "available",
      tone: "blue",
    },
    {
      vaccine: "Sinovac",
      batchId: "SNO-2023-C44",
      quantity: "120,000",
      expiry: "Oct 03, 2026",
      status: "Available",
      statusClass: "available",
      tone: "gold",
    },
    {
      vaccine: "Moderna",
      batchId: "MOD-2023-B12",
      quantity: "45,000",
      expiry: "Jul 11, 2026",
      status: "Low Stock",
      statusClass: "low-stock",
      tone: "blue",
    },
    {
      vaccine: "J&J Janssen",
      batchId: "JNJ-2023-X99",
      quantity: "10,000",
      expiry: "May 28, 2026",
      status: "Near Expiry",
      statusClass: "near-expiry",
      tone: "gray",
    },
    {
      vaccine: "AstraZeneca",
      batchId: "AZN-2024-D18",
      quantity: "64,500",
      expiry: "Sep 14, 2026",
      status: "Available",
      statusClass: "available",
      tone: "blue",
    },
    {
      vaccine: "Novavax",
      batchId: "NVX-2024-K22",
      quantity: "18,000",
      expiry: "Dec 02, 2026",
      status: "Low Stock",
      statusClass: "low-stock",
      tone: "gold",
    },
    {
      vaccine: "Sputnik V",
      batchId: "SPU-2024-R10",
      quantity: "52,300",
      expiry: "Nov 19, 2026",
      status: "Available",
      statusClass: "available",
      tone: "blue",
    },
    {
      vaccine: "Hepatitis B",
      batchId: "HEP-2024-H31",
      quantity: "9,400",
      expiry: "Apr 08, 2026",
      status: "Near Expiry",
      statusClass: "near-expiry",
      tone: "gray",
    },
    {
      vaccine: "Influenza Vaccine",
      batchId: "FLU-2024-F07",
      quantity: "73,900",
      expiry: "Jan 26, 2027",
      status: "Available",
      statusClass: "available",
      tone: "blue",
    },
    {
      vaccine: "BCG Vaccine",
      batchId: "BCG-2024-B15",
      quantity: "14,250",
      expiry: "Feb 18, 2027",
      status: "Low Stock",
      statusClass: "low-stock",
      tone: "gold",
    },
    {
      vaccine: "Rotavirus Vaccine",
      batchId: "ROT-2024-R29",
      quantity: "7,800",
      expiry: "Mar 21, 2026",
      status: "Near Expiry",
      statusClass: "near-expiry",
      tone: "gray",
    },
    {
      vaccine: "Tetanus Toxoid",
      batchId: "TET-2024-T05",
      quantity: "39,600",
      expiry: "Jun 09, 2027",
      status: "Available",
      statusClass: "available",
      tone: "blue",
    },
  ];

  const quickActions = [
    {
      label: "Request New Order",
      text: "Create a vaccine request for approval.",
      href: "/sales-rep/request-order",
      icon: <ClipboardList size={19} />,
    },
    {
      label: "Place Order",
      text: "Prepare client order details.",
      href: "/sales-rep/place-order",
      icon: <ShoppingCart size={19} />,
    },
    {
      label: "Track Shipment",
      text: "Check delivery status and ETA.",
      href: "/sales-rep/order-tracking",
      icon: <Truck size={19} />,
    },
    {
      label: "View Alerts",
      text: "Review order and delivery alerts.",
      href: "/sales-rep/alerts",
      icon: <AlertTriangle size={19} />,
    },
  ];

  const requestRows = [
    {
      order: "ORDER #VX-6608",
      city: "San Pedro City",
      status: "Pending",
    },
    {
      order: "ORDER #VX-6667",
      city: "Cavite, Imus",
      status: "Approved",
    },
    {
      order: "ORDER #VX-6669",
      city: "BGC, Taguig",
      status: "Declined",
    },
  ];

  const trackingRows = [
    {
      order: "#VX-8821",
      destination: "Manila Doctors Hospital",
      status: "Delivered",
      progress: "100%",
    },
    {
      order: "#VX-8830",
      destination: "Makati Health District",
      status: "In Transit",
      progress: "72%",
    },
    {
      order: "#VX-8844",
      destination: "San Pedro City",
      status: "Processing",
      progress: "35%",
    },
  ];

  const filteredInventory = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return inventoryRows.filter((row) => {
      const matchesSearch =
        !keyword ||
        row.vaccine.toLowerCase().includes(keyword) ||
        row.batchId.toLowerCase().includes(keyword) ||
        row.status.toLowerCase().includes(keyword);

      const matchesStatus = statusFilter === "All" || row.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [inventoryRows, searchTerm, statusFilter]);

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
    const nextPage = Math.min(Math.max(page, 1), totalPages);
    setCurrentPage(nextPage);
  };

  return (
    <SalesRepLayout active="dashboard" title="Sales Representative Dashboard">
      <section className="salesrep-metrics four">
        <MetricCard
          icon={<ShoppingCart size={28} />}
          label="Total Orders (30D)"
          value="1,284"
          note="↗ +12% vs last month"
          tone="blue"
        />
        <MetricCard
          icon={<ClipboardList size={28} />}
          label="Pending Requests"
          value="18"
          note="5 awaiting approval"
          tone="gold"
        />
        <MetricCard
          icon={<CheckCircle2 size={28} />}
          label="Approved Orders"
          value="96"
          note="+9 approved this week"
          tone="green"
        />
        <MetricCard
          icon={<Truck size={28} />}
          label="Active Shipments"
          value="42"
          note="8 arriving today"
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
            <a href="/sales-rep/inventory" className="salesrep-view-link">
              View Inventory <ArrowRight size={14} />
            </a>
          </div>

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
                  <tr key={row.batchId}>
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
                  <td colSpan="5">No vaccine batches match your search/filter.</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="salesrep-pagination-row dashboard-pagination-row">
            <p>
              Showing {showingStart} to {showingEnd} of {filteredInventory.length} batches
            </p>
            <div className="salesrep-pagination-controls">
              <button
                type="button"
                onClick={() => goToPage(safePage - 1)}
                disabled={safePage === 1}
                aria-label="Previous page"
              >
                &lt;
              </button>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
                <button
                  key={page}
                  type="button"
                  className={page === safePage ? "active" : ""}
                  onClick={() => goToPage(page)}
                >
                  {page}
                </button>
              ))}
              <button
                type="button"
                onClick={() => goToPage(safePage + 1)}
                disabled={safePage === totalPages}
                aria-label="Next page"
              >
                &gt;
              </button>
            </div>
          </div>
        </div>

        <aside className="salesrep-side-stack">
          <div className="salesrep-card">
            <div className="salesrep-section-title compact">
              <Clock3 size={16} />
              <h2>Recent Activity</h2>
              <a href="/sales-rep/order-tracking">View All</a>
            </div>

            <ActivityItem
              tone="green"
              title="Order #VX-8821 delivered to Manila Doctors Hospital."
              time="2 mins ago"
            />
            <ActivityItem
              tone="blue"
              title="Batch release Lot B-1049 verified for distribution."
              time="15 mins ago"
            />
            <ActivityItem
              tone="red"
              title="Cold chain warning detected in Truck #042."
              time="1 hour ago"
            />
            <ActivityItem
              tone="blue"
              title="Makati Health District was added to your client list."
              time="3 hours ago"
            />
          </div>

          <div className="salesrep-card approvals-card">
            <h2>My Order Requests</h2>
            {requestRows.map((request) => (
              <RequestStatus
                key={request.order}
                order={request.order}
                city={request.city}
                status={request.status}
              />
            ))}
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
              <QuickAction key={action.label} {...action} />
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
            {trackingRows.map((item) => (
              <TrackingPreview key={item.order} {...item} />
            ))}
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

function QuickAction({ icon, label, text, href }) {
  return (
    <a className="dashboard-action-card" href={href}>
      <span className="dashboard-action-icon">{icon}</span>
      <div>
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
      <ArrowRight size={16} />
    </a>
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
