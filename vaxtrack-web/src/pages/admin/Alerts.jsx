import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  MapPin,
  Package,
  Route,
  Search,
  ShieldAlert,
  Thermometer,
  Truck,
  XCircle,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

function Alerts() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const alerts = [
    {
      id: "ALT-001",
      type: "Route Deviation",
      message: "Rider 0412 moved outside the assigned delivery route.",
      source: "Delivery DEL-2026-002",
      severity: "Critical",
      time: "2 mins ago",
      icon: <Route size={17} />,
    },
    {
      id: "ALT-002",
      type: "Temperature Warning",
      message: "Cold-chain temperature report requires admin validation.",
      source: "Batch BT-2026-001",
      severity: "Warning",
      time: "8 mins ago",
      icon: <Thermometer size={17} />,
    },
    {
      id: "ALT-003",
      type: "Low Stock",
      message: "Sinovac stock is below the safe inventory threshold.",
      source: "Inventory Module",
      severity: "Warning",
      time: "15 mins ago",
      icon: <Package size={17} />,
    },
    {
      id: "ALT-004",
      type: "Delayed Delivery",
      message: "Pagsanjan delivery is estimated to arrive later than expected.",
      source: "Delivery DEL-2026-002",
      severity: "Notice",
      time: "22 mins ago",
      icon: <Truck size={17} />,
    },
    {
      id: "ALT-005",
      type: "Delivery Completed",
      message: "Rider 0225 successfully completed delivery to Lumban Clinic.",
      source: "Delivery DEL-2026-003",
      severity: "Resolved",
      time: "35 mins ago",
      icon: <CheckCircle2 size={17} />,
    },
  ];

  return (
    <div className="inventory-page">
      <AdminSidebar active="alerts" onLogout={handleLogout} />

      <main className="alerts-main">
        <header className="alerts-topbar">
          <div>
            <p>VaxTrack / Alert Center</p>
            <h1>Alerts</h1>
            <small>
              Review route deviations, cold-chain warnings, stock issues, and
              delivery notifications.
            </small>
          </div>

          <div className="alerts-actions">
            <button className="outline-btn">
              <CheckCircle2 size={16} />
              Mark All Read
            </button>

            <button className="blue-btn">
              <Bell size={16} />
              Alert Settings
            </button>
          </div>
        </header>

        <section className="alert-kpi-grid">
          <AlertKpi
            icon={<ShieldAlert size={22} />}
            label="Critical Alerts"
            value="1"
            note="Needs immediate action"
            type="red"
          />

          <AlertKpi
            icon={<AlertTriangle size={22} />}
            label="Warnings"
            value="2"
            note="Requires review"
            type="orange"
          />

          <AlertKpi
            icon={<Clock size={22} />}
            label="Pending Notices"
            value="1"
            note="For monitoring"
            type="blue"
          />

          <AlertKpi
            icon={<CheckCircle2 size={22} />}
            label="Resolved Today"
            value="6"
            note="Completed alerts"
            type="green"
          />
        </section>

        <section className="alerts-layout-grid">
          <div className="alerts-list-card">
            <div className="alerts-list-toolbar">
              <div>
                <h2>Recent Alerts</h2>
                <p>Latest system-generated admin notifications</p>
              </div>

              <div className="alerts-search">
                <Search size={16} />
                <input placeholder="Search alert type, rider, batch..." />
              </div>
            </div>

            <div className="alerts-list">
              {alerts.map((alert) => (
                <div
                  className={`alert-row ${getAlertClass(alert.severity)}`}
                  key={alert.id}
                >
                  <div className="alert-row-icon">{alert.icon}</div>

                  <div className="alert-row-content">
                    <div className="alert-row-title">
                      <h3>{alert.type}</h3>
                      <span>{alert.severity}</span>
                    </div>

                    <p>{alert.message}</p>

                    <div className="alert-row-meta">
                      <small>{alert.id}</small>
                      <small>{alert.source}</small>
                      <small>{alert.time}</small>
                    </div>
                  </div>

                  <button className="alert-view-btn">Review</button>
                </div>
              ))}
            </div>
          </div>

          <aside className="alerts-side-panel">
            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Alert Categories</h2>
                <p>System areas being monitored</p>
              </div>

              <div className="alert-category-stack">
                <CategoryItem
                  icon={<Route size={18} />}
                  title="Route Deviation"
                  count="1 active"
                  type="red"
                />

                <CategoryItem
                  icon={<Thermometer size={18} />}
                  title="Cold-chain Warning"
                  count="1 active"
                  type="orange"
                />

                <CategoryItem
                  icon={<Package size={18} />}
                  title="Inventory Warning"
                  count="1 active"
                  type="blue"
                />

                <CategoryItem
                  icon={<Truck size={18} />}
                  title="Delivery Status"
                  count="2 updates"
                  type="green"
                />
              </div>
            </div>

            <div className="alerts-panel-card">
              <div className="alerts-panel-header">
                <h2>Priority Action</h2>
                <p>Most urgent alert to review</p>
              </div>

              <div className="priority-alert-card">
                <div>
                  <XCircle size={24} />
                </div>

                <h3>Route deviation detected</h3>
                <p>
                  Rider 0412 is outside the assigned route. Admin should check
                  the delivery map and contact the rider if needed.
                </p>

                <button>
                  <MapPin size={15} />
                  View Location
                </button>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function AlertKpi({ icon, label, value, note, type }) {
  return (
    <div className={`alert-kpi ${type}`}>
      <div className="alert-kpi-icon">{icon}</div>

      <div>
        <p>{label}</p>
        <h2>{value}</h2>
        <small>{note}</small>
      </div>
    </div>
  );
}

function CategoryItem({ icon, title, count, type }) {
  return (
    <div className={`alert-category-item ${type}`}>
      <div>{icon}</div>

      <section>
        <strong>{title}</strong>
        <p>{count}</p>
      </section>
    </div>
  );
}

function getAlertClass(severity) {
  if (severity === "Critical") return "critical";
  if (severity === "Warning") return "warning";
  if (severity === "Resolved") return "resolved";
  return "notice";
}

export default Alerts;