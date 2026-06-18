import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flag,
  Hash,
  MapPin,
  Navigation,
  Package,
  Play,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import RiderLayout from "./RiderLayout";

function RiderGeofence() {
  const navigate = useNavigate();

  return (
    <RiderLayout active="home">
      <section className="geofence-status-banner">
        <div className="geo-status-icon">
          <ShieldCheck size={19} />
        </div>

        <div>
          <h2>Route Status: Compliant</h2>
          <p>
            You are inside the assigned route geofence. GPS tracking is active
            and logging properly.
          </p>
        </div>
      </section>

      <section className="rider-info-card">
        <div className="rider-card-header">
          <span>LIVE TRACKING</span>
          <b>Updated 2m ago</b>
        </div>

        <div className="rider-map-preview">
          <div className="phone-map-mock">
            <div className="mock-road"></div>
            <div className="mock-zone"></div>
            <div className="mock-truck">
              <Truck size={18} />
            </div>
          </div>
        </div>
      </section>

      <section className="rider-info-card">
        <h3 className="section-label">CONSIGNMENT DETAILS</h3>

        <InfoRow icon={<Hash size={14} />} label="Delivery ID" value="DEL-49281-A" />
        <InfoRow icon={<Package size={14} />} label="Vaccine Batch" value="Sinovac-99" />
        <InfoRow icon={<Flag size={14} />} label="Destination" value="Makati Medical Center" />
        <InfoRow icon={<Clock size={14} />} label="Est. Arrival Time" value="10:30 AM" blue />
      </section>

      <button
        type="button"
        className="rider-primary-btn action-gap"
        onClick={() => navigate("/rider/navigation")}
      >
        <Play size={16} />
        Start Delivery
      </button>

      <div className="dual-actions">
        <button
          type="button"
          className="rider-outline-btn"
          onClick={() => navigate("/rider/navigation")}
        >
          <Navigation size={15} />
          Navigate Route
        </button>

        <button
          type="button"
          className="rider-outline-btn"
          onClick={() => navigate("/rider/deviation-alert")}
        >
          <AlertTriangle size={15} />
          Report Issue
        </button>
      </div>

      <button type="button" className="rider-secondary-btn action-gap">
        <MapPin size={15} />
        Mark Arrival
      </button>
    </RiderLayout>
  );
}

function InfoRow({ icon, label, value, blue }) {
  return (
    <div className="rider-info-row">
      <span>
        {icon}
        {label}
      </span>

      <strong className={blue ? "blue" : ""}>{value}</strong>
    </div>
  );
}

export default RiderGeofence;