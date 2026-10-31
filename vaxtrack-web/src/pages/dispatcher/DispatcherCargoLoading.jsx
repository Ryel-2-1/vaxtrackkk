import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Home,
  Info,
  Loader2,
  Package,
  RotateCcw,
  Truck,
} from "lucide-react";
import {
  finalizeRiderDispatch,
  subscribeCargoLoadingGroups,
  updateOrderLoadedState,
} from "../../services/cargoLoadingService";
import {
  dispatchEligibility,
  SCHEDULED_DATE_NOT_REACHED,
} from "../../services/dispatchEligibility";
import useManilaDayNow from "../../components/useManilaDayNow";
import StatusBadge from "../../components/ui/StatusBadge";
import KpiCard from "../../components/ui/KpiCard";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { missingEtaWarning } from "../../services/deliveryTiming";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import { subscribeRiders } from "../../services/riderService";
import { confirmRiderReturnToHub, subscribeRiderDispatchStates } from "../../services/riderDispatchService";
import { cargoGroupDispatch, ridersReturningToHub } from "../../services/riderTrip";
import DispatcherDialogLayer from "./DispatcherDialogLayer";
import DeparturePlanner from "../../components/dispatch/DeparturePlanner";
import { subscribeRoutingSettings } from "../../services/routingSettingsService";
import { routingSettingsOf } from "../../services/routingSettings";
import { subscribeClinics } from "../../services/clinicService";
import { clinicsById } from "../../services/destinationFreshness";
import DestinationNotes from "../../components/dispatch/DestinationNotes";

// The departure planner (requested arrivals + motorcycle travel times) is
// switched on per build with VITE_DEPARTURE_PLANNER_ENABLED=true, and always
// in the loopback-only motorcycle-QA mode.
const DEPARTURE_PLANNER_ENABLED =
  import.meta.env?.VITE_DEPARTURE_PLANNER_ENABLED === "true" || import.meta.env?.MODE === "motorcycle-qa";
import { requestedArrivalOf, requestedScheduleLabel } from "../../services/requestedArrival";
import "./CargoLoading.css";

// Loading-state badge shown on each rider card. Text + icon (not colour alone)
// so the state is clear without relying on colour perception.
function loadingBadge(group, dispatched) {
  if (dispatched) return { label: "Dispatched", tone: "dispatched" };
  if (group.allLoaded) return { label: "Ready", tone: "ready" };
  return { label: "Pending", tone: "pending" };
}

function orderClinic(order) {
  return order.clinicName || order.clinic || "Unknown clinic";
}

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

function DispatcherCargoLoading() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const now = useManilaDayNow();
  const pageRef = useRef(null);
  const cardsRef = useRef(null);
  const [pageSize, setPageSize] = useState(3);
  const [page, setPage] = useState(1);
  const [cardMaxHeight, setCardMaxHeight] = useState(420);
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const currentPage = Math.min(page, pageCount);

  useEffect(() => {
    const element = pageRef.current;
    if (!element) return undefined;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      setPageSize(width >= 1020 ? 3 : width >= 680 ? 2 : 1);
      if (cardsRef.current) {
        const top = cardsRef.current.getBoundingClientRect().top;
        const pagerHeight = element.querySelector(".cl-pagination")?.getBoundingClientRect().height ?? 0;
        setCardMaxHeight(Math.max(280, Math.floor(window.innerHeight - top - pagerHeight - 64)));
      }
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [loading, error]);

  const [savingOrders, setSavingOrders] = useState({}); // orderId -> true while writing
  const [finalizingRider, setFinalizingRider] = useState(null);
  const [dispatchedRiders, setDispatchedRiders] = useState({}); // riderId -> true (just dispatched)

  const [confirmGroup, setConfirmGroup] = useState(null); // group awaiting finalize confirmation
  // Rider trips (server-owned): which Riders are out, and who is back at the
  // hub waiting for a Dispatcher to confirm it.
  const [tripStates, setTripStates] = useState(() => new Map());
  // Unreadable trip states (e.g. before the rules that expose them are live):
  // the page says so plainly; every Finalize and return is still checked on
  // the server, so nothing is unsafe — only the trip labels are missing.
  const [tripStatesUnavailable, setTripStatesUnavailable] = useState(false);
  const [riders, setRiders] = useState([]);
  const [confirmReturn, setConfirmReturn] = useState(null); // { riderUid, tripId, name, ... }
  const { toast, showToast, dismissToast } = useToast();
  // Hub + planning defaults for the departure planner (Admin → Settings → Routing).
  // null while loading; an unreadable document plans with no hub, never a guessed one.
  const [routing, setRouting] = useState(null);
  // Clinics, to tell when an order's saved pin is older than its clinic's
  // (DestinationNotes). A failed read only hides that note.
  const [clinicMap, setClinicMap] = useState(() => new Map());
  useEffect(
    () =>
      subscribeClinics(
        (list) => setClinicMap(clinicsById(list)),
        (err) => logSafeError("Clinics for destination notes", err)
      ),
    []
  );

  useEffect(() => {
    if (!DEPARTURE_PLANNER_ENABLED) return undefined;
    return subscribeRoutingSettings(
      (docData) => setRouting(routingSettingsOf(docData)),
      () => setRouting(routingSettingsOf(null))
    );
  }, []);

  // Live subscription to rider loading groups.
  useEffect(() => {
    const unsub = subscribeCargoLoadingGroups(
      (next) => {
        setGroups(next);
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(liveErrorMessage(err, "cargo loading"));
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsubStates = subscribeRiderDispatchStates(
      (map) => {
        setTripStates(map);
        setTripStatesUnavailable(false);
      },
      (err) => {
        logSafeError("Rider trip states", err);
        setTripStatesUnavailable(true);
      }
    );
    const unsubRiders = subscribeRiders(setRiders, () => {});
    return () => {
      unsubStates();
      unsubRiders();
    };
  }, []);

  const returning = useMemo(() => ridersReturningToHub(tripStates, riders), [tripStates, riders]);

  // Runs from the confirmation; on failure it rethrows so the dialog says why.
  const handleConfirmReturn = async (entry) => {
    try {
      await confirmRiderReturnToHub({ riderUid: entry.riderUid, tripId: entry.tripId });
    } catch (err) {
      logSafeError("Confirm rider return", err);
      throw err;
    }
    setConfirmReturn(null);
    showToast(`${entry.name} is back at the hub and can take new orders.`, "success");
  };

  const summary = useMemo(() => {
    const riders = groups.length;
    const ordersToLoad = groups.reduce((sum, g) => sum + (g.totalOrders || 0), 0);
    const loaded = groups.reduce((sum, g) => sum + (g.loadedCount || 0), 0);
    const ready = groups.filter(
      (g) => g.allLoaded && !dispatchedRiders[g.riderId]
    ).length;
    return { riders, ordersToLoad, loaded, ready };
  }, [groups, dispatchedRiders]);

  const handleToggleLoaded = async (order, nextLoaded) => {
    if (savingOrders[order.id]) return; // block duplicate writes
    setSavingOrders((prev) => ({ ...prev, [order.id]: true }));
    try {
      // The service re-reads the order and decides for itself whether the
      // status permits this and whether to promote assigned → loading. The
      // rendered `statusKey` is no longer passed — a stale list must not be
      // able to drive a status change — and the dispatcher's audit identity
      // now comes from the session inside the service.
      await updateOrderLoadedState(order.id, nextLoaded);
    } catch (err) {
      logSafeError("Update loaded state", err);
      showToast(
        friendlyErrorMessage(err, "The loaded check could not be saved. The order is unchanged — please try again."),
        "error"
      );
    } finally {
      setSavingOrders((prev) => {
        const copy = { ...prev };
        delete copy[order.id];
        return copy;
      });
    }
  };

  // Runs from the confirmation dialog, which stays open until the server
  // confirms: on failure it rethrows, so the dialog shows the reason and the
  // Dispatcher can retry or cancel. Success closes it.
  const handleFinalize = async (group) => {
    if (!group || finalizingRider) return;
    setFinalizingRider(group.riderId);
    try {
      // The server re-reads the Rider's trip and every order; the whole trip
      // leaves together or nothing moves. The trip id the page saw is sent so
      // a trip that changed meanwhile is refused, not sent.
      await finalizeRiderDispatch(
        group.riderId,
        group.orders.map((o) => o.id),
        cargoGroupDispatch(tripStates.get(group.riderId)).tripId
      );
      // Show the "Dispatched" state briefly; the snapshot then removes the group.
      setDispatchedRiders((prev) => ({ ...prev, [group.riderId]: true }));
      setConfirmGroup(null);
      showToast(`Dispatch finalized for ${group.rider.name}.`, "success");
    } catch (err) {
      logSafeError("Finalize dispatch", err);
      throw err;
    } finally {
      setFinalizingRider(null);
    }
  };

  if (loading) {
    return (
      <>
        <div className="cl-state">
          <Loader2 size={30} className="cl-spin" />
          <p>Loading cargo data...</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="cl-state">
          <span className="cl-state-icon">
            <AlertTriangle size={20} />
          </span>
          <strong>Could not load cargo data</strong>
          <p>{error}</p>
          <button
            type="button"
            className="cl-btn cl-btn-outline"
            onClick={() => {
              setError("");
              setLoading(true);
            }}
          >
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dispatcher-v2-page cl-page" ref={pageRef}>
        <div className="cl-header">
          <h2 className="disp-section-title">Loading queue</h2>
          <p>Confirm each order as loaded, then finalize dispatch per rider.</p>
        </div>

        <section className="cl-summary">
          <KpiCard
            label="Riders"
            value={summary.riders}
            context="With orders to load"
            tone="neutral"
          />
          <KpiCard
            label="Orders to load"
            value={summary.ordersToLoad}
            context="Across all riders"
            tone="neutral"
          />
          <KpiCard
            label="Loaded"
            value={summary.loaded}
            context={`of ${summary.ordersToLoad} confirmed`}
            tone="success"
          />
          <KpiCard
            label="Ready to dispatch"
            value={summary.ready}
            context={summary.ready > 0 ? "Fully loaded" : "None ready yet"}
            tone={summary.ready > 0 ? "success" : "neutral"}
          />
        </section>

        <ToastRegion toast={toast} onDismiss={dismissToast} />

        {tripStatesUnavailable && (
          <p className="cl-hint" role="status">
            Rider trip status is not available right now. Finalize dispatch still checks every rider on the server.
          </p>
        )}

        {returning.length > 0 && (
          <section className="cl-return" aria-label="Riders returning to the hub">
            <div className="cl-return-head">
              <Home size={16} aria-hidden="true" />
              <div>
                <h3>Returning to hub</h3>
                <p>Every order on these trips is finished. Confirm each rider once they are physically back at the distribution hub.</p>
              </div>
            </div>
            <ul className="cl-return-list">
              {returning.map((r) => (
                <li key={r.riderUid} className="cl-return-row">
                  <span className="cl-avatar" aria-hidden="true">{initialsOf(r.name)}</span>
                  <div className="cl-rider-meta">
                    <strong>{r.name}</strong>
                    <small>
                      {r.plate ? <span className="cl-plate">{r.plate}</span> : null}
                      {r.plate ? " · " : ""}
                      <span className="tnum">{r.orderCount}</span> {r.orderCount === 1 ? "order" : "orders"} on the trip
                    </small>
                  </div>
                  <button type="button" className="cl-btn cl-btn-primary" onClick={() => setConfirmReturn(r)}>
                    <Home size={14} /> Confirm return
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {groups.length === 0 ? (
          <div className="cl-empty">
            <span className="cl-empty-icon">
              <Package size={20} />
            </span>
            <strong>No assigned orders ready for loading</strong>
            <p>
              Orders appear here once a dispatcher assigns them to a rider.
            </p>
          </div>
        ) : (
          <>
            <div className="cl-note">
              <Info size={15} />
              <span>
                Live route mapping isn&apos;t active yet — orders follow each
                rider&apos;s delivery sequence below.
              </span>
            </div>

            <div className={`cl-cards cl-cards-${pageSize}`} ref={cardsRef}
              style={{ "--cl-card-max-height": `${cardMaxHeight}px` }}>
              {groups.map((group, index) => (
                <RiderCard
                  key={group.riderId}
                  hidden={index < (currentPage - 1) * pageSize || index >= currentPage * pageSize}
                  group={group}
                  dispatched={!!dispatchedRiders[group.riderId]}
                  savingOrders={savingOrders}
                  finalizing={finalizingRider === group.riderId}
                  now={now}
                  onToggleLoaded={handleToggleLoaded}
                  onFinalize={() => setConfirmGroup(group)}
                  tripHold={cargoGroupDispatch(tripStates.get(group.riderId))}
                  routing={routing}
                  clinicMap={clinicMap}
                />
              ))}
            </div>
            {/* Always shown, so its place under the cards never changes. */}
            {groups.length > 0 && (
              <nav className="cl-pagination" aria-label="Cargo loading pages">
                <span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, groups.length)} of {groups.length} riders</span>
                <div>
                  <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
                  <span>Page {currentPage} of {pageCount}</span>
                  <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
                </div>
              </nav>
            )}
          </>
        )}
      </div>

      {/* Portaled: inside the Dispatcher content area (transformed by its
          entrance animation) a dialog is centred in the whole page and opens
          off-screen once it is scrolled (DispatcherDialogLayer.jsx). */}
      {confirmGroup && (
        <DispatcherDialogLayer>
        <ConfirmDialog
          title="Finalize dispatch?"
          target={`${confirmGroup.rider.name}${confirmGroup.rider.plate ? ` · ${confirmGroup.rider.plate}` : ""} · ${
            confirmGroup.totalOrders
          } order${confirmGroup.totalOrders === 1 ? "" : "s"}`}
          consequence={`All ${confirmGroup.totalOrders} order${
            confirmGroup.totalOrders === 1 ? "" : "s"
          } leave together as one trip and are marked In Transit. No more orders can be assigned to this rider until their return to the hub is confirmed. This cannot be undone here.`}
          confirmLabel="Confirm dispatch"
          busyLabel="Dispatching…"
          tone="primary"
          failureMessage="The dispatch could not be finalized. No order was moved — please try again."
          onCancel={() => setConfirmGroup(null)}
          onConfirm={() => handleFinalize(confirmGroup)}
        >
          {/* Non-blocking: dispatch stays available without a route ETA. */}
          {(() => {
            const warning = missingEtaWarning(confirmGroup.orders);
            return warning ? (
              <p className="m-dialog-warning" role="note">
                {warning.text} <span className="tnum">({warning.orderLabels.join(", ")})</span>
              </p>
            ) : null;
          })()}
        </ConfirmDialog>
        </DispatcherDialogLayer>
      )}

      {confirmReturn && (
        <DispatcherDialogLayer>
          <ConfirmDialog
            title="Confirm return to hub?"
            target={`${confirmReturn.name}${confirmReturn.plate ? ` · ${confirmReturn.plate}` : ""}`}
            consequence="Confirm only once this rider is physically back at the distribution hub. They become available for new assignments."
            confirmLabel="Confirm return"
            busyLabel="Confirming…"
            tone="primary"
            failureMessage="The return could not be confirmed. The rider is still marked as returning — please try again."
            onCancel={() => setConfirmReturn(null)}
            onConfirm={() => handleConfirmReturn(confirmReturn)}
          />
        </DispatcherDialogLayer>
      )}

    </>
  );
}

function RiderCard({
  group,
  hidden = false,
  dispatched,
  savingOrders,
  finalizing,
  now,
  onToggleLoaded,
  onFinalize,
  tripHold = { canFinalize: true, reason: "" },
  routing = null,
  clinicMap = null,
}) {
  const badge = loadingBadge(group, dispatched);
  // Orders assigned before the schedule guard existed may still sit here ahead
  // of their date, or with no usable date at all. They cannot be loaded
  // (assigned → loading) or dispatched until they are eligible, so one of them
  // holds the whole group — finalizing is all-or-nothing in the service too.
  const scheduleById = Object.fromEntries(
    group.orders.map((o) => [o.id, dispatchEligibility(o, now)])
  );
  const heldOrders = group.orders.filter((o) => !scheduleById[o.id].eligible);
  const canFinalize =
    group.allLoaded && !dispatched && !finalizing && heldOrders.length === 0 && tripHold.canFinalize;
  const total = group.totalOrders || 0;
  const loaded = group.loadedCount || 0;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <section className="cl-card" hidden={hidden} aria-label={`Cargo for ${group.rider.name}`}>
      <header className="cl-card-head">
        <span className="cl-avatar" aria-hidden="true">
          {initialsOf(group.rider.name)}
        </span>

        <div className="cl-rider-meta">
          <strong>{group.rider.name}</strong>
          <small>
            {group.rider.plate ? (
              <span className="cl-plate">{group.rider.plate}</span>
            ) : (
              "No plate on file"
            )}
          </small>
        </div>

        <span className={`cl-badge cl-badge-${badge.tone}`}>
          {badge.tone === "ready" || badge.tone === "dispatched" ? (
            <CheckCircle2 size={12} />
          ) : (
            <span className="cl-badge-dot" />
          )}
          {badge.label}
        </span>
      </header>

      <div className="cl-progress">
        <div className="cl-progress-row">
          <span className="tnum">
            {loaded}/{total} loaded
          </span>
          <span className="cl-progress-pct tnum">{pct}%</span>
        </div>
        <div className="cl-progress-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="cl-card-body">
      <div className="cl-order-list">
        {group.orders.map((order, index) => {
          const checkboxId = `loaded-${order.id}`;
          const saving = !!savingOrders[order.id];
          const isLoaded = order.isLoaded === true;
          const schedule = scheduleById[order.id];
          // Confirming an `assigned` order promotes it to `loading`, which is
          // dispatch preparation — not allowed ahead of the scheduled day.
          const loadBlocked =
            !schedule.eligible && order.statusKey === "assigned" && !isLoaded;
          const seq = Number.isFinite(Number(order.deliverySequence))
            ? Number(order.deliverySequence)
            : index + 1;

          return (
            <div
              key={order.id}
              className={`cl-order-row ${isLoaded ? "loaded" : ""}`}
            >
              <span className="cl-seq tnum">
                {String(seq).padStart(2, "0")}
              </span>

              <div className="cl-order-info">
                <div className="cl-order-top">
                  <strong>{orderClinic(order)}</strong>
                  <StatusBadge statusKey={order.statusKey} />
                </div>
                <small className="cl-order-vaccine">
                  {order.vaccineName || "Unknown vaccine"}
                  <span className="tnum">
                    {" · "}
                    {(order.quantity || 0).toLocaleString()} {order.unit || "doses"}
                  </span>
                  {order.batchId ? ` · Batch ${order.batchId}` : ""}
                </small>
                {/* When the order is needed AT the destination — a request
                    for planning, not an estimate or a departure time. */}
                <small className="cl-order-request">
                  Requested arrival: {requestedScheduleLabel(order.requestedDeliveryDate, requestedArrivalOf(order))}
                </small>
                <DestinationNotes order={order} clinic={clinicMap?.get(order.clinicDocId)} />
                {!schedule.eligible && (
                  <>
                    {schedule.code === SCHEDULED_DATE_NOT_REACHED && (
                      <span className="dispatch-anomaly">
                        Assigned before its scheduled date
                      </span>
                    )}
                    <p className="dispatch-hold-note">{schedule.message}</p>
                  </>
                )}
              </div>

              <label
                htmlFor={checkboxId}
                className={`cl-check ${isLoaded ? "on" : ""}`}
              >
                <input
                  type="checkbox"
                  id={checkboxId}
                  checked={isLoaded}
                  disabled={saving || dispatched || loadBlocked}
                  onChange={(e) => onToggleLoaded(order, e.target.checked)}
                />
                {saving ? (
                  <Loader2 size={13} className="cl-spin" />
                ) : (
                  <span className="cl-check-text">
                    {isLoaded ? "Loaded" : "Confirm"}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>

      {DEPARTURE_PLANNER_ENABLED && !dispatched && <DeparturePlanner orders={group.orders} riderName={group.rider.name} routing={routing} />}

      {!tripHold.canFinalize && !dispatched ? (
        <p className="cl-hint">{tripHold.reason}</p>
      ) : heldOrders.length > 0 && !dispatched ? (
        <p className="cl-hint">
          {heldOrders.length === 1
            ? "One order cannot be dispatched yet (see its note), so this group is on hold."
            : `${heldOrders.length} orders cannot be dispatched yet (see their notes), so this group is on hold.`}
        </p>
      ) : (
        !group.allLoaded &&
        !dispatched && (
          <p className="cl-hint">Confirm all orders as loaded to enable dispatch.</p>
        )
      )}
      </div>

      <div className="cl-card-actions">
        <button
          type="button"
          className="cl-btn cl-btn-primary"
          disabled={!canFinalize}
          aria-disabled={!canFinalize}
          onClick={onFinalize}
        >
          {finalizing ? <Loader2 size={14} className="cl-spin" /> : <Truck size={14} />}
          {dispatched ? "Dispatched" : "Finalize dispatch"}
        </button>
      </div>
    </section>
  );
}

export default DispatcherCargoLoading;
