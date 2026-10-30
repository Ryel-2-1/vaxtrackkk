import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Package, Search, X } from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { MAX_CANCEL_REASON_LENGTH } from "../../services/orderService";
import {
  cancelOrderWithInventoryRelease,
  requeueFailedOrder,
} from "../../services/inventoryCallables";
import { useSearchParams } from "react-router-dom";
import { cancelStockEffect } from "../../services/cancelStockEffect";
import { loadingCustodyConfirmed } from "../../services/loadingCustody";
import { requestOrderDestinationChange } from "../../services/destinationCorrectionService";
import DestinationCorrectionDialog from "./DestinationCorrectionDialog";
import { subscribeClinics } from "../../services/clinicService";
import { clinicsById } from "../../services/destinationFreshness";
import DestinationNotes from "../../components/dispatch/DestinationNotes";
import VaccineBreakdown from "../../components/dispatch/VaccineBreakdown";
import {
  ACTOR_DISPATCHER,
  AWAITING_DISPATCHER_STATUSES,
  canTransition,
} from "../../services/orderWorkflow";
import StatusBadge from "../../components/ui/StatusBadge";
import TimingIndicator from "../../components/ui/TimingIndicator";
import RequestedArrivalNote from "../../components/schedule/RequestedArrivalNote";
import KpiCard from "../../components/ui/KpiCard";
import {
  dispatchEligibility,
  formatScheduledDate,
  isEarlyDispatchAnomaly,
} from "../../services/dispatchEligibility";
import useManilaDayNow from "../../components/useManilaDayNow";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { UserMessageError } from "../../services/userMessageError";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import DialogLayer from "../../components/ui/DialogLayer";
import { capitalizedOrderPhrase, orderNumberPhrase, orderPhrase, orderReference } from "../../services/orderLabel";
import { fetchCancelledShipmentAudit } from "../../services/cancelledShipmentAudit";
import { orderArrivalNote } from "../../services/requestedArrival";

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

// Recovery is the failed-delivery path ONLY. `requeueFailedOrder` is a dedicated
// server callable that accepts `delivery_failed` and rejects everything else
// ("Only a failed delivery can be returned…"), so the button must be gated to the
// same set. A failed order's stock went back to the warehouse (awaiting an
// Admin decision), so recovery returns the order to the dispatch QUEUE: it is
// reserved again by the allocator and assigned through Assign Rider once fully
// reserved — never sent straight back out to a rider.
// `canTransition(dispatcher, …, "assigned")` was the wrong gate — it is also
// true for `pending_dispatch` (normal assignment), which put a recovery button
// on every unassigned order and then failed at the server. A pending order is
// assigned through the Assign Rider flow, not here.
function canReassign(statusKey) {
  return AWAITING_DISPATCHER_STATUSES.includes(statusKey);
}

// An order placed before future-order allocation (version 1) whose stock has
// already gone to return-pending cannot be re-reserved, so the server refuses
// to requeue it (legacy-order-not-requeueable). The control is not offered;
// the dispatcher is told to cancel it instead.
function isLegacyReturned(order) {
  return order.allocationVersion === 1 && order.allocationStatus === "returned";
}

function canCorrectDestination(order) {
  return order.destinationVersion === 1 && !!order.doctorId && !!order.createdByUid &&
    !order.destinationChangeRequest &&
    ["pending_dispatch", "assigned", "loading", "delivery_failed"].includes(order.statusKey);
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

function viewableProofUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    const localEmulator = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || localEmulator ? url.href : "";
  } catch {
    return "";
  }
}

function formatCancellationTime(value) {
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Time not recorded";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date)} PHT`;
}

function DispatcherShipments() {
  const pageSize = 10;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { toast, showToast, dismissToast } = useToast();
  const [updating, setUpdating] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(null);
  const [proofTargetId, setProofTargetId] = useState(null);
  const [detailsTargetId, setDetailsTargetId] = useState(null);
  const now = useManilaDayNow();
  // A notification's link (/dispatcher/shipments?order=…) points at one order.
  const [searchParams] = useSearchParams();
  const focusOrderId = searchParams.get("order") || "";

  useEffect(() => {
    const unsub = subscribeDeliveries(
      (all) => {
        setOrders(all);
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(liveErrorMessage(err, "shipments"));
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  // Clinics, to tell when an order's saved pin is older than its clinic's. A
  // failed read only hides that note; shipments stay usable.
  const [clinicMap, setClinicMap] = useState(() => new Map());
  useEffect(
    () =>
      subscribeClinics(
        (list) => setClinicMap(clinicsById(list)),
        (err) => logSafeError("Shipments: clinics", err)
      ),
    []
  );

  const grouped = useMemo(() => {
    const pending = orders.filter((o) => o.statusKey === "pending_dispatch");
    const assigned = orders.filter((o) => o.statusKey === "assigned");
    const loadingO = orders.filter((o) => o.statusKey === "loading");
    const transit = orders.filter((o) => o.statusKey === "in_transit");
    const delayed = orders.filter((o) => o.statusKey === "delayed");
    // Failed deliveries are the dispatcher's queue: nothing moves until they
    // retry or cancel, so they get their own group and are counted as active.
    const failed = orders.filter((o) => o.statusKey === "delivery_failed");
    const delivered = orders.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed");
    const cancelled = orders.filter((o) => o.statusKey === "cancelled" || o.statusKey === "canceled");
    return { pending, assigned, loading: loadingO, transit, delayed, failed, delivered, cancelled };
  }, [orders]);

  const activeOrders = useMemo(() => {
    if (filterStatus === "active") {
      return [
        ...grouped.failed,
        ...grouped.pending,
        ...grouped.assigned,
        ...grouped.loading,
        ...grouped.transit,
        ...grouped.delayed,
      ];
    }
    if (filterStatus === "pending_dispatch") return grouped.pending;
    if (filterStatus === "assigned") return grouped.assigned;
    if (filterStatus === "loading") return grouped.loading;
    if (filterStatus === "in_transit") return grouped.transit;
    if (filterStatus === "delayed") return grouped.delayed;
    if (filterStatus === "delivery_failed") return grouped.failed;
    if (filterStatus === "delivered") return grouped.delivered;
    if (filterStatus === "cancelled") return grouped.cancelled;
    return orders;
  }, [filterStatus, grouped, orders]);

  const matchingOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return activeOrders;
    return activeOrders.filter((order) => [
      order.orderNumber, order.clinicName, order.clinicAddress,
      order.vaccineName, order.assignedRiderName,
    ].some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [activeOrders, search]);
  const pageCount = Math.max(1, Math.ceil(matchingOrders.length / pageSize));
  const focusedIndex = focusOrderId ? matchingOrders.findIndex((order) => order.id === focusOrderId) : -1;
  const initialPage = focusedIndex < 0 ? 1 : Math.floor(focusedIndex / pageSize) + 1;
  const currentPage = Math.min(page ?? initialPage, pageCount);
  const pageOrders = matchingOrders.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const proofTarget = proofTargetId ? orders.find((order) => order.id === proofTargetId) : null;
  const detailsTarget = detailsTargetId ? orders.find((order) => order.id === detailsTargetId) : null;

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

  const [correctionTarget, setCorrectionTarget] = useState(null);
  const correctionTriggerRef = useRef(null);

  const openCorrectionDialog = (order, triggerEl) => {
    correctionTriggerRef.current = triggerEl;
    setCorrectionTarget(order);
  };

  const closeCorrectionDialog = useCallback(() => {
    setCorrectionTarget(null);
    correctionTriggerRef.current?.focus();
    correctionTriggerRef.current = null;
  }, []);

  const handleConfirmCorrection = async (order, doctorAddressId, reason) => {
    setUpdating(order.id);
    dismissToast();
    try {
      await requestOrderDestinationChange(
        order.id, doctorAddressId, reason, order.destinationRevision ?? 0
      );
      closeCorrectionDialog();
      showToast(`Destination change requested for ${orderPhrase(order)}. Awaiting Med Rep approval.`, "success");
    } finally {
      setUpdating("");
    }
  };

  const handleConfirmReassign = async (order) => {
    setUpdating(order.id);
    dismissToast();
    try {
      // Server-side: clears the assignment, keeps the failure record, and puts
      // the order back into allocation in its original priority position.
      const result = await requeueFailedOrder(order.id);
      closeReassignDialog();
      const state = result?.allocationState;
      showToast(
        `${capitalizedOrderPhrase(order)} is back in the dispatch queue${
          state === "fully_reserved"
            ? " and fully reserved — assign a rider from the dashboard."
            : state
              ? " and is waiting for stock before it can be assigned."
              : "."
        }`,
        "success"
      );
    } catch (err) {
      logSafeError("Requeue failed order", err);
      // Shown INSIDE the dialog, which stays open so the Dispatcher can retry.
      throw new UserMessageError(
        friendlyErrorMessage(err, "The order could not be returned to the queue. It is still marked failed — please try again."),
        { code: err?.code, cause: err }
      );
    } finally {
      setUpdating("");
    }
  };

  const handleConfirmCancel = async (order, reason) => {
    setUpdating(order.id);
    dismissToast();
    try {
      // Cancelling releases the order's reserved stock, so it now runs on the
      // server: the callable re-reads the order and the reservation inside one
      // transaction and releases each batch exactly once. The dialog, its reason
      // validation and its accessibility behaviour are unchanged — only the
      // service boundary and the error mapping moved.
      const result = await cancelOrderWithInventoryRelease(order.id, reason);
      closeCancelDialog();
      showToast(
        // Worded from what the SERVER did (returnedForCheck / released), not
        // from the dialog's possibly stale copy of the order.
        result?.returnedForCheck
          ? `${capitalizedOrderPhrase(order)} cancelled. Its vials are held as a return for an Admin to inspect.`
          : result?.released
            ? `${capitalizedOrderPhrase(order)} cancelled. Its reservation was released for other orders.`
            : `${capitalizedOrderPhrase(order)} cancelled.`,
        "success"
      );
    } catch (err) {
      logSafeError("Cancel order", err);
      // Domain messages are already phrased for the operator; the two cases
      // below are the ones where the right next action is not obvious.
      const message =
        err?.code === "reservation-already-settled"
          ? "This order's stock was already settled. The page shows its current state."
          : err?.code === "service-unavailable"
            ? "The ordering service is unavailable right now. The order was not cancelled — please try again."
            : friendlyErrorMessage(err, "The order could not be cancelled. Nothing was changed — please try again.");
      // Shown INSIDE the dialog, which stays open with the reason typed.
      throw new UserMessageError(message, { code: err?.code, cause: err });
    } finally {
      setUpdating("");
    }
  };

  const totalActive =
    grouped.pending.length +
    grouped.assigned.length +
    grouped.loading.length +
    grouped.transit.length +
    grouped.delayed.length +
    grouped.failed.length;
  const totalDone = grouped.delivered.length;

  const FILTERS = [
    { id: "active", label: "Active", count: totalActive },
    { id: "pending_dispatch", label: "Awaiting dispatch", count: grouped.pending.length },
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
      <>
        <div className="shp-state">
          <Loader2 size={30} className="spin" />
          <p>Loading shipments...</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="shp-state">
          <span className="shp-state-icon">
            <AlertTriangle size={18} />
          </span>
          <strong>Could not load shipments</strong>
          <p>{error}</p>
        </div>
      </>
    );
  }

  return (
    <>
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

        <ToastRegion toast={toast} onDismiss={dismissToast} />

        <div className="shp-filterbar">
          <label className="shp-search">
            <Search size={16} aria-hidden="true" />
            <span className="shp-search-label">Search shipments</span>
            <input type="search" value={search} placeholder="Search shipments"
              onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          </label>
          <div className="shp-segmented">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`shp-segment ${filterStatus === f.id ? "active" : ""}`}
                onClick={() => { setFilterStatus(f.id); setPage(1); }}
              >
                {f.label} · {f.count}
              </button>
            ))}
          </div>
        </div>

        <section className="shp-card">
          {matchingOrders.length === 0 ? (
            <div className="shp-empty">
              <span className="shp-empty-icon">
                <Package size={18} />
              </span>
              {/* An empty collection is not a filter result: say which it is. */}
              {orders.length === 0 ? (
                <>
                  <strong>No shipments yet</strong>
                  <p>Orders appear here as soon as they are placed.</p>
                </>
              ) : (
                <>
                  <strong>No shipments match this filter</strong>
                  <p>Try a different status filter or search.</p>
                </>
              )}
            </div>
          ) : (
            <div className="shp-table-wrap">
              <table className="shp-table">
                <colgroup>
                  <col style={{ width: "15%" }} /><col style={{ width: "21%" }} />
                  <col style={{ width: "12%" }} /><col style={{ width: "11%" }} />
                  <col style={{ width: "13%" }} /><col style={{ width: "8%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
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
                  {pageOrders.map((order) => (
                    <ShipmentRow
                      key={order.id}
                      order={order}
                      now={now}
                      updating={updating === order.id}
                      onRequestCancel={openCancelDialog}
                      onRequestReassign={openReassignDialog}
                      onRequestCorrection={openCorrectionDialog}
                      onViewProof={(order) => setProofTargetId(order.id)}
                      onViewDetails={(order) => setDetailsTargetId(order.id)}
                      clinic={clinicMap.get(order.clinicDocId)}
                      focused={order.id === focusOrderId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {matchingOrders.length > 0 && (
          <nav className="shp-pagination" aria-label="Shipment pages">
            <span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, matchingOrders.length)} of {matchingOrders.length}</span>
            <div>
              <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
              <span>Page {currentPage} of {pageCount}</span>
              <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
            </div>
          </nav>
        )}
      </div>

      {proofTarget && (
        <DialogLayer scope="dispatcher-page">
          <ProofOfDeliveryDialog order={proofTarget} onDismiss={() => setProofTargetId(null)} />
        </DialogLayer>
      )}

      {detailsTarget && (
        <DialogLayer scope="dispatcher-page">
          <CancelledShipmentDialog order={detailsTarget} onDismiss={() => setDetailsTargetId(null)} />
        </DialogLayer>
      )}

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

      {correctionTarget && (
        <DestinationCorrectionDialog
          order={correctionTarget}
          onDismiss={closeCorrectionDialog}
          onConfirm={handleConfirmCorrection}
        />
      )}
    </>
  );
}

function ProofOfDeliveryDialog({ order, onDismiss }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [imageFailed, setImageFailed] = useState(false);
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss });
  const proofUrl = viewableProofUrl(order.proofOfDeliveryUrl);
  const hasStoredProof = typeof order.proofOfDeliveryUrl === "string" && !!order.proofOfDeliveryUrl.trim();
  const titleId = "shipment-proof-title";
  const descriptionId = "shipment-proof-description";

  return (
    <div className="shp-dialog-backdrop shp-proof-backdrop" onMouseDown={onDismiss}>
      <div className="shp-dialog shp-proof-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="shp-dialog-head">
          <h2 id={titleId}>Proof of delivery</h2>
          <button type="button" className="shp-dialog-close" aria-label="Close proof of delivery"
            onClick={onDismiss} ref={closeRef}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className="shp-dialog-desc">
          {orderNumberPhrase(order)} · {order.clinicName || "Clinic"}
        </p>
        {proofUrl && !imageFailed ? (
          <a className="shp-proof-image-link" href={proofUrl} target="_blank" rel="noopener noreferrer">
            <img src={proofUrl} alt={`Proof of delivery for ${orderNumberPhrase(order)}`}
              onError={() => setImageFailed(true)} />
          </a>
        ) : (
          <p className="shp-proof-empty" role="status">
            {proofUrl
              ? "The proof image could not be previewed. Open the image to try again."
              : hasStoredProof
                ? "The proof image link is unavailable."
                : "No proof of delivery was uploaded for this order."}
          </p>
        )}
        {proofUrl && (
          <a className="shp-proof-open" href={proofUrl} target="_blank" rel="noopener noreferrer">
            Open image in new tab
          </a>
        )}
      </div>
    </div>
  );
}

function CancelledShipmentDialog({ order, onDismiss }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [audit, setAudit] = useState(null);
  const [auditError, setAuditError] = useState("");
  const [copied, setCopied] = useState(false);
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss });

  useEffect(() => {
    let current = true;
    fetchCancelledShipmentAudit(order.id)
      .then((result) => { if (current) setAudit(result); })
      .catch((error) => { if (current) setAuditError(friendlyErrorMessage(error, "Cancellation audit is unavailable.")); });
    return () => { current = false; };
  }, [order.id]);

  const orderId = orderReference(order, order.id);
  const lines = Array.isArray(order.items) && order.items.length
    ? order.items
    : [{ name: order.vaccineName, quantity: order.quantity }];
  const slices = Array.isArray(audit?.slices) ? audit.slices : [];
  const releasedCount = slices.reduce((sum, slice) => sum + slice.quantity, 0);
  const releaseNote = order.inventoryReconciliation === "legacy-unallocated"
    ? "Legacy stock effect could not be reconciled. Admin review is needed."
    : audit?.reservationStatus === "released" && audit?.settlementType === "cancelled"
      ? releasedCount === 0
        ? "No reserved vials needed release; unfilled items were never taken from stock."
        : `${releasedCount.toLocaleString()} reserved vial${releasedCount === 1 ? "" : "s"} released back to available inventory.${releasedCount < (Number(order.quantity) || 0) ? " Unreserved items were never taken from stock." : ""}`
      : audit?.reservationStatus === "returned" || order.allocationStatus === "returned"
        ? "Stock is awaiting Admin inspection; it has not been released to available inventory."
        : audit
          ? "Stock restoration is not confirmed by the reservation record. Admin review is needed."
          : auditError ? "Stock restoration could not be verified here." : "Checking the reservation record…";

  const copyOrderId = async () => {
    try {
      await navigator.clipboard.writeText(orderId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="shp-dialog-backdrop shp-proof-backdrop" onMouseDown={onDismiss}>
      <div className="shp-dialog shp-cancelled-dialog" role="dialog" aria-modal="true"
        aria-labelledby="shipment-details-title" ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="shp-dialog-head">
          <h2 id="shipment-details-title">Cancelled shipment details</h2>
          <button type="button" className="shp-dialog-close" aria-label="Close shipment details"
            onClick={onDismiss} ref={closeRef}><X size={16} aria-hidden="true" /></button>
        </div>

        <section className="shp-audit-section">
          <h3>Cancellation audit</h3>
          <dl className="shp-audit-grid">
            <div><dt>Reason</dt><dd>{order.cancelReason || "Not recorded"}</dd></div>
            <div><dt>Cancelled by</dt><dd>{audit?.cancelledByName || order.cancelledByName || (audit || auditError ? "Name unavailable" : "Loading…")}{order.cancelledByRole ? ` · ${order.cancelledByRole === "salesrep" ? "Med Rep" : order.cancelledByRole.charAt(0).toUpperCase() + order.cancelledByRole.slice(1)}` : ""}</dd></div>
            <div><dt>Cancelled at</dt><dd>{formatCancellationTime(order.cancelledAt)}</dd></div>
            <div><dt>Previous status</dt><dd>{order.cancelledFromStatus?.replaceAll("_", " ") || "Not recorded"}</dd></div>
          </dl>
        </section>

        <section className="shp-audit-section">
          <h3>Order and destination</h3>
          <div className="shp-audit-id"><span>{orderId}</span><button type="button" className="shp-act-btn" onClick={copyOrderId}>{copied ? "Copied" : "Copy ID"}</button></div>
          <dl className="shp-audit-grid">
            <div><dt>Receiving doctor</dt><dd>{order.doctorName || "Not recorded"}</dd></div>
            <div><dt>Clinic</dt><dd>{order.clinicName || "Not recorded"}</dd></div>
            <div><dt>Delivery address</dt><dd>{order.clinicAddress || "Not recorded"}</dd></div>
            <div><dt>Requested arrival</dt><dd>{orderArrivalNote(order)}</dd></div>
          </dl>
        </section>

        <section className="shp-audit-section">
          <h3>Vaccine package</h3>
          <ul className="shp-audit-items">{lines.map((line, index) => {
            const batches = slices.filter((slice) => slice.lineIndex === index);
            return <li key={`${line.productKey || line.name || "item"}-${index}`}>
              <strong>{line.name || "Vaccine not recorded"}</strong>
              <span>{Number.isFinite(Number(line.quantity)) ? Number(line.quantity).toLocaleString() : "—"} vials</span>
              <small>Allocated batch{batches.length === 1 ? "" : "es"}: {audit ? (batches.length ? batches.map((slice) => `${slice.batchId || "Unknown lot"} (${slice.quantity} vials)`).join(", ") : "None recorded") : auditError ? "Unavailable" : "Checking…"}</small>
              <small>Storage requirements: Not recorded for this order</small>
            </li>;
          })}</ul>
        </section>

        <section className="shp-audit-section">
          <h3>Logistics and inventory</h3>
          <dl className="shp-audit-grid">
            <div><dt>Assigned rider</dt><dd>{order.assignedRiderName || "Unassigned"}{order.assignedRiderPhone ? ` · ${order.assignedRiderPhone}` : ""}</dd></div>
            <div><dt>Stock restoration</dt><dd>{releaseNote}</dd></div>
          </dl>
          {auditError && <p className="shp-audit-error" role="alert">{auditError} Stock release and allocated lots cannot be verified here.</p>}
        </section>
      </div>
    </div>
  );
}

/**
 * Return a failed delivery to the dispatch queue.
 *
 * The rider's report already sent the order's stock back to the warehouse,
 * where it waits for an Admin to confirm its condition. So recovery cannot be
 * "send it out again": the order rejoins allocation, is reserved again in its
 * priority position, and is assigned through Assign Rider once fully
 * reserved. The failure record is kept.
 */
function ReassignFailedOrderDialog({ order, onDismiss, onConfirm }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  const titleId = "reassign-order-title";
  const descId = "reassign-order-desc";

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

  const submit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(order);
    } catch (failure) {
      setError(friendlyErrorMessage(failure, "The order could not be returned to the queue. Please try again."));
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
          <h2 id={titleId}>Return failed delivery to the queue</h2>
          <button
            type="button"
            className="shp-dialog-close"
            aria-label="Close without changing the order"
            onClick={onDismiss}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p id={descId} className="shp-dialog-desc">
          {orderNumberPhrase(order)} for {order.clinicName || "this clinic"} failed
          {order.deliveryFailureReason ? `: "${order.deliveryFailureReason}"` : "."} Its stock
          was returned to the warehouse for an Admin to check. Returning the order to the dispatch
          queue reserves stock for it again in its original priority position; it can be assigned
          to a rider once every item is fully reserved.
        </p>

        <form onSubmit={submit}>
          {error && (
            <p role="alert" className="shp-dialog-error">
              {error}
            </p>
          )}
          <div className="shp-dialog-actions">
            <button type="button" className="shp-act-btn" onClick={onDismiss} ref={firstFieldRef}>
              Keep as failed
            </button>
            <button type="submit" className="shp-act-btn primary return-to-queue" disabled={submitting}>
              {submitting ? "Returning…" : "Return to queue"}
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
    } catch (failure) {
      // Shown here, in the dialog that stays open with the typed reason, so
      // the operator can retry or dismiss — never only in a passing toast.
      setError(friendlyErrorMessage(failure, "The order could not be cancelled. Please try again."));
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
          {orderNumberPhrase(order)} for {order.clinicName || "this clinic"} will
          be cancelled. This cannot be undone. {cancelStockEffect(order.statusKey, loadingCustodyConfirmed(order))}
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

function ShipmentRow({ order, now, updating, onRequestCancel, onRequestReassign, onRequestCorrection, onViewProof, onViewDetails, clinic: clinicDoc, focused = false }) {
  const rowRef = useRef(null);
  // Opened from a notification: bring the order into view once.
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  const sKey = order.statusKey;
  const cancellable = canCancel(sKey);
  // Recovery only returns the order to the dispatch queue; the assignment that
  // follows waits for the scheduled day and for full stock like any other.
  const schedule = dispatchEligibility(order, now);
  const legacyReturned = canReassign(sKey) && isLegacyReturned(order);
  const reassignable = canReassign(sKey) && !legacyReturned;
  const earlyDispatch = isEarlyDispatchAnomaly(order, sKey, now);
  const correctable = canCorrectDestination(order);
  const awaitingApproval = !!order.destinationChangeRequest;
  const isDelayed = sKey === "delayed" || sKey === "delivery_failed";
  const isCompleted = sKey === "delivered" || sKey === "completed";
  const isCancelled = sKey === "cancelled" || sKey === "canceled";

  const riderName = order.assignedRiderName || "Unassigned";
  const riderPhone = order.assignedRiderPhone || "";
  const orderNum = orderReference(order, "No order number");
  const clinic = order.clinicName || "—";
  const address = order.clinicAddress || "";
  const qty = order.quantity || 0;
  const unit = order.unit || "vials";
  const updated = formatTime(order.updatedAt || order.assignedAt || order.createdAt);

  return (
    <tr ref={rowRef} className={`${isDelayed ? "shp-row-delayed" : ""}${focused ? " shp-row-focus" : ""}`} aria-current={focused ? "true" : undefined}>
      <td>
        <div className="shp-order-content">
          <span className="shp-order-id">{orderNum}</span>
          <RequestedArrivalNote order={order} />
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong>{clinic}</strong>
          {address && <small>{address}</small>}
          {awaitingApproval && <small>Change requested — awaiting Med Rep approval</small>}
          <DestinationNotes order={order} clinic={clinicDoc} />
        </div>
      </td>
      <td>
        <div className="shp-cell">
          <strong><VaccineBreakdown order={order} /></strong>
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
        <div>
          <TimingIndicator order={order} />
        </div>
        {earlyDispatch && (
          <div>
            <span
              className="dispatch-anomaly"
              title="Dispatched before its scheduled date. Review it manually; nothing is changed automatically."
            >
              Early dispatch · scheduled {formatScheduledDate(schedule.iso)}
            </span>
          </div>
        )}
      </td>
      <td className="shp-td-meta">{updated}</td>
      <td className="shp-actions-cell">
        <div className="shp-actions">
          {isCompleted ? (
            <button type="button" className="shp-act-btn primary view-proof"
              aria-label={`View proof of delivery for ${orderNumberPhrase(order)}`}
              onClick={() => onViewProof(order)}>
              View proof of delivery
            </button>
          ) : isCancelled ? (
            <button type="button" className="shp-act-btn view-details"
              aria-label={`View cancellation details for ${orderNumberPhrase(order)}`}
              onClick={() => onViewDetails(order)}>View details</button>
          ) : (
          <>
          {awaitingApproval && <span className="shp-muted shp-action-note">Awaiting Med Rep approval</span>}
          {correctable && (
            <button type="button" className="shp-act-btn request-change" disabled={updating}
              onClick={(e) => onRequestCorrection(order, e.currentTarget)}>
              Request change
            </button>
          )}
          {!correctable && (
            <span className="shp-action-placeholder" aria-hidden="true">
              {!cancellable && !reassignable && !legacyReturned && !awaitingApproval ? "—" : null}
            </span>
          )}
          {reassignable && (
            <button
              type="button"
              className="shp-act-btn primary return-to-queue"
              disabled={updating}
              onClick={(e) => onRequestReassign(order, e.currentTarget)}
            >
              Return to queue
            </button>
          )}
          {!reassignable && <span className="shp-action-placeholder" aria-hidden="true" />}
          {legacyReturned && (
            <span className="shp-muted shp-action-note">
              Placed before future orders — its stock was returned. Cancel it and place a new order.
            </span>
          )}
          {cancellable && (
            <button
              type="button"
              className="shp-act-btn danger cancel-order-outline"
              disabled={updating}
              onClick={(e) => onRequestCancel(order, e.currentTarget)}
            >
              Cancel order
            </button>
          )}
          {!cancellable && <span className="shp-action-placeholder" aria-hidden="true" />}
          <span className="shp-action-placeholder" aria-hidden="true" />
          </>
          )}
        </div>
      </td>
    </tr>
  );
}

export default DispatcherShipments;
