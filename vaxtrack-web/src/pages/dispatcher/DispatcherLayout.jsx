import { NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Search,
  Settings,
  Truck,
  UserPlus,
} from "lucide-react";
import { auth } from "../../firebase";
import "./Dispatcher.css";

function DispatcherLayout({ active = "dashboard", title = "VaxTrack Logistics", children }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      navigate("/");
    }
  };

  return (
    <div className="dispatcher-page">
      <aside className="dispatcher-sidebar">
        <div className="dispatcher-brand">
          <h1>VaxTrack</h1>
          <p>Vaccine Logistics</p>
        </div>

        <nav className="dispatcher-nav">
          <NavLink
            to="/dispatcher"
            end
            className={active === "dashboard" ? "active" : ""}
          >
            <LayoutDashboard size={16} />
            <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/dispatcher/assign-rider"
          className={active === "assign-rider" ? "active" : ""}
          >
          <UserPlus size={16} />
          <span>Assign Rider</span>
          </NavLink>
          <NavLink
            to="/dispatcher/shipments"
            className={active === "shipments" ? "active" : ""}
          >
            <Truck size={16} />
            <span>Shipments</span>
          </NavLink>

          <NavLink
            to="/dispatcher/geofence"
            className={active === "geofence" ? "active" : ""}
          >
            <MapPinned size={16} />
            <span>Geofence</span>
          </NavLink>

          <NavLink
            to="/dispatcher/settings"
            className={active === "settings" ? "active" : ""}
          >
            <Settings size={16} />
            <span>Settings</span>
          </NavLink>
        </nav>

        <button type="button" className="dispatcher-logout" onClick={handleLogout}>
          <LogOut size={16} />
          Logout
        </button>
      </aside>

      <main className="dispatcher-main">
        <header className="dispatcher-topbar">
          <h2>{title}</h2>

          <div className="dispatcher-search">
            <Search size={15} />
            <input placeholder="Search orders, clinics, or vaccine types..." />
          </div>

          <button type="button" className="dispatcher-bell">
            <Bell size={16} />
            <span></span>
          </button>

          <strong className="dispatcher-hub">VaxTrack Logistics</strong>
        </header>

        <div className="dispatcher-content">{children}</div>
      </main>
    </div>
  );
}

export default DispatcherLayout;
