import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeActiveAlerts } from "../../services/alertService";
import { manilaToday } from "../../services/deliveryCalendar";
import {
  comparePending,
  dispatchEligibility,
  partitionPendingDispatch,
  requestedDateMeta,
  SCHEDULED_DATE_MISSING,
} from "../../services/dispatchEligibility";
import useManilaDayNow from "../../components/useManilaDayNow";
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  PackageCheck,
  Truck,
  UserPlus,
} from "lucide-react";
import KpiCard from "../../components/ui/KpiCard";
import { liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import DispatcherTrackingOverview from "../../components/tracking/DispatcherTrackingOverview";
import { availableRiderCount } from "../../services/riderTracking";
import { subscribeRiderDispatchStates } from "../../services/riderDispatchService";
import { assignmentBlockReason } from "../../services/backorder";
import { presentAlert } from "../../services/alertPresentation";
import { requestedArrivalLabel, requestedArrivalOf } from "../../services/requestedArrival";
import PageNav, { PAGE_SIZE } from "../../components/ui/PageNav";

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function DispatcherDashboard() {
  const navigate = useNavigate();
  const [queuePage, setQueuePage] = useState(1);

  const [pendingOrders, setPendingOrders] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [riders, setRiders] = useState([]);
  // Rider trips (server-owned): a Rider out on a trip or returning to the hub
  // is not available, even after their last delivery.
  const [tripStates, setTripStates] = useState(null);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Sources whose listener failed. Their figures show "—", never a zero
  // nothing measured. (A failed source also counts as settled, so one refused
  // listener can no longer hold the whole page on its loading state.)
  const [failed, setFailed] = useState({});
  const anyFailed = Object.values(failed).some(Boolean);
  const [assignNotice, setAssignNotice] = useState("");
  // Advances at each 00:00 Manila, so a scheduled order moves from Upcoming to
  // the actionable queue on its day without a reload.
  const now = useManilaDayNow();

  useEffect(() => {
    let loaded = { pending: false, all: false, riders: false, alerts: false };
    const checkDone = () => {
      if (loaded.pending && loaded.all && loaded.riders && loaded.alerts) {
        setLoading(false);
      }
    };

    // A listener that recovers clears its own failure (see AdminDashboard).
    const recover = (source) =>
      setFailed((prev) => (prev[source] ? { ...prev, [source]: false } : prev));

    const fail = (source, what) => (err) => {
      logSafeError(`Dispatcher dashboard subscription (${source})`, err);
      setError(liveErrorMessage(err, what));
      setFailed((prev) => ({ ...prev, [source]: true }));
      loaded[source] = true;
      checkDone();
    };

    const unsubPending = subscribePendingDispatchOrders((orders) => {
      setPendingOrders(orders);
      loaded.pending = true;
      recover("pending");
      checkDone();
    }, fail("pending", "the dispatch queue"));

    const unsubAll = subscribeDeliveries((orders) => {
      setAllOrders(orders);
      loaded.all = true;
      recover("all");
      checkDone();
    }, fail("all", "orders"));

    const unsubRiders = subscribeRiders((riderList) => {
      setRiders(riderList);
      loaded.riders = true;
      recover("riders");
      checkDone();
    }, fail("riders", "riders"));

    let unsubAlerts;
    try {
      unsubAlerts = subscribeActiveAlerts((alerts) => {
        setActiveAlerts(alerts);
        loaded.alerts = true;
        recover("alerts");
        checkDone();
      }, fail("alerts", "alerts"));
    } catch (err) {
      fail("alerts", "alerts")(err);
    }

    return () => {
      unsubPending();
      unsubAll();
      unsubRiders();
      if (unsubAlerts) unsubAlerts();
    };
  }, []);

  const handleAssignRider = (order) => {
    // Defensive: the button is only rendered for actionable orders, but a
    // screen left open across the boundary must still not hand one off early.
    // The assignment transaction and the rules re-check regardless.
    const schedule = dispatchEligibility(order, new Date());
    if (!schedule.eligible) {
      setAssignNotice(schedule.message);
      return;
    }
    // A future order that is not yet fully reserved cannot be assigned: there
    // is no partial dispatch. The rules refuse the write independently.
    const stockBlock = assignmentBlockReason(order);
    if (stockBlock) {
      setAssignNotice(stockBlock);
      return;
    }
    setAssignNotice("");
    localStorage.setItem("selectedDispatchOrderId", order.id);
    localStorage.setItem("selectedDispatchOrder", JSON.stringify(order));
    navigate("/dispatcher/assign-rider");
  };

  const scrollToPendingQueue = () => {
    document
      .getElementById("pending-dispatch-queue")
      ?.scrollIntoView({ behavior: "smooth" });
  };

  // Shared wording (names + human order code, never ids or an address).
  const latestAlert = activeAlerts[0] ? presentAlert(activeAlerts[0], { role: "dispatcher" }) : null;

  // Genuinely free riders: approved and not carrying an active delivery.
  useEffect(
    () =>
      subscribeRiderDispatchStates(setTripStates, () => {
        // Without trip states the count falls back to riders with no active order.
        setTripStates(null);
      }),
    []
  );
  const availableRiders = useMemo(
    () => availableRiderCount(riders, allOrders, tripStates),
    [riders, allOrders, tripStates]
  );
  const activeDeliveries = allOrders.filter(
    (o) => o.statusKey === "in_transit" || o.statusKey === "assigned" || o.statusKey === "loading"
  ).length;
  const delayedDeliveries = allOrders.filter((o) => o.statusKey === "delayed").length;

  // Only orders with a valid date whose day has begun (Manila) are dispatch
  // work. A future-dated order is Upcoming — visible, read-only, not counted.
  // An order with no date, or an unusable one, is in Needs scheduling —
  // equally read-only and uncounted until an admin stores a valid date.
  const { actionable, upcoming, missing, invalid } = useMemo(
    () => partitionPendingDispatch(pendingOrders, now),
    [pendingOrders, now]
  );
  const needsScheduling = useMemo(() => [...missing, ...invalid], [missing, invalid]);
  const urgentOrders = actionable.filter(
    (o) => (o.priority || "").toLowerCase() === "urgent"
  ).length;

  // A figure from a failed source is unknown, not zero.
  const shown = (sources, value) => (sources.some((s) => failed[s]) ? "—" : value);
  const pendingShown = shown(["pending"], actionable.length);
  const urgentShown = shown(["pending"], urgentOrders);
  const availableShown = shown(["riders", "all"], availableRiders);
  const activeShown = shown(["all"], activeDeliveries);
  const delayedShown = shown(["all"], delayedDeliveries);

  // Schedule-aware queue: sort by requested delivery date (soonest first, so
  // overdue rises to the top), urgent within a date, undated last.
  const today = manilaToday(now);
  const sortedPending = useMemo(
    () => [...actionable].sort(comparePending),
    [actionable]
  );
  const currentQueuePage = Math.min(queuePage, Math.max(1, Math.ceil(sortedPending.length / PAGE_SIZE)));
  const pagePending = sortedPending.slice((currentQueuePage - 1) * PAGE_SIZE, currentQueuePage * PAGE_SIZE);
  const sortedUpcoming = useMemo(
    () => [...upcoming].sort(comparePending),
    [upcoming]
  );
  const overdueCount = actionable.filter(
    (o) => requestedDateMeta(o, today).kind === "overdue"
  ).length;
  const dueTodayCount = actionable.filter(
    (o) => requestedDateMeta(o, today).kind === "today"
  ).length;

  if (loading) {
    return (
      <>
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading dispatch data...</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dispatcher-dash-page">
        <section className="dispatcher-dash-hero">
          <div>
            <span className="dispatcher-dash-eyebrow">
              Dispatch Control Center
            </span>
            <h2 className="disp-section-title">Operations overview</h2>
            <p>
              Review approved orders, monitor live deliveries, and assign riders
              for vaccine distribution.
            </p>
          </div>

          <div className="dispatcher-dash-hero-status">
            <span className="status-dot"></span>
            Real-time monitoring active
          </div>
        </section>

        {latestAlert && (
          <section className="dispatcher-dash-alert">
            <AlertTriangle size={18} />
            <div>
              <strong>{latestAlert.title}</strong>
              <p>{latestAlert.message}</p>
              {latestAlert.metaText && <small>{latestAlert.metaText}</small>}
            </div>
          </section>
        )}

        {assignNotice && (
          <section className="dispatcher-dash-alert" role="status">
            <CalendarClock size={18} />
            <div>
              <strong>Not yet dispatchable</strong>
              <p>{assignNotice}</p>
            </div>
          </section>
        )}

        {anyFailed && error && (
          <section className="dispatcher-dash-alert">
            <AlertTriangle size={18} />
            <div>
              <strong>Some dashboard data could not be loaded</strong>
              <p>{error}</p>
            </div>
          </section>
        )}

        <section className="dispatcher-dash-kpi-grid">
          <KpiCard
            label="Pending orders"
            value={pendingShown}
            context={
              [
                "Ready for dispatch",
                upcoming.length > 0 ? `${upcoming.length} upcoming` : null,
                needsScheduling.length > 0 ? `${needsScheduling.length} need scheduling` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            }
            tone="neutral"
          />

          <KpiCard
            label="Available riders"
            value={availableShown}
            context={failed.riders ? "Riders unavailable" : `${riders.length} total registered`}
            tone="success"
          />

          <KpiCard
            label="Active deliveries"
            value={activeShown}
            context="Currently in transit"
            tone="info"
          />

          <KpiCard
            label="Urgent orders"
            value={urgentShown}
            context={failed.all ? "Delayed deliveries unavailable" : delayedDeliveries > 0 ? `${delayedDeliveries} delayed ${delayedDeliveries === 1 ? "delivery" : "deliveries"}` : "No delayed deliveries"}
            tone="danger"
            attention={urgentOrders > 0 || delayedDeliveries > 0}
          />
        </section>

        <section className="dispatcher-dash-main-grid">
          <DispatcherTrackingOverview
            orders={allOrders}
            riders={riders}
            activeCount={activeShown}
            delayedCount={delayedShown}
            pendingCount={pendingShown}
            availableCount={availableShown}
          />

          <aside className="dispatcher-dash-side-card">
            <div className="dispatcher-dash-card-head small">
              <div>
                <span className="card-kicker">Today&apos;s Operations</span>
                <h2>Dispatch Summary</h2>
              </div>
            </div>

            <div className="dispatcher-dash-op-list">
              <OperationItem
                title="Priority Dispatch"
                value={`${urgentShown} urgent orders`}
                text={failed.pending ? "The dispatch queue could not be loaded." : urgentOrders > 0 ? "Assign riders as soon as possible." : "No urgent orders right now."}
                danger={urgentOrders > 0}
              />

              <OperationItem
                title="Rider Availability"
                value={`${availableShown} available`}
                text={availableShown === "—" || pendingShown === "—" ? "Rider availability could not be worked out." : availableRiders >= actionable.length ? "Enough riders for current queue." : "More riders needed for pending orders."}
              />

              <OperationItem
                title="Route Condition"
                value={`${delayedShown} delayed`}
                text={failed.all ? "Deliveries could not be loaded." : delayedDeliveries > 0 ? "Monitor geofence and traffic alerts." : "All routes running smoothly."}
                warning={delayedDeliveries > 0}
              />
            </div>

            <button
              type="button"
              className="dispatcher-dash-primary-btn"
              onClick={scrollToPendingQueue}
            >
              <UserPlus size={16} />
              Assign From Queue
            </button>

            <button
              type="button"
              className="dispatcher-dash-secondary-btn"
              onClick={() => navigate("/dispatcher/shipments")}
            >
              <Truck size={16} />
              View Shipments
            </button>
          </aside>
        </section>

        <section
          id="pending-dispatch-queue"
          className="dispatcher-dash-table-card"
        >
          <div className="dispatcher-dash-table-head">
            <div>
              <span className="card-kicker">Pending Dispatch Queue</span>
              <h2>Approved Orders Waiting for Rider Assignment</h2>
            </div>

            <div className="dispatcher-dash-live-pill">
              <span></span>
              Real-time update active
            </div>
          </div>

          <div className="dispatcher-dash-table-wrap">
            <table className="dispatcher-dash-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Destination</th>
                  <th>Vaccine Type</th>
                  <th>Quantity</th>
                  <th>Requested date</th>
                  <th>Priority</th>
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {sortedPending.length > 0 ? (
                  pagePending.map((order) => {
                    const priority = order.priority || "Standard";
                    const isUrgent = priority.toLowerCase() === "urgent";
                    const dateMeta = requestedDateMeta(order, today);
                    const stockBlock = assignmentBlockReason(order);

                    return (
                      <tr key={order.id}>
                        <td>
                          <strong className="order-id">
                            {order.orderNumber || order.id}
                          </strong>
                        </td>

                        <td>
                          <strong>
                            {order.clinicName || "No destination"}
                          </strong>
                          <p>{order.clinicAddress || ""}</p>
                        </td>

                        <td>
                          <span className="dispatcher-dash-vaccine-dot"></span>
                          {order.vaccineName || "—"}
                        </td>

                        <td>
                          {order.quantity || 0} {order.unit || "vials"}
                        </td>

                        <td>
                          {dateMeta.kind === "none" ? (
                            // Unreachable for an actionable order (every one
                            // has a valid date); kept so a bad row never
                            // renders as a blank cell.
                            <span className="dispatcher-dash-date none">
                              No date
                            </span>
                          ) : (
                            <span className={`dispatcher-dash-date ${dateMeta.kind}`}>
                              {dateMeta.kind === "overdue" && "Overdue · "}
                              {dateMeta.kind === "today" && "Today · "}
                              {shortDate(dateMeta.iso)}
                            </span>
                          )}
                          {/* Requested ARRIVAL at the destination that day. */}
                          <p className="dispatcher-dash-arrival">{requestedArrivalLabel(requestedArrivalOf(order))}</p>
                        </td>

                        <td>
                          <span
                            className={`dispatcher-dash-priority ${
                              isUrgent ? "urgent" : "standard"
                            }`}
                          >
                            {priority}
                          </span>
                        </td>

                        <td>
                          <button
                            type="button"
                            className="dispatcher-dash-assign-btn"
                            onClick={() => handleAssignRider(order)}
                            disabled={Boolean(stockBlock)}
                            aria-describedby={stockBlock ? `stock-block-${order.id}` : undefined}
                          >
                            <UserPlus size={14} />
                            {stockBlock ? "Waiting for stock" : "Assign Rider"}
                          </button>
                          {stockBlock && (
                            <small id={`stock-block-${order.id}`} className="dispatcher-stock-block">
                              {stockBlock}
                            </small>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan="7">
                      <div className="dispatcher-empty-queue">
                        <PackageCheck size={28} />
                        <p>
                          {failed.pending
                            ? "The dispatch queue could not be loaded. See the notice above."
                            : upcoming.length > 0 || needsScheduling.length > 0
                            ? "Nothing to dispatch right now. Orders waiting on a date are listed below."
                            : "No pending orders. All orders have been assigned."}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="dispatcher-dash-table-bottom">
            Showing {actionable.length === 0 ? 0 : (currentQueuePage - 1) * PAGE_SIZE + 1}–{Math.min(currentQueuePage * PAGE_SIZE, actionable.length)} of {actionable.length} pending dispatch orders
            {(overdueCount > 0 || dueTodayCount > 0) && (
              <span className="dispatcher-dash-table-bottom-meta">
                {overdueCount > 0 && (
                  <span className="dispatcher-dash-date overdue">
                    {overdueCount} overdue
                  </span>
                )}
                {dueTodayCount > 0 && (
                  <span className="dispatcher-dash-date today">
                    {dueTodayCount} due today
                  </span>
                )}
              </span>
            )}
          </div>
          {sortedPending.length > PAGE_SIZE && <PageNav page={currentQueuePage} total={sortedPending.length} onPageChange={setQueuePage} label="Dispatch queue pages" />}
        </section>

        <ReadOnlyQueue
          id="upcoming-dispatch-title"
          kicker="Upcoming · read-only"
          title="Scheduled for a later date"
          note="Each order joins the queue above at 00:00 (Manila) on its date."
          orders={sortedUpcoming}
          now={now}
        />

        <ReadOnlyQueue
          id="needs-scheduling-title"
          kicker="Needs scheduling · read-only"
          title="Orders without a usable delivery date"
          note="An admin must store a valid delivery date before these can be dispatched."
          orders={needsScheduling}
          now={now}
        />
      </div>
    </>
  );
}

// A pending order that is NOT dispatch work yet: shown so nothing is hidden,
// but with no dispatch control — the last column states why instead.
function ReadOnlyQueue({ id, kicker, title, note, orders, now }) {
  const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(orders.length / PAGE_SIZE)));
  const pageOrders = orders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  if (orders.length === 0) return null;
  return (
    <section
      className="dispatcher-dash-table-card dispatcher-dash-upcoming"
      aria-labelledby={id}
    >
      <div className="dispatcher-dash-table-head">
        <div>
          <span className="card-kicker">{kicker}</span>
          <h2 id={id}>{title}</h2>
        </div>
        <div className="dispatcher-dash-upcoming-note">
          <CalendarClock size={15} />
          {note}
        </div>
      </div>

      <div className="dispatcher-dash-table-wrap">
        <table className="dispatcher-dash-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Destination</th>
              <th>Vaccine Type</th>
              <th>Quantity</th>
              <th>Requested date</th>
              <th>Priority</th>
              <th>Dispatch</th>
            </tr>
          </thead>
          <tbody>
            {pageOrders.map((order) => {
              const priority = order.priority || "Standard";
              const schedule = dispatchEligibility(order, now);
              return (
                <tr key={order.id}>
                  <td>
                    <strong className="order-id">
                      {order.orderNumber || order.id}
                    </strong>
                  </td>
                  <td>
                    <strong>{order.clinicName || "No destination"}</strong>
                    <p>{order.clinicAddress || ""}</p>
                  </td>
                  <td>{order.vaccineName || "—"}</td>
                  <td>
                    {order.quantity || 0} {order.unit || "vials"}
                  </td>
                  <td>
                    {schedule.iso ? (
                      <span className="dispatcher-dash-date scheduled">
                        {shortDate(schedule.iso)}
                      </span>
                    ) : schedule.code === SCHEDULED_DATE_MISSING ? (
                      <span className="dispatcher-dash-date overdue">No date</span>
                    ) : (
                      <span className="dispatcher-dash-date overdue">Invalid date</span>
                    )}
                    <p className="dispatcher-dash-arrival">{requestedArrivalLabel(requestedArrivalOf(order))}</p>
                  </td>
                  <td>
                    <span
                      className={`dispatcher-dash-priority ${
                        priority.toLowerCase() === "urgent" ? "urgent" : "standard"
                      }`}
                    >
                      {priority}
                    </span>
                  </td>
                  <td>
                    <p className="dispatcher-dash-not-yet">{schedule.message}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {orders.length > PAGE_SIZE && <PageNav page={currentPage} total={orders.length} onPageChange={setPage} label={`${title} pages`} />}
    </section>
  );
}

function OperationItem({ title, value, text, danger, warning }) {
  return (
    <div
      className={`dispatcher-dash-op-item ${
        danger ? "danger" : warning ? "warning" : ""
      }`}
    >
      <div>
        <strong>{title}</strong>
        <span>{value}</span>
      </div>
      <p>{text}</p>
    </div>
  );
}

export default DispatcherDashboard;
