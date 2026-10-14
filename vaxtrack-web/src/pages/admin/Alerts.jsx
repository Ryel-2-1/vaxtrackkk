import "./Alerts.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  MapPin,
  Package,
  PhoneCall,
  Route,
  Search,
  Settings,
  Truck,
  X,
} from "lucide-react";
import {
  markAlertRead,
  resolveAlert,
  subscribeAllAlerts,
} from "../../services/alertService";
import KpiCard from "../../components/ui/KpiCard";
import { liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";

const TYPE_MAP = {
  route_deviation: {
    display: "Route Deviation",
    iconKey: "route",
    recommendation: "Contact the rider and inspect the delivery route immediately.",
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
  delivery_completed: {
    display: "Delivery Completed",
    iconKey: "check",
    recommendation: "No further action required.",
  },
};

function formatRelativeTime(timestamp) {
  if (!timestamp?.toDate) return "Just now";
  const mins = Math.floor((Date.now() - timestamp.toDate().getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

function normalizeAlert(raw) {
  const mapped = TYPE_MAP[raw.type] || {
    display: raw.title || raw.type || "Alert",
    iconKey: null,
    recommendation: "",
  };
  return {
    id: raw.id,
    type: mapped.display,
    message: raw.message || "",
    source: raw.deliveryId || raw.orderId || "System",
    deliveryId: raw.deliveryId || "",
    rider: raw.riderName || "System",
    severity: raw.severity || "notice",
    status: raw.status || "active",
    time: formatRelativeTime(raw.createdAt),
    iconKey: mapped.iconKey,
    recommendation: raw.recommendation || mapped.recommendation,
    read: raw.read || false,
  };
}

function Alerts() {

  const [alerts, setAlerts] = useState([]);
  // Loading and failure are their own states: an empty list must mean "no
  // alerts", never "not loaded yet" or "not allowed to read".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  // The OPEN alert is looked up in the live list by id, so the dialog shows
  // what is stored now — resolved or read in another browser included.
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  // "Mark resolved" is confirmed first; the write runs from that dialog.
  const [confirmResolveId, setConfirmResolveId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const { toast, showToast, dismissToast } = useToast();
  const [markingAll, setMarkingAll] = useState(false);
  const markingAllRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeAllAlerts(
      (raw) => {
        setAlerts(raw.map(normalizeAlert));
        setLoadError("");
        setLoading(false);
      },
      (error) => {
        setLoadError(liveErrorMessage(error, "alerts"));
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const selectedAlert = selectedAlertId ? alerts.find((a) => a.id === selectedAlertId) ?? null : null;
  // Deleted while open: the dialog closes and says why, instead of showing a
  // record that no longer exists.
  const selectedGone = Boolean(selectedAlertId) && !loading && !loadError && !selectedAlert;


  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      const searchValue =
        `${alert.type} ${alert.message} ${alert.source} ${alert.deliveryId} ${alert.rider} ${alert.severity} ${alert.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());

      const matchesFilter =
        severityFilter === "all" ||
        (severityFilter === "resolved" && alert.status === "resolved") ||
        (severityFilter !== "resolved" &&
          alert.status !== "resolved" &&
          alert.severity === severityFilter);

      return matchesSearch && matchesFilter;
    });
  }, [alerts, searchTerm, severityFilter]);

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
    const unread = alerts.filter((a) => !a.read);
    if (unread.length === 0) {
      showToast("There are no unread alerts.", "info");
      return;
    }
    markingAllRef.current = true;
    setMarkingAll(true);
    try {
      const results = await Promise.allSettled(unread.map((a) => markAlertRead(a.id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed === 0) {
        showToast(`${unread.length} ${unread.length === 1 ? "alert" : "alerts"} marked as read.`, "success");
      } else if (failed === unread.length) {
        showToast("No alerts could be marked as read. Check your connection and try again.", "error");
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

  const categoryCounts = {
    route: alerts.filter(
      (alert) => alert.status !== "resolved" && alert.type === "Route Deviation"
    ).length,
    inventory: alerts.filter(
      (alert) => alert.status !== "resolved" && alert.type === "Low Stock"
    ).length,
    delivery: alerts.filter((alert) => alert.type.includes("Delivery")).length,
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
              Review route deviations, stock issues, and delivery notifications.
            </small>
          </div>

          <div className="alerts-v2-actions">
            <button
              type="button"
              className="alerts-outline-btn"
              onClick={handleMarkAllRead}
              disabled={markingAll}
              aria-busy={markingAll}
            >
              <CheckCircle2 size={16} />
              Mark All Read
            </button>

            <button
              type="button"
              className="alerts-blue-btn"
              onClick={() => setShowSettings(true)}
            >
              <Bell size={16} />
              Alert delivery
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
            label="Resolved today"
            value={kpi(resolvedCount)}
            context="Completed alerts"
            tone="success"
            onClick={() => setSeverityFilter("resolved")}
          />
        </section>

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
                  placeholder="Search alert type, rider, batch, delivery ID..."
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
                onClick={() => setSeverityFilter("resolved")}
              >
                Resolved
              </button>
            </div>

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
                      <h3>{alert.type}</h3>
                      <span>{getSeverityLabel(alert)}</span>
                    </div>

                    <p>{alert.message}</p>

                    <div className="alert-row-meta">
                      <small>{alert.id}</small>
                      <small>{alert.source}</small>
                      <small>{alert.time}</small>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="alert-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReviewAlert(alert);
                    }}
                  >
                    Review
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
                <p>System areas being monitored</p>
              </div>

              <div className="alert-category-stack">
                <CategoryItem
                  icon={<Route size={18} />}
                  title="Route Deviation"
                  count={`${categoryCounts.route} active`}
                  type="red"
                  onClick={() => {
                    setSearchTerm("Route Deviation");
                    setSeverityFilter("all");
                  }}
                />

                <CategoryItem
                  icon={<Package size={18} />}
                  title="Inventory Warning"
                  count={`${categoryCounts.inventory} active`}
                  type="blue"
                  onClick={() => {
                    setSearchTerm("Low Stock");
                    setSeverityFilter("all");
                  }}
                />

                <CategoryItem
                  icon={<Truck size={18} />}
                  title="Delivery Status"
                  count={`${categoryCounts.delivery} updates`}
                  type="green"
                  onClick={() => {
                    setSearchTerm("Delivery");
                    setSeverityFilter("all");
                  }}
                />
              </div>
            </div>

            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Priority Action</h2>
                <p>Most urgent alert to review</p>
              </div>

              {priorityAlert ? (
                <div className={`priority-alert-card ${getAlertClass(priorityAlert)}`}>
                  <div>{getAlertIcon(priorityAlert.iconKey)}</div>

                  <h3>{priorityAlert.type}</h3>
                  <p>{priorityAlert.message}</p>

                  <button type="button" onClick={() => handleReviewAlert(priorityAlert)}>
                    <MapPin size={15} />
                    Review Alert
                  </button>
                </div>
              ) : (
                <div className="priority-alert-card resolved">
                  <div>
                    <CheckCircle2 size={24} />
                  </div>

                  <h3>No active priority alert</h3>
                  <p>All critical alerts are currently resolved.</p>
                </div>
              )}
            </div>
          </aside>
        </section>
      </main>

      {selectedAlert && (
        <AlertReviewModal
          alert={selectedAlert}
          onClose={() => setSelectedAlertId(null)}
          onResolve={() => setConfirmResolveId(selectedAlert.id)}
        />
      )}

      {confirmResolveId && selectedAlert && (
        <ConfirmDialog
          title="Mark alert as resolved?"
          target={`${selectedAlert.type} · ${selectedAlert.deliveryId || selectedAlert.source || selectedAlert.id}`}
          consequence="It moves to the resolved list and stops counting as an open alert. Resolved alerts cannot be reopened from VaxTrack."
          confirmLabel="Mark resolved"
          busyLabel="Resolving…"
          tone="primary"
          failureMessage="The alert could not be resolved. It is still open — please try again."
          onConfirm={handleResolveAlert}
          onCancel={() => setConfirmResolveId(null)}
        />
      )}

      {showSettings && (
        <AlertChannelsModal onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

function CategoryItem({ icon, title, count, type, onClick }) {
  return (
    <button type="button" className={`alert-category-item ${type}`} onClick={onClick}>
      <div>{icon}</div>

      <section>
        <strong>{title}</strong>
        <p>{count}</p>
      </section>
    </button>
  );
}

function AlertReviewModal({ alert, onClose, onResolve }) {
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

        <h2 id="alert-review-title">{alert.type}</h2>
        <p>{alert.message}</p>

        <div className="alerts-modal-grid">
          <div>
            <span>Severity</span>
            <strong>{getSeverityLabel(alert)}</strong>
          </div>

          <div>
            <span>Status</span>
            <strong>{alert.status === "resolved" ? "Resolved" : "Needs Review"}</strong>
          </div>

          <div>
            <span>Alert ID</span>
            <strong>{alert.id}</strong>
          </div>

          <div>
            <span>Source</span>
            <strong>{alert.source}</strong>
          </div>

          <div>
            <span>Rider / Module</span>
            <strong>{alert.rider}</strong>
          </div>

          <div>
            <span>Time</span>
            <strong>{alert.time}</strong>
          </div>

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

          {/* Not built yet. Shown disabled, with the reason, rather than
              clickable with a toast that implies something happened. */}
          <button type="button" className="alerts-light-action" disabled aria-describedby="alert-unavailable-actions">
            <PhoneCall size={15} aria-hidden="true" />
            Contact Rider
          </button>

          <button type="button" className="alerts-light-action" disabled aria-describedby="alert-unavailable-actions">
            <MapPin size={15} aria-hidden="true" />
            View Route
          </button>

          <button type="button" className="alerts-light-action" onClick={onClose}>
            Close
          </button>
        </div>
        <p id="alert-unavailable-actions" className="alerts-unavailable-note">
          Calling a rider and viewing their route from an alert aren't available yet. Use Live Tracking
          for positions and the rider's registered phone number to call.
        </p>
      </div>
    </div>
  );
}

/**
 * How alerts actually reach an admin — stated, not configured.
 *
 * This was an editable form with six toggles and a "Save Settings" button that
 * reported "Alert settings saved." Nothing in the app ever read
 * `alertSettings`, no service wrote it, and no Firestore field or localStorage
 * key existed for it: every toggle was inert and the confirmation was false.
 * Two of them ("Push notifications", "Email notifications") offered to
 * configure delivery channels the system does not have at all.
 *
 * Persisting the preferences instead would only have moved the lie from the
 * toast into the database — a stored `email: true` that nothing reads is still
 * a promise the system cannot keep. So the form is gone and what remains is a
 * read-only statement of which channels exist. Building the channels
 * themselves (FCM, email) is separate work and is deliberately not done here.
 */
function AlertChannelsModal({ onClose }) {
  const channels = [
    {
      key: "in-app",
      available: true,
      title: "In-app alerts",
      description:
        "Read live from Firestore and shown here and on the dashboard for admins and dispatchers. Always on — there is nothing to switch.",
    },
    {
      key: "push",
      available: false,
      title: "Push notifications",
      description:
        "Not configured. There is no push messaging channel, so alerts do not reach a device while the dashboard is closed.",
    },
    {
      key: "email",
      available: false,
      title: "Email notifications",
      description: "Not configured. No alert summaries are sent by email.",
    },
  ];

  return (
    <div className="alerts-modal-backdrop">
      <div
        className="alerts-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-channels-title"
      >
        <button type="button" className="alerts-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className="alerts-modal-icon settings">
          <Settings size={24} />
        </div>

        <h2 id="alert-channels-title">Alert delivery</h2>
        <p>Where alerts are delivered today. These are not settings — there is nothing to switch on.</p>

        <div className="alerts-settings-list">
          {channels.map(({ key, available, title, description }) => (
            <div className="alerts-setting-row" key={key}>
              <div>
                <strong>{title}</strong>
                <p>{description}</p>
              </div>

              {/* A status word, not a control. Green for what works, neutral
                  for what does not exist — never a toggle an admin could flip
                  believing it changed something. */}
              <span className={`alerts-channel-state ${available ? "on" : "off"}`}>
                {available ? "Available" : "Not configured"}
              </span>
            </div>
          ))}
        </div>

        <div className="alerts-modal-actions">
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