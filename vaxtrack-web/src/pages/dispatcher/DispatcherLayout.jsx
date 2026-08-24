import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  CheckCircle2,
  ClipboardCheck,
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

function DispatcherLayout({
  active = "dashboard",
  title = "VaxTrack Logistics",
  children,
}) {
  const navigate = useNavigate();

  const [searchText, setSearchText] = useState("");
  const [showNotifications, setShowNotifications] = useState(false);
  // No demo/sample data is seeded here — notifications start empty until wired
  // to real Firestore alerts.
  const [notifications, setNotifications] = useState([]);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications]
  );

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      navigate("/");
    }
  };

  const handleNotificationClick = (notification) => {
    setNotifications((prev) =>
      prev.map((item) =>
        item.id === notification.id ? { ...item, read: true } : item
      )
    );

    setShowNotifications(false);
    navigate(notification.path);
  };

  const handleClearNotifications = () => {
    setNotifications((prev) =>
      prev.map((notification) => ({
        ...notification,
        read: true,
      }))
    );
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();

    const keyword = searchText.trim().toLowerCase();

    if (!keyword) return;

    if (
      keyword.includes("assign") ||
      keyword.includes("rider") ||
      keyword.includes("delivery assignment")
    ) {
      navigate("/dispatcher/assign-rider");
      return;
    }

    if (
      keyword.includes("shipment") ||
      keyword.includes("cargo") ||
      keyword.includes("loading")
    ) {
      navigate("/dispatcher/shipments");
      return;
    }

    if (
      keyword.includes("geofence") ||
      keyword.includes("route") ||
      keyword.includes("deviation")
    ) {
      navigate("/dispatcher/geofence");
      return;
    }

    if (
      keyword.includes("setting") ||
      keyword.includes("profile") ||
      keyword.includes("preference")
    ) {
      navigate("/dispatcher/settings");
      return;
    }

    navigate("/dispatcher");
  };

  return (
    <div className="dispatcher-page">
      <aside className="dispatcher-sidebar">
        <div className="dispatcher-brand">
          <h1>VaxTrack</h1>
          <span className="m-role-chip">
            <span className="m-role-dot" />
            Dispatch
          </span>
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
            to="/dispatcher/cargo-loading"
            className={active === "cargo-loading" ? "active" : ""}
          >
            <ClipboardCheck size={16} />
            <span>Cargo Loading</span>
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

          <form className="dispatcher-search" onSubmit={handleSearchSubmit}>
            <Search size={15} />
            <input
              placeholder="Search orders, clinics, or vaccine types..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </form>

          <div className="dispatcher-notification-wrap">
            <button
              type="button"
              className="dispatcher-bell"
              onClick={() => setShowNotifications((prev) => !prev)}
            >
              <Bell size={16} />
              {unreadCount > 0 && <span></span>}
            </button>

            {showNotifications && (
              <div className="dispatcher-notification-panel">
                <div className="dispatcher-notification-head">
                  <div>
                    <strong>Notifications</strong>
                    <p>{unreadCount} unread alert(s)</p>
                  </div>

                  <button type="button" onClick={handleClearNotifications}>
                    Mark all read
                  </button>
                </div>

                <div className="dispatcher-notification-list">
                  {notifications.length === 0 && (
                    <p
                      style={{
                        padding: "18px 16px",
                        margin: 0,
                        fontSize: 13,
                        color: "#6b7280",
                        textAlign: "center",
                      }}
                    >
                      No notifications.
                    </p>
                  )}
                  {notifications.map((notification) => (
                    <button
                      type="button"
                      key={notification.id}
                      className={`dispatcher-notification-item ${
                        notification.read ? "read" : ""
                      } ${notification.type}`}
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <div className="notification-icon">
                        {notification.read ? (
                          <CheckCircle2 size={15} />
                        ) : (
                          <Bell size={15} />
                        )}
                      </div>

                      <div>
                        <strong>{notification.title}</strong>
                        <p>{notification.message}</p>
                        <small>{notification.time}</small>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <strong className="dispatcher-hub">VaxTrack Logistics</strong>
        </header>

        <div className="dispatcher-content">{children}</div>
      </main>
    </div>
  );
}

export default DispatcherLayout;