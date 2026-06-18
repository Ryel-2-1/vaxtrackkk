import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribePendingDispatchOrders } from "../../services/orderService";
import { subscribeActiveAlerts } from "../../services/alertService";
import { MapPin, PackageCheck, Truck, UserPlus } from "lucide-react";
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
  ];

  const orders = firestoreOrders.length > 0 ? firestoreOrders : mockOrders;
  const latestAlert = activeAlerts[0];

  return (
    <DispatcherLayout active="dashboard" title="VaxTrack Logistics">
      <div className="dispatcher-v2-page">
        <div className="dispatcher-v2-header">
          <h1>Dispatcher Dashboard</h1>
          <p>Review approved orders and assign logistical assets for delivery.</p>
        </div>

        {latestAlert && (
          <section className="dispatcher-demo-alert">
            <strong>{latestAlert.title}</strong>
            <p>
              {latestAlert.riderName} • {latestAlert.location} •{" "}
              {latestAlert.message}
            </p>
          </section>
        )}

        <section className="dispatcher-live-card">
          <div className="dispatcher-live-header">
            <div className="dispatcher-live-title">
              <MapPin size={15} />
              <span>Live Delivery Monitoring</span>
            </div>

            <div className="dispatcher-live-badges">
              <span className="on-time">8 ON-TIME</span>
              <span className="delayed">2 DELAYED</span>
            </div>
          </div>

          <div className="dispatcher-live-map">
            <div className="dispatcher-map-network"></div>

            <span className="dispatch-route route-a"></span>
            <span className="dispatch-route route-b"></span>
            <span className="dispatch-route route-c"></span>
            <span className="dispatch-route route-d"></span>
            <span className="dispatch-route route-e"></span>
            <span className="dispatch-route route-f"></span>

            <span className="dispatch-node n1"></span>
            <span className="dispatch-node n2"></span>
            <span className="dispatch-node n3"></span>
            <span className="dispatch-node n4"></span>
            <span className="dispatch-node n5"></span>
            <span className="dispatch-node n6"></span>
            <span className="dispatch-node n7"></span>
            <span className="dispatch-node n8"></span>
            <span className="dispatch-node n9"></span>

            <div className="dispatcher-map-info left">
              <small>NEXT ARRIVAL</small>
              <strong>St. Lukes Medical Center</strong>
              <p>12 mins away • 4.2km</p>
            </div>

            <div className="dispatcher-map-info right">
              <small>CRITICAL DELAY</small>
              <strong>Cardinal Santos</strong>
              <p>Traffic Halt • +15m</p>
            </div>
          </div>
        </section>

        <section className="dispatcher-v2-summary-grid">
          <div className="dispatcher-v2-stat-card">
            <div>
              <p>Approved Orders</p>
              <h2>{orders.length}</h2>
            </div>

            <div className="dispatcher-v2-stat-meta">
              <PackageCheck size={34} />
              <span>Ready for dispatch</span>
            </div>
          </div>

          <div className="dispatcher-v2-stat-card">
            <div>
              <p>Available Riders</p>
              <h2>12</h2>
            </div>

            <div className="dispatcher-v2-stat-meta">
              <Truck size={34} />
              <span>Ready to Dispatch</span>
            </div>
          </div>
        </section>

        <section className="dispatcher-v2-table-card">
          <div className="dispatcher-v2-table-head">
            <h3>Pending Dispatch Queue</h3>
            <div className="live-indicator">
              <span className="dot"></span>
              REAL-TIME UPDATE ACTIVE
            </div>
          </div>

          <div className="dispatcher-v2-table-wrap">
            <table className="dispatcher-v2-table">
              <thead>
                <tr>
                  <th>ORDER ID</th>
                  <th>DESTINATION</th>
                  <th>VACCINE TYPE</th>
                  <th>QUANTITY</th>
                  <th>PRIORITY</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>

              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="order-link">
                      {order.orderNumber || order.id}
                    </td>

                    <td>
                      <strong>{order.clinicName || order.destination}</strong>
                      <p>{order.clinicAddress || order.address}</p>
                    </td>

                    <td>
                      <span className="vaccine-dot"></span>
                      {order.vaccineName || order.vaccine}
                    </td>

                    <td>
                      {order.quantity} {order.unit || "Vials"}
                    </td>

                    <td>
                      <span
                        className={`priority-badge ${
                          order.priority === "Urgent" ? "urgent" : "standard"
                        }`}
                      >
                        {order.priority || "Standard"}
                      </span>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="assign-btn"
                        onClick={() => handleAssignRider(order)}
                      >
                        <UserPlus size={14} />
                        Assign Rider
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="dispatcher-v2-table-bottom">
            <span>Showing {orders.length} pending orders</span>

            <div className="pager-mini">
              <button type="button">‹</button>
              <button type="button">›</button>
            </div>
          </div>
        </section>

        <footer className="dispatcher-v2-footer">
          <span>© 2026 VaxTrack Logistics. All rights reserved.</span>

          <div>
            <a href="/">Privacy Policy</a>
            <a href="/">Terms of Service</a>
            <a href="/">Help Center</a>
          </div>
        </footer>
      </div>
    </DispatcherLayout>
  );
}

export default DispatcherDashboard;