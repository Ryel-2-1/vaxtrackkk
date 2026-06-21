import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Flag,
  Hash,
  Layers3,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCcw,
  ShieldAlert,
  Truck,
  User,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherGeofence() {
  const [zoomLevel, setZoomLevel] = useState(1);
  const [mapLayer, setMapLayer] = useState("standard");
  const [showRoute, setShowRoute] = useState(true);
  const [selectedStatus, setSelectedStatus] = useState("deviation");
  const [lastUpdated, setLastUpdated] = useState("2m ago");

  const delivery = {
    rider: "Juan Dela Cruz",
    deliveryId: "TRK-9824",
    batchId: "PFZ-2023-A01",
    currentLocation: "Quezon City (GPS Unverified)",
    offRouteDistance: "1.2km from Planned Route",
    destination: "Makati Medical Center",
    primaryRoute: "Main Hub-A → Quezon City",
    eta: "18 minutes",
    coldChain: "Stable",
    nextArrival: "St. Luke's Medical Center",
    criticalDelay: "Cardinal Santos",
  };

  const timeline = [
    { label: "Warehouse Departure", time: "08:00 AM", state: "done" },
    { label: "Checkpoint 1: EDSA", time: "08:30 AM", state: "done" },
    { label: "Out of Route Detected", time: "08:45 AM · Automated Alert", state: "alert" },
    { label: "Clinic Arrival", time: "Pending", state: "pending" },
    { label: "Delivery Completed", time: "Pending", state: "pending" },
  ];

  const handleZoomIn = () => {
    setZoomLevel((current) => Math.min(current + 0.1, 1.3));
  };

  const handleZoomOut = () => {
    setZoomLevel((current) => Math.max(current - 0.1, 0.9));
  };

  const handleLayerToggle = () => {
    setMapLayer((current) => (current === "standard" ? "satellite" : "standard"));
  };

  const handleRefresh = () => {
    setLastUpdated("Just now");
  };

  return (
    <DispatcherLayout active="geofence" title="Geofence Monitoring Dashboard">
      <section className="geo3-page">
        <div className="geo3-top-row">
          <div>
            <h1>Geofence Monitoring Dashboard</h1>
            <p>Real-time tracking for critical medical shipments.</p>
          </div>

          <div className={`geo3-alert-banner ${selectedStatus === "inside" ? "safe" : ""}`}>
            <div className="geo3-alert-icon">
              {selectedStatus === "inside" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            </div>
            <div>
              <strong>
                {selectedStatus === "inside" ? "Rider Inside Assigned Route" : "Route Deviation Detected"}
              </strong>
              <p>
                {selectedStatus === "inside"
                  ? "Rider is currently inside the assigned geofence and route corridor."
                  : `Rider is outside the assigned geofence for Batch ${delivery.batchId}.`}
              </p>
            </div>
          </div>
        </div>

        <div className="geo3-header-actions">
          <button type="button" className="geo3-view-route-btn" onClick={() => setShowRoute((current) => !current)}>
            <Navigation size={15} />
            {showRoute ? "Hide Route" : "View Route"}
          </button>

          <button type="button" className="geo3-refresh-btn" onClick={handleRefresh}>
            <RefreshCcw size={15} />
            Refresh GPS
          </button>
        </div>

        <div className="geo3-grid">
          <div className="geo3-left">
            <div className="geo3-card geo3-status-card">
              <h3>Geofence Status</h3>

              <div className="geo3-status-options">
                <button
                  type="button"
                  className={`geo3-status-box muted ${selectedStatus === "inside" ? "active-safe" : ""}`}
                  onClick={() => setSelectedStatus("inside")}
                >
                  <LocateFixed size={20} />
                  <span>Inside Route</span>
                </button>

                <button
                  type="button"
                  className={`geo3-status-box danger ${selectedStatus === "deviation" ? "active" : ""}`}
                  onClick={() => setSelectedStatus("deviation")}
                >
                  <ShieldAlert size={20} />
                  <span>Route Deviation Detected</span>
                </button>
              </div>
            </div>

            <div className="geo3-card geo3-map-card">
              <div className={`geo3-map ${mapLayer} ${showRoute ? "show-route" : "hide-route"}`}>
                <div className="geo3-map-controls">
                  <button type="button" onClick={handleZoomIn} title="Zoom in">
                    <ZoomIn size={18} />
                  </button>
                  <button type="button" onClick={handleZoomOut} title="Zoom out">
                    <ZoomOut size={18} />
                  </button>
                  <button type="button" onClick={handleLayerToggle} title="Toggle map layer">
                    <Layers3 size={18} />
                  </button>
                </div>

                <div className="geo3-layer-badge">
                  {mapLayer === "standard" ? "Standard View" : "Satellite View"} · {Math.round(zoomLevel * 100)}%
                </div>

                <div className="geo3-map-canvas" style={{ transform: `scale(${zoomLevel})` }}>
                  <div className="geo3-road road-1" />
                  <div className="geo3-road road-2" />
                  <div className="geo3-road road-3" />
                  <div className="geo3-road road-4" />

                  <div className="geo3-geofence-shape" />

                  <div className="geo3-route-line route-a" />
                  <div className="geo3-route-line route-b" />
                  <div className="geo3-route-line route-c" />
                  <div className="geo3-route-line route-deviation" />

                  <span className="geo3-checkpoint cp1" />
                  <span className="geo3-checkpoint cp2" />
                  <span className="geo3-checkpoint cp3" />
                  <span className="geo3-checkpoint cp4" />
                  <span className="geo3-checkpoint cp5" />

                  <div className="geo3-tag geo3-route-tag">Assigned Route</div>

                  <div className={`geo3-rider-marker ${selectedStatus === "inside" ? "safe" : ""}`}>
                    <Truck size={15} />
                  </div>

                  <div className="geo3-rider-label">
                    <strong>{delivery.deliveryId}</strong>
                    <p>{selectedStatus === "inside" ? "Inside Route" : `⚠ ${delivery.offRouteDistance}`}</p>
                  </div>
                </div>

                <div className="geo3-next-arrival">
                  <span>NEXT ARRIVAL</span>
                  <strong>{delivery.nextArrival}</strong>
                  <p>12 mins away • 4.2 km</p>
                </div>

                <div className="geo3-critical-delay">
                  <span>CRITICAL DELAY</span>
                  <strong>{delivery.criticalDelay}</strong>
                  <p>Traffic halt • +15 mins</p>
                </div>

                <div className="geo3-map-legend">
                  <div><span className="dot green"></span> Checkpoint</div>
                  <div><span className="line green"></span> Planned Route</div>
                  <div><span className="line red"></span> Off Route</div>
                </div>
              </div>

              <div className="geo3-map-footer">
                <div>
                  <span>PRIMARY ROUTE</span>
                  <strong>{delivery.primaryRoute}</strong>
                </div>
                <div>
                  <span>AVERAGE ETA</span>
                  <strong>{delivery.eta}</strong>
                </div>
                <div>
                  <span>COLD-CHAIN STATUS</span>
                  <strong>{delivery.coldChain}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="geo3-right">
            <div className="geo3-card geo3-info-card">
              <div className="geo3-card-head">
                <h3>Route Details</h3>
                <span className={`geo3-badge ${selectedStatus === "inside" ? "stable" : "critical"}`}>
                  {selectedStatus === "inside" ? "Stable" : "Critical"}
                </span>
              </div>

              <div className="geo3-info-list">
                <div className="geo3-info-row">
                  <User size={15} />
                  <div>
                    <span>Rider</span>
                    <strong>{delivery.rider}</strong>
                  </div>
                </div>

                <div className="geo3-info-split">
                  <div className="geo3-mini-box">
                    <Hash size={15} />
                    <div>
                      <span>Delivery ID</span>
                      <strong>{delivery.deliveryId}</strong>
                    </div>
                  </div>

                  <div className="geo3-mini-box">
                    <Hash size={15} />
                    <div>
                      <span>Batch ID</span>
                      <strong>{delivery.batchId}</strong>
                    </div>
                  </div>
                </div>

                <div className="geo3-info-row">
                  <MapPin size={15} />
                  <div>
                    <span>Current Location</span>
                    <strong>{delivery.currentLocation}</strong>
                    <p className={selectedStatus === "inside" ? "safe-text" : ""}>
                      {selectedStatus === "inside" ? "Within planned route corridor" : `-${delivery.offRouteDistance}`}
                    </p>
                  </div>
                </div>

                <div className="geo3-info-row">
                  <Flag size={15} />
                  <div>
                    <span>Destination</span>
                    <strong>{delivery.destination}</strong>
                  </div>
                </div>

                <div className="geo3-info-row">
                  <Clock3 size={15} />
                  <div>
                    <span>Last GPS Update</span>
                    <strong>{lastUpdated}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div className="geo3-card geo3-timeline-card">
              <h3>Delivery Timeline</h3>

              <div className="geo3-timeline">
                {timeline.map((item) => (
                  <div
                    key={item.label}
                    className={`geo3-timeline-item ${item.state}`}
                  >
                    <div className="geo3-timeline-dot" />
                    <div className="geo3-timeline-content">
                      <strong>{item.label}</strong>
                      <p>{item.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </DispatcherLayout>
  );
}

export default DispatcherGeofence;
