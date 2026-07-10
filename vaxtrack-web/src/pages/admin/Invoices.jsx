import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  Printer,
  RotateCcw,
  Search,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import {
  subscribeInvoiceQueue,
  updateInvoicePriority,
} from "../../services/invoiceService";
import "./Invoices.css";

const PRIORITY_OPTIONS = ["Normal", "High", "Urgent"];
const PAGE_SIZE = 8;

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

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState("success");
  const [updatingPriority, setUpdatingPriority] = useState("");

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
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view invoices.");
        } else {
          setError("Unable to load the invoice queue.");
        }
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (msg, type = "success") => {
    setToast(msg);
    setToastType(type);
    window.setTimeout(() => setToast(""), 2600);
  };

  const handlePriorityChange = async (orderId, priority) => {
    setUpdatingPriority(orderId);
    try {
      const user = auth.currentUser;
      await updateInvoicePriority(orderId, priority, {
        uid: user?.uid || null,
        email: user?.email || null,
      });
      showToast(`Priority set to ${priority}.`, "success");
    } catch (err) {
      showToast(err.message || "Failed to update priority.", "error");
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

  return (
    <div className="inventory-page">
      <AdminSidebar active="invoices" onLogout={handleLogout} />

      <main className="inv-page">
        {toast && (
          <div className={`inv-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{toast}</span>
          </div>
        )}

        <header className="inv-header">
          <div>
            <h1>Sales Invoice Queue</h1>
            <p>Manage approved customer orders and prioritize sales invoice preparation.</p>
          </div>
        </header>

        <section className="inv-summary-grid">
          <SummaryCard
            icon={<ClipboardList size={18} />}
            value={summary.pending}
            label="Pending Invoices"
            tone="blue"
          />
          <SummaryCard
            icon={<AlertTriangle size={18} />}
            value={summary.highPriority}
            label="High Priority"
            tone="red"
          />
          <SummaryCard
            icon={<CheckCircle2 size={18} />}
            value={summary.issuedToday}
            label="Issued Today"
            tone="green"
          />
          <SummaryCard
            icon={<FileText size={18} />}
            value={summary.totalIssued}
            label="Total Issued"
            tone="slate"
          />
        </section>

        <section className="inv-table-card">
          <div className="inv-table-toolbar">
            <h2>Approved Orders</h2>

            <div className="inv-search">
              <Search size={15} />
              <input
                placeholder="Search order, customer, or sales rep..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
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
                <option value="date">Order date</option>
                <option value="customer">Customer name</option>
              </select>
            </label>
          </div>

          <div className="inv-table-wrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer / Clinic</th>
                  <th>Sales Rep</th>
                  <th>Order Date</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>Invoice Status</th>
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
                    <td>{formatDate(r.orderDate)}</td>
                    <td>
                      {r.totalQuantity.toLocaleString()} {r.unit}
                    </td>
                    <td>{formatCurrency(r.amount)}</td>
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
              <div className="inv-state">
                <AlertTriangle size={28} />
                <p>{error}</p>
                <button
                  type="button"
                  className="inv-btn inv-btn-outline"
                  onClick={() => {
                    setError("");
                    setLoading(true);
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
    </div>
  );
}

function SummaryCard({ icon, value, label, tone }) {
  return (
    <div className={`inv-summary-card ${tone}`}>
      <div className="inv-summary-icon">{icon}</div>
      <div>
        <h2>{value}</h2>
        <p>{label}</p>
      </div>
    </div>
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
