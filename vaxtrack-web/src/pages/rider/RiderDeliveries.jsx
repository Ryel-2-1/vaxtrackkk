import {
  CalendarDays,
  CheckCircle2,
  MapPin,
  Phone,
  Snowflake,
  Truck,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import RiderLayout from "./RiderLayout";

function RiderDeliveries() {
  const navigate = useNavigate();

  return (
    <RiderLayout active="deliveries">
      <section className="rider-page-heading">
        <h2>Deliveries</h2>
        <p>Today, Oct 24 • Shift A</p>
      </section>

      <div className="rider-tabs">
        <button className="active">Active (2)</button>
        <button>Upcoming (4)</button>
        <button>Completed (1)</button>
      </div>

      <section className="delivery-list">
        <DeliveryCard
          priority
          id="TRK-9824-A"
          title="Philippine General Hospital"
          distance="2.4 km"
          time="14 mins"
          temp="-70°C"
          vaccine="Pfizer BioNTech"
          details="200 Vials • Cold Chain Req."
          onStart={() => navigate("/rider/geofence")}
        />

        <DeliveryCard
          id="TRK-9825-B"
          title="Makati Medical Center"
          distance="5.1 km"
          time="28 mins"
          temp="2°C - 8°C"
          vaccine="AstraZeneca"
          details="150 Vials • Standard Fridge"
          onStart={() => navigate("/rider/geofence")}
        />
      </section>
    </RiderLayout>
  );
}

function DeliveryCard({
  priority,
  id,
  title,
  distance,
  time,
  temp,
  vaccine,
  details,
  onStart,
}) {
  return (
    <article className="delivery-card">
      <div className="delivery-card-head">
        <span>{id}</span>

        <b className={priority ? "priority" : "on-time"}>
          {priority ? "Priority" : "On Time"}
        </b>
      </div>

      <h3>{title}</h3>

      <div className="delivery-meta-row">
        <span>
          <MapPin size={12} />
          {distance}
        </span>

        <span>
          <CalendarDays size={12} />
          {time}
        </span>

        <span className="green">
          <Snowflake size={12} />
          {temp}
        </span>
      </div>

      <div className="delivery-product-box">
        <div className="delivery-product-icon">
          <Truck size={15} />
        </div>

        <div>
          <strong>{vaccine}</strong>
          <p>{details}</p>
        </div>
      </div>

      <div className="delivery-actions">
        <button type="button" className="rider-outline-btn compact">
          <Phone size={14} />
          Contact
        </button>

        <button type="button" className="rider-primary-btn compact" onClick={onStart}>
          Start Route
        </button>
      </div>
    </article>
  );
}

export default RiderDeliveries;