import {
  AlertTriangle,
  MapPin,
  Navigation,
  Plus,
  RotateCw,
  ShieldAlert,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import RiderLayout from "./RiderLayout";
import { createRouteDeviationAlert } from "../../services/alertService";

function RiderDeviationAlert() {
  const navigate = useNavigate();
  const [reporting, setReporting] = useState(false);

const handleReportIssue = async () => {
  try {
    setReporting(true);

    const orderId = localStorage.getItem("activeRiderOrderId");

    await createRouteDeviationAlert({
      orderId,
      deliveryId: "#TRK-9824",
      riderId: "rider_001",
      riderName: "Juan Dela Cruz",
      location: "Quezon City",
      message:
        "Rider is outside the assigned delivery perimeter. Route deviation alert was reported from the rider app.",
    });

    alert("Route deviation alert sent to Dispatcher.");
  } catch (error) {
    console.error("Create alert error:", error);
    alert("Unable to send alert. Please try again.");
  } finally {
    setReporting(false);
  }
};

  return (
    <RiderLayout active="navigation">
      <section className="deviation-alert-box">
        <AlertTriangle size={20} />

        <div>
          <h2>Route Deviation Detected</h2>
          <p>
            You are outside the assigned delivery perimeter. Please return to
            the suggested route immediately to maintain compliance.
          </p>
        </div>
      </section>

      <section className="deviation-map-card">
        <div className="deviation-map">
          <div className="map-live-label">● Live Tracking: Deviated Path</div>

          <button className="map-mini-control plus" type="button">
            <Plus size={14} />
          </button>

          <button className="map-mini-control rotate" type="button">
            <RotateCw size={14} />
          </button>

          <div className="green-route"></div>
          <div className="red-route"></div>

          <span className="route-dot green one"></span>
          <span className="route-dot green two"></span>
          <span className="route-dot red one"></span>
          <span className="route-dot red two"></span>
        </div>

        <div className="deviation-details">
          <div>
            <span>SHIPMENT ID</span>
            <strong>#TRK-9824</strong>
          </div>

          <div>
            <span>DESTINATION</span>
            <strong>Quezon City</strong>
          </div>
        </div>
      </section>

      <div className="dual-actions top-space">
        <button
          type="button"
          className="rider-primary-btn"
          onClick={() => navigate("/rider/navigation")}
        >
          <Navigation size={15} />
          Navigate Route
        </button>

        <button type="button" className="rider-secondary-btn">
          <ShieldAlert size={15} />
          Report Issue
        </button>
      </div>

      <button type="button" className="rider-secondary-btn action-gap disabled">
        <MapPin size={15} />
        Mark Arrival
      </button>
    </RiderLayout>
  );
}

export default RiderDeviationAlert;