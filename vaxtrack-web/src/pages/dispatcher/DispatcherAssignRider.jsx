import { useEffect, useState } from "react";
import { assignRiderToOrder } from "../../services/orderService";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bike,
  CheckCircle,
  Circle,
  MapPin,
  Package,
  Snowflake,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

const riders = [
 {
  id: "rider_001",
  name: "Juan Dela Cruz",
  vehicle: "Motorcycle",
  temp: "Available",
  tags: ["Available", "Cold-Chain Certified"],
  img: "🧑‍✈️",
  disabled: false,
},
  {
    id: "RR-8802",
    name: "Sarah Jenkins",
    vehicle: "Motorcycle",
    temp: "Available",
    tags: ["Available", "Fast Route Expert"],
    img: "👩‍✈️",
    disabled: false,
  },
  {
    id: "RR-1129",
    name: "David Okafor",
    vehicle: "Motorcycle",
    temp: "Unloading",
    tags: ["Unloading (9m)", "Vax-Certified"],
    img: "🧑‍🔧",
    disabled: true,
  },
];

function DispatcherAssignRider() {
  const navigate = useNavigate();
 const [selected, setSelected] = useState("rider_001");
const [selectedOrder, setSelectedOrder] = useState(null);
const [saving, setSaving] = useState(false);

useEffect(() => {
  const storedOrder = localStorage.getItem("selectedDispatchOrder");

  if (storedOrder) {
    setSelectedOrder(JSON.parse(storedOrder));
  }
}, []);

const handleConfirmAssignment = async () => {
  try {
    setSaving(true);

    const orderId = localStorage.getItem("selectedDispatchOrderId");
    const selectedRider = riders.find((rider) => rider.id === selected);

    if (!orderId) {
      alert("No selected order found. Please go back to Dispatcher Dashboard.");
      return;
    }

    await assignRiderToOrder(orderId, {
      id: selectedRider.id,
      name: selectedRider.name,
    });

    alert("Rider assigned successfully.");
    navigate("/dispatcher/shipments");
  } catch (error) {
    console.error("Assign rider error:", error);
    alert("Unable to assign rider. Please try again.");
  } finally {
    setSaving(false);
  }
};

  return (
    <DispatcherLayout active="assign-rider" title="VaxTrack Logistics">
      <section className="assign-header">
        <button type="button" onClick={() => navigate("/dispatcher")}>
          <ArrowLeft size={17} />
        </button>

        <h1>
        Assign Rider: {selectedOrder?.orderNumber || selectedOrder?.id || "#VT-9021"}
        </h1>
      </section>

      <section className="assign-grid">
        <div className="available-riders-card">
          <h2>Available Riders</h2>

          {riders.map((rider) => (
            <button
              type="button"
              key={rider.id}
              className={`rider-option ${selected === rider.id ? "selected" : ""}`}
              onClick={() => !rider.disabled && setSelected(rider.id)}
              disabled={rider.disabled}
            >
              <div className="rider-image">{rider.img}</div>

              <div className="rider-info">
                <strong>{rider.name}</strong>
                <small><Bike size={12} /> {rider.vehicle} <b>ID: {rider.id}</b></small>

                <div className="rider-tags">
                  {rider.tags.map((tag) => (
                    <span key={tag} className={tag.toLowerCase().includes("unloading") ? "danger" : ""}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {selected === rider.id ? <CheckCircle size={20} /> : <Circle size={20} />}
            </button>
          ))}
        </div>

        <aside className="order-details-panel">
          <h2>Order Details</h2>

          <div className="order-summary-card">
            <span>Priority: High <Snowflake size={15} /></span>
            <h3>{selectedOrder?.vaccineName || "Pfizer-BioNTech Vaccine"}</h3>
            <p>{selectedOrder?.quantity || 500} {selectedOrder?.unit || "Vials"}</p>

            <div>
              <small><Package size={13} /> 500 Vials / 5 Cartons</small>
              <small><Snowflake size={13} /> -70°C Storage Required</small>
            </div>
          </div>

          <div className="route-preview-map">
            <span className="route-point start"></span>
            <span className="route-point end"></span>
            <div className="route-preview-line one"></div>
            <div className="route-preview-line two"></div>
            <b>MANILA</b>
          </div>

          <div className="delivery-route-info">
            <span>Delivery Route</span>
            <strong><MapPin size={13} /> Main Distribution Hub-A</strong>
          </div>

          <button
          className="dispatcher-blue-btn full"
          onClick={handleConfirmAssignment}
          disabled={saving}
          >
          {saving ? "Assigning..." : "Confirm Assignment"}
          </button>

          <button className="dispatcher-outline-btn full" onClick={() => navigate("/dispatcher")}>
            Cancel
          </button>
        </aside>
      </section>
    </DispatcherLayout>
  );
}

export default DispatcherAssignRider;
