import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Hourglass,
  Loader2,
  PackageCheck,
  PackagePlus,
  RotateCcw,
  Search,
  Snowflake,
} from "lucide-react";
import { subscribeInventory } from "../../services/inventoryService";
import SalesRepLayout from "./SalesRepLayout";

const statusTypes = ["All", "Critical", "Warning", "Stable"];
const rowsPerPage = 5;

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

function normalizeStock(raw) {
  const status = raw.status || "Stable";
  const daysRemaining = getDaysUntilExpiry(raw.expiryDate);
  return {
    id: raw.id,
    batchId: raw.batchId || raw.id,
    name: raw.vaccineName || "Unknown Vaccine",
    type: raw.vaccineType || "Other",
    manufacturer: raw.manufacturer || "—",
    expiryDate: formatExpiry(raw.expiryDate),
    expiryRaw: raw.expiryDate || "",
    daysRemaining,
    quantity: raw.quantity != null ? Number(raw.quantity) : 0,
    temp: raw.storageTempDisplay || (raw.storageTemp != null ? `${raw.storageTemp}°C` : "—"),
    status,
    statusLower: status.toLowerCase(),
  };
}

function SalesRepInventory() {
  const navigate = useNavigate();

  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [expiryWindow, setExpiryWindow] = useState("all");
  const [selectedRows, setSelectedRows] = useState([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        setInventory(raw.map(normalizeStock));
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view inventory. Please contact your administrator.");
        } else {
          setError("Unable to load inventory. Please try again later.");
        }
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const vaccineTypes = useMemo(() => {
    const types = new Set(inventory.map((s) => s.type));
    return ["All", ...Array.from(types).sort()];
  }, [inventory]);

  const filteredStocks = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return inventory.filter((stock) => {
      const matchesSearch =
        stock.name.toLowerCase().includes(query) ||
        stock.manufacturer.toLowerCase().includes(query) ||
        stock.batchId.toLowerCase().includes(query) ||
        stock.type.toLowerCase().includes(query);

      const matchesType = selectedType === "All" || stock.type === selectedType;
      const matchesStatus = selectedStatus === "All" || stock.status === selectedStatus;
      const matchesExpiry =
        expiryWindow === "all" ||
        (stock.daysRemaining >= 0 && stock.daysRemaining <= Number(expiryWindow));

      return matchesSearch && matchesType && matchesStatus && matchesExpiry;
    });
  }, [inventory, searchTerm, selectedType, selectedStatus, expiryWindow]);

  const totalPages = Math.max(1, Math.ceil(filteredStocks.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const visibleStocks = filteredStocks.slice(startIndex, startIndex + rowsPerPage);

  const metrics = useMemo(() => {
    const expiringSoon = inventory
      .filter((stock) => stock.daysRemaining <= 30 && stock.daysRemaining >= 0)
      .reduce((total, stock) => total + stock.quantity, 0);

    const safeStock = inventory
      .filter((stock) => stock.statusLower === "stable")
      .reduce((total, stock) => total + stock.quantity, 0);

    const coldChainAlerts = inventory.filter((stock) => stock.statusLower !== "stable").length;

    return { expiringSoon, safeStock, coldChainAlerts };
  }, [inventory]);

  const stockByType = useMemo(() => {
    if (inventory.length === 0) return [];
    const totals = {};

    for (const stock of inventory) {
      const key = stock.type || "Unknown";
      totals[key] = (totals[key] || 0) + stock.quantity;
    }

    const sorted = Object.entries(totals).sort(([, a], [, b]) => b - a);
    const maxQty = sorted.length > 0 ? sorted[0][1] : 1;
    const tones = ["blue", "green", "gold", "red", "purple"];

    return sorted.map(([label, qty], i) => ({
      label,
      qty,
      barHeight: maxQty > 0 ? Math.max(Math.round((qty / maxQty) * 100), 4) : 0,
      tone: tones[i % tones.length],
    }));
  }, [inventory]);

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedType("All");
    setSelectedStatus("All");
    setExpiryWindow("all");
    setSelectedRows([]);
    setPage(1);
  };

  const handleTypeFilter = (type) => {
    setSelectedType(type);
    setPage(1);
  };

  const handleStatusFilter = (event) => {
    setSelectedStatus(event.target.value);
    setPage(1);
  };

  const handleExpiryFilter = (event) => {
    setExpiryWindow(event.target.value);
    setPage(1);
  };

  const handleSearch = (event) => {
    setSearchTerm(event.target.value);
    setPage(1);
  };

  const toggleRow = (batchId) => {
    setSelectedRows((current) =>
      current.includes(batchId)
        ? current.filter((id) => id !== batchId)
        : [...current, batchId]
    );
  };

  const toggleVisibleRows = () => {
    const visibleIds = visibleStocks.map((stock) => stock.id);
    const allVisibleSelected = visibleIds.every((id) => selectedRows.includes(id));

    if (allVisibleSelected) {
      setSelectedRows((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }

    setSelectedRows((current) => [...new Set([...current, ...visibleIds])]);
  };

  const requestSelected = () => {
    const selectedStockItems = inventory.filter((stock) => selectedRows.includes(stock.id));

    localStorage.setItem("salesRepSelectedInventory", JSON.stringify(selectedStockItems));
    navigate("/sales-rep/request-order");
  };

  const formatNumber = (value) => Number(value || 0).toLocaleString();

  if (loading) {
    return (
      <SalesRepLayout active="inventory" title="Inventory Monitoring" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading inventory data...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="inventory" title="Inventory Monitoring" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (inventory.length === 0) {
    return (
      <SalesRepLayout active="inventory" title="Inventory Monitoring" showSearch={false}>
        <div className="inventory-loading-state">
          <PackageCheck size={32} />
          <strong>No inventory data</strong>
          <p>No vaccine batches found in the system. Contact your administrator.</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="inventory" title="Inventory Monitoring" showSearch={false}>
      <section className="salesrep-page-title inventory-v2-title">
        <div>
          <h1>Inventory Monitoring</h1>
          <p>Real-time stock availability, expiry tracking, and cold-chain status.</p>
        </div>

        <button
          type="button"
          className="inventory-request-btn"
          onClick={requestSelected}
          disabled={selectedRows.length === 0}
        >
          <PackagePlus size={16} />
          Request Selected ({selectedRows.length})
        </button>
      </section>

      <section className="inventory-v2-summary">
        <div className="salesrep-card inventory-stock-chart-card">
          <div className="inventory-card-head">
            <div>
              <h2>Available Stock by Vaccine Type</h2>
              <p>Total doses grouped by vaccine type</p>
            </div>
          </div>

          <div className="stock-hbar-list">
            {stockByType.length > 0 ? (
              stockByType.map((bar) => (
                <HBar key={bar.label} label={bar.label} qty={bar.qty} barWidth={bar.barHeight} tone={bar.tone} />
              ))
            ) : (
              <p className="chart-empty">No stock data available</p>
            )}
          </div>
        </div>

        <div className="inventory-side-metrics">
          <SmallMetric
            icon={<Hourglass size={24} />}
            label="Expiring ≤ 30 Days"
            value={formatNumber(metrics.expiringSoon)}
            sub="vials need priority"
            tone="gold"
          />

          <SmallMetric
            icon={<CheckCircle2 size={24} />}
            label="Total Safe Stock"
            value={formatCompact(metrics.safeStock)}
            sub="stable batches"
            tone="green"
          />

          <SmallMetric
            icon={<Snowflake size={24} />}
            label="Cold-Chain Alerts"
            value={metrics.coldChainAlerts}
            sub="need monitoring"
            tone="blue"
          />
        </div>
      </section>

      <section className="salesrep-card inventory-table-card inventory-v2-table-card">
        <div className="inventory-v2-toolbar">
          <div className="inventory-search-box">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={handleSearch}
              placeholder="Search vaccine, manufacturer, type, or batch ID..."
            />
          </div>

          <div className="inventory-v2-selects">
            <label>
              <Filter size={14} />
              <select value={selectedStatus} onChange={handleStatusFilter}>
                {statusTypes.map((status) => (
                  <option key={status} value={status}>
                    {status === "All" ? "All Status" : status}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <CalendarDays size={14} />
              <select value={expiryWindow} onChange={handleExpiryFilter}>
                <option value="30">Expiry: Next 30 Days</option>
                <option value="90">Expiry: Next 90 Days</option>
                <option value="180">Expiry: Next 180 Days</option>
                <option value="all">All Expiry Dates</option>
              </select>
            </label>

            <button type="button" className="inventory-reset-btn" onClick={resetFilters}>
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
        </div>

        <div className="inventory-type-tabs">
          {vaccineTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={selectedType === type ? "active" : ""}
              onClick={() => handleTypeFilter(type)}
            >
              {type === "All" ? "All Vaccine Types" : type}
            </button>
          ))}
        </div>

        <div className="inventory-selected-bar">
          <div>
            <strong>{filteredStocks.length}</strong> matching batches
            {selectedRows.length > 0 && <span> · {selectedRows.length} selected</span>}
          </div>

          {filteredStocks.some((stock) => stock.statusLower === "critical") && (
            <p>
              <AlertTriangle size={14} />
              Critical batches should be requested or escalated first.
            </p>
          )}
        </div>

        <table className="salesrep-inventory-table inventory-v2-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={
                    visibleStocks.length > 0 &&
                    visibleStocks.every((stock) => selectedRows.includes(stock.id))
                  }
                  onChange={toggleVisibleRows}
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
            {visibleStocks.length > 0 ? (
              visibleStocks.map((stock) => (
                <tr key={stock.id} className={selectedRows.includes(stock.id) ? "selected" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedRows.includes(stock.id)}
                      onChange={() => toggleRow(stock.id)}
                    />
                  </td>
                  <td>
                    <div className="stock-name">
                      <span><PackageCheck size={16} /></span>
                      <div>
                        <strong>{stock.name}</strong>
                        <small>{stock.manufacturer} · {stock.type}</small>
                      </div>
                    </div>
                  </td>
                  <td><span className="batch-chip">{stock.batchId}</span></td>
                  <td>
                    <strong>{stock.expiryDate}</strong>
                    {stock.daysRemaining !== Infinity && (
                      <small>{stock.daysRemaining} Days Remaining</small>
                    )}
                  </td>
                  <td>{formatNumber(stock.quantity)}</td>
                  <td><span className="temp-chip">{stock.temp}</span></td>
                  <td><span className={`status-chip ${stock.statusLower}`}>• {stock.status}</span></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="7">
                  <div className="inventory-empty-state">
                    <PackageCheck size={28} />
                    <strong>No batches found</strong>
                    <p>Try changing the search term, vaccine type, status, or expiry filter.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="salesrep-pagination-row right inventory-v2-pagination">
          <p>
            Displaying {filteredStocks.length === 0 ? 0 : startIndex + 1}-
            {Math.min(startIndex + rowsPerPage, filteredStocks.length)} of {filteredStocks.length} batches
          </p>

          <div>
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(value - 1, 1))}
            >
              <ChevronLeft size={15} />
            </button>

            {Array.from({ length: totalPages }, (_, index) => (
              <button
                key={index + 1}
                type="button"
                className={currentPage === index + 1 ? "active" : ""}
                onClick={() => setPage(index + 1)}
              >
                {index + 1}
              </button>
            ))}

            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() => setPage((value) => Math.min(value + 1, totalPages))}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </section>
    </SalesRepLayout>
  );
}

function HBar({ label, qty, barWidth, tone }) {
  return (
    <div className="hbar-row">
      <span className="hbar-label">{label}</span>
      <div className="hbar-track">
        <div className={`hbar-fill ${tone}`} style={{ width: `${barWidth}%` }} />
      </div>
      <span className="hbar-qty">{formatCompact(qty)} doses</span>
    </div>
  );
}

function SmallMetric({ icon, label, value, sub, tone }) {
  return (
    <div className="small-metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <h2>{value}</h2>
        <p>{sub}</p>
      </div>
    </div>
  );
}

function formatCompact(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return value.toLocaleString();
}

export default SalesRepInventory;
