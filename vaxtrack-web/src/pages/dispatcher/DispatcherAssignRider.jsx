import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bike,
  CheckCircle,
  CheckCircle2,
  Circle,
  Loader2,
  MapPin,
  Package,
  Snowflake,
  X,
} from "lucide-react";
import { assignRiderToOrder } from "../../services/orderService";
import { subscribeRiders } from "../../services/riderService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherAssignRider() {
  const navigate = useNavigate();

  const [riders, setRiders] = useState([]);
  const [ridersLoading, setRidersLoading] = useState(true);
  const [ridersError, setRidersError] = useState("");

  const [selectedRiderId, setSelectedRiderId] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState("success");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("selectedDispatchOrder");
      if (stored) {
        setSelectedOrder(JSON.parse(stored));
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeRiders(
      (riderList) => {
        setRiders(riderList);
        setRidersLoading(false);
        setRidersError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setRidersError("No permission to view riders.");
        } else {
          setRidersError("Unable to load riders.");
        }
        setRidersLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const approvedRiders = riders.filter((r) => r.status === "approved");
  const otherRiders = riders.filter((r) => r.status !== "approved");

  const handleConfirmAssignment = async () => {
    const orderId = localStorage.getItem("selectedDispatchOrderId");
    if (!orderId) {
      showToast("No order selected. Go back to Dashboard.", "error");
      return;
    }

    const rider = approvedRiders.find((r) => r.uid === selectedRiderId);
    if (!rider) {
      showToast("Please select an available rider.", "error");
      return;
    }

    setSaving(true);
    setToast("");

    try {
      const user = auth.currentUser;
      const riderName = rider.fullName || rider.name || rider.displayName || rider.email;
      const riderPhone = rider.phone || rider.contactNumber || "";

      await assignRiderToOrder(
        orderId,
        { id: rider.uid, name: riderName, phone: riderPhone },
        { uid: user?.uid || null, email: user?.email || null }
      );

      showToast(`Rider ${riderName} assigned successfully.`, "success");

      localStorage.removeItem("selectedDispatchOrderId");
      localStorage.removeItem("selectedDispatchOrder");

      setTimeout(() => navigate("/dispatcher"), 1200);
    } catch (err) {
      console.error("Assign rider error:", err);
      showToast(err.message || "Unable to assign rider. Please try again.", "error");
    } finally {
      setSaving(false);
    }
  };

  const showToast = (msg, type) => {
    setToast(msg);
    setToastType(type);
  };

  const getRiderName = (r) => r.fullName || r.name || r.displayName || r.email || "Unknown";
  const getRiderVehicle = (r) => r.vehiclePlate || r.motorcycle || r.motorcycleId || r.vehicle || "Motorcycle";
  const getRiderPhone = (r) => r.phone || r.contactNumber || "";
  const getRiderEmployeeId = (r) => r.employeeId || r.uid?.slice(0, 8) || "—";

  return (
    <DispatcherLayout active="assign-rider" title="VaxTrack Logistics">
      <section className="assign-header">
        <button type="button" onClick={() => navigate("/dispatcher")}>
          <ArrowLeft size={17} />
        </button>

        <h1>
          Assign Rider: {selectedOrder?.orderNumber || selectedOrder?.id || "—"}
        </h1>
      </section>

      {toast && (
        <div className={`alerts-v2-toast ${toastType === "error" ? "error" : ""}`}>
          {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{toast}</span>
          <button type="button" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}

      <section className="assign-grid">
        <div className="available-riders-card">
          <h2>Available Riders ({approvedRiders.length})</h2>

          {ridersLoading ? (
            <div className="dispatcher-loading-state small">
              <Loader2 size={24} className="spin" />
              <p>Loading riders...</p>
            </div>
          ) : ridersError ? (
            <div className="dispatcher-loading-state small">
              <AlertTriangle size={24} />
              <p>{ridersError}</p>
            </div>
          ) : approvedRiders.length === 0 ? (
            <div className="dispatcher-loading-state small">
              <Bike size={24} />
              <p>No available riders. All riders are off-duty or pending approval.</p>
            </div>
          ) : (
            approvedRiders.map((rider) => {
              const name = getRiderName(rider);
              const vehicle = getRiderVehicle(rider);
              const empId = getRiderEmployeeId(rider);
              const phone = getRiderPhone(rider);

              return (
                <button
                  type="button"
                  key={rider.uid}
                  className={`rider-option ${selectedRiderId === rider.uid ? "selected" : ""}`}
                  onClick={() => setSelectedRiderId(rider.uid)}
                >
                  <div className="rider-image">🧑‍✈️</div>

                  <div className="rider-info">
                    <strong>{name}</strong>
                    <small>
                      <Bike size={12} /> {vehicle} <b>ID: {empId}</b>
                    </small>

                    {phone && (
                      <small className="rider-phone">📞 {phone}</small>
                    )}

                    <div className="rider-tags">
                      <span>Available</span>
                    </div>
                  </div>

                  {selectedRiderId === rider.uid ? (
                    <CheckCircle size={20} />
                  ) : (
                    <Circle size={20} />
                  )}
                </button>
              );
            })
          )}

          {otherRiders.length > 0 && (
            <>
              <h3 className="unavailable-riders-heading">
                Unavailable ({otherRiders.length})
              </h3>

              {otherRiders.map((rider) => {
                const name = getRiderName(rider);
                const vehicle = getRiderVehicle(rider);
                const statusLabel =
                  rider.status === "disabled" ? "Off Duty" :
                  rider.status === "pending" || rider.status === "pending_approval" ? "Pending Approval" :
                  rider.status === "rejected" ? "Rejected" : rider.status;

                return (
                  <button
                    type="button"
                    key={rider.uid}
                    className="rider-option"
                    disabled
                  >
                    <div className="rider-image">🧑‍🔧</div>

                    <div className="rider-info">
                      <strong>{name}</strong>
                      <small>
                        <Bike size={12} /> {vehicle}
                      </small>

                      <div className="rider-tags">
                        <span className="danger">{statusLabel}</span>
                      </div>
                    </div>

                    <Circle size={20} />
                  </button>
                );
              })}
            </>
          )}
        </div>

        <aside className="order-details-panel">
          <h2>Order Details</h2>

          {selectedOrder ? (
            <>
              <div className="order-summary-card">
                <span>
                  Priority: {selectedOrder.priority || "Standard"}{" "}
                  {(selectedOrder.priority || "").toLowerCase() === "urgent" && <Snowflake size={15} />}
                </span>
                <h3>{selectedOrder.vaccineName || "—"}</h3>
                <p>{selectedOrder.quantity || 0} {selectedOrder.unit || "vials"}</p>

                <div>
                  <small>
                    <Package size={13} /> {selectedOrder.quantity || 0} {selectedOrder.unit || "vials"}
                  </small>
                  {selectedOrder.storageTemp && (
                    <small>
                      <Snowflake size={13} /> {selectedOrder.storageTemp} Storage
                    </small>
                  )}
                </div>
              </div>

              <div className="delivery-route-info">
                <span>Destination</span>
                <strong>
                  <MapPin size={13} /> {selectedOrder.clinicName || "—"}
                </strong>
                {selectedOrder.clinicAddress && (
                  <p>{selectedOrder.clinicAddress}</p>
                )}
              </div>

              {selectedOrder.deliveryInstructions && (
                <div className="delivery-route-info">
                  <span>Instructions</span>
                  <p>{selectedOrder.deliveryInstructions}</p>
                </div>
              )}
            </>
          ) : (
            <div className="dispatcher-loading-state small">
              <Package size={24} />
              <p>No order data. Go back to Dashboard and select an order.</p>
            </div>
          )}

          <button
            className="dispatcher-blue-btn full"
            onClick={handleConfirmAssignment}
            disabled={saving || !selectedRiderId || !selectedOrder}
          >
            {saving ? (
              <>
                <Loader2 size={16} className="spin" /> Assigning...
              </>
            ) : (
              "Confirm Assignment"
            )}
          </button>

          <button
            className="dispatcher-outline-btn full"
            onClick={() => navigate("/dispatcher")}
          >
            Cancel
          </button>
        </aside>
      </section>
    </DispatcherLayout>
  );
}

export default DispatcherAssignRider;
