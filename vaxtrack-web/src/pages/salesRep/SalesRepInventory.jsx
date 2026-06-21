import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Hourglass,
  PackageCheck,
  PackagePlus,
  RotateCcw,
  Search,
  Snowflake,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const inventoryData = [
  {
    id: "BT-2024-X91",
    name: "VaxCovar-19",
    type: "Moderna",
    manufacturer: "Moderna Pharma",
    expiryDate: "Oct 24, 2026",
    daysRemaining: 12,
    quantity: 14200,
    temp: "-70°C",
    status: "Critical",
    capacity: 78,
  },
  {
    id: "INF-221-Z67",
    name: "Influenza-Plus",
    type: "Pfizer",
    manufacturer: "Global Bio",
    expiryDate: "Dec 12, 2026",
    daysRemaining: 61,
    quantity: 8400,
    temp: "2-8°C",
    status: "Warning",
    capacity: 84,
  },
  {
    id: "PO-882-V69",
    name: "Polio-Zero",
    type: "Sinovac",
    manufacturer: "Hygiela Lab",
    expiryDate: "Mar 30, 2027",
    daysRemaining: 170,
    quantity: 52000,
    temp: "2-8°C",
    status: "Stable",
    capacity: 72,
  },
  {
    id: "PFZ-2023-A01",
    name: "Comirnaty Shield",
    type: "Pfizer",
    manufacturer: "Pfizer-BioNTech",
    expiryDate: "Aug 18, 2026",
    daysRemaining: 38,
    quantity: 85000,
    temp: "-70°C",
    status: "Stable",
    capacity: 90,
  },
  {
    id: "SNO-2023-C44",
    name: "CoronaVac Plus",
    type: "Sinovac",
    manufacturer: "Sinovac",
    expiryDate: "Oct 03, 2026",
    daysRemaining: 84,
    quantity: 120000,
    temp: "2-8°C",
    status: "Stable",
    capacity: 86,
  },
  {
    id: "MOD-2023-B12",
    name: "Spikevax Batch",
    type: "Moderna",
    manufacturer: "Moderna",
    expiryDate: "Jul 11, 2026",
    daysRemaining: 29,
    quantity: 45000,
    temp: "-20°C",
    status: "Warning",
    capacity: 56,
  },
  {
    id: "JNJ-2023-X99",
    name: "Janssen Protect",
    type: "J&J",
    manufacturer: "J&J Janssen",
    expiryDate: "May 28, 2026",
    daysRemaining: 18,
    quantity: 10000,
    temp: "2-8°C",
    status: "Critical",
    capacity: 18,
  },
  {
    id: "HEP-2025-HB2",
    name: "HepaGuard-B",
    type: "Pfizer",
    manufacturer: "MedSupply PH",
    expiryDate: "Jan 14, 2027",
    daysRemaining: 95,
    quantity: 36000,
    temp: "2-8°C",
    status: "Stable",
    capacity: 66,
  },
  {
    id: "RAB-2025-R01",
    name: "RabiesVac",
    type: "Moderna",
    manufacturer: "Global Bio",
    expiryDate: "Nov 02, 2026",
    daysRemaining: 50,
    quantity: 18500,
    temp: "2-8°C",
    status: "Warning",
    capacity: 42,
  },
  {
    id: "TET-2024-T11",
    name: "TetanusCare",
    type: "Sinovac",
    manufacturer: "Hygiela Lab",
    expiryDate: "Feb 22, 2027",
    daysRemaining: 135,
    quantity: 24000,
    temp: "2-8°C",
    status: "Stable",
    capacity: 58,
  },
];

const vaccineTypes = ["All", "Pfizer", "Moderna", "Sinovac", "J&J"];
const statusTypes = ["All", "Critical", "Warning", "Stable"];
const rowsPerPage = 5;

function SalesRepInventory() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [expiryWindow, setExpiryWindow] = useState("90");
  const [selectedRows, setSelectedRows] = useState([]);
  const [page, setPage] = useState(1);

  const filteredStocks = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return inventoryData.filter((stock) => {
      const matchesSearch =
        stock.name.toLowerCase().includes(query) ||
        stock.manufacturer.toLowerCase().includes(query) ||
        stock.id.toLowerCase().includes(query) ||
        stock.type.toLowerCase().includes(query);

      const matchesType = selectedType === "All" || stock.type === selectedType;
      const matchesStatus = selectedStatus === "All" || stock.status === selectedStatus;
      const matchesExpiry =
        expiryWindow === "all" || stock.daysRemaining <= Number(expiryWindow);

      return matchesSearch && matchesType && matchesStatus && matchesExpiry;
    });
  }, [searchTerm, selectedType, selectedStatus, expiryWindow]);

  const totalPages = Math.max(1, Math.ceil(filteredStocks.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const visibleStocks = filteredStocks.slice(startIndex, startIndex + rowsPerPage);

  const metrics = useMemo(() => {
    const expiringSoon = inventoryData
      .filter((stock) => stock.daysRemaining <= 30)
      .reduce((total, stock) => total + stock.quantity, 0);

    const safeStock = inventoryData
      .filter((stock) => stock.status === "Stable")
      .reduce((total, stock) => total + stock.quantity, 0);

    const coldChainAlerts = inventoryData.filter((stock) => stock.status !== "Stable").length;

    return {
      expiringSoon,
      safeStock,
      coldChainAlerts,
    };
  }, []);

  const capacityByType = useMemo(() => {
    return vaccineTypes
      .filter((type) => type !== "All")
      .map((type) => {
        const typeStocks = inventoryData.filter((stock) => stock.type === type);
        const averageCapacity =
          typeStocks.reduce((total, stock) => total + stock.capacity, 0) / typeStocks.length;

        return {
          label: type,
          value: Math.round(averageCapacity || 0),
          tone: type === "Pfizer" ? "blue" : type === "Moderna" ? "green" : type === "Sinovac" ? "gold" : "red",
        };
      });
  }, []);

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedType("All");
    setSelectedStatus("All");
    setExpiryWindow("90");
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
    const selectedStockItems = inventoryData.filter((stock) => selectedRows.includes(stock.id));

    localStorage.setItem("salesRepSelectedInventory", JSON.stringify(selectedStockItems));
    navigate("/sales-rep/request-order");
  };

  const formatNumber = (value) => value.toLocaleString();

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
        <div className="salesrep-card capacity-card inventory-capacity-card">
          <div className="inventory-card-head">
            <div>
              <h2>Central Hub Capacity</h2>
              <p>Average storage capacity by vaccine type</p>
            </div>
          </div>

          <div className="bar-chart inventory-v2-chart">
            {capacityByType.map((bar) => (
              <Bar key={bar.label} label={bar.label} value={bar.value} tone={bar.tone} />
            ))}
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

          {filteredStocks.some((stock) => stock.status === "Critical") && (
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
                  <td><span className="batch-chip">{stock.id}</span></td>
                  <td>
                    <strong>{stock.expiryDate}</strong>
                    <small>{stock.daysRemaining} Days Remaining</small>
                  </td>
                  <td>{formatNumber(stock.quantity)}</td>
                  <td><span className="temp-chip">{stock.temp}</span></td>
                  <td><span className={`status-chip ${stock.status.toLowerCase()}`}>• {stock.status}</span></td>
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

function Bar({ label, value, tone }) {
  return (
    <div className="bar-item">
      <div className="bar-bg">
        <span className={tone} style={{ height: `${value}%` }}></span>
      </div>
      <p>{label}</p>
      <small>{value}%</small>
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
