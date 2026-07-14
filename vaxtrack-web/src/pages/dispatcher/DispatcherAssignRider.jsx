import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bike,
  CheckCircle2,
  Loader2,
  MapPin,
  Package,
  Phone,
  Snowflake,
  X,
} from "lucide-react";
import { assignRiderToOrder } from "../../services/orderService";
import { subscribeRiders } from "../../services/riderService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";
import StatusBadge from "../../components/ui/StatusBadge";

function initialsOf(name) {
  return (
    (name || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

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

  const selectedRider = approvedRiders.find((r) => r.uid === selectedRiderId) || null;
  const canAssign = !saving && !!selectedRiderId && !!selectedOrder;

  return (
    <DispatcherLayout active="assign-rider" title="VaxTrack Logistics">
      <div className="ar-page">
        <header className="ar-header">
          <button
            type="button"
            className="ar-back"
            onClick={() => navigate("/dispatcher")}
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1>Assign rider</h1>
            <p>
              Order {selectedOrder?.orderNumber || selectedOrder?.id || "—"}
            </p>
          </div>
        </header>

        {toast && (
          <div className={`ar-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? (
              <AlertTriangle size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )}
            <span>{toast}</span>
            <button type="button" onClick={() => setToast("")} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        <section className="ar-grid">
          <div className="ar-card">
            <div className="ar-card-head">
              <div>
                <h2>Available riders</h2>
                <p>{approvedRiders.length} ready for assignment</p>
              </div>
            </div>

            {ridersLoading ? (
              <div className="ar-state">
                <Loader2 size={22} className="spin" />
                <p>Loading riders...</p>
              </div>
            ) : ridersError ? (
              <div className="ar-state">
                <span className="ar-state-icon">
                  <AlertTriangle size={18} />
                </span>
                <strong>Could not load riders</strong>
                <p>{ridersError}</p>
              </div>
            ) : approvedRiders.length === 0 ? (
              <div className="ar-state">
                <span className="ar-state-icon">
                  <Bike size={18} />
                </span>
                <strong>No available riders</strong>
                <p>All riders are off-duty or pending approval.</p>
              </div>
            ) : (
              <div className="ar-rider-list">
                {approvedRiders.map((rider) => {
                  const name = getRiderName(rider);
                  const vehicle = getRiderVehicle(rider);
                  const empId = getRiderEmployeeId(rider);
                  const phone = getRiderPhone(rider);
                  const isSelected = selectedRiderId === rider.uid;

                  return (
                    <button
                      type="button"
                      key={rider.uid}
                      className={`ar-rider ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedRiderId(rider.uid)}
                    >
                      <span className="ar-avatar">{initialsOf(name)}</span>

                      <div className="ar-rider-info">
                        <strong>{name}</strong>
                        <small>
                          {vehicle} · ID {empId}
                        </small>
                        {phone && (
                          <small className="ar-rider-phone">
                            <Phone size={11} /> {phone}
                          </small>
                        )}
                      </div>

                      <span className="ar-chip available">Available</span>

                      <span className={`ar-radio ${isSelected ? "on" : ""}`}>
                        {isSelected && <CheckCircle2 size={18} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {otherRiders.length > 0 && (
              <div className="ar-unavailable">
                <h3>Unavailable ({otherRiders.length})</h3>
                <div className="ar-rider-list">
                  {otherRiders.map((rider) => {
                    const name = getRiderName(rider);
                    const vehicle = getRiderVehicle(rider);
                    const statusLabel =
                      rider.status === "disabled"
                        ? "Off duty"
                        : rider.status === "pending" || rider.status === "pending_approval"
                        ? "Pending approval"
                        : rider.status === "rejected"
                        ? "Rejected"
                        : rider.status;

                    return (
                      <div key={rider.uid} className="ar-rider disabled">
                        <span className="ar-avatar muted">{initialsOf(name)}</span>
                        <div className="ar-rider-info">
                          <strong>{name}</strong>
                          <small>{vehicle}</small>
                        </div>
                        <span className="ar-chip off">{statusLabel}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <aside className="ar-card ar-side">
            <div className="ar-card-head">
              <div>
                <h2>Order details</h2>
              </div>
            </div>

            {selectedOrder ? (
              <div className="ar-order">
                <div className="ar-order-top">
                  <StatusBadge statusKey={selectedOrder.statusKey || "pending_dispatch"} />
                  <span
                    className={`ar-priority ${
                      (selectedOrder.priority || "").toLowerCase() === "urgent" ? "urgent" : ""
                    }`}
                  >
                    {selectedOrder.priority || "Standard"}
                  </span>
                </div>

                <h3>{selectedOrder.vaccineName || "—"}</h3>

                <div className="ar-order-meta">
                  <span>
                    <Package size={13} />
                    {selectedOrder.quantity || 0} {selectedOrder.unit || "vials"}
                  </span>
                  {selectedOrder.storageTemp && (
                    <span>
                      <Snowflake size={13} />
                      {selectedOrder.storageTemp}
                    </span>
                  )}
                </div>

                <div className="ar-order-row">
                  <span>Destination</span>
                  <strong>
                    <MapPin size={13} /> {selectedOrder.clinicName || "—"}
                  </strong>
                  {selectedOrder.clinicAddress && <p>{selectedOrder.clinicAddress}</p>}
                </div>

                {selectedOrder.deliveryInstructions && (
                  <div className="ar-order-row">
                    <span>Instructions</span>
                    <p>{selectedOrder.deliveryInstructions}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="ar-state">
                <span className="ar-state-icon">
                  <Package size={18} />
                </span>
                <strong>No order selected</strong>
                <p>Go back to the dashboard and choose an order to assign.</p>
              </div>
            )}

            <div className="ar-assignee">
              <span>Assigning to</span>
              {selectedRider ? (
                <div className="ar-assignee-rider">
                  <span className="ar-avatar sm">{initialsOf(getRiderName(selectedRider))}</span>
                  <div>
                    <strong>{getRiderName(selectedRider)}</strong>
                    <small>{getRiderVehicle(selectedRider)}</small>
                  </div>
                </div>
              ) : (
                <p className="ar-assignee-empty">Select a rider from the list.</p>
              )}
            </div>

            <button
              type="button"
              className="ar-btn ar-btn-primary"
              onClick={handleConfirmAssignment}
              disabled={!canAssign}
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="spin" /> Assigning...
                </>
              ) : (
                "Confirm assignment"
              )}
            </button>

            <button
              type="button"
              className="ar-btn ar-btn-secondary"
              onClick={() => navigate("/dispatcher")}
            >
              Cancel
            </button>
          </aside>
        </section>
      </div>
    </DispatcherLayout>
  );
}

export default DispatcherAssignRider;
