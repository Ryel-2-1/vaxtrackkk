import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bike,
  CheckCircle2,
  Loader2,
  MapPin,
  Package,
  Phone,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { assignRiderToOrder, getOrderById, subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeRiders } from "../../services/riderService";
import { dispatchEligibility } from "../../services/dispatchEligibility";
import { assignmentBlockReason } from "../../services/backorder";
import { normalizeStatusKey } from "../../services/deliveryService";
import {
  QUEUE_FILTERS,
  buildAssignmentQueue,
  createAssignmentRunner,
  goneOrderMessage,
  pageOf,
} from "../../services/assignmentQueue";
import useManilaDayNow from "../../components/useManilaDayNow";
// `auth` is no longer imported here: the dispatcher's audit identity is taken
// from the session inside assignRiderToOrder, so this page cannot supply — or
// mis-supply — who performed the assignment.
import StatusBadge from "../../components/ui/StatusBadge";
import "./DispatcherAssignRider.css";
import { liveErrorMessage } from "../../services/liveDataErrors";

function initialsOf(name) {
  return (
    (name || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

const getRiderName = (r) => r.fullName || r.name || r.displayName || r.email || "Unknown";
const getRiderVehicle = (r) => r.vehiclePlate || r.motorcycle || r.motorcycleId || r.vehicle || "Motorcycle";
const getRiderPhone = (r) => r.phone || r.contactNumber || "";
// Employee id is display-only, and only when the rider actually has one. The
// rider's Auth UID is never displayed; it is only the assignment identity.
const getRiderEmployeeId = (r) => r.employeeId || "";

/**
 * Dispatcher › Assign Rider.
 *
 * A live queue of orders waiting for a rider (subscribePendingDispatchOrders —
 * an assignment here or in another browser removes the order from the next
 * snapshot, with no reload). "Assign rider" opens a dialog; confirming runs
 * the transactional, server-validated assignRiderToOrder once, closes the
 * dialog and says so — and the page stays exactly where it was: same search,
 * filter, page and scroll. Nothing on this page navigates after an assignment.
 *
 * The Dashboard's "Assign Rider" hands one order over (localStorage); this page
 * opens its dialog, and the queue stays underneath.
 */
function DispatcherAssignRider() {
  const navigate = useNavigate();
  const now = useManilaDayNow();

  const [orders, setOrders] = useState(null); // null until the first snapshot
  const [ordersError, setOrdersError] = useState("");
  const [riders, setRiders] = useState([]);
  const [ridersLoading, setRidersLoading] = useState(true);
  const [ridersError, setRidersError] = useState("");

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  // The Dashboard hand-off, read once (navigation state only — the
  // assignment re-reads and re-validates the order in its transaction).
  const [dialogOrderId, setDialogOrderId] = useState(() => {
    try {
      return localStorage.getItem("selectedDispatchOrderId") || null;
    } catch {
      return null;
    }
  });
  const [selectedRiderId, setSelectedRiderId] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [goneInfo, setGoneInfo] = useState(null); // { id, status } of an order that left the queue
  const [toast, setToast] = useState(null); // { message, type }
  // One assignment at a time; a second click before React re-renders is refused.
  const [runner] = useState(() => createAssignmentRunner(assignRiderToOrder));
  // Stable, so the dialog is focused once when it opens (for Escape), not on
  // every re-render.
  const focusOnOpen = useCallback((el) => el?.focus(), []);

  // The hand-off is consumed once; a later visit starts from the queue.
  useEffect(() => {
    try {
      localStorage.removeItem("selectedDispatchOrderId");
      localStorage.removeItem("selectedDispatchOrder");
    } catch {
      // storage unavailable — nothing to clear
    }
  }, []);

  // Live subscriptions, created once and removed on unmount (sign-out and a
  // role change unmount this page through the route guard).
  useEffect(() => {
    const unsubOrders = subscribePendingDispatchOrders(
      (list) => {
        setOrders(list);
        setOrdersError("");
      },
      (err) => setOrdersError(liveErrorMessage(err, "the dispatch queue"))
    );
    const unsubRiders = subscribeRiders(
      (riderList) => {
        setRiders(riderList);
        setRidersLoading(false);
        setRidersError("");
      },
      (err) => {
        setRidersError(liveErrorMessage(err, "riders"));
        setRidersLoading(false);
      }
    );
    return () => {
      unsubOrders();
      unsubRiders();
    };
  }, []);

  const queue = useMemo(
    () => buildAssignmentQueue({ orders: orders || [], now, search, filter }),
    [orders, now, search, filter]
  );
  const { rows, page: currentPage, pageCount } = pageOf(queue, page);

  // The dialog's order is always the LIVE pending order; once the snapshot no
  // longer has it, it cannot be assigned from here.
  const selectedOrder = dialogOrderId && orders ? orders.find((o) => o.id === dialogOrderId) || null : null;
  // Not while our own assignment is pending: its snapshot may land before the
  // call resolves, and that is a success, not an order taken elsewhere.
  const dialogGone = Boolean(dialogOrderId) && orders !== null && !selectedOrder && !saving;

  // Why it left (assigned elsewhere, or cancelled) — one read of that order.
  useEffect(() => {
    if (!dialogGone) return undefined;
    let active = true;
    getOrderById(dialogOrderId)
      .then((o) => active && setGoneInfo({ id: dialogOrderId, status: o?.status ?? null }))
      .catch(() => active && setGoneInfo({ id: dialogOrderId, status: null }));
    return () => {
      active = false;
    };
  }, [dialogGone, dialogOrderId]);

  const approvedRiders = riders.filter((r) => r.status === "approved");
  const selectedRider = approvedRiders.find((r) => r.uid === selectedRiderId) || null;
  // A scheduled order is not assignable before 00:00 Manila on its date, and a
  // future order waits until it is fully reserved (no partial dispatch). The
  // transaction and the rules refuse both regardless; this says so first.
  const schedule = selectedOrder ? dispatchEligibility(selectedOrder, now) : null;
  const scheduleBlocked = !!schedule && !schedule.eligible;
  const stockBlock = selectedOrder ? assignmentBlockReason(selectedOrder) : null;
  const canAssign =
    !saving && !!selectedRiderId && !!selectedRider && !!selectedOrder && !scheduleBlocked && !stockBlock;

  const openDialog = (orderId) => {
    setDialogOrderId(orderId);
    setSelectedRiderId("");
    setDialogError("");
    setGoneInfo(null);
  };
  const closeDialog = () => {
    if (saving) return;
    setDialogOrderId(null);
    setSelectedRiderId("");
    setDialogError("");
    setGoneInfo(null);
  };

  const handleConfirmAssignment = async () => {
    if (!canAssign) return;
    setSaving(true);
    setDialogError("");
    const outcome = await runner.run(selectedOrder.id, selectedRider.uid);
    if (outcome.busy) return; // a click while the first is pending: ignored
    setSaving(false);
    if (outcome.ok) {
      // Stay here. The live snapshot removes the order from the queue.
      setDialogOrderId(null);
      setSelectedRiderId("");
      setToast({ message: outcome.message, type: "success" });
      return;
    }
    if (outcome.conflict) {
      setDialogOrderId(null);
      setSelectedRiderId("");
      setToast({ message: outcome.message, type: "error" });
      return;
    }
    // Keep the dialog open with the reason; the operator can retry or pick
    // another rider.
    setDialogError(outcome.message);
  };

  const goneMessage = dialogGone ? goneOrderMessage(goneInfo?.id === dialogOrderId ? goneInfo.status : undefined) : null;

  return (
    <>
      <div className="ar-page">
        <header className="ar-header">
          <button
            type="button"
            className="ar-back"
            onClick={() => navigate("/dispatcher")}
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h2 className="disp-section-title">Rider assignment</h2>
            <p>Orders waiting for a rider · updates live</p>
          </div>
        </header>

        {toast && (
          <div
            className={`ar-toast ${toast.type === "error" ? "error" : ""}`}
            role={toast.type === "error" ? "alert" : "status"}
            aria-live={toast.type === "error" ? "assertive" : "polite"}
          >
            {toast.type === "error" ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            <span>{toast.message}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss message">
              <X size={14} />
            </button>
          </div>
        )}

        {goneMessage && (
          <div className="ar-toast error" role="status" aria-live="polite">
            <AlertTriangle size={16} />
            <span>{goneMessage}</span>
            <button type="button" onClick={closeDialog} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        <section className="ar-card arq-card">
          <div className="arq-toolbar">
            <label className="arq-search">
              <Search size={15} aria-hidden="true" />
              <span className="arq-sr">Search orders</span>
              <input
                type="search"
                value={search}
                placeholder="Search order, clinic, doctor or vaccine"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <div className="arq-filters" role="group" aria-label="Filter orders">
              {QUEUE_FILTERS.map((f) => (
                <button
                  type="button"
                  key={f.key}
                  className={`arq-filter${filter === f.key ? " active" : ""}`}
                  aria-pressed={filter === f.key}
                  onClick={() => {
                    setFilter(f.key);
                    setPage(1);
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {ordersError ? (
            <div className="ar-state" role="alert">
              <span className="ar-state-icon">
                <AlertTriangle size={18} />
              </span>
              <strong>Could not load the queue</strong>
              <p>{ordersError}</p>
            </div>
          ) : orders === null ? (
            <div className="ar-state" role="status">
              <Loader2 size={22} className="spin" />
              <p>Loading orders…</p>
            </div>
          ) : queue.length === 0 ? (
            <div className="ar-state">
              <span className="ar-state-icon">
                <Package size={18} />
              </span>
              <strong>{search || filter !== "all" ? "No orders match" : "No orders are waiting for a rider"}</strong>
              <p>{search || filter !== "all" ? "Try another search or filter." : "New orders appear here as soon as they are ready for dispatch."}</p>
            </div>
          ) : (
            <>
              <ul className="arq-list">
                {rows.map((o) => (
                  <li key={o.id} className="arq-row">
                    <div className="arq-row-main">
                      <strong className="arq-order tnum" title={o.orderNumber || o.id}>{o.orderNumber || o.id}</strong>
                      {(o.priority || "").toLowerCase() === "urgent" && <span className="arq-tag urgent">Urgent</span>}
                      {o.dateKind === "overdue" && <span className="arq-tag overdue">Overdue</span>}
                      {o.dateKind === "today" && <span className="arq-tag">Due today</span>}
                    </div>
                    <p className="arq-row-meta">
                      <span title={o.clinicName}>{o.clinicName || "—"}</span>
                      <span>
                        {o.vaccineName || "—"} · <span className="tnum">{o.quantity || 0}</span> {o.unit || "vials"}
                      </span>
                    </p>
                    {o.stockBlock && <p className="arq-hold">{o.stockBlock}</p>}
                    <button
                      type="button"
                      className="ar-btn ar-btn-primary arq-assign"
                      onClick={() => openDialog(o.id)}
                      disabled={Boolean(o.stockBlock)}
                    >
                      <UserPlus size={15} /> {o.stockBlock ? "Waiting for stock" : "Assign rider"}
                    </button>
                  </li>
                ))}
              </ul>
              {pageCount > 1 && (
                <nav className="arq-pager" aria-label="Queue pages">
                  <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                    Previous
                  </button>
                  <span className="tnum">
                    Page {currentPage} of {pageCount}
                  </span>
                  <button type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
                    Next
                  </button>
                </nav>
              )}
            </>
          )}
        </section>
      </div>

      {selectedOrder && (
        <div className="arq-backdrop" onClick={closeDialog}>
          <div
            className="arq-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="arq-dialog-title"
            tabIndex={-1}
            ref={focusOnOpen}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeDialog();
            }}
          >
            <div className="arq-dialog-head">
              <div>
                <h2 id="arq-dialog-title">Assign a rider</h2>
                <p className="tnum">Order {selectedOrder.orderNumber || selectedOrder.id}</p>
              </div>
              <button type="button" className="ar-back" onClick={closeDialog} aria-label="Close" disabled={saving}>
                <X size={16} />
              </button>
            </div>

            <div className="ar-order">
              <div className="ar-order-top">
                <StatusBadge statusKey={normalizeStatusKey(selectedOrder.status)} />
                <span className={`ar-priority ${(selectedOrder.priority || "").toLowerCase() === "urgent" ? "urgent" : ""}`}>
                  {selectedOrder.priority || "Standard"}
                </span>
              </div>
              <h3>{selectedOrder.vaccineName || "—"}</h3>
              <div className="ar-order-meta">
                <span>
                  <Package size={13} />
                  {selectedOrder.quantity || 0} {selectedOrder.unit || "vials"}
                </span>
              </div>
              <div className="ar-order-row">
                <span>Destination</span>
                <strong>
                  <MapPin size={13} /> {selectedOrder.clinicName || "—"}
                </strong>
                {selectedOrder.clinicAddress && <p>{selectedOrder.clinicAddress}</p>}
              </div>
            </div>

            <h3 className="arq-dialog-sub">Available riders</h3>
            {ridersLoading ? (
              <div className="ar-state">
                <Loader2 size={22} className="spin" />
                <p>Loading riders…</p>
              </div>
            ) : ridersError ? (
              <div className="ar-state">
                <span className="ar-state-icon">
                  <AlertTriangle size={18} />
                </span>
                <strong>Could not load riders</strong>
                <p>{ridersError}</p>
              </div>
            ) : approvedRiders.length === 0 ? (
              <div className="ar-state">
                <span className="ar-state-icon">
                  <Bike size={18} />
                </span>
                <strong>No available riders</strong>
                <p>All riders are off-duty or pending approval.</p>
              </div>
            ) : (
              <div className="ar-rider-list arq-riders">
                {approvedRiders.map((rider) => {
                  const name = getRiderName(rider);
                  const empId = getRiderEmployeeId(rider);
                  const phone = getRiderPhone(rider);
                  const isSelected = selectedRiderId === rider.uid;
                  return (
                    <button
                      type="button"
                      key={rider.uid}
                      className={`ar-rider ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedRiderId(rider.uid)}
                      aria-pressed={isSelected}
                      disabled={saving}
                    >
                      <span className="ar-avatar">{initialsOf(name)}</span>
                      <div className="ar-rider-info">
                        <strong>{name}</strong>
                        <small>
                          {getRiderVehicle(rider)}
                          {empId && ` · ID ${empId}`}
                        </small>
                        {phone && (
                          <small className="ar-rider-phone">
                            <Phone size={11} /> {phone}
                          </small>
                        )}
                      </div>
                      <span className={`ar-radio ${isSelected ? "on" : ""}`}>
                        {isSelected && <CheckCircle2 size={18} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {scheduleBlocked && (
              <p className="dispatch-hold-note" role="status">
                {schedule.message}
              </p>
            )}
            {stockBlock && (
              <p className="dispatch-hold-note" role="status">
                {stockBlock}
              </p>
            )}
            {dialogError && (
              <p className="arq-dialog-error" role="alert">
                {dialogError}
              </p>
            )}

            <div className="arq-dialog-actions">
              <button type="button" className="ar-btn ar-btn-secondary" onClick={closeDialog} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="ar-btn ar-btn-primary"
                onClick={handleConfirmAssignment}
                disabled={!canAssign}
                aria-busy={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="spin" /> Assigning…
                  </>
                ) : (
                  "Confirm assignment"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default DispatcherAssignRider;
