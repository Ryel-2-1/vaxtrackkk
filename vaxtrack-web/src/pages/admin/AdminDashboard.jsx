import "./AdminDashboard.css";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Clock,
  Layers,
  Minus,
  Plus,
  Search,
  ShieldAlert,
  Truck,
  Users,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

function AdminDashboard() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="dashboard" onLogout={handleLogout} />

      <main className="v2-admin-main">
        <header className="v2-admin-topbar">
          <p>VaxTrack Logistics Command</p>

          <div className="v2-admin-search">
            <Search size={14} />
            <input placeholder="Search health unit, shipment, or rider..." />
          </div>

          <div className="v2-admin-icons">
            <button type="button">
              <Bell size={15} />
            </button>

            <button type="button">
              <ShieldAlert size={15} />
            </button>
          </div>
        </header>

        <section className="v2-alert-banner">
          <div className="v2-alert-icon">
            <AlertTriangle size={18} />
          </div>

          <div>
            <strong>Route Deviation Detected</strong>
            <p>
              Shipment RTX-9824 has moved 1.2km outside the assigned delivery
              perimeter in Quezon City.
            </p>
          </div>

          <button type="button" className="v2-red-btn">
            Inspect Now
          </button>

          <button type="button" className="v2-dismiss-btn">
            Dismiss
          </button>
        </section>

        <section className="v2-admin-grid">
          <div className="v2-tracking-column">
            <div className="v2-map-card">
              <div className="v2-map-title">
                <span></span>
                Live Tracking: Arby Barruevo
              </div>

              <div className="v2-live-map">
                <div className="v2-planned-route"></div>
                <div className="v2-current-route"></div>

                <span className="v2-map-dot start"></span>
                <span className="v2-map-dot middle"></span>

                <span className="v2-map-dot rider">
                  <Truck size={15} />
                </span>

                <div className="v2-map-controls">
                  <button type="button">
                    <Plus size={22} strokeWidth={2.4} />
                  </button>

                  <button type="button">
                    <Minus size={22} strokeWidth={2.4} />
                  </button>

                  <button type="button">
                    <Layers size={21} strokeWidth={2.4} />
                  </button>
                </div>

                <div className="v2-map-legend">
                  <span>
                    <i className="planned"></i>
                    Planned Path
                  </span>

                  <span>
                    <i className="current"></i>
                    Current Deviation
                  </span>
                </div>
              </div>
            </div>

            <section className="v2-stats-grid">
              <MetricCard
                icon={<Truck size={18} />}
                value="42"
                label="Active Deliveries"
                trend="+15%"
                type="blue"
              />

              <MetricCard
                icon={<Clock size={18} />}
                value="3"
                label="Delayed / Missing"
                trend="-2%"
                type="amber"
              />

              <MetricCard
                icon={<AlertTriangle size={18} />}
                value="5"
                label="Low Stock / Critical"
                trend="-8.5%"
                type="red"
              />

              <MetricCard
                icon={<Users size={18} />}
                value="28"
                label="Riders Online"
                trend="+6%"
                type="green"
              />
            </section>
          </div>

          <aside className="v2-rider-panel">
            <div className="v2-rider-avatar"></div>

            <div>
              <h3>Arby Barruevo</h3>
              <p>Rider ID: RTX-9824</p>
            </div>

            <div className="v2-rider-info">
              <div>
                <span>Delivery ID</span>
                <strong>RTX-9824</strong>
              </div>

              <div>
                <span>Current Location</span>
                <strong>Quezon City</strong>
              </div>
            </div>

            <button type="button" className="v2-outline-full">
              View Full Route History
            </button>

            <div className="v2-recent-alerts">
              <div className="v2-section-head">
                <h4>Recent Alerts</h4>
                <button type="button">All</button>
              </div>

              <AlertItem
                type="critical"
                title="Route Deviation"
                desc="Delivery moved outside the expected delivery path."
                time="3 min ago"
              />

              <AlertItem
                type="warning"
                title="Late Arrival"
                desc="ETA delayed by 15 minutes due to traffic."
                time="8 min ago"
              />

              <AlertItem
                type="success"
                title="Cold Storage"
                desc="Temperature successfully stabilized to 3.8°C."
                time="15 min ago"
              />
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function MetricCard({ icon, value, label, trend, type }) {
  return (
    <div className={`v2-metric-card ${type}`}>
      <div className="v2-metric-icon">{icon}</div>

      <div className="v2-trend">{trend}</div>

      <h2>{value}</h2>
      <p>{label}</p>
    </div>
  );
}

function AlertItem({ title, desc, time, type }) {
  return (
    <div className={`v2-alert-item ${type}`}>
      <strong>{title}</strong>
      <p>{desc}</p>
      <small>{time}</small>
    </div>
  );
}

export default AdminDashboard;