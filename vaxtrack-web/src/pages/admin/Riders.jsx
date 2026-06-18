import "./Riders.css";

import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  CheckCircle2,
  Clock,
  HelpCircle,
  MapPin,
  Navigation,
  Plus,
  Search,
  Truck,
  UserRound,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

function Riders() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const riders = [
    {
      name: "Juan Dela Cruz",
      plate: "MCV-1234",
      vehicle: "Rider",
      status: "On Delivery",
      delivery: "VAX-9821",
      destination: "Sta. Lucia RHU",
      badge: "Active",
      type: "active",
    },
    {
      name: "Maria Reyes",
      plate: "VAX-990",
      vehicle: "Van",
      status: "Available at Hub",
      delivery: "Last active: 2 mins ago",
      destination: "",
      badge: "Standby",
      type: "standby",
    },
    {
      name: "Peter Santos",
      plate: "TXU-4455",
      vehicle: "Auto",
      status: "Offline",
      delivery: "Shift ended: 14:00",
      destination: "",
      badge: "Off Duty",
      type: "offline",
    },
  ];

  return (
    <div className="inventory-page">
      <AdminSidebar active="riders" onLogout={handleLogout} />

      <main className="riders-main compact-riders">
        <header className="compact-page-header">
          <div>
            <h1>Riders Management</h1>
            <p>Monitor field personnel and cold-chain assignments.</p>
          </div>

          <div className="compact-header-actions">
            <div className="compact-search">
              <Search size={14} />
              <input placeholder="Search riders..." />
            </div>

            <button className="small-icon-btn">
              <Bell size={15} />
            </button>

            <button className="small-icon-btn">
              <HelpCircle size={15} />
            </button>

            <button className="compact-primary-btn">
              <Plus size={14} />
              New Rider
            </button>
          </div>
        </header>

        <section className="riders-overview-grid">
          <div className="live-map-card">
            <div className="compact-card-header">
              <div>
                <h2>Live Fleet Map</h2>
              </div>

              <div className="map-status-pills">
                <span className="active-dot">12 Active</span>
                <span>3 Idle</span>
              </div>
            </div>

            <div className="riders-map-preview">
              <div className="map-city-label quezon">Quezon City</div>
              <div className="map-city-label manila">Manila</div>
              <div className="map-city-label makati">Makati City</div>

              <div className="map-road road-one"></div>
              <div className="map-road road-two"></div>
              <div className="map-road road-three"></div>

              <span className="map-point green">
                <Truck size={13} />
              </span>
              <span className="map-point blue">
                <Navigation size={13} />
              </span>
              <span className="map-point red">
                <MapPin size={13} />
              </span>
              <span className="map-point pink">
                <MapPin size={13} />
              </span>

              <div className="map-controls">
                <button>+</button>
                <button>−</button>
              </div>
            </div>
          </div>

          <div className="rider-score-card">
            <div className="score-icon">
              <Truck size={22} />
            </div>

            <div className="score-trend">+8%</div>

            <p>On-Time Delivery Rate</p>
            <h2>94.2%</h2>
          </div>
        </section>

        <section className="active-personnel-card">
          <div className="compact-card-header">
            <h2>Active Personnel</h2>
          </div>

          <div className="personnel-list">
            {riders.map((rider) => (
              <div className="personnel-row" key={rider.name}>
                <div className={`personnel-avatar ${rider.type}`}>
                  <UserRound size={18} />
                </div>

                <div className="personnel-name">
                  <strong>{rider.name}</strong>
                  <small>
                    {rider.vehicle}: {rider.plate}
                  </small>
                </div>

                <div className="personnel-status-box">
                  <div className="status-title">
                    {rider.type === "active" && <Truck size={13} />}
                    {rider.type === "standby" && <CheckCircle2 size={13} />}
                    {rider.type === "offline" && <Clock size={13} />}
                    <span>{rider.status}</span>
                  </div>

                  <small>
                    {rider.delivery}
                    {rider.destination ? ` at ${rider.destination}` : ""}
                  </small>
                </div>

                <span className={`personnel-badge ${rider.type}`}>
                  {rider.badge}
                </span>

                <button className={rider.type === "standby" ? "assign-btn" : "details-btn"}>
                  {rider.type === "standby" ? "Assign" : "Details"}
                </button>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export default Riders;