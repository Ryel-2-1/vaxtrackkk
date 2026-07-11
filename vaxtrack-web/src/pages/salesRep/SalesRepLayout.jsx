import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Box,
  CheckCircle2,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import "./SalesRep.css";

function SalesRepLayout({ active, title, children, topbarTitle, showSearch = true }) {
  const navigate = useNavigate();
  const notificationRef = useRef(null);
  const [topSearch, setTopSearch] = useState("");
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [readNotifications, setReadNotifications] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("salesrepReadNotifications")) || [];
    } catch {
      return [];
    }
  });

  const notifications = useMemo(
    () => [
      {
        id: "sr-order-approved",
        title: "Order #VX-6667 approved",
        message: "Cavite, Imus request is ready for dispatch preparation.",
        time: "5 mins ago",
        tone: "success",
        route: "/sales-rep/order-tracking",
      },
      {
        id: "sr-pending-requests",
        title: "5 requests awaiting approval",
        message: "Review your pending order requests before the daily cutoff.",
        time: "18 mins ago",
        tone: "warning",
        route: "/sales-rep/request-order",
      },
      {
        id: "sr-cold-chain",
        title: "Cold chain warning detected",
        message: "Truck #042 reported a possible temperature deviation.",
        time: "1 hour ago",
        tone: "danger",
        route: "/sales-rep/alerts",
      },
      {
        id: "sr-near-expiry",
        title: "Near-expiry batch alert",
        message: "Batch JNJ-2023-X99 should be prioritized for client orders.",
        time: "2 hours ago",
        tone: "info",
        route: "/sales-rep/inventory",
      },
    ],
    []
  );

  const unreadCount = notifications.filter(
    (notification) => !readNotifications.includes(notification.id)
  ).length;

  useEffect(() => {
    localStorage.setItem("salesrepReadNotifications", JSON.stringify(readNotifications));
  }, [readNotifications]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setNotificationOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      navigate("/");
    } catch {
      window.alert("Unable to log out right now. Please try again.");
    }
  };

  const handleTopSearch = (event) => {
    event.preventDefault();

    const keyword = topSearch.trim();
    if (!keyword) return;

    const lowerKeyword = keyword.toLowerCase();
    let targetRoute = "/sales-rep";

    if (lowerKeyword.includes("request") || lowerKeyword.includes("approval")) {
      targetRoute = "/sales-rep/request-order";
    } else if (
      lowerKeyword.includes("track") ||
      lowerKeyword.includes("shipment") ||
      lowerKeyword.includes("delivery") ||
      lowerKeyword.includes("eta") ||
      lowerKeyword.includes("order")
    ) {
      targetRoute = "/sales-rep/order-tracking";
    } else if (
      lowerKeyword.includes("vaccine") ||
      lowerKeyword.includes("batch") ||
      lowerKeyword.includes("sku") ||
      lowerKeyword.includes("stock") ||
      lowerKeyword.includes("inventory") ||
      lowerKeyword.includes("expiry")
    ) {
      targetRoute = "/sales-rep/inventory";
    } else if (
      lowerKeyword.includes("alert") ||
      lowerKeyword.includes("warning") ||
      lowerKeyword.includes("cold") ||
      lowerKeyword.includes("temperature")
    ) {
      targetRoute = "/sales-rep/alerts";
    }

    navigate(`${targetRoute}?search=${encodeURIComponent(keyword)}`);
  };

  const clearTopSearch = () => {
    setTopSearch("");
  };

  const markAllRead = () => {
    setReadNotifications(notifications.map((notification) => notification.id));
  };

  const openNotification = (notification) => {
    setReadNotifications((current) =>
      current.includes(notification.id) ? current : [...current, notification.id]
    );
    setNotificationOpen(false);
    navigate(notification.route);
  };

  return (
    <div className="salesrep-page">
      <aside className="salesrep-sidebar">
        <div className="salesrep-brand">VaxTrack</div>

        <span className="m-role-chip">
          <span className="m-role-dot" />
          Sales
        </span>

        <div className="salesrep-profile">
          <div className="salesrep-profile-icon">SR</div>
          <div>
            <h3>Sales Representative</h3>
            <p>Manila Central Hub</p>
            <small>VaxTrack Web</small>
          </div>
        </div>

        <nav className="salesrep-nav">
          <Link className={active === "dashboard" ? "active" : ""} to="/sales-rep">
            <LayoutDashboard size={17} />
            <span>Dashboard</span>
          </Link>

          <Link className={active === "inventory" ? "active" : ""} to="/sales-rep/inventory">
            <Box size={17} />
            <span>Inventory</span>
          </Link>

          <Link className={active === "request" ? "active" : ""} to="/sales-rep/request-order">
            <Truck size={17} />
            <span>Request Order</span>
          </Link>

          <Link className={active === "alerts" ? "active" : ""} to="/sales-rep/alerts">
            <AlertTriangle size={17} />
            <span>Alerts</span>
          </Link>

          <Link className={active === "settings" ? "active" : ""} to="/sales-rep/settings">
            <Settings size={17} />
            <span>Settings</span>
          </Link>
        </nav>

        <button type="button" className="salesrep-logout" onClick={handleLogout}>
          <LogOut size={17} />
          <span>Logout</span>
        </button>
      </aside>

      <main className="salesrep-main">
        <header className="salesrep-topbar">
          <h1>{topbarTitle || title}</h1>

          <div className="salesrep-topbar-right">
            {showSearch && (
              <form className="salesrep-search salesrep-global-search" onSubmit={handleTopSearch}>
                <Search size={15} />
                <input
                  value={topSearch}
                  onChange={(event) => setTopSearch(event.target.value)}
                  placeholder="Search orders, SKU..."
                />
                {topSearch && (
                  <button
                    type="button"
                    className="salesrep-search-clear"
                    onClick={clearTopSearch}
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </form>
            )}

            <div className="salesrep-notification-wrap" ref={notificationRef}>
              <button
                type="button"
                className={`salesrep-icon-btn salesrep-bell-btn ${notificationOpen ? "active" : ""}`}
                onClick={() => setNotificationOpen((open) => !open)}
                aria-label="Open notifications"
              >
                <Bell size={16} />
                {unreadCount > 0 && <span className="salesrep-bell-badge">{unreadCount}</span>}
              </button>

              {notificationOpen && (
                <div className="salesrep-notification-dropdown">
                  <div className="salesrep-notification-header">
                    <div>
                      <h2>Notifications</h2>
                      <p>{unreadCount} unread alerts</p>
                    </div>
                    <button type="button" onClick={markAllRead}>
                      Mark all read
                    </button>
                  </div>

                  <div className="salesrep-notification-list">
                    {notifications.map((notification) => {
                      const isUnread = !readNotifications.includes(notification.id);

                      return (
                        <button
                          type="button"
                          key={notification.id}
                          className={`salesrep-notification-item ${isUnread ? "unread" : ""}`}
                          onClick={() => openNotification(notification)}
                        >
                          <span className={`notification-dot ${notification.tone}`}>
                            {notification.tone === "success" && <CheckCircle2 size={13} />}
                            {notification.tone !== "success" && <AlertTriangle size={13} />}
                          </span>
                          <div>
                            <strong>{notification.title}</strong>
                            <p>{notification.message}</p>
                            <small>{notification.time}</small>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}

export default SalesRepLayout;
