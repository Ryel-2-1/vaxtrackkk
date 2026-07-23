import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
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

// DOM-based marker (no image assets) — Leaflet's default icon PNGs break under
// bundlers, and a divIcon lets the marker use Meridian green via CSS.
// "geo3-live-*" names: the legacy removed fake-map CSS still defines
// .geo3-rider-marker with absolute left/top offsets that corrupt Leaflet's
// transform positioning.
const riderIcon = L.divIcon({
  className: "geo3-live-rider-marker",
  html: '<span class="geo3-live-rider-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const ACTIVE_STATUSES = new Set(["assigned", "loading", "in_transit", "delayed"]);

// A live-location fix older than this reads as stale — the rider stream is
// throttled to ~15s, so 2 minutes without an update means it has stopped
// (app backgrounded/closed, GPS lost, or delivery ended).
const STALE_LOCATION_MS = 2 * 60 * 1000;

function isLocationStale(ts) {
  if (!ts) return false;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() > STALE_LOCATION_MS;
}

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

// Handles both Firestore GeoPoint shapes (latitude/longitude and _lat/_long).
function getLatLng(geoPoint) {
  if (!geoPoint) return null;
  const lat = geoPoint.latitude ?? geoPoint._lat;
  const lng = geoPoint.longitude ?? geoPoint._long;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return [lat, lng];
}

// Rider-position-only map (Leaflet + OpenStreetMap tiles — no API key).
// Destination markers, geofence, and routes stay deferred until clinics
// have coordinates. Renders only when a lastLocation exists.
function RiderLocationMap({ lat, lng }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(mapRef.current);
    }

    mapRef.current.setView([lat, lng], 15);

    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { icon: riderIcon }).addTo(mapRef.current);
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }

    // Leaflet measures the container at construction time, which can happen
    // before flex layout settles — recalc after layout so the marker/center
    // aren't offset from the visible container. setTimeout (not rAF): rAF can
    // be suspended in embedded/headless panes.
    const map = mapRef.current;
    const timer = setTimeout(() => {
      map.invalidateSize();
      map.setView([lat, lng], 15, { animate: false });
    }, 50);
    return () => clearTimeout(timer);
  }, [lat, lng]);

  // Re-measure on viewport resize so the responsive height breakpoints
  // (480 / 390 / 320px) don't leave the map with stale dimensions (gray
  // strips / off-center tiles). ResizeObserver on the container also catches
  // sidebar/layout reflows, not just window resizes.
  useEffect(() => {
    const onResize = () => mapRef.current && mapRef.current.invalidateSize();
    window.addEventListener("resize", onResize);
    let ro;
    if (containerRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, []);

  // Tear the map down on unmount so HMR / re-selection never hits
  // "Map container is already initialized".
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
  }, []);

  // "geo3-live-map" (not "geo3-map") — the legacy removed fake-map CSS still
  // defines .geo3-map with a 520px gradient background, which would collide.
  return <div ref={containerRef} className="geo3-live-map" />;
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
            <strong>Live rider tracking shows position only.</strong>
            <p>
              The map displays the rider&apos;s last reported location while a
              delivery is in transit (foreground tracking). Geofence, route
              deviation, and destination markers will activate once clinics have
              coordinates. All data comes from Firestore.
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
                                {isLocationStale(selected.lastLocationUpdate) && (
                                  <span className="geo3-stale"> · Stale (no recent update)</span>
                                )}
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

                  {getLatLng(selected.lastLocation) && (
                    <div className="geo3-card geo3-live-map-card">
                      <h3>Live map</h3>
                      <RiderLocationMap
                        lat={getLatLng(selected.lastLocation)[0]}
                        lng={getLatLng(selected.lastLocation)[1]}
                      />
                      <p className="geo3-live-map-note">
                        Rider position only
                        {isLocationStale(selected.lastLocationUpdate)
                          ? " — last update is stale"
                          : ""}
                        . Destination markers and geofence require clinic
                        coordinates (deferred).
                      </p>
                    </div>
                  )}

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
