import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Box,
  Building2,
  CheckCircle2,
  FileDown,
  LayoutDashboard,
  LogOut,
  Package,
  Plus,
  Search,
  Settings,
  Thermometer,
  Truck,
  Users,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import "./Inventory.css";

const vaccines = [
  {
    name: "HepaShield-B",
    type: "Injectable",
    batch: "HB-2026-118",
    expiry: "Jul 15, 2026",
    qty: "6,200",
    temp: "2-8°C",
    status: "Warning",
    level: "warning",
    location: "Cold Room A-02",
    manufacturer: "MediCore Labs",
  },
  {
    name: "BCG-Pro",
    type: "Routine",
    batch: "BCG-2026-220",
    expiry: "Jul 28, 2026",
    qty: "9,750",
    temp: "2-8°C",
    status: "Stable",
    level: "stable",
    location: "Cold Room B-01",
    manufacturer: "GlobalVax Pharma",
  },
  {
    name: "RotaVax-Kids",
    type: "Oral",
    batch: "RV-2026-302",
    expiry: "Aug 10, 2026",
    qty: "4,900",
    temp: "2-8°C",
    status: "Stable",
    level: "stable",
    location: "Cold Room B-04",
    manufacturer: "PediaVax Inc.",
  },
  {
    name: "TetraVax",
    type: "Combination",
    batch: "TV-2026-044",
    expiry: "Aug 18, 2026",
    qty: "3,500",
    temp: "2-8°C",
    status: "Critical",
    level: "critical",
    location: "Cold Room C-03",
    manufacturer: "TetraHealth Bio",
  },
  {
    name: "MeaslesGuard",
    type: "Injectable",
    batch: "MG-2026-771",
    expiry: "Sep 02, 2026",
    qty: "11,800",
    temp: "2-8°C",
    status: "Stable",
    level: "stable",
    location: "Cold Room A-03",
    manufacturer: "GlobalVax Pharma",
  },
  {
    name: "RabiesSafe",
    type: "Injectable",
    batch: "RB-2026-650",
    expiry: "Sep 12, 2026",
    qty: "2,100",
    temp: "2-8°C",
    status: "Warning",
    level: "warning",
    location: "Cold Room C-02",
    manufacturer: "SafeDose Biologics",
  },
  {
    name: "VaxCora-19",
    type: "mRNA",
    batch: "BT-2024-991",
    expiry: "Oct 24, 2026",
    qty: "14,250",
    temp: "-80°C",
    status: "Critical",
    level: "critical",
    location: "Freezer Unit A-01",
    manufacturer: "VaxCora Biologics",
  },
  {
    name: "Influenza-Plus",
    type: "Doses",
    batch: "INF-2027-OP",
    expiry: "Dec 12, 2026",
    qty: "8,400",
    temp: "2-8°C",
    status: "Warning",
    level: "warning",
    location: "Cold Room B-02",
    manufacturer: "MediCore Labs",
  },
  {
    name: "Polio-Zero",
    type: "Injectable",
    batch: "PO-982-ZR",
    expiry: "Mar 30, 2027",
    qty: "52,000",
    temp: "2-8°C",
    status: "Stable",
    level: "stable",
    location: "Cold Room C-01",
    manufacturer: "GlobalVax Pharma",
  },
];

const demoToday = new Date("2026-06-18T00:00:00");

function getDaysUntilExpiry(expiryDate) {
  const expiry = new Date(expiryDate);
  const diffTime = expiry.getTime() - demoToday.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function Inventory() {
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedBatches, setSelectedBatches] = useState([]);
  const [selectedVaccine, setSelectedVaccine] = useState(null);
  const [toast, setToast] = useState("");

  const pageSize = 3;

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const filteredVaccines = useMemo(() => {
    return vaccines.filter((item) => {
      const searchValue =
        `${item.name} ${item.type} ${item.batch} ${item.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" || item.level === statusFilter;

      const daysUntilExpiry = getDaysUntilExpiry(item.expiry);

      const matchesExpiry =
        expiryFilter === "all" ||
        (daysUntilExpiry >= 0 && daysUntilExpiry <= Number(expiryFilter));

      return matchesSearch && matchesStatus && matchesExpiry;
    });
  }, [searchTerm, statusFilter, expiryFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, expiryFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredVaccines.length / pageSize));

  const paginatedVaccines = filteredVaccines.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const startItem =
    filteredVaccines.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;

  const endItem = Math.min(currentPage * pageSize, filteredVaccines.length);

  const isAllSelected =
    paginatedVaccines.length > 0 &&
    paginatedVaccines.every((item) => selectedBatches.includes(item.batch));

  const toggleAll = () => {
    const visibleBatchIds = paginatedVaccines.map((item) => item.batch);

    if (isAllSelected) {
      setSelectedBatches((prev) =>
        prev.filter((batch) => !visibleBatchIds.includes(batch))
      );
      return;
    }

    setSelectedBatches((prev) => Array.from(new Set([...prev, ...visibleBatchIds])));
  };

  const toggleBatch = (batch) => {
    setSelectedBatches((prev) =>
      prev.includes(batch)
        ? prev.filter((item) => item !== batch)
        : [...prev, batch]
    );
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="inventory" onLogout={handleLogout} />

      <main className="v2-inventory-main">
        {toast && <div className="v2-inventory-toast">{toast}</div>}

        <header className="v2-inventory-topbar">
          <div>
            <h1>Inventory Monitoring</h1>
            <p>Real-time vaccine stock, batch status, and cold-chain visibility.</p>
          </div>

          <div className="v2-inventory-actions">
            <button
              type="button"
              className="v2-light-action"
              onClick={() => showToast("Inventory report exported.")}
            >
              <FileDown size={16} />
              Export
            </button>

            <button
              type="button"
              className="v2-blue-action"
              onClick={() => navigate("/admin/add-vaccine")}
            >
              <Plus size={16} />
              Add Vaccine
            </button>

            <button
              type="button"
              className="v2-blue-action"
              onClick={() => navigate("/admin/add-stock")}
            >
              <Plus size={16} />
              Add Stock
            </button>

            <button type="button" className="v2-icon-action">
              <Bell size={15} />
            </button>

            <button type="button" className="v2-icon-action">
              <Settings size={15} />
            </button>
          </div>
        </header>

        <section className="v2-inventory-summary-grid">
          <SummaryCard
            icon={<Package size={20} />}
            title="Total Batches"
            value="124"
            note="Across all vaccine types"
            type="blue"
            onClick={() => setStatusFilter("all")}
          />

          <SummaryCard
            icon={<AlertTriangle size={20} />}
            title="Critical Stock"
            value="5"
            note="Needs immediate review"
            type="red"
            onClick={() => setStatusFilter("critical")}
          />

          <SummaryCard
            icon={<Thermometer size={20} />}
            title="Cold-chain Alerts"
            value="2"
            note="Temperature exceptions"
            type="amber"
            onClick={() => showToast("Showing cold-chain alert batches.")}
          />

          <SummaryCard
            icon={<CheckCircle2 size={20} />}
            title="Stable Batches"
            value="107"
            note="No action required"
            type="green"
            onClick={() => setStatusFilter("stable")}
          />
        </section>

        <section className="v2-hub-grid">
          <HubCapacityCard
            title="Central Hub Capacity"
            subtitle="Storage usage by vaccine group"
            bars={[
              { label: "Pfizer", height: "86%", type: "blue", value: "86%" },
              { label: "Moderna", height: "60%", type: "green", value: "60%" },
              { label: "Sinovac", height: "78%", type: "amber", value: "78%" },
              { label: "J&J", height: "50%", type: "light", value: "50%" },
            ]}
          />

          <ColdStorageCard />

          <InventoryAlertCard />
        </section>

        <section className="v2-inventory-table-card">
          <div className="v2-inventory-toolbar">
            <div className="v2-inventory-search">
              <Search size={15} />
              <input
                placeholder="Search vaccine name, batch ID, or type..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="v2-inventory-filters">
              <button
                type="button"
                className={statusFilter === "all" ? "active" : ""}
                onClick={() => setStatusFilter("all")}
              >
                All
              </button>

              <button
                type="button"
                className={statusFilter === "critical" ? "active" : ""}
                onClick={() => setStatusFilter("critical")}
              >
                Critical
              </button>

              <button
                type="button"
                className={statusFilter === "warning" ? "active" : ""}
                onClick={() => setStatusFilter("warning")}
              >
                Warning
              </button>

              <button
                type="button"
                className={statusFilter === "stable" ? "active" : ""}
                onClick={() => setStatusFilter("stable")}
              >
                Stable
              </button>

              <select
                className="v2-expiry-select"
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value)}
              >
                <option value="all">Expiry: All Batches</option>
                <option value="30">Expiry: Next 30 Days</option>
                <option value="90">Expiry: Next 90 Days</option>
                <option value="180">Expiry: Next 180 Days</option>
              </select>
            </div>
          </div>

          {selectedBatches.length > 0 && (
            <div className="v2-bulk-bar">
              <strong>{selectedBatches.length} batch selected</strong>

              <div>
                <button
                  type="button"
                  onClick={() => showToast("Selected batches marked as checked.")}
                >
                  Mark as Checked
                </button>

                <button
                  type="button"
                  onClick={() => showToast("Batch report generated.")}
                >
                  Generate Report
                </button>

                <button type="button" onClick={() => setSelectedBatches([])}>
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="v2-table-scroll">
            <table className="v2-vaccine-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Vaccine Name</th>
                  <th>Batch ID</th>
                  <th>Expiry Date</th>
                  <th>Remaining Qty</th>
                  <th>Temp</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {paginatedVaccines.map((item) => (
                  <tr
                    key={item.batch}
                    className={`v2-row-${item.level}`}
                    onClick={() => setSelectedVaccine(item)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedBatches.includes(item.batch)}
                        onChange={() => toggleBatch(item.batch)}
                      />
                    </td>

                    <td>
                      <div className="v2-vaccine-cell">
                        <span>
                          <Package size={15} />
                        </span>

                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.type}</small>
                        </div>
                      </div>
                    </td>

                    <td>{item.batch}</td>
                    <td>{item.expiry}</td>
                    <td>{item.qty}</td>

                    <td>
                      <span className="v2-temp-pill">{item.temp}</span>
                    </td>

                    <td>
                      <span className={`v2-stock-status ${item.level}`}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredVaccines.length === 0 && (
            <div className="v2-empty-inventory">
              <Package size={28} />
              <strong>No vaccine batches found</strong>
              <p>Try changing the search keyword or selected filters.</p>
            </div>
          )}

          <div className="v2-inventory-footer">
            <p>
              Showing {startItem}–{endItem} of {filteredVaccines.length} filtered
              batches. Full inventory count: 124 batches.
            </p>

            <div className="v2-pagination">
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              >
                Previous
              </button>

              {Array.from({ length: totalPages }, (_, index) => index + 1).map(
                (page) => (
                  <button
                    key={page}
                    type="button"
                    className={currentPage === page ? "active" : ""}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                )
              )}

              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() =>
                  setCurrentPage((prev) => Math.min(prev + 1, totalPages))
                }
              >
                Next
              </button>
            </div>
          </div>
        </section>
      </main>

      {selectedVaccine && (
        <div className="v2-inventory-modal-backdrop">
          <div className="v2-inventory-modal">
            <button
              type="button"
              className="v2-inventory-modal-close"
              onClick={() => setSelectedVaccine(null)}
            >
              <X size={18} />
            </button>

            <div className={`v2-modal-badge ${selectedVaccine.level}`}>
              {selectedVaccine.status}
            </div>

            <h2>{selectedVaccine.name}</h2>
            <p>{selectedVaccine.type} vaccine batch details and cold-chain status.</p>

            <div className="v2-modal-detail-grid">
              <div>
                <span>Batch ID</span>
                <strong>{selectedVaccine.batch}</strong>
              </div>

              <div>
                <span>Remaining Qty</span>
                <strong>{selectedVaccine.qty}</strong>
              </div>

              <div>
                <span>Expiry Date</span>
                <strong>{selectedVaccine.expiry}</strong>
              </div>

              <div>
                <span>Storage Temp</span>
                <strong>{selectedVaccine.temp}</strong>
              </div>

              <div>
                <span>Location</span>
                <strong>{selectedVaccine.location}</strong>
              </div>

              <div>
                <span>Manufacturer</span>
                <strong>{selectedVaccine.manufacturer}</strong>
              </div>
            </div>

            <div className="v2-modal-actions">
              <button
                type="button"
                className="v2-blue-action"
                onClick={() => navigate("/admin/add-stock")}
              >
                Add Stock
              </button>

              <button
                type="button"
                className="v2-light-action"
                onClick={() => showToast("Batch history opened.")}
              >
                View Batch History
              </button>

              <button
                type="button"
                className="v2-danger-action"
                onClick={() => showToast("Batch flagged for review.")}
              >
                Flag for Review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon, title, value, note, type, onClick }) {
  return (
    <button type="button" className={`v2-summary-card ${type}`} onClick={onClick}>
      <div className="v2-summary-icon">{icon}</div>

      <div>
        <p>{title}</p>
        <h2>{value}</h2>
        <small>{note}</small>
      </div>
    </button>
  );
}

function HubCapacityCard({ title, subtitle, bars }) {
  return (
    <div className="v2-hub-card">
      <div className="v2-card-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="v2-hub-bars">
        {bars.map((bar) => (
          <button
            type="button"
            className="v2-hub-bar-item"
            key={bar.label}
            title={`${bar.label}: ${bar.value}`}
          >
            <div>
              <span className={bar.type} style={{ height: bar.height }}></span>
            </div>

            <small>{bar.label}</small>
            <b>{bar.value}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function ColdStorageCard() {
  return (
    <div className="v2-hub-card v2-cold-card">
      <div className="v2-card-head">
        <h2>Cold Storage Status</h2>
        <p>Live temperature monitoring</p>
      </div>

      <div className="v2-cold-list">
        <div>
          <span>Ultra-low Freezer</span>
          <strong>-80°C</strong>
          <small className="critical">Critical review</small>
        </div>

        <div>
          <span>Cold Room A</span>
          <strong>2–8°C</strong>
          <small className="stable">Stable</small>
        </div>

        <div>
          <span>Cold Room B</span>
          <strong>3.8°C</strong>
          <small className="stable">Stable</small>
        </div>
      </div>
    </div>
  );
}

function InventoryAlertCard() {
  return (
    <div className="v2-hub-card v2-alert-summary-card">
      <div className="v2-card-head">
        <h2>Inventory Alerts</h2>
        <p>Action required today</p>
      </div>

      <div className="v2-alert-summary-list">
        <div className="critical">
          <strong>5</strong>
          <span>Critical stock</span>
        </div>

        <div className="warning">
          <strong>12</strong>
          <span>Expiring soon</span>
        </div>

        <div className="stable">
          <strong>107</strong>
          <span>Stable batches</span>
        </div>
      </div>
    </div>
  );
}

export function AdminSidebar({ active, onLogout }) {
  return (
    <aside className="inventory-sidebar">
      <h2>VaxTrack</h2>

      <div className="profile-mini">
        <div className="avatar">🧑‍💼</div>

        <div className="profile-mini-text">
          <h3>Logistics Admin</h3>
          <p>Manila Central Hub</p>
          <small>VaxTrack Web</small>
        </div>
      </div>

      <nav>
        <Link className={active === "dashboard" ? "active" : ""} to="/admin">
          <LayoutDashboard size={16} />
          <span>Dashboard</span>
        </Link>

        <Link
          className={active === "inventory" ? "active" : ""}
          to="/admin/inventory"
        >
          <Box size={16} />
          <span>Inventory</span>
        </Link>

        <Link
          className={active === "deliveries" ? "active" : ""}
          to="/admin/deliveries"
        >
          <Truck size={16} />
          <span>Deliveries</span>
        </Link>

        <Link className={active === "riders" ? "active" : ""} to="/admin/riders">
          <Users size={16} />
          <span>Riders</span>
        </Link>

        <Link className={active === "clinics" ? "active" : ""} to="/admin/clinics">
          <Building2 size={16} />
          <span>Clinics</span>
        </Link>

        <Link
          className={active === "analytics" ? "active" : ""}
          to="/admin/analytics"
        >
          <BarChart3 size={16} />
          <span>Analytics</span>
        </Link>

        <Link className={active === "alerts" ? "active" : ""} to="/admin/alerts">
          <AlertTriangle size={16} />
          <span>Alerts</span>
        </Link>

        <Link
          className={active === "settings" ? "active" : ""}
          to="/admin/settings"
        >
          <Settings size={16} />
          <span>Settings</span>
        </Link>
      </nav>

      <button className="sidebar-logout" onClick={onLogout}>
        <LogOut size={16} />
        <span>Logout</span>
      </button>
    </aside>
  );
}

export default Inventory;