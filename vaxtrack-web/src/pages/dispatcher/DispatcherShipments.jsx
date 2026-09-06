import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Package, X } from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import {
  cancelOrderByDispatcher,
  MAX_CANCEL_REASON_LENGTH,
  reassignFailedOrder,
} from "../../services/orderService";
import { subscribeRiders } from "../../services/riderService";
import { ACTOR_DISPATCHER, canTransition } from "../../services/orderWorkflow";
import DispatcherLayout from "./DispatcherLayout";
import StatusBadge from "../../components/ui/StatusBadge";
import KpiCard from "../../components/ui/KpiCard";

// A local status-label copy used to live here for the status-change toasts.
// Those toasts are gone with the Delivered/Delay/Resume actions, and the
// canonical labels now come from the shared policy (orderWorkflow.STATUS_LABELS)
// so there is one place to correct them.

// Shipments is a monitoring surface. Cargo Loading is the canonical route for
// assigned → loading → in_transit, so "Start loading" and "Dispatch" have long
// been absent here.
//
// "Mark delivered (override)", "Delay" and "Resume transit" are now gone too.
// Delivering, delaying and resuming belong to the assigned rider who is
// actually carrying the order — a dispatcher marking an order delivered from a
// desk records an observation nobody made. Removing the buttons is only half
// of it: the service they called has been replaced as well, so there is no
// reachable path left for a dispatcher to perform a rider transition.
//
// Cancellation is the one status change a dispatcher still owns here, and it
// now requires a reason. The decision is derived from the shared policy rather
// than restated, so this page cannot drift from the matrix the services and
// rules enforce.
function canCancel(statusKey) {
  return canTransition(ACTOR_DISPATCHER, statusKey, "cancelled").ok;
}

// Recovery. Only a failed delivery can go back to `assigned`, so this is true
// for `delivery_failed` and nothing else — again derived from the policy rather
// than restated as a status literal.
function canReassign(statusKey) {
  return canTransition(ACTOR_DISPATCHER, statusKey, "assigned").ok;
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function DispatcherShipments() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState("success");
  const [updating, setUpdating] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");

  useEffect(() => {
    const unsub = subscribeDeliveries(
      (all) => {
        setOrders(all);
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view shipments.");
        } else {
          setError("Unable to load shipments.");
        }
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const grouped = useMemo(() => {
    const assigned = orders.filter((o) => o.statusKey === "assigned");
    const loadingO = orders.filter((o) => o.statusKey === "loading");
    const transit = orders.filter((o) => o.statusKey === "in_transit");
    const delayed = orders.filter((o) => o.statusKey === "delayed");
    // Failed deliveries are the dispatcher's queue: nothing moves until they
    // retry or cancel, so they get their own group and are counted as active.
    const failed = orders.filter((o) => o.statusKey === "delivery_failed");
    const delivered = orders.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed");
    const cancelled = orders.filter((o) => o.statusKey === "cancelled" || o.statusKey === "canceled");
    return { assigned, loading: loadingO, transit, delayed, failed, delivered, cancelled };
  }, [orders]);

  const activeOrders = useMemo(() => {
    if (filterStatus === "active") {
      return [
        ...grouped.failed,
        ...grouped.assigned,
        ...grouped.loading,
        ...grouped.transit,
        ...grouped.delayed,
      ];
    }
    if (filterStatus === "assigned") return grouped.assigned;
    if (filterStatus === "loading") return grouped.loading;
    if (filterStatus === "in_transit") return grouped.transit;
    if (filterStatus === "delayed") return grouped.delayed;
    if (filterStatus === "delivery_failed") return grouped.failed;
    if (filterStatus === "delivered") return grouped.delivered;
    if (filterStatus === "cancelled") return grouped.cancelled;
    return orders;
  }, [filterStatus, grouped, orders]);

  // The order awaiting cancellation confirmation, plus the control that opened
  // the dialog so focus can be handed back to it.
  const [cancelTarget, setCancelTarget] = useState(null);
  const cancelTriggerRef = useRef(null);

  const openCancelDialog = (order, triggerEl) => {
    cancelTriggerRef.current = triggerEl;
    setCancelTarget(order);
  };

  const closeCancelDialog = useCallback(() => {
    setCancelTarget(null);
    if (cancelTriggerRef.current) {
      cancelTriggerRef.current.focus();
      cancelTriggerRef.current = null;
    }
  }, []);

  // Recovery of a failed delivery.
  const [reassignTarget, setReassignTarget] = useState(null);
  const reassignTriggerRef = useRef(null);

  const openReassignDialog = (order, triggerEl) => {
    reassignTriggerRef.current = triggerEl;
    setReassignTarget(order);
  };

  const closeReassignDialog = useCallback(() => {
    setReassignTarget(null);
    if (reassignTriggerRef.current) {
      reassignTriggerRef.current.focus();
      reassignTriggerRef.current = null;
    }
  }, []);

  const handleConfirmReassign = async (order, riderUid) => {
    setUpdating(order.id);
    setToast("");
    try {
      // A dedicated recovery entry point — NOT the normal assignment service,
      // which only ever accepts `pending_dispatch`. It re-reads the order and
      // the rider inside its own transaction and preserves the failure record.
      const result = await reassignFailedOrder(order.id, riderUid);
      closeReassignDialog();
      showToast(
        `Order ${order.orderNumber || order.id} reassigned to ${result.assignedRiderName || "the selected rider"}.`,
        "success"
      );
    } catch (err) {
      console.error("Reassign failed order error:", err);
      showToast(err.message || "Failed to reassign order.", "error");
      throw err; // keeps the dialog open and releases its guard
    } finally {
      setUpdating("");
    }
  };

  const handleConfirmCancel = async (order, reason) => {
    setUpdating(order.id);
    setToast("");
    try {
      // The service trims and re-validates the reason and re-reads the order
      // inside its transaction; this page is not the authority on either.
      await cancelOrderByDispatcher(order.id, reason);
      closeCancelDialog();
      showToast(
        `Order ${order.orderNumber || order.id} cancelled.`,
        "success"
      );
    } catch (err) {
      console.error("Cancel order error:", err);
      // WorkflowError messages are already phrased for the operator.
      showToast(err.message || "Failed to cancel order.", "error");
      throw err; // lets the dialog keep itself open and release its guard
    } finally {
      setUpdating("");
    }
  };

  const showToast = (msg, type) => {
    setToast(msg);
    setToastType(type);
  };

  const totalActive =
    grouped.assigned.length +
    grouped.loading.length +
    grouped.transit.length +
    grouped.delayed.length +
    grouped.failed.length;
  const totalDone = grouped.delivered.length;

  const FILTERS = [
    { id: "active", label: "Active", count: totalActive },
    { id: "assigned", label: "Assigned", count: grouped.assigned.length },
    { id: "loading", label: "Loading", count: grouped.loading.length },
    { id: "in_transit", label: "In transit", count: grouped.transit.length },
    { id: "delayed", label: "Delayed", count: grouped.delayed.length },
    { id: "delivery_failed", label: "Delivery failed", count: grouped.failed.length },
    { id: "delivered", label: "Delivered", count: totalDone },
    { id: "cancelled", label: "Cancelled", count: grouped.cancelled.length },
  ];

  if (loading) {
    return (
      <DispatcherLayout active="shipments" title="Shipments">
        <div className="shp-state">
          <Loader2 size={30} className="spin" />
          <p>Loading shipments...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="shipments" title="Shipments">
        <div className="shp-state">
          <span className="shp-state-icon">
            <AlertTriangle size={18} />
          </span>
          <strong>Could not load shipments</strong>
          <p>{error}</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="shipments" title="Shipments">
      <div className="shp-page">
        <header className="shp-header">
          <h2 className="disp-section-title">Shipment queue</h2>
          <p>Track and update the status of assigned shipments.</p>
        </header>

        <section className="shp-kpis">
          <KpiCard label="Active" value={totalActive} context="In progress" tone="neutral" />
          <KpiCard label="In transit" value={grouped.transit.length} context="On the road" tone="info" />
          <KpiCard
            label="Delayed"
            value={grouped.delayed.length}
            context={grouped.delayed.length > 0 ? "Needs attention" : "None delayed"}
            tone="danger"
            attention={grouped.delayed.length > 0}
          />
          <KpiCard label="Delivered" value={totalDone} context="Completed" tone="success" />
        </section>

        {toast && (
          <div className={`shp-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{toast}</span>
            <button type="button" onClick={() => setToast("")} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="shp-filterbar">
          <div className="shp-segmented">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`shp-segment ${filterStatus === f.id ? "active" : ""}`}
                onClick={() => setFilterStatus(f.id)}
              >
                {f.label} · {f.count}
              </button>
            ))}
          </div>
        </div>

        <section className="shp-card">
          {activeOrders.length === 0 ? (
            <div className="shp-empty">
              <span className="shp-empty-icon">
                <Package size={18} />
              </span>
              <strong>No shipments match this filter</strong>
              <p>Try a different status filter above.</p>
            </div>
          ) : (
            <div className="shp-table-wrap">
              <table className="shp-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Destination</th>
                    <th>Vaccine</th>
                    <th>Rider</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeOrders.map((order) => (
                    <ShipmentRow
                      key={order.id}
                      order={order}
                      updating={updating === order.id}
                      onRequestCancel={openCancelDialog}
                      onRequestReassign={openReassignDialog}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {cancelTarget && (
        <CancelOrderDialog
          order={cancelTarget}
          onDismiss={closeCancelDialog}
          onConfirm={handleConfirmCancel}
        />
      )}

      {reassignTarget && (
        <ReassignFailedOrderDialog
          order={reassignTarget}
          onDismiss={closeReassignDialog}
          onConfirm={handleConfirmReassign}
        />
      )}
    </DispatcherLayout>
  );
}

/**
 * Choose an approved rider to carry a failed delivery again.
 *
 * The same rider may be picked (a retry) or a different one (a reassignment).
 * Only approved riders are listed, and only their document UID is ever sent —
 * employee id is display-only, exactly as on the assignment page. The service
 * re-reads and re-validates the rider regardless of what this list shows.
 */
function ReassignFailedOrderDialog({ order, onDismiss, onConfirm }) {
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  const titleId = "reassign-order-title";
  const descId = "reassign-order-desc";
  const errorId = "reassign-order-error";

  useEffect(() => {
    const unsubscribe = subscribeRiders(
      (list) => {
        setRiders(list);
        setLoading(false);
        setLoadError("");
      },
      (err) => {
        setLoadError(
          err?.code === "permission-denied"
            ? "No permission to view riders."
            : "Unable to load riders."
        );
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), select, input, [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onDismiss]);

  const approvedRiders = riders.filter((r) => r.status === "approved");

  const submit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!selected) {
      setError("Please choose an approved rider.");
      firstFieldRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(order, selected);
    } catch {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="shp-dialog-backdrop" onMouseDown={onDismiss}>
      <div
        className="shp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shp-dialog-head">
          <h2 id={titleId}>Retry failed delivery</h2>
          <button
            type="button"
            className="shp-dialog-close"
            aria-label="Close without reassigning the order"
            onClick={onDismiss}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p id={descId} className="shp-dialog-desc">
          Order {order.orderNumber || order.id} for {order.clinicName || "this clinic"} failed
          {order.deliveryFailureReason ? `: "${order.deliveryFailureReason}"` : "."} Choosing a
          rider sends it back to Assigned, and it passes through Cargo Loading again.
        </p>

        <form onSubmit={submit}>
          <label htmlFor="reassign-rider">Rider</label>
          {loading ? (
            <p className="shp-muted">Loading riders...</p>
          ) : loadError ? (
            <p className="shp-dialog-error" role="alert">{loadError}</p>
          ) : approvedRiders.length === 0 ? (
            <p className="shp-dialog-error" role="alert">
              No approved riders are available.
            </p>
          ) : (
            <select
              id="reassign-rider"
              ref={firstFieldRef}
              value={selected}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? "true" : undefined}
              onChange={(e) => {
                setSelected(e.target.value);
                if (error) setError("");
              }}
            >
              <option value="">Select an approved rider...</option>
              {approvedRiders.map((r) => (
                // The VALUE is the document uid — the assignment identity.
                <option key={r.uid} value={r.uid}>
                  {r.fullName || r.name || r.displayName || r.email}
                  {r.uid === order.assignedRiderId ? " (same rider — retry)" : ""}
                </option>
              ))}
            </select>
          )}

          <div aria-live="assertive">
            {error && (
              <p id={errorId} role="alert" className="shp-dialog-error">
                {error}
              </p>
            )}
          </div>

          <div className="shp-dialog-actions">
            <button type="button" className="shp-act-btn" onClick={onDismiss}>
              Keep as failed
            </button>
            <button
              type="submit"
              className="shp-act-btn primary"
              disabled={submitting || loading || approvedRiders.length === 0}
            >
              {submitting && <Loader2 size={12} className="spin" aria-hidden="true" />}
              {submitting ? "Reassigning..." : "Reassign order"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Confirm-with-reason dialog for cancelling an order.
 *
 * Deliberately not `window.prompt`: that is unstyled, unlabelled, cannot be
 * validated before it closes, and is invisible to the page's own error
 * handling. This is a real dialog — labelled, focus-contained, Escape-closable,
 * and it hands focus back to the control that opened it.
 *
 * Dismissing changes nothing, and confirming with an empty or whitespace-only
 * reason performs no write at all: the guard here is for the operator's benefit,
 * and the service and the Firestore rules each re-check the reason
 * independently.
 */
function CancelOrderDialog({ order, onDismiss, onConfirm }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const dialogRef = useRef(null);
  const reasonRef = useRef(null);

  const titleId = "cancel-order-title";
  const descId = "cancel-order-desc";
  const errorId = "cancel-order-error";

  // Focus the reason field on open, keep Tab inside the dialog, and close on
  // Escape. Background scrolling is locked while it is open.
  useEffect(() => {
    reasonRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), textarea, input, [href], select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onDismiss]);

  const submit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;

    const trimmed = reason.trim();
    if (trimmed === "") {
      setError("Please give a reason for cancelling this order.");
      reasonRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_CANCEL_REASON_LENGTH) {
      setError(`Please keep the reason under ${MAX_CANCEL_REASON_LENGTH} characters.`);
      reasonRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(order, trimmed);
    } catch {
      // The page has already surfaced the message in its toast; keep the
      // dialog open so the operator can retry or dismiss.
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="shp-dialog-backdrop" onMouseDown={onDismiss}>
      <div
        className="shp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shp-dialog-head">
          <h2 id={titleId}>Cancel order</h2>
          <button
            type="button"
            className="shp-dialog-close"
            aria-label="Close without cancelling the order"
            onClick={onDismiss}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p id={descId} className="shp-dialog-desc">
          Order {order.orderNumber || order.id} for {order.clinicName || "this clinic"} will
          be cancelled. This cannot be undone.
        </p>

        <form onSubmit={submit}>
          <label htmlFor="cancel-reason">Reason for cancellation</label>
          <textarea
            id="cancel-reason"
            ref={reasonRef}
            rows={3}
            value={reason}
            maxLength={MAX_CANCEL_REASON_LENGTH}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? "true" : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError("");
            }}
            placeholder="e.g. Clinic closed for the day"
          />

          <div aria-live="assertive">
            {error && (
              <p id={errorId} role="alert" className="shp-dialog-error">
                {error}
              </p>
            )}
          </div>

          <div className="shp-dialog-actions">
            <button type="button" className="shp-act-btn" onClick={onDismiss}>
              Keep order
            </button>
            <button type="submit" className="shp-act-btn danger" disabled={submitting}>
              {submitting && <Loader2 size={12} className="spin" aria-hidden="true" />}
              {submitting ? "Cancelling..." : "Cancel order"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ShipmentRow({ order, updating, onRequestCancel, onRequestReassign }) {
  const sKey = order.statusKey;
  const cancellable = canCancel(sKey);
  const reassignable = canReassign(sKey);
  const isDelayed = sKey === "delayed" || sKey === "delivery_failed";

  const riderName = order.assignedRiderName || "Unassigned";
  const riderPhone = order.assignedRiderPhone || "";
  const orderNum = order.orderNumber || order.id;
  const vaccine = order.vaccineName || "—";
  const clinic = order.clinicName || "—";
  const address = order.clinicAddress || "";
  const qty = order.quantity || 0;
  const unit = order.unit || "vials";
  const updated = formatTime(order.updatedAt || order.assignedAt || order.createdAt);

  return (
    <tr className={isDelayed ? "shp-row-delayed" : ""}>
      <td>
        <span className="shp-order-id">{orderNum}</span>
      </td>
      <td>
        <div className="shp-cell">
          <strong>{clinic}</strong>
          {address && <small>{address}</small>}
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong>{vaccine}</strong>
          <small className="tnum">{qty.toLocaleString()} {unit}</small>
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong className={riderName === "Unassigned" ? "shp-muted" : ""}>{riderName}</strong>
          {riderPhone && <small>{riderPhone}</small>}
        </div>
      </td>
      <td>
        <StatusBadge statusKey={sKey} />
      </td>
      <td className="shp-td-meta">{updated}</td>
      <td>
        {cancellable || reassignable ? (
          <div className="shp-actions">
            {reassignable && (
              <button
                type="button"
                className="shp-act-btn primary"
                disabled={updating}
                onClick={(e) => onRequestReassign(order, e.currentTarget)}
              >
                Retry / Reassign
              </button>
            )}
            {cancellable && (
              <button
                type="button"
                className="shp-act-btn danger"
                disabled={updating}
                onClick={(e) => onRequestCancel(order, e.currentTarget)}
              >
                Cancel order
              </button>
            )}
          </div>
        ) : (
          <span className="shp-muted">—</span>
        )}
      </td>
    </tr>
  );
}

export default DispatcherShipments;
