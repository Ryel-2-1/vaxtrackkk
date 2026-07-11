import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeActiveAlerts } from "../../services/alertService";
import {
  AlertTriangle,
  Clock3,
  Loader2,
  Navigation,
  PackageCheck,
  ShieldCheck,
  Truck,
  UserPlus,
  UsersRound,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";
import KpiCard from "../../components/ui/KpiCard";

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

  if (loading) {
    return (
      <DispatcherLayout active="dashboard" title="VaxTrack Logistics">
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading dispatch data...</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="dashboard" title="VaxTrack Logistics">
      <div className="dispatcher-dash-page">
        <section className="dispatcher-dash-hero">
          <div>
            <span className="dispatcher-dash-eyebrow">
              Dispatch Control Center
            </span>
            <h1>Dispatcher Dashboard</h1>
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
                <span className="card-kicker">Live Delivery Monitoring</span>
                <h2>Metro Manila Delivery Network</h2>
              </div>

              <div className="dispatcher-dash-badges">
                <span className="green">{activeDeliveries} Active</span>
                <span className="red">{delayedDeliveries} Delayed</span>
              </div>
            </div>

            <div className="dispatcher-dash-map">
              <div className="map-grid-bg"></div>

              <span className="dash-route dash-route-a"></span>
              <span className="dash-route dash-route-b"></span>
              <span className="dash-route dash-route-c"></span>
              <span className="dash-route dash-route-d"></span>
              <span className="dash-route dash-route-e"></span>

              <span className="dash-node node-a"></span>
              <span className="dash-node node-b"></span>
              <span className="dash-node node-c"></span>
              <span className="dash-node node-d"></span>
              <span className="dash-node node-e"></span>
              <span className="dash-node node-f"></span>

              <div className="dash-moving-rider">
                <Truck size={18} />
              </div>

              <div className="dash-map-label next">
                <small>DELIVERIES</small>
                <strong>{activeDeliveries} active</strong>
                <p>{delayedDeliveries} delayed</p>
              </div>

              {delayedDeliveries > 0 && (
                <div className="dash-map-label danger">
                  <small>DELAYED</small>
                  <strong>{delayedDeliveries} route{delayedDeliveries > 1 ? "s" : ""}</strong>
                  <p>Requires attention</p>
                </div>
              )}
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
                  <th>Priority</th>
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {pendingOrders.length > 0 ? (
                  pendingOrders.map((order) => {
                    const priority = order.priority || "Standard";
                    const isUrgent = priority.toLowerCase() === "urgent";

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
                    <td colSpan="6">
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
