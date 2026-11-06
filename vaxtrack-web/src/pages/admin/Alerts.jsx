import "./Alerts.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  MapPin,
  Package,
  RefreshCw,
  Route,
  Search,
  Truck,
  X,
} from "lucide-react";
import {
  markAlertRead,
  resolveAlert,
  subscribeAllAlerts,
} from "../../services/alertService";
import KpiCard from "../../components/ui/KpiCard";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { recheckStockAlerts } from "../../services/stockAlertCallables";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import { presentAlert } from "../../services/alertPresentation";
import { subscribeDeliveryExceptions } from "../../services/deliveryService";
import { activeAlertCountOfType, filterAdminAlerts } from "../../services/adminAlertCategories";
import DeliveryExceptions from "./DeliveryExceptions";
import ZeroRateReviews from "./ZeroRateReviews";

const TYPE_MAP = {
  route_deviation: {
    display: "Route Deviation",
    iconKey: "route",
    recommendation: "Contact the rider and inspect the delivery route immediately.",
  },
  // Server-written (functions/src/stockAlerts.js): low / out of stock per
  // vaccine against its safety stock, and expiring / expired batches.
  stock_low: {
    display: "Low Stock",
    iconKey: "package",
    recommendation: "Reorder or add stock for this vaccine. Its safety stock is set in AI Inventory Analytics.",
  },
  batch_expiry: {
    display: "Expiring Stock",
    iconKey: "package",
    recommendation: "Use or allocate this batch first; quarantine or dispose of expired vials in Inventory.",
  },
  low_stock: {
    display: "Low Stock",
    iconKey: "package",
    recommendation: "Prepare a stock replenishment request for the affected vaccine.",
  },
  delivery_delay: {
    display: "Delayed Delivery",
    iconKey: "truck",
    recommendation: "Monitor ETA and notify the receiving clinic if delay continues.",
  },
  delivery_awaiting_completion: {
    display: "Awaiting Completion",
    iconKey: "truck",
    recommendation: "Call the rider: they have been at the destination for 15 minutes without completing the delivery.",
  },
  rider_location_stale: {
    display: "Location Not Updating",
    iconKey: "pin",
    recommendation: "Call the rider and check that the VaxTrack app is open, signed in and has signal.",
  },
  delivery_completed: {
    display: "Delivery Completed",
    iconKey: "check",
    recommendation: "No further action required.",
  },
};

// Everything an admin READS comes from presentAlert (shared with the
// Dispatcher bell and dashboards): rider name, the human order code and
// friendly times — never the alert document id, a rider uid, an order's
// document id or a Firestore path. `id` is kept only as the React key and
// for the read/resolve writes; it is never rendered.
function normalizeAlert(raw) {
  const mapped = TYPE_MAP[raw.type] || {
    display: raw.title || raw.type || "Alert",
    iconKey: null,
    recommendation: "",
  };
  const view = presentAlert(raw, { role: "admin", fallbackTitle: mapped.display });
  const status = raw.status || "active";
  return {
    id: raw.id,
    typeKey: raw.type,
    type: mapped.display,
    title: view.title,
    message: view.message,
    meta: view.meta,
    details: view.details,
    statusLabel: view.statusLabel,
    orderCode: view.orderCode,
    path: view.path,
    actionLabel: view.actionLabel,
    searchText: view.searchText,
    severity: raw.severity || "notice",
    status,
    iconKey: mapped.iconKey,
    // A resolved alert asks for nothing; its type's "act now" advice would
    // contradict the resolved state.
    recommendation: status === "resolved" ? "No further action required." : raw.recommendation || mapped.recommendation,
    read: raw.read || false,
  };
}

function Alerts() {
  const navigate = useNavigate();
  const location = useLocation();
  const [alerts, setAlerts] = useState([]);
  // Loading and failure are their own states: an empty list must mean "no
  // alerts", never "not loaded yet" or "not allowed to read".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState(null);
  // The OPEN alert is looked up in the live list by id, so the dialog shows
  // what is stored now — resolved or read in another browser included.
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  // "Mark resolved" is confirmed first; the write runs from that dialog.
  const [confirmResolveId, setConfirmResolveId] = useState(null);
  const { toast, showToast, dismissToast } = useToast();
  const [markingAll, setMarkingAll] = useState(false);
  const markingAllRef = useRef(false);
  const openedFromLinkRef = useRef(null);
  // Delayed and failed deliveries (moved here from the Deliveries banner).
  const [exceptions, setExceptions] = useState([]);
  const [exceptionsError, setExceptionsError] = useState("");
  useEffect(() => subscribeDeliveryExceptions(
    (rows) => { setExceptions(rows); setExceptionsError(""); },
    (error) => setExceptionsError(liveErrorMessage(error, "delivery exceptions"))
  ), []);

  useEffect(() => {
    const unsubscribe = subscribeAllAlerts(
      (raw) => {
        setAlerts(raw.map(normalizeAlert));
        setLoadError("");
        setLoading(false);
      },
      (error) => {
        setAlerts([]);
        setLoadError(liveErrorMessage(error, "alerts"));
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const alertId = new URLSearchParams(location.search).get("alert");
    if (!alertId || openedFromLinkRef.current === alertId || loading || loadError) return;
    openedFromLinkRef.current = alertId;
    const linkedAlert = alerts.find((alert) => alert.id === alertId);
    setSelectedAlertId(alertId);
    if (linkedAlert && !linkedAlert.read) {
      markAlertRead(alertId).catch((error) => logSafeError("Mark alert read", error));
    }
  }, [location.search, alerts, loading, loadError]);

  const selectedAlert = selectedAlertId ? alerts.find((a) => a.id === selectedAlertId) ?? null : null;
  // Deleted while open: the dialog closes and says why, instead of showing a
  // record that no longer exists.
  const selectedGone = Boolean(selectedAlertId) && !loading && !loadError && !selectedAlert;


  const filteredAlerts = useMemo(
    () => filterAdminAlerts(alerts, { searchTerm, severityFilter, typeFilter }),
    [alerts, searchTerm, severityFilter, typeFilter],
  );

  const criticalCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "critical"
  ).length;

  const warningCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "warning"
  ).length;

  const noticeCount = alerts.filter(
    (alert) => alert.status !== "resolved" && alert.severity === "notice"
  ).length;

  const resolvedCount = alerts.filter((alert) => alert.status === "resolved").length;
  const unreadAlerts = alerts.filter((alert) => !alert.read);

  const priorityAlert =
    alerts.find((alert) => alert.status !== "resolved" && alert.severity === "critical") ||
    alerts.find((alert) => alert.status !== "resolved" && alert.severity === "warning") ||
    alerts.find((alert) => alert.status !== "resolved");

  const handleReviewAlert = (alert) => {
    // The read flag is cosmetic; if the write fails the live list keeps
    // showing the alert as unread, which is the truth.
    if (!alert.read) markAlertRead(alert.id).catch((error) => logSafeError("Mark alert read", error));
    setSelectedAlertId(alert.id);
  };

  const handleMarkAllRead = async () => {
    if (markingAllRef.current) return;
    const unread = unreadAlerts;
    if (unread.length === 0) {
      showToast("There are no unread alerts.", "info");
      return;
    }
    markingAllRef.current = true;
    setMarkingAll(true);
    try {
      const results = await Promise.allSettled(unread.map((a) => markAlertRead(a.id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      for (const result of results) {
        if (result.status === "rejected") logSafeError("Mark all alerts read", result.reason);
      }
      if (failed === 0) {
        showToast(`${unread.length} ${unread.length === 1 ? "alert" : "alerts"} marked as read.`, "success");
      } else if (failed === unread.length) {
        showToast("No alerts could be marked as read. Check your connection or access and try again.", "error");
      } else {
        showToast(
          `${unread.length - failed} of ${unread.length} alerts were marked as read. The other ${failed} could not be updated — try again.`,
          "warning"
        );
      }
    } finally {
      markingAllRef.current = false;
      setMarkingAll(false);
    }
  };

  // Runs from the confirmation. Closes only once the write succeeded (the
  // dialog ignores repeated presses); on failure it rethrows, so the dialog
  // stays open with the reason.
  const handleResolveAlert = async () => {
    const alertId = confirmResolveId;
    try {
      await resolveAlert(alertId);
    } catch (error) {
      logSafeError("Resolve alert", error);
      throw error;
    }
    setConfirmResolveId(null);
    setSelectedAlertId(null);
    showToast("Alert marked as resolved.", "success");
  };

  const kpi = (count) => (loading || loadError ? "—" : count);

  // Server-generated alert types. Stock and expiry alerts come from
  // functions/src/stockAlerts.js (every stock change, the daily review, or
  // "Check stock now").
  const categoryCounts = {
    route: kpi(activeAlertCountOfType(alerts, "route_deviation")),
    delivery: kpi(activeAlertCountOfType(alerts, "delivery_delay")),
    location: kpi(activeAlertCountOfType(alerts, "rider_location_stale")),
    stock: kpi(activeAlertCountOfType(alerts, "stock_low")),
    expiry: kpi(activeAlertCountOfType(alerts, "batch_expiry")),
  };
  const [stockCheckBusy, setStockCheckBusy] = useState(false);
  const checkStockNow = async () => {
    if (stockCheckBusy) return;
    setStockCheckBusy(true);
    try {
      const r = await recheckStockAlerts();
      const vaccines = `${r.checked} vaccine${r.checked === 1 ? "" : "s"}`;
      const changes = r.changed === 0 ? "No alert changed." : `${r.changed} alert${r.changed === 1 ? "" : "s"} updated.`;
      showToast(
        r.failed > 0
          ? `Checked ${r.checked - r.failed} of ${vaccines}; ${r.failed} could not be checked. Try again.`
          : `Checked ${vaccines}. ${changes}`,
        r.failed > 0 ? "warning" : "success"
      );
    } catch (error) {
      logSafeError("Check stock now", error);
      showToast(friendlyErrorMessage(error, "Stock could not be checked right now. Please try again."), "error");
    } finally {
      setStockCheckBusy(false);
    }
  };
  const selectType = (typeKey) => {
    setTypeFilter((current) => current === typeKey ? null : typeKey);
    setSeverityFilter("all");
    setSearchTerm("");
  };

  return (
    <>
    <main className="alerts-v2-main">
        <ToastRegion toast={toast} onDismiss={dismissToast} />
        {selectedGone && (
          <div className="alerts-toast" role="status">
            That alert was removed. The list has been updated.{" "}
            <button type="button" className="alerts-toast-dismiss" onClick={() => setSelectedAlertId(null)}>
              Dismiss
            </button>
          </div>
        )}

        <header className="alerts-v2-topbar">
          <div>
            <small>
              Review system alerts and delivery exceptions. Exceptions clear when an order moves on.
            </small>
          </div>

          <div className="alerts-v2-actions">
            <button
              type="button"
              className="alerts-outline-btn"
              onClick={handleMarkAllRead}
              disabled={markingAll || loading || Boolean(loadError) || unreadAlerts.length === 0}
              aria-busy={markingAll}
              title="Marks system alerts as read; does not resolve them or clear delivery exceptions"
            >
              <CheckCircle2 size={16} />
              {markingAll ? "Marking as read…" : unreadAlerts.length > 0 ? `Mark ${unreadAlerts.length} read` : "All alerts read"}
            </button>

          </div>
        </header>

        <section className="alert-kpi-grid">
          <KpiCard
            label="Critical alerts"
            value={kpi(criticalCount)}
            context="Needs immediate action"
            tone="danger"
            attention
            onClick={() => setSeverityFilter("critical")}
          />

          <KpiCard
            label="Warnings"
            value={kpi(warningCount)}
            context="Requires review"
            tone="warning"
            onClick={() => setSeverityFilter("warning")}
          />

          <KpiCard
            label="Pending notices"
            value={kpi(noticeCount)}
            context="For monitoring"
            tone="info"
            onClick={() => setSeverityFilter("notice")}
          />

          <KpiCard
            label="Resolved alerts"
            value={kpi(resolvedCount)}
            context="Completed alerts"
            tone="success"
            onClick={() => { setTypeFilter(null); setSeverityFilter("resolved"); }}
          />
        </section>

        <ZeroRateReviews />
        <DeliveryExceptions exceptions={exceptions} error={exceptionsError} />

        <section className="alerts-layout-grid">
          <div className="alerts-list-card">
            <div className="alerts-list-toolbar">
              <div>
                <h2>Recent Alerts</h2>
                <p>Latest system-generated admin notifications</p>
              </div>

              <div className="alerts-search">
                <Search size={16} />
                <input
                  placeholder="Search alert type, rider or order number..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="alerts-filter-tabs">
              <button
                type="button"
                className={severityFilter === "all" ? "active" : ""}
                onClick={() => setSeverityFilter("all")}
              >
                All
              </button>

              <button
                type="button"
                className={severityFilter === "critical" ? "active" : ""}
                onClick={() => setSeverityFilter("critical")}
              >
                Critical
              </button>

              <button
                type="button"
                className={severityFilter === "warning" ? "active" : ""}
                onClick={() => setSeverityFilter("warning")}
              >
                Warning
              </button>

              <button
                type="button"
                className={severityFilter === "notice" ? "active" : ""}
                onClick={() => setSeverityFilter("notice")}
              >
                Notice
              </button>

              <button
                type="button"
                className={severityFilter === "resolved" ? "active" : ""}
                onClick={() => { setTypeFilter(null); setSeverityFilter("resolved"); }}
              >
                Resolved
              </button>
            </div>

            {typeFilter && (
              <div className="alerts-type-selection" role="status">
                <span>Showing {TYPE_MAP[typeFilter]?.display || "selected type"}</span>
                <button type="button" onClick={() => setTypeFilter(null)}>Clear type filter</button>
              </div>
            )}

            <div className="alerts-list">
              {filteredAlerts.map((alert) => (
                <div
                  className={`alert-row ${getAlertClass(alert)} ${
                    alert.read ? "" : "unread"
                  }`}
                  key={alert.id}
                  onClick={() => handleReviewAlert(alert)}
                >
                  <div className="alert-row-icon">{getAlertIcon(alert.iconKey)}</div>

                  <div className="alert-row-content">
                    <div className="alert-row-title">
                      <h3>{alert.title}</h3>
                      <span>{getSeverityLabel(alert)}</span>
                      {/* Unread is a reading state, not an operational one:
                          a neutral word, never a green status dot. */}
                      {!alert.read && <span className="alert-unread-tag">New</span>}
                    </div>

                    <p>{alert.message}</p>

                    {alert.meta.length > 0 && (
                      <p className="alert-row-meta">{alert.meta.join(" · ")}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    className="alert-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReviewAlert(alert);
                    }}
                  >
                    {alert.actionLabel}
                  </button>
                </div>
              ))}

              {loading && (
                <div className="alerts-empty" role="status">
                  <Bell size={28} />
                  <strong>Loading alerts…</strong>
                </div>
              )}

              {!loading && loadError && (
                <div className="alerts-empty" role="alert">
                  <AlertTriangle size={28} />
                  <strong>Alerts unavailable</strong>
                  <p>{loadError}</p>
                </div>
              )}

              {!loading && !loadError && filteredAlerts.length === 0 && (
                <div className="alerts-empty">
                  <AlertTriangle size={28} />
                  <strong>No alerts found</strong>
                  <p>Try changing the search keyword or selected filter.</p>
                </div>
              )}
            </div>
          </div>

          <aside className="alerts-side-panel">
            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Alert Categories</h2>
                <p>Active system alerts by type</p>
              </div>

              <div className="alert-category-stack">
                <CategoryItem
                  icon={<Route size={18} />}
                  title="Route Deviation"
                  count={categoryCounts.route}
                  type="red"
                  selected={typeFilter === "route_deviation"}
                  disabled={loading || Boolean(loadError)}
                  onClick={() => selectType("route_deviation")}
                />

                <CategoryItem
                  icon={<Truck size={18} />}
                  title="Late Delivery"
                  count={categoryCounts.delivery}
                  type="orange"
                  selected={typeFilter === "delivery_delay"}
                  disabled={loading || Boolean(loadError)}
                  onClick={() => selectType("delivery_delay")}
                />

                <CategoryItem
                  icon={<MapPin size={18} />}
                  title="Location Not Updating"
                  count={categoryCounts.location}
                  type="blue"
                  selected={typeFilter === "rider_location_stale"}
                  disabled={loading || Boolean(loadError)}
                  onClick={() => selectType("rider_location_stale")}
                />

                <CategoryItem
                  icon={<Package size={18} />}
                  title="Low Stock"
                  count={categoryCounts.stock}
                  type="orange"
                  selected={typeFilter === "stock_low"}
                  disabled={loading || Boolean(loadError)}
                  onClick={() => selectType("stock_low")}
                />

                <CategoryItem
                  icon={<CalendarClock size={18} />}
                  title="Expiring Stock"
                  count={categoryCounts.expiry}
                  type="red"
                  selected={typeFilter === "batch_expiry"}
                  disabled={loading || Boolean(loadError)}
                  onClick={() => selectType("batch_expiry")}
                />
              </div>
              <button type="button" className="alert-stock-link" onClick={checkStockNow} disabled={stockCheckBusy} aria-busy={stockCheckBusy}>
                <RefreshCw size={16} aria-hidden="true" />
                <span>{stockCheckBusy ? "Checking stock…" : "Check stock now"}<small>Re-check low stock and expiry dates for every vaccine</small></span>
              </button>
              <button type="button" className="alert-stock-link" onClick={() => navigate("/admin/inventory")}>
                <Package size={16} aria-hidden="true" />
                <span>Review stock in Inventory<small>Check stock levels and expiry dates</small></span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>

            {!loading && !loadError && priorityAlert && (
              <div className="alerts-panel-card">
                <div className="alerts-panel-header">
                  <h2>Priority Action</h2>
                  <p>Most urgent system alert to review</p>
                </div>

                <div className={`priority-alert-card ${getAlertClass(priorityAlert)}`}>
                  <div className="priority-alert-heading">
                    <span className="priority-alert-icon" aria-hidden="true">{getAlertIcon(priorityAlert.iconKey)}</span>
                    <h3>{priorityAlert.title}</h3>
                  </div>
                  <p>{priorityAlert.message}</p>
                  <button type="button" onClick={() => handleReviewAlert(priorityAlert)}>
                    {priorityAlert.actionLabel}
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </aside>
        </section>
      </main>

      {selectedAlert && (
        <AlertReviewModal
          alert={selectedAlert}
          onClose={() => setSelectedAlertId(null)}
          onResolve={() => setConfirmResolveId(selectedAlert.id)}
          onOpenDelivery={selectedAlert.path ? () => navigate(selectedAlert.path) : null}
        />
      )}

      {confirmResolveId && selectedAlert && (
        <ConfirmDialog
          title="Mark alert as resolved?"
          target={selectedAlert.orderCode ? `${selectedAlert.title} · Order ${selectedAlert.orderCode}` : selectedAlert.title}
          consequence="It moves to the resolved list and stops counting as an open alert. Resolved alerts cannot be reopened from VaxTrack."
          confirmLabel="Mark resolved"
          busyLabel="Resolving…"
          tone="primary"
          failureMessage="The alert could not be resolved. It is still open — please try again."
          onConfirm={handleResolveAlert}
          onCancel={() => setConfirmResolveId(null)}
        />
      )}

    </>
  );
}

function CategoryItem({ icon, title, count, type, selected, disabled, onClick }) {
  return (
    <button
      type="button"
      className={`alert-category-item ${type}${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="alert-category-icon" aria-hidden="true">{icon}</span>
      <span className="alert-category-copy">
        <strong>{title}</strong>
      </span>
      <span className="alert-category-count">{count}<small>{count === "—" ? "" : "active"}</small></span>
      <ChevronRight size={16} className="alert-category-chevron" aria-hidden="true" />
    </button>
  );
}

function AlertReviewModal({ alert, onClose, onResolve, onOpenDelivery }) {
  const dialogRef = useRef(null);
  useDialogFocus({ dialogRef, onDismiss: onClose });
  return (
    <div className="alerts-modal-backdrop">
      <div
        ref={dialogRef}
        className="alerts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-review-title"
      >
        <button type="button" className="alerts-modal-close" onClick={onClose} aria-label="Close alert details">
          <X size={18} aria-hidden="true" />
        </button>

        <div className={`alerts-modal-icon ${getAlertClass(alert)}`}>
          {getAlertIcon(alert.iconKey)}
        </div>

        <h2 id="alert-review-title">{alert.title}</h2>
        <p>{alert.message}</p>

        <div className="alerts-modal-grid">
          <div>
            <span>Severity</span>
            <strong>{getSeverityLabel(alert)}</strong>
          </div>

          <div>
            <span>Status</span>
            <strong>{alert.statusLabel}</strong>
          </div>

          {alert.details.map(({ label, value }) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}

          <div className="wide">
            <span>Recommended Action</span>
            <strong>{alert.recommendation}</strong>
          </div>
        </div>



        <div className="alerts-modal-actions">
          {alert.status !== "resolved" && (
            <button type="button" className="alerts-primary-action" onClick={onResolve}>
              Mark Resolved
            </button>
          )}

          {onOpenDelivery && (
            <button type="button" className="alerts-light-action" onClick={onOpenDelivery}>
              <MapPin size={15} aria-hidden="true" />
              Open delivery
            </button>
          )}

          <button type="button" className="alerts-light-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function getAlertIcon(iconKey) {
  if (iconKey === "route") return <Route size={17} />;
  if (iconKey === "package") return <Package size={17} />;
  if (iconKey === "truck") return <Truck size={17} />;
  if (iconKey === "pin") return <MapPin size={17} />;
  if (iconKey === "check") return <CheckCircle2 size={17} />;
  return <AlertTriangle size={17} />;
}

function getSeverityLabel(alert) {
  if (alert.status === "resolved") return "Resolved";
  if (alert.severity === "critical") return "Critical";
  if (alert.severity === "warning") return "Warning";
  return "Notice";
}

function getAlertClass(alert) {
  if (alert.status === "resolved") return "resolved";
  if (alert.severity === "critical") return "critical";
  if (alert.severity === "warning") return "warning";
  return "notice";
}

export default Alerts;
