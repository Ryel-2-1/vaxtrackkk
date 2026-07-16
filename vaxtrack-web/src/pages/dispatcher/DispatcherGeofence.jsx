import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  Flag,
  Info,
  Loader2,
  MapPin,
  Navigation,
  Package,
  User,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";
import { subscribeDeliveries } from "../../services/deliveryService";
import StatusBadge from "../../components/ui/StatusBadge";

const ACTIVE_STATUSES = new Set(["assigned", "loading", "in_transit", "delayed"]);

function formatRelativeTime(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCoords(geoPoint) {
  if (!geoPoint) return null;
  const lat = geoPoint.latitude ?? geoPoint._lat;
  const lng = geoPoint.longitude ?? geoPoint._long;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function DispatcherGeofence() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    const unsub = subscribeDeliveries(
      (all) => {
        setOrders(all);
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view live monitoring.");
        } else {
          setError("Unable to load live monitoring data.");
        }
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const activeOrders = useMemo(
    () => orders.filter((o) => ACTIVE_STATUSES.has(o.statusKey)),
    [orders]
  );

  useEffect(() => {
    if (activeOrders.length === 0) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!activeOrders.some((o) => o.id === selectedId)) {
      setSelectedId(activeOrders[0].id);
    }
  }, [activeOrders, selectedId]);

  const selected = activeOrders.find((o) => o.id === selectedId) || null;

  if (loading) {
    return (
      <DispatcherLayout active="geofence" title="Live Monitoring">
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading live monitoring...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="geofence" title="Live Monitoring">
        <div className="dispatcher-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="geofence" title="Live Monitoring">
      <section className="geo3-page">
        <div className="geo3-top-row">
          <div>
            <h1>Live Monitoring</h1>
            <p>Track active vaccine shipments in real time from Firestore orders.</p>
          </div>
        </div>

        <div className="geo3-info-banner">
          <Info size={16} />
          <div>
            <strong>Live GPS tracking not yet active.</strong>
            <p>
              Map view, geofence, and route deviation detection will activate once
              the Rider mobile app begins sending location updates. This page shows
              real order and status data from Firestore.
            </p>
          </div>
        </div>

        {activeOrders.length === 0 ? (
          <div className="dispatcher-empty-queue">
            <Package size={28} />
            <p>No active shipments to monitor right now.</p>
            <small>Orders with status Assigned, Loading, In Transit, or Delayed will appear here.</small>
          </div>
        ) : (
          <div className="geo3-grid">
            <div className="geo3-left">
              <div className="geo3-card geo3-status-card">
                <h3>Active Shipments ({activeOrders.length})</h3>
                <div className="geo3-order-list">
                  {activeOrders.map((order) => {
                    const isActive = order.id === selectedId;
                    return (
                      <button
                        key={order.id}
                        type="button"
                        className={`geo3-order-item ${isActive ? "active" : ""}`}
                        onClick={() => setSelectedId(order.id)}
                      >
                        <div className="geo3-order-item-head">
                          <strong>{order.orderNumber || order.id}</strong>
                          <StatusBadge statusKey={order.statusKey} label={order.statusLabel} />
                        </div>
                        <p>{order.clinicName || "—"}</p>
                        <small>
                          {order.assignedRiderName
                            ? `Rider: ${order.assignedRiderName}`
                            : "No rider assigned"}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="geo3-right">
              {selected ? (
                <>
                  <div className="geo3-card geo3-info-card">
                    <div className="geo3-card-head">
                      <h3>Shipment Details</h3>
                      <StatusBadge statusKey={selected.statusKey} label={selected.statusLabel} />
                    </div>

                    <div className="geo3-info-list">
                      <div className="geo3-info-row">
                        <User size={15} />
                        <div>
                          <span>Rider</span>
                          <strong>{selected.assignedRiderName || "Unassigned"}</strong>
                          {selected.assignedRiderPhone && (
                            <p>{selected.assignedRiderPhone}</p>
                          )}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Package size={15} />
                        <div>
                          <span>Order</span>
                          <strong>{selected.orderNumber || selected.id}</strong>
                          <p>
                            {selected.vaccineName || "—"} · {selected.quantity || 0}{" "}
                            {selected.unit || "vials"}
                          </p>
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Flag size={15} />
                        <div>
                          <span>Priority</span>
                          <strong>{selected.priority || "Standard"}</strong>
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <MapPin size={15} />
                        <div>
                          <span>Destination</span>
                          <strong>{selected.clinicName || "—"}</strong>
                          {selected.clinicAddress && <p>{selected.clinicAddress}</p>}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Navigation size={15} />
                        <div>
                          <span>Live Location</span>
                          {formatCoords(selected.lastLocation) ? (
                            <>
                              <strong>{formatCoords(selected.lastLocation)}</strong>
                              <p>
                                Updated{" "}
                                {formatRelativeTime(selected.lastLocationUpdate) || "—"}
                              </p>
                            </>
                          ) : (
                            <>
                              <strong className="geo3-muted">No live location yet</strong>
                              <p>Waiting for Rider mobile app location update.</p>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Clock3 size={15} />
                        <div>
                          <span>Last Status Update</span>
                          <strong>
                            {formatRelativeTime(
                              selected.statusUpdatedAt || selected.updatedAt
                            ) || "—"}
                          </strong>
                        </div>
                      </div>
                    </div>
                  </div>

                  {selected.deliveryInstructions && (
                    <div className="geo3-card geo3-timeline-card">
                      <h3>Delivery Instructions</h3>
                      <p style={{ fontSize: 13, color: "#475569", margin: 0 }}>
                        {selected.deliveryInstructions}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="geo3-card">
                  <p>Select a shipment to view details.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </DispatcherLayout>
  );
}

export default DispatcherGeofence;
