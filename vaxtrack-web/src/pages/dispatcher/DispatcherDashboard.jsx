import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeActiveAlerts } from "../../services/alertService";
import { isoDateOnly, manilaToday } from "../../services/deliveryCalendar";
import {
  AlertTriangle,
  Clock3,
  Info,
  Loader2,
  Navigation,
  PackageCheck,
  ShieldCheck,
  Truck,
  UserPlus,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";
import KpiCard from "../../components/ui/KpiCard";

// How a pending order relates to its requested delivery date, measured against
// today (Manila). `none` = the order carries no valid date; those are worked
// last since they have no schedule to honour.
function requestedDateMeta(order, today) {
  const iso = isoDateOnly(order?.requestedDeliveryDate);
  if (!iso) return { kind: "none", iso: null };
  if (iso < today) return { kind: "overdue", iso };
  if (iso === today) return { kind: "today", iso };
  return { kind: "scheduled", iso };
}

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

const createdMs = (o) => o.createdAt?.toMillis?.() ?? 0;
const isUrgentOrder = (o) => (o?.priority || "").toLowerCase() === "urgent";

// Dispatch order: honour the schedule first. Dated orders come before undated;
// among dated ones the soonest date leads (so overdue floats to the very top);
// within a single date urgent wins; oldest-waiting breaks any remaining tie.
// Date-only ISO strings sort correctly lexicographically, so "today" isn't
// needed here — an earlier date is always earlier in the queue.
function comparePending(a, b) {
  const isoA = isoDateOnly(a?.requestedDeliveryDate);
  const isoB = isoDateOnly(b?.requestedDeliveryDate);
  if ((isoA !== null) !== (isoB !== null)) return isoA !== null ? -1 : 1;
  if (isoA !== null && isoB !== null && isoA !== isoB) return isoA < isoB ? -1 : 1;
  const urgentDelta = (isUrgentOrder(a) ? 0 : 1) - (isUrgentOrder(b) ? 0 : 1);
  if (urgentDelta !== 0) return urgentDelta;
  return createdMs(a) - createdMs(b);
}

function DispatcherDashboard() {
  const navigate = useNavigate();

  const [pendingOrders, setPendingOrders] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [riders, setRiders] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let loaded = { pending: false, all: false, riders: false, alerts: false };
    const checkDone = () => {
      if (loaded.pending && loaded.all && loaded.riders && loaded.alerts) {
        setLoading(false);
      }
    };

    const unsubPending = subscribePendingDispatchOrders((orders) => {
      setPendingOrders(orders);
      loaded.pending = true;
      checkDone();
    });

    const unsubAll = subscribeDeliveries((orders) => {
      setAllOrders(orders);
      loaded.all = true;
      checkDone();
    }, (err) => {
      console.error("subscribeDeliveries error:", err);
      setError("Unable to load orders.");
      loaded.all = true;
      checkDone();
    });

    const unsubRiders = subscribeRiders((riderList) => {
      setRiders(riderList);
      loaded.riders = true;
      checkDone();
    }, (err) => {
      console.error("subscribeRiders error:", err);
      loaded.riders = true;
      checkDone();
    });

    let unsubAlerts;
    try {
      unsubAlerts = subscribeActiveAlerts(( alerts) => {
        setActiveAlerts(alerts);
        loaded.alerts = true;
        checkDone();
      });
    } catch {
      loaded.alerts = true;
      checkDone();
    }

    return () => {
      unsubPending();
      unsubAll();
      unsubRiders();
      if (unsubAlerts) unsubAlerts();
    };
  }, []);

  const handleAssignRider = (order) => {
    localStorage.setItem("selectedDispatchOrderId", order.id);
    localStorage.setItem("selectedDispatchOrder", JSON.stringify(order));
    navigate("/dispatcher/assign-rider");
  };

  const scrollToPendingQueue = () => {
    document
      .getElementById("pending-dispatch-queue")
      ?.scrollIntoView({ behavior: "smooth" });
  };

  const latestAlert = activeAlerts[0];

  const availableRiders = riders.filter((r) => r.status === "approved").length;
  const activeDeliveries = allOrders.filter(
    (o) => o.statusKey === "in_transit" || o.statusKey === "assigned" || o.statusKey === "loading"
  ).length;
  const delayedDeliveries = allOrders.filter((o) => o.statusKey === "delayed").length;
  const urgentOrders = pendingOrders.filter(
    (o) => (o.priority || "").toLowerCase() === "urgent"
  ).length;

  // Schedule-aware queue: sort by requested delivery date (soonest first, so
  // overdue rises to the top), urgent within a date, undated last.
  const today = manilaToday();
  const sortedPending = useMemo(
    () => [...pendingOrders].sort(comparePending),
    [pendingOrders]
  );
  const overdueCount = pendingOrders.filter(
    (o) => requestedDateMeta(o, today).kind === "overdue"
  ).length;
  const dueTodayCount = pendingOrders.filter(
    (o) => requestedDateMeta(o, today).kind === "today"
  ).length;

  if (loading) {
    return (
      <DispatcherLayout active="dashboard" title="Dashboard">
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading dispatch data...</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="dashboard" title="Dashboard">
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
              <p>
                {latestAlert.riderName} • {latestAlert.location} •{" "}
                {latestAlert.message}
              </p>
            </div>
          </section>
        )}

        {error && (
          <section className="dispatcher-dash-alert">
            <AlertTriangle size={18} />
            <div>
              <strong>Data Error</strong>
              <p>{error}</p>
            </div>
          </section>
        )}

        <section className="dispatcher-dash-kpi-grid">
          <KpiCard
            label="Pending orders"
            value={pendingOrders.length}
            context="Ready for dispatch"
            tone="neutral"
          />

          <KpiCard
            label="Available riders"
            value={availableRiders}
            context={`${riders.length} total registered`}
            tone="success"
          />

          <KpiCard
            label="Active deliveries"
            value={activeDeliveries}
            context="Currently in transit"
            tone="info"
          />

          <KpiCard
            label="Urgent orders"
            value={urgentOrders}
            context={delayedDeliveries > 0 ? `${delayedDeliveries} delayed routes` : "No delayed routes"}
            tone="danger"
            attention={urgentOrders > 0 || delayedDeliveries > 0}
          />
        </section>

        <section className="dispatcher-dash-main-grid">
          <div className="dispatcher-dash-monitor-card">
            <div className="dispatcher-dash-card-head">
              <div>
                <span className="card-kicker">Delivery monitoring</span>
                <h2>Active delivery overview</h2>
              </div>

              <div className="dispatcher-dash-badges">
                <span className="green">{activeDeliveries} active</span>
                <span className="red">{delayedDeliveries} delayed</span>
              </div>
            </div>

            <div className="dispatcher-dash-monitor-note">
              <Info size={16} />
              <div>
                <strong>Live map view not yet active.</strong>
                <p>
                  Route and geofence map tracking will activate once the Rider
                  mobile app begins sending location updates. The counts below
                  reflect real order and status data from Firestore.
                </p>
              </div>
            </div>

            <div className="dispatcher-dash-monitor-footer">
              <MonitorInfo
                icon={<Navigation size={15} />}
                label="Pending Orders"
                value={`${pendingOrders.length} awaiting`}
              />

              <MonitorInfo
                icon={<Clock3 size={15} />}
                label="Riders Available"
                value={`${availableRiders} on duty`}
              />

              <MonitorInfo
                icon={<ShieldCheck size={15} />}
                label="Delayed Routes"
                value={`${delayedDeliveries} delayed`}
              />
            </div>
          </div>

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
                value={`${urgentOrders} urgent orders`}
                text={urgentOrders > 0 ? "Assign riders as soon as possible." : "No urgent orders right now."}
                danger={urgentOrders > 0}
              />

              <OperationItem
                title="Rider Availability"
                value={`${availableRiders} available`}
                text={availableRiders >= pendingOrders.length ? "Enough riders for current queue." : "More riders needed for pending orders."}
              />

              <OperationItem
                title="Route Condition"
                value={`${delayedDeliveries} delayed`}
                text={delayedDeliveries > 0 ? "Monitor geofence and traffic alerts." : "All routes running smoothly."}
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
                  sortedPending.map((order) => {
                    const priority = order.priority || "Standard";
                    const isUrgent = priority.toLowerCase() === "urgent";
                    const dateMeta = requestedDateMeta(order, today);

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
                            <span className="dispatcher-dash-date none">
                              Unscheduled
                            </span>
                          ) : (
                            <span className={`dispatcher-dash-date ${dateMeta.kind}`}>
                              {dateMeta.kind === "overdue" && "Overdue · "}
                              {dateMeta.kind === "today" && "Today · "}
                              {shortDate(dateMeta.iso)}
                            </span>
                          )}
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
                          >
                            <UserPlus size={14} />
                            Assign Rider
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan="7">
                      <div className="dispatcher-empty-queue">
                        <PackageCheck size={28} />
                        <p>No pending orders. All orders have been assigned.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="dispatcher-dash-table-bottom">
            Showing {pendingOrders.length} pending dispatch order{pendingOrders.length !== 1 ? "s" : ""}
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
        </section>
      </div>
    </DispatcherLayout>
  );
}

function MonitorInfo({ icon, label, value }) {
  return (
    <div className="dispatcher-dash-monitor-info">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
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
