import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Download,
  FileText,
  Loader2,
  Printer,
  RotateCcw,
  Search,
} from "lucide-react";
import { auth } from "../../firebase";
import {
  subscribeInvoiceQueue,
  updateInvoicePriority,
  vatClassificationLabel,
} from "../../services/invoiceService";
import { subscribeMedReps } from "../../services/orderHistoryService";
import { toCsv, downloadCsv } from "../../utils/csv";
import KpiCard from "../../components/ui/KpiCard";
import { friendlyErrorMessage, kpiValue, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import "./Invoices.css";

const PRIORITY_OPTIONS = ["Normal", "High", "Urgent"];
const PAGE_SIZE = 10;

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ISO date (YYYY-MM-DD) for CSV cells; blank when absent/invalid.
function csvDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// Raw numbers for CSV (spreadsheet-friendly, no ₱); blank when there is no value.
function numOrBlank(v) {
  return v === null || v === undefined ? "" : Number(v);
}

function isToday(ms) {
  if (!ms) return false;
  const d = new Date(ms);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function Invoices() {
  const navigate = useNavigate();

  const [queueRows, setRows] = useState([]);
  // Most orders carry no Med Rep name snapshot, only the uid that placed them:
  // the name comes from the Med Rep directory, never the uid itself.
  const [medReps, setMedReps] = useState(null);
  useEffect(() => subscribeMedReps(setMedReps, () => setMedReps(null)), []);
  const rows = useMemo(() => {
    const labels = new Map((medReps || []).map((m) => [m.uid, m.label]));
    return queueRows.map((r) => ({
      ...r,
      salesRepName: r.salesRepName || labels.get(r.salesRepUid) || "Not recorded",
    }));
  }, [queueRows, medReps]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { toast, showToast, dismissToast } = useToast();
  const [updatingPriority, setUpdatingPriority] = useState("");
  // Bumped by Retry: a listener that failed is closed for good, so retrying
  // means opening a new one, not just clearing the message.
  const [retryKey, setRetryKey] = useState(0);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [sortBy, setSortBy] = useState("priority");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const unsub = subscribeInvoiceQueue(
      (next) => {
        setRows(next);
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(liveErrorMessage(err, "the invoice queue"));
        setLoading(false);
      }
    );
    return unsub;
  }, [retryKey]);


  const handlePriorityChange = async (orderId, priority) => {
    if (updatingPriority) return;
    setUpdatingPriority(orderId);
    try {
      const user = auth.currentUser;
      await updateInvoicePriority(orderId, priority, {
        uid: user?.uid || null,
        email: user?.email || null,
      });
      showToast(`Priority set to ${priority}.`, "success");
    } catch (err) {
      logSafeError("Update invoice priority", err);
      showToast(
        friendlyErrorMessage(err, "The priority could not be changed. Nothing was saved — please try again."),
        "error"
      );
    } finally {
      setUpdatingPriority("");
    }
  };

  const summary = useMemo(() => {
    const pending = rows.filter((r) =>
      ["Pending", "In Progress", "Ready to Print"].includes(r.invoiceStatus)
    );
    return {
      pending: pending.length,
      highPriority: pending.filter((r) => r.priority === "High" || r.priority === "Urgent").length,
      issuedToday: rows.filter((r) => r.invoiceStatus === "Issued" && isToday(r.issuedAtMs)).length,
      totalIssued: rows.filter((r) => r.invoiceStatus === "Issued").length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const result = rows.filter((r) => {
      const haystack = `${r.orderNumber} ${r.clinicName} ${r.salesRepName}`.toLowerCase();
      const matchesSearch = !term || haystack.includes(term);
      const matchesStatus = statusFilter === "all" || r.invoiceStatus === statusFilter;
      const matchesPriority = priorityFilter === "all" || r.priority === priorityFilter;
      return matchesSearch && matchesStatus && matchesPriority;
    });

    const rank = { Urgent: 3, High: 2, Normal: 1 };
    return [...result].sort((a, b) => {
      if (sortBy === "date") return a.orderDateMs - b.orderDateMs;
      if (sortBy === "customer") return a.clinicName.localeCompare(b.clinicName);
      // default: priority, then oldest first
      const diff = (rank[b.priority] || 0) - (rank[a.priority] || 0);
      return diff !== 0 ? diff : a.orderDateMs - b.orderDateMs;
    });
  }, [rows, search, statusFilter, priorityFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const handleExportCsv = () => {
    if (filtered.length === 0) return;
    const headers = [
      "Order ID",
      "Date Order",
      "Customer / Clinic",
      "Med Rep",
      "Qty",
      "Unit",
      "Invoice No.",
      "Invoice Status",
      "Priority",
      "VAT Classification",
      "VATable Sales",
      "VAT-Exempt Sales",
      "Zero-Rated Sales",
      "VAT Amount",
      "Subtotal",
      "Discount",
      "Other Charges",
      "Total",
    ];
    const rows = filtered.map((r) => [
      r.orderNumber,
      csvDate(r.orderDate),
      r.clinicName,
      r.salesRepName,
      r.totalQuantity,
      r.unit,
      r.invoiceNumber || "",
      r.invoiceStatus,
      r.priority,
      vatClassificationLabel(r.invoiceVatClassification),
      numOrBlank(r.invoiceVatableSales),
      numOrBlank(r.invoiceVatExemptSales),
      numOrBlank(r.invoiceZeroRatedSales),
      numOrBlank(r.invoiceVatAmount),
      numOrBlank(r.invoiceSubtotal),
      numOrBlank(r.invoiceDiscount),
      numOrBlank(r.invoiceOtherCharges),
      numOrBlank(r.invoiceGrandTotal ?? r.amount),
    ]);
    downloadCsv(
      `sales-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(headers, rows)
    );
    showToast(
      `Exported ${filtered.length} row${filtered.length !== 1 ? "s" : ""} to CSV.`,
      "success"
    );
  };

  return (
    <main className="inv-page">
        <ToastRegion toast={toast} onDismiss={dismissToast} />

        <header className="inv-header">
          <div>
            <p>Manage approved customer orders and prioritize sales invoice preparation.</p>
          </div>
        </header>

        <section className="inv-summary-grid">
          <KpiCard
            label="Pending invoices"
            value={kpiValue(summary.pending, { loading, error })}
            tone="neutral"
          />
          <KpiCard
            label="High priority"
            value={kpiValue(summary.highPriority, { loading, error })}
            tone="danger"
            attention={summary.highPriority > 0}
          />
          <KpiCard
            label="Issued today"
            value={kpiValue(summary.issuedToday, { loading, error })}
            tone="success"
          />
          <KpiCard
            label="Total issued"
            value={kpiValue(summary.totalIssued, { loading, error })}
            tone="neutral"
          />
        </section>

        <section className="inv-table-card">
          <div className="inv-table-toolbar">
            <h2>Approved Orders</h2>

            <div className="inv-toolbar-actions">
              <div className="inv-search">
                <Search size={15} />
                <input
                  placeholder="Search order, customer, or Med Rep..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <button
                type="button"
                className="inv-btn inv-btn-outline"
                onClick={handleExportCsv}
                disabled={filtered.length === 0}
              >
                <Download size={14} /> Export CSV
              </button>
            </div>
          </div>

          <div className="inv-filters">
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All</option>
                <option value="Pending">Pending</option>
                <option value="In Progress">In Progress</option>
                <option value="Ready to Print">Ready to Print</option>
                <option value="Issued">Issued</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </label>

            <label>
              Priority
              <select
                value={priorityFilter}
                onChange={(e) => {
                  setPriorityFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All</option>
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Sort by
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="priority">Priority</option>
                <option value="date">Date Order</option>
                <option value="customer">Customer name</option>
              </select>
            </label>
          </div>

          <div className="inv-table-wrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer / clinic</th>
                  <th>Med Rep</th>
                  <th>Order date</th>
                  <th>Amount · qty</th>
                  <th>Invoice status</th>
                  <th>Priority</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.orderId}>
                    <td>
                      <strong className="inv-order-id">{r.orderNumber}</strong>
                    </td>
                    <td>{r.clinicName}</td>
                    <td>{r.salesRepName}</td>
                    <td className="inv-cell-nowrap">{formatDate(r.orderDate)}</td>
                    {/* Amount and quantity describe the same order line; one
                        column keeps the queue readable at laptop widths. The
                        CSV export keeps them as separate columns. */}
                    <td className="inv-cell-nowrap">
                      <span className="inv-amount">{formatCurrency(r.amount)}</span>
                      <small className="inv-qty">
                        {r.totalQuantity.toLocaleString()} {r.unit}
                      </small>
                    </td>
                    <td>
                      <StatusBadge status={r.invoiceStatus} />
                    </td>
                    <td>
                      <select
                        className={`inv-priority-select p-${r.priority.toLowerCase()}`}
                        value={r.priority}
                        disabled={updatingPriority === r.orderId || r.invoiceStatus === "Issued"}
                        aria-label={`Priority for ${r.orderNumber}`}
                        onChange={(e) => handlePriorityChange(r.orderId, e.target.value)}
                      >
                        {PRIORITY_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <RowActions row={r} navigate={navigate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {loading && (
              <div className="inv-state">
                <Loader2 size={28} className="inv-spin" />
                <p>Loading invoice queue...</p>
              </div>
            )}

            {!loading && error && (
              <div className="inv-state" role="alert">
                <AlertTriangle size={28} aria-hidden="true" />
                <p>{error}</p>
                <button
                  type="button"
                  className="inv-btn inv-btn-outline"
                  onClick={() => {
                    setError("");
                    setLoading(true);
                    setRetryKey((k) => k + 1);
                  }}
                >
                  <RotateCcw size={14} /> Retry
                </button>
              </div>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div className="inv-state">
                <FileText size={28} />
                <p>
                  {rows.length === 0
                    ? "No customer orders are currently waiting for invoice preparation."
                    : "No orders match your search or filters."}
                </p>
              </div>
            )}
          </div>

          {!loading && !error && filtered.length > 0 && (
            <div className="inv-pagination">
              <p>
                Showing {(currentPage - 1) * PAGE_SIZE + 1} to{" "}
                {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} entries
              </p>
              <div>
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  ‹
                </button>
                <span>
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  ›
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
  );
}

function StatusBadge({ status }) {
  const tone =
    status === "Issued"
      ? "issued"
      : status === "Ready to Print"
      ? "ready"
      : status === "In Progress"
      ? "progress"
      : status === "Cancelled"
      ? "cancelled"
      : "pending";
  return <span className={`inv-status-badge ${tone}`}>{status}</span>;
}

function RowActions({ row, navigate }) {
  const to = `/admin/invoices/${row.orderId}`;

  if (row.invoiceStatus === "Issued") {
    return (
      <div className="inv-row-actions">
        <button type="button" className="inv-btn inv-btn-outline" onClick={() => navigate(to)}>
          <FileText size={13} /> View
        </button>
        <button
          type="button"
          className="inv-btn inv-btn-primary"
          onClick={() => navigate(to, { state: { autoPrint: true } })}
        >
          <Printer size={13} /> Print
        </button>
      </div>
    );
  }

  const label =
    row.invoiceStatus === "Pending" ? "Create Invoice" : "Continue Editing";

  return (
    <div className="inv-row-actions">
      <button type="button" className="inv-btn inv-btn-primary" onClick={() => navigate(to)}>
        <FileText size={13} /> {label}
      </button>
    </div>
  );
}

export default Invoices;
