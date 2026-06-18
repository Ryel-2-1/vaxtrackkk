import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CirclePlay,
  MapPin,
  MoreVertical,
  Package,
  Truck,
  WifiOff,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import RiderLayout from "./RiderLayout";
import {
  startRiderDelivery,
  subscribeAssignedRiderOrders,
} from "../../services/orderService";

function RiderDashboard() {
  const navigate = useNavigate();

  const [assignedOrders, setAssignedOrders] = useState([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeAssignedRiderOrders(
      "rider_001",
      setAssignedOrders
    );

    return () => unsubscribe();
  }, []);

  const assignedOrder = assignedOrders[0];

  const handleStartDelivery = async () => {
    try {
      if (assignedOrder?.id) {
        setStarting(true);

        await startRiderDelivery(assignedOrder.id);

        localStorage.setItem("activeRiderOrderId", assignedOrder.id);
        localStorage.setItem("activeRiderOrder", JSON.stringify(assignedOrder));
      }

      navigate("/rider/geofence");
    } catch (error) {
      console.error("Start delivery error:", error);
      alert("Unable to start delivery. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <RiderLayout active="home">
      <section className="rider-dashboard-head">
        <div>
          <h2>Handa na ba, Juan?</h2>
          <p>Shift started at 08:00 AM</p>
        </div>

        <span className="rider-status-pill">
          <WifiOff size={13} />
          OFFLINE
        </span>
      </section>

      <section className="rider-next-card">
        <div className="rider-next-top">
          <span>NEXT DROP-OFF</span>
          <small>Est. 10:30 AM</small>
        </div>

        <h3>{assignedOrder?.clinicName || "Makati Medical Center"}</h3>

        <p>
          <MapPin size={14} />
          {assignedOrder?.clinicAddress ||
            "2 Amorsolo Street, Legazpi Village, Makati City"}
        </p>

        <div className="rider-tags">
          <span className="rider-tag">
            <Package size={13} />
            {assignedOrder?.storageTemp || "-70°C Cold Chain"}
          </span>

          <span className="rider-tag light">
            {assignedOrder
              ? `${assignedOrder.quantity} ${assignedOrder.unit || "vials"}`
              : "2 Pallets (150kg)"}
          </span>
        </div>
      </section>

      <button
        type="button"
        className="rider-primary-btn rider-start-btn"
        onClick={handleStartDelivery}
        disabled={starting}
      >
        <CirclePlay size={18} />
        {starting ? "Starting..." : "Start Delivery"}
      </button>

      <section className="rider-stat-grid">
        <div className="rider-stat-card">
          <div className="rider-stat-icon">
            <Truck size={19} />
          </div>
          <h3>{assignedOrders.length || 12}</h3>
          <p>Deliveries Today</p>
        </div>

        <div className="rider-stat-card">
          <div className="rider-stat-icon green">
            <CheckCircle2 size={19} />
          </div>
          <h3>
            0 <small>/ {assignedOrders.length || 12}</small>
          </h3>
          <p>Completed</p>
        </div>
      </section>

      <section className="rider-section-title">
        <h3>Route Overview</h3>
        <a>View Map</a>
      </section>

      <RouteCard
        number="1"
        title={assignedOrder?.clinicName || "Makati Medical Center"}
        note={assignedOrder ? "Assigned Delivery" : "Next Stop"}
      />

      <RouteCard
        number="2"
        title="St. Luke's Medical Center BGC"
        note="Pending"
        muted
      />
    </RiderLayout>
  );
}

function RouteCard({ number, title, note, muted }) {
  return (
    <div className="rider-route-card">
      <span className={`rider-route-number ${muted ? "muted" : ""}`}>
        {number}
      </span>

      <div>
        <strong>{title}</strong>
        <small>{note}</small>
      </div>

      <MoreVertical size={17} />
    </div>
  );
}

export default RiderDashboard;