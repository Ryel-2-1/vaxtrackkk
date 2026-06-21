import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeActiveAlerts } from "../../services/alertService";
import {
  AlertTriangle,
  Clock3,
  MapPin,
  Navigation,
  PackageCheck,
  ShieldCheck,
  Truck,
  UserPlus,
  UsersRound,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherDashboard() {
  const navigate = useNavigate();

  const [firestoreOrders, setFirestoreOrders] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);

  useEffect(() => {
    const unsubscribeOrders = subscribePendingDispatchOrders(setFirestoreOrders);
    const unsubscribeAlerts = subscribeActiveAlerts(setActiveAlerts);

    return () => {
      unsubscribeOrders();
      unsubscribeAlerts();
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

  const mockOrders = [
    {
      id: "#VT-9021",
      destination: "Central General Hospital",
      address: "District 4, Main St.",
      vaccine: "Pfizer-BioNTech",
      quantity: "1,200",
      unit: "Vials",
      priority: "Urgent",
    },
    {
      id: "#VT-9022",
      destination: "St. Mary Clinic",
      address: "North Suburb, Ave 12",
      vaccine: "Moderna Spikvax",
      quantity: "850",
      unit: "Vials",
      priority: "Standard",
    },
    {
      id: "#VT-9023",
      destination: "Cardinal Santos Medical Center",
      address: "San Juan, Metro Manila",
      vaccine: "Vaxipro Ultra-V Adult",
      quantity: "660",
      unit: "Vials",
      priority: "Urgent",
    },
  ];

  const orders = firestoreOrders.length > 0 ? firestoreOrders : mockOrders;
  const latestAlert = activeAlerts[0];

  const urgentOrders = orders.filter(
    (order) => (order.priority || "").toLowerCase() === "urgent"
  ).length;

  const availableRiders = 12;
  const activeDeliveries = 8;
  const delayedDeliveries = 2;

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

        <section className="dispatcher-dash-kpi-grid">
          <KpiCard
            icon={<PackageCheck size={22} />}
            label="Approved Orders"
            value={orders.length}
            note="Ready for dispatch"
          />

          <KpiCard
            icon={<UsersRound size={22} />}
            label="Available Riders"
            value={availableRiders}
            note="On-duty and available"
          />

          <KpiCard
            icon={<Truck size={22} />}
            label="Active Deliveries"
            value={activeDeliveries}
            note="Currently in transit"
          />

          <KpiCard
            icon={<AlertTriangle size={22} />}
            label="Urgent Orders"
            value={urgentOrders}
            note={`${delayedDeliveries} delayed routes`}
            danger
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
                <span className="green">{activeDeliveries} On-time</span>
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
                <small>NEXT ARRIVAL</small>
                <strong>St. Luke&apos;s Medical Center</strong>
                <p>12 mins away • 4.2 km</p>
              </div>

              <div className="dash-map-label danger">
                <small>CRITICAL DELAY</small>
                <strong>Cardinal Santos</strong>
                <p>Traffic halt • +15 mins</p>
              </div>
            </div>

            <div className="dispatcher-dash-monitor-footer">
              <MonitorInfo
                icon={<Navigation size={15} />}
                label="Primary Route"
                value="Main Hub-A → Quezon City"
              />

              <MonitorInfo
                icon={<Clock3 size={15} />}
                label="Average ETA"
                value="18 minutes"
              />

              <MonitorInfo
                icon={<ShieldCheck size={15} />}
                label="Cold-chain Status"
                value="Stable"
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
                text="Assign riders as soon as possible."
                danger={urgentOrders > 0}
              />

              <OperationItem
                title="Rider Availability"
                value={`${availableRiders} available`}
                text="Enough riders for current queue."
              />

              <OperationItem
                title="Route Condition"
                value={`${delayedDeliveries} delayed`}
                text="Monitor geofence and traffic alerts."
                warning
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
                {orders.map((order) => {
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
                          {order.clinicName || order.destination || "No destination"}
                        </strong>
                        <p>{order.clinicAddress || order.address || "No address"}</p>
                      </td>

                      <td>
                        <span className="dispatcher-dash-vaccine-dot"></span>
                        {order.vaccineName || order.vaccine || "No vaccine type"}
                      </td>

                      <td>
                        {order.quantity || 0} {order.unit || "Vials"}
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
                })}
              </tbody>
            </table>
          </div>

          <div className="dispatcher-dash-table-bottom">
            Showing {orders.length} pending dispatch orders
          </div>
        </section>
      </div>
    </DispatcherLayout>
  );
}

function KpiCard({ icon, label, value, note, danger }) {
  return (
    <div className={`dispatcher-dash-kpi ${danger ? "danger" : ""}`}>
      <div className="dispatcher-dash-kpi-icon">{icon}</div>

      <div>
        <p>{label}</p>
        <h2>{value}</h2>
        <span>{note}</span>
      </div>
    </div>
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