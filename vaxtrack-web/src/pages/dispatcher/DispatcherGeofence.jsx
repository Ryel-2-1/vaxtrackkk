import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Hash,
  Layers,
  MapPin,
  Minus,
  Plus,
  Route,
  ShieldAlert,
  Truck,
  User,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherGeofence() {
  return (
    <DispatcherLayout active="geofence" title="VaxTrack Logistics">
      <section className="geo2-wrap">
        <div className="geo2-header">
          <div>
            <h1>Geofence Monitoring Dashboard</h1>
            <p>Real-time tracking for critical medical shipments.</p>
          </div>

          <div className="geo2-alert">
            <div className="geo2-alert-icon">
              <AlertTriangle size={22} />
            </div>

            <div>
              <h3>Route Deviation Detected</h3>
              <p>
                Rider is outside the assigned geofence for Batch PFZ-2023-A01.
              </p>
            </div>
          </div>
        </div>

        <div className="geo2-view-route-row">
          <button type="button">View Route</button>
        </div>

        <div className="geo2-main-grid">
          <div className="geo2-left">
            <section className="geo2-status-card">
              <h2>Geofence Status</h2>

              <div className="geo2-status-options">
                <div className="geo2-status-box muted">
                  <ShieldAlert size={25} />
                  <span>Inside Route</span>
                </div>

                <div className="geo2-status-box danger">
                  <Route size={25} />
                  <span>Route Deviation Detected</span>
                </div>
              </div>
            </section>

            <section className="geo2-map-card">
              <div className="geo2-map">
                <div className="geo2-fence"></div>

                <div className="geo2-route-path">
                  <span className="geo2-checkpoint cp1"></span>
                  <span className="geo2-checkpoint cp2"></span>
                  <span className="geo2-checkpoint cp3"></span>
                  <span className="geo2-checkpoint cp4"></span>
                  <span className="geo2-checkpoint cp5"></span>
                </div>

                <div className="geo2-batch-label">Pfizer-BioNTech</div>

                <div className="geo2-offroute-line"></div>

                <div className="geo2-truck-marker">
                  <Truck size={20} />
                </div>

                <div className="geo2-warning-label">
                  <strong>TRK-9824</strong>
                  <span>⚠ 1.2km Off Route</span>
                </div>

                <div className="geo2-controls">
                  <button type="button">
                    <Plus size={18} />
                  </button>
                  <button type="button">
                    <Minus size={18} />
                  </button>
                  <button type="button">
                    <Layers size={18} />
                  </button>
                </div>

                <div className="geo2-legend">
                  <div>
                    <span className="dot"></span>
                    <p>Checkpoint</p>
                  </div>

                  <div>
                    <span className="line"></span>
                    <p>Planned Route</p>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <aside className="geo2-right">
            <section className="geo2-details-card">
              <div className="geo2-card-head">
                <h2>Route Details</h2>
                <span>Critical</span>
              </div>

              <DetailRow icon={<User size={15} />} label="Rider" value="Juan Dela Cruz" />

              <div className="geo2-split-row">
                <div>
                  <small>
                    <Hash size={13} />
                    Delivery ID
                  </small>
                  <strong>TRK-9824</strong>
                </div>

                <div>
                  <small>
                    <Hash size={13} />
                    Batch ID
                  </small>
                  <strong>PFZ-2023-A01</strong>
                </div>
              </div>

              <DetailRow
                icon={<MapPin size={15} />}
                label="Current Location"
                value="Quezon City (GPS Unverified)"
                danger="1.2km from Planned Route"
              />

              <DetailRow
                icon={<MapPin size={15} />}
                label="Destination"
                value="Makati Medical Center"
              />

              <DetailRow
                icon={<Clock3 size={15} />}
                label="Last GPS Update"
                value="2m ago"
              />
            </section>

            <section className="geo2-timeline-card">
              <h2>Delivery Timeline</h2>

              <TimelineItem done title="Warehouse Departure" time="08:00 AM" />
              <TimelineItem done title="Checkpoint 1: EDSA" time="08:30 AM" />
              <TimelineItem danger title="Out of Route Detected" time="08:45 AM • Automated Alert" />
              <TimelineItem title="Clinic Arrival" time="Pending" />
              <TimelineItem title="Delivery Completed" time="Pending" />
            </section>
          </aside>
        </div>
      </section>
    </DispatcherLayout>
  );
}

function DetailRow({ icon, label, value, danger }) {
  return (
    <div className="geo2-detail-row">
      <span>{icon}</span>

      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {danger && <p>{danger}</p>}
      </div>
    </div>
  );
}

function TimelineItem({ title, time, done = false, danger = false }) {
  return (
    <div
      className={`geo2-timeline-item ${done ? "done" : ""} ${
        danger ? "danger" : ""
      }`}
    >
      <span>
        {done && <CheckCircle2 size={14} />}
        {danger && <AlertTriangle size={13} />}
      </span>

      <div>
        <strong>{title}</strong>
        <small>{time}</small>
      </div>
    </div>
  );
}

export default DispatcherGeofence;