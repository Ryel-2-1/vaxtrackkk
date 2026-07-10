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
  FileText,
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
import { subscribeInventory } from "../../services/inventoryService";
import "./Inventory.css";

function getDaysUntilExpiry(rawDateStr) {
  if (!rawDateStr) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(rawDateStr + "T00:00:00");
  return Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatExpiry(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeInventoryItem(raw) {
  const status = raw.status || "Stable";
  return {
    id: raw.id,
    name: raw.vaccineName || "—",
    type: raw.vaccineType || "—",
    batch: raw.batchId || "—",
    expiry: formatExpiry(raw.expiryDate),
    expiryRaw: raw.expiryDate || "",
    qty: raw.quantity != null ? Number(raw.quantity).toLocaleString() : "—",
    qtyRaw: raw.quantity != null ? Number(raw.quantity) : 0,
    temp: raw.storageTempDisplay || (raw.storageTemp != null ? `${raw.storageTemp}°C` : "—"),
    status,
    level: status.toLowerCase(),
    location: raw.location || "—",
    manufacturer: raw.manufacturer || "—",
  };
}

function Inventory() {
  const navigate = useNavigate();

  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedBatches, setSelectedBatches] = useState([]);
  const [selectedVaccine, setSelectedVaccine] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeInventory((raw) => {
      setInventory(raw.map(normalizeInventoryItem));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

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
    return inventory.filter((item) => {
      const searchValue =
        `${item.name} ${item.type} ${item.batch} ${item.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "all" || item.level === statusFilter;

      const daysUntilExpiry = getDaysUntilExpiry(item.expiryRaw);
      const matchesExpiry =
        expiryFilter === "all" ||
        (daysUntilExpiry >= 0 && daysUntilExpiry <= Number(expiryFilter));

      return matchesSearch && matchesStatus && matchesExpiry;
    });
  }, [inventory, searchTerm, statusFilter, expiryFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, expiryFilter]);

  const stockByType = useMemo(() => {
    if (inventory.length === 0) return [];
    const totals = {};
    inventory.forEach((item) => {
      const key = item.type !== "—" ? item.type : "Unknown";
      totals[key] = (totals[key] || 0) + item.qtyRaw;
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const maxQty = sorted[0]?.[1] || 1;
    const tones = ["blue", "green", "gold", "red", "purple"];
    return sorted.map(([label, totalQty], i) => ({
      label,
      totalQty,
      percentage: Math.max(4, Math.round((totalQty / maxQty) * 100)),
      tone: tones[i % tones.length],
    }));
  }, [inventory]);

  const criticalAndExpiring = useMemo(() => {
    return inventory
      .filter((i) => {
        const days = getDaysUntilExpiry(i.expiryRaw);
        return i.level === "critical" || (days >= 0 && days <= 30);
      })
      .sort((a, b) => getDaysUntilExpiry(a.expiryRaw) - getDaysUntilExpiry(b.expiryRaw))
      .slice(0, 4);
  }, [inventory]);

  const criticalCount = useMemo(
    () => inventory.filter((i) => i.level === "critical").length,
    [inventory]
  );
  const expiringSoonCount = useMemo(
    () =>
      inventory.filter((i) => {
        const days = getDaysUntilExpiry(i.expiryRaw);
        return days >= 0 && days <= 90;
      }).length,
    [inventory]
  );
  const stableCount = useMemo(
    () => inventory.filter((i) => i.level === "stable").length,
    [inventory]
  );

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
            value={loading ? "—" : inventory.length}
            note="Across all vaccine types"
            type="blue"
            onClick={() => setStatusFilter("all")}
          />

          <SummaryCard
            icon={<AlertTriangle size={20} />}
            title="Critical Stock"
            value={loading ? "—" : inventory.filter((i) => i.level === "critical").length}
            note="Needs immediate review"
            type="red"
            onClick={() => setStatusFilter("critical")}
          />

          <SummaryCard
            icon={<Thermometer size={20} />}
            title="Warning Batches"
            value={loading ? "—" : inventory.filter((i) => i.level === "warning").length}
            note="Temperature exceptions"
            type="amber"
            onClick={() => setStatusFilter("warning")}
          />

          <SummaryCard
            icon={<CheckCircle2 size={20} />}
            title="Stable Batches"
            value={loading ? "—" : inventory.filter((i) => i.level === "stable").length}
            note="No action required"
            type="green"
            onClick={() => setStatusFilter("stable")}
          />
        </section>

        <section className="v2-hub-grid">
          <StockOverviewCard groups={stockByType} loading={loading} />

          <CriticalExpiringCard batches={criticalAndExpiring} loading={loading} />

          <InventoryAlertCard
            critical={criticalCount}
            expiringSoon={expiringSoonCount}
            stable={stableCount}
            loading={loading}
          />
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

          {loading && (
            <div className="v2-empty-inventory">
              <Package size={28} />
              <strong>Loading inventory...</strong>
              <p>Fetching vaccine batches from Firestore.</p>
            </div>
          )}

          {!loading && filteredVaccines.length === 0 && (
            <div className="v2-empty-inventory">
              <Package size={28} />
              <strong>No vaccine batches found</strong>
              <p>
                {inventory.length === 0
                  ? "No stock has been added yet. Use Add Stock to register a batch."
                  : "Try changing the search keyword or selected filters."}
              </p>
            </div>
          )}

          <div className="v2-inventory-footer">
            <p>
              Showing {startItem}–{endItem} of {filteredVaccines.length} filtered
              batches. Full inventory count: {inventory.length} batches.
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

function StockOverviewCard({ groups, loading }) {
  return (
    <div className="v2-hub-card">
      <div className="v2-card-head">
        <h2>Current Stock Overview</h2>
        <p>Total doses available by vaccine type</p>
      </div>

      {loading ? (
        <p className="v2-stock-empty">Loading...</p>
      ) : groups.length === 0 ? (
        <p className="v2-stock-empty">No inventory data yet. Add stock to see the overview.</p>
      ) : (
        <div className="v2-stock-list">
          {groups.map((g) => (
            <div className="v2-stock-row" key={g.label}>
              <span className="v2-stock-row-label" title={g.label}>{g.label}</span>
              <div className="v2-stock-row-track">
                <div className={`v2-stock-row-fill ${g.tone}`} style={{ width: `${g.percentage}%` }} />
              </div>
              <span className="v2-stock-row-qty">{g.totalQty.toLocaleString()} doses</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CriticalExpiringCard({ batches, loading }) {
  return (
    <div className="v2-hub-card v2-cold-card">
      <div className="v2-card-head">
        <h2>Critical &amp; Expiring</h2>
        <p>Critical stock and batches expiring within 30 days</p>
      </div>

      <div className="v2-cold-list">
        {loading ? (
          <div><span>Loading...</span></div>
        ) : batches.length === 0 ? (
          <div><span>No critical or near-expiry batches</span></div>
        ) : (
          batches.map((item) => {
            const days = getDaysUntilExpiry(item.expiryRaw);
            return (
              <div key={item.batch}>
                <span>{item.name}</span>
                <strong>{item.expiry}</strong>
                <small className={item.level}>
                  {item.level === "critical"
                    ? `Critical — ${days >= 0 ? `${days}d left` : "expired"}`
                    : `${days} day${days !== 1 ? "s" : ""} left`}
                </small>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function InventoryAlertCard({ critical, expiringSoon, stable, loading }) {
  const dash = "—";
  return (
    <div className="v2-hub-card v2-alert-summary-card">
      <div className="v2-card-head">
        <h2>Inventory Alerts</h2>
        <p>Action required today</p>
      </div>

      <div className="v2-alert-summary-list">
        <div className="critical">
          <strong>{loading ? dash : critical}</strong>
          <span>Critical stock</span>
        </div>

        <div className="warning">
          <strong>{loading ? dash : expiringSoon}</strong>
          <span>Expiring in 90 days</span>
        </div>

        <div className="stable">
          <strong>{loading ? dash : stable}</strong>
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
          className={active === "invoices" ? "active" : ""}
          to="/admin/invoices"
        >
          <FileText size={16} />
          <span>Invoices</span>
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