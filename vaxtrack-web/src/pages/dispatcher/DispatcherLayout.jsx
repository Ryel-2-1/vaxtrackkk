import { useEffect, useMemo, useState } from "react";
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
import { subscribeActiveAlerts } from "../../services/alertService";
import "./Dispatcher.css";

// Relative time from a Firestore Timestamp (or "" when unavailable) — an honest
// fallback, never a fabricated time.
function alertTimeText(createdAt) {
  if (!createdAt || typeof createdAt.toDate !== "function") return "";
  const mins = Math.floor((Date.now() - createdAt.toDate().getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

// Map an alert's severity to the dropdown's existing tone classes.
function alertToneClass(severity) {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "info";
  return "normal";
}

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

  // Live dispatcher notifications = the active Firestore alerts. No fake or
  // fallback entries are ever inserted; a failure just leaves the empty state.
  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeActiveAlerts((alerts) => {
        setNotifications(Array.isArray(alerts) ? alerts : []);
      });
    } catch {
      setNotifications([]);
    }
    return () => unsubscribe();
  }, []);

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
    // Real alert docs carry no client route; navigate only when a path exists.
    if (notification.path) {
      navigate(notification.path);
    }
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
                      } ${alertToneClass(notification.severity)}`}
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
                        <strong>{notification.title || "Alert"}</strong>
                        <p>{notification.message || "No additional details."}</p>
                        <small>{alertTimeText(notification.createdAt)}</small>
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