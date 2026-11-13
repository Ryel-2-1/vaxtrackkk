import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Box,
  CheckCircle2,
  History,
  Info,
  LayoutDashboard,
  LogOut,
  MapPin,
  MapPinned,
  Menu,
  X,
  Settings,
  Truck,
} from "lucide-react";
import { auth } from "../../firebase";
import SidebarProfile from "../../components/shell/SidebarProfile";
import { nextNavState, toggleLabel } from "../dispatcher/navDrawer";
import OfflineNotice from "../../components/shell/OfflineNotice";
import { subscribeSalesRepOrders } from "../../services/orderService";
import { deriveSalesRepOrderAlert } from "../../services/salesRepOrderAlert";
import useNotificationReadState from "../../components/useNotificationReadState";
import useNotificationPanelState from "../../components/useNotificationPanelState";
import NotificationPanelItem, { NotificationPanelFooter } from "../../components/shell/NotificationPanelItem";
import "./SalesRep.css";

/**
 * Persistent Sales Rep shell.
 *
 * Rendered ONCE as the parent layout route for every /sales-rep/* page, so the
 * sidebar and topbar stay mounted across navigation — pages swap through the
 * <Outlet/> only. This is what stops the sidebar "resetting" on every click: it
 * no longer unmounts, so its scroll position holds and the active-link animation
 * plays only on the link that actually becomes active. The per-page chrome
 * (title, topbar title) comes from the route table below, so pages render just
 * their content. Each page keeps its own search; the top bar has none.
 */
// Phone widths, where the rail becomes an off-canvas menu (shell-chrome.css).
const SALESREP_DRAWER_QUERY = "(max-width: 768px)";

const ROUTE_META = {
  "/sales-rep": { key: "dashboard", title: "Dashboard" },
  "/sales-rep/inventory": { key: "inventory", title: "Inventory" },
  "/sales-rep/request-order": { key: "request", title: "Request Order" },
  "/sales-rep/place-order": { key: "request", title: "Checkout" },
  "/sales-rep/order-confirmation": { key: "request", title: "Order Confirmation" },
  "/sales-rep/order-tracking": { key: "tracking", title: "Order Tracking" },
  "/sales-rep/live-monitoring": { key: "monitoring", title: "Live Monitoring" },
  "/sales-rep/order-history": { key: "history", title: "Order History" },
  "/sales-rep/alerts": { key: "alerts", title: "Alerts" },
  "/sales-rep/settings": { key: "settings", title: "Settings" },
};

function metaFor(pathname) {
  return ROUTE_META[pathname] || { key: "dashboard", title: "Dashboard" };
}

function SalesRepShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const meta = metaFor(location.pathname);
  const active = meta.key;

  const notificationRef = useRef(null);
  // Phones: the same off-canvas side menu as Admin and Dispatcher, with every
  // page and Logout in it. Open/close decisions come from the Dispatcher's
  // tested state machine (navDrawer.js); this binds it to the DOM.
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef(null);
  const sidebarRef = useRef(null);
  const applyNav = useCallback((event) => setNavOpen((open) => nextNavState(open, event)), []);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const uid = auth.currentUser?.uid ?? null;
  // Read marks: this browser's cache + the user's shared copy in Firestore.
  const [readNotifications, markNotificationsRead] = useNotificationReadState("salesrep");
  const { dismissedIds, dismiss, undo, canUndo } = useNotificationPanelState({
    projectId: auth.app.options.projectId, role: "salesrep", uid,
  });
  const [orders, setOrders] = useState([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsError, setNotificationsError] = useState(false);

  // Reuse the same order-derived updates as the Med Rep Alerts page. Med Reps
  // have no permission to read the shared operational `alerts` collection.
  useEffect(() => {
    if (!uid) return undefined;
    return subscribeSalesRepOrders(uid, (nextOrders) => {
      setOrders(nextOrders);
      setNotificationsLoading(false);
      setNotificationsError(false);
    }, () => {
      setOrders([]);
      setNotificationsLoading(false);
      setNotificationsError(true);
    });
  }, [uid]);

  const notifications = useMemo(() =>
    orders.map(deriveSalesRepOrderAlert).sort((a, b) => b.sortTime - a.sortTime),
  [orders]);

  const panelNotifications = notifications.filter((notification) => !dismissedIds.includes(notification.readId));
  const unreadCount = panelNotifications.filter(
    (notification) => !readNotifications.includes(notification.readId)
  ).length;
  // The badge counts only unread updates that need follow-up (delayed, failed,
  // cancelled, running late). Every order makes one update, so a badge of all
  // unread said "200" and meant nothing (2026-11-14). The panel still lists all.
  const followUpUnread = panelNotifications.filter(
    (notification) => notification.tone === "critical" && !readNotifications.includes(notification.readId)
  ).length;

  // Logging out is one request at a time; a failure is shown beside the
  // button (never a browser alert) and the Med Rep stays signed in.
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutRef = useRef(false);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setNotificationOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close any open dropdown on navigation so it never lingers over a new page.
  // Syncing transient UI to a route change is a legitimate effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotificationOpen(false);
    applyNav({ type: "navigate" });
  }, [location.pathname, applyNav]);

  // The drawer is a phone affordance: widening past the breakpoint closes it.
  useEffect(() => {
    const query = window.matchMedia(SALESREP_DRAWER_QUERY);
    const onChange = (e) => applyNav({ type: "viewport", matches: e.matches });
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [applyNav]);

  // While open: Escape closes, the page behind cannot scroll, focus moves into
  // the menu and returns to the menu button on close.
  useEffect(() => {
    if (!navOpen) return undefined;
    const toggle = navToggleRef.current;
    const onKey = (e) => applyNav({ type: "key", key: e.key });
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebarRef.current?.querySelector("a[href], button:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (toggle && toggle.isConnected && toggle.getClientRects().length > 0) toggle.focus();
    };
  }, [navOpen, applyNav]);

  const handleLogout = async () => {
    if (logoutRef.current) return;
    logoutRef.current = true;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await signOut(auth);
      navigate("/");
    } catch {
      setLogoutError("You're still signed in — we couldn't log you out. Check your connection and try again.");
    } finally {
      logoutRef.current = false;
      setLoggingOut(false);
    }
  };

  const markAllRead = () => {
    markNotificationsRead(panelNotifications.map((notification) => notification.readId));
  };

  const openNotification = (notification) => {
    markNotificationsRead([notification.readId]);
    setNotificationOpen(false);
    const history = ["completed", "delivered", "cancelled", "canceled"].includes(notification.statusKey);
    navigate(`/sales-rep/alerts?tab=${history ? "history" : "active"}&reference=${encodeURIComponent(notification.orderNumber)}`);
  };

  return (
    <div className="salesrep-page">
      {/* Phones only; it is also the close control, stacked above the menu. */}
      <button
        ref={navToggleRef}
        type="button"
        className="salesrep-nav-toggle"
        aria-label={toggleLabel(navOpen)}
        aria-expanded={navOpen}
        aria-controls="salesrep-nav"
        onClick={() => applyNav({ type: "toggle" })}
      >
        {navOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      {navOpen && <div className="salesrep-nav-backdrop" onClick={() => applyNav({ type: "dismiss" })} aria-hidden="true" />}

      <aside
        ref={sidebarRef}
        id="salesrep-nav"
        className={`salesrep-sidebar${navOpen ? " salesrep-nav-open" : ""}`}
        aria-label="Med Rep navigation"
      >
        <div className="salesrep-brand m-brand">VaxTrack</div>

        <span className="m-role-chip">
          <span className="m-role-dot" />
          Med Rep
        </span>

        <SidebarProfile fallbackRole="Med Rep" />

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

          <Link className={active === "tracking" ? "active" : ""} to="/sales-rep/order-tracking">
            <MapPin size={17} />
            <span>Order Tracking</span>
          </Link>

          <Link className={active === "monitoring" ? "active" : ""} to="/sales-rep/live-monitoring">
            <MapPinned size={17} />
            <span>Live Monitoring</span>
          </Link>

          <Link className={active === "history" ? "active" : ""} to="/sales-rep/order-history">
            <History size={17} />
            <span>Order History</span>
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

        <button
          type="button"
          className="salesrep-logout"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-busy={loggingOut}
          aria-describedby={logoutError ? "salesrep-logout-error" : undefined}
        >
          <LogOut size={17} aria-hidden="true" />
          <span>{loggingOut ? "Logging out…" : "Logout"}</span>
        </button>
        {logoutError && (
          <p id="salesrep-logout-error" className="salesrep-logout-error" role="alert">
            {logoutError}
          </p>
        )}
      </aside>

      <main className="salesrep-main" inert={navOpen || undefined}>
        <header className="salesrep-topbar m-topbar">
          <h1 className="m-topbar-title">{meta.topbarTitle || meta.title}</h1>

          <div className="salesrep-topbar-right m-topbar-actions">
            <div className="salesrep-notification-wrap" ref={notificationRef}>
              <button
                type="button"
                className={`salesrep-icon-btn salesrep-bell-btn m-topbar-icon-btn ${notificationOpen ? "active" : ""}`}
                onClick={() => setNotificationOpen((open) => !open)}
                aria-label={followUpUnread > 0
                  ? `Open notifications, ${followUpUnread} need${followUpUnread === 1 ? "s" : ""} follow-up`
                  : "Open notifications"}
              >
                <Bell size={16} />
                {followUpUnread > 0 && <span className="salesrep-bell-badge">{followUpUnread > 99 ? "99+" : followUpUnread}</span>}
              </button>

              {notificationOpen && (
                <div className="salesrep-notification-dropdown">
                  <div className="salesrep-notification-header">
                    <div>
                      <h2>Notifications</h2>
                      <p>{unreadCount} unread alerts</p>
                    </div>
                    <button type="button" onClick={markAllRead} disabled={unreadCount === 0}>
                      Mark all read
                    </button>
                  </div>

                  <div className="salesrep-notification-list">
                    {notificationsError && <p className="salesrep-notification-empty" role="alert">Notifications could not be loaded.</p>}
                    {!notificationsError && notificationsLoading && <p className="salesrep-notification-empty" role="status">Loading notifications…</p>}
                    {!notificationsError && !notificationsLoading && panelNotifications.length === 0 && (
                      <p className="salesrep-notification-empty">No notifications.</p>
                    )}
                    {!notificationsError && panelNotifications.map((notification) => {
                      const isUnread = !readNotifications.includes(notification.readId);
                      return (
                        <NotificationPanelItem key={notification.readId} title={notification.title} isRead={!isUnread}
                          onRead={() => markNotificationsRead([notification.readId])}
                          onDelete={() => dismiss([notification.readId])}>
                        <button
                          type="button"
                          className={`salesrep-notification-item ${isUnread ? "unread" : ""}`}
                          onClick={() => openNotification(notification)}
                        >
                          <span className={`notification-dot ${notification.tone === "critical" ? "danger" : notification.tone}`}>
                            {notification.tone === "success" && <CheckCircle2 size={13} />}
                            {notification.tone === "critical" && <AlertTriangle size={13} />}
                            {notification.tone === "info" && <Info size={13} />}
                          </span>
                          <div>
                            <strong>{notification.title}</strong>
                            <p>{notification.body}</p>
                            <small>{notification.time}</small>
                          </div>
                        </button>
                        </NotificationPanelItem>
                      );
                    })}
                  </div>
                  <NotificationPanelFooter canClear={!notificationsError && panelNotifications.length > 0}
                    onClear={() => dismiss(panelNotifications.map((notification) => notification.readId))}
                    canUndo={canUndo} onUndo={undo} historyPath="/sales-rep/alerts"
                    onHistory={() => setNotificationOpen(false)} />
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Keyed by route so only the content region replays the entrance
            animation; the sidebar above stays mounted. The Suspense fallback is
            scoped here too, so a lazy chunk load never blanks the sidebar. */}
        <Suspense
          fallback={
            <div className="route-view-fallback" role="status" aria-live="polite">
              <span className="rv-spinner" aria-hidden="true" />
              <span>Loading…</span>
            </div>
          }
        >
          <div className="salesrep-route-view route-view" key={`${location.pathname}${location.search}`}>
            <Outlet />
          </div>
        </Suspense>
        <OfflineNotice />
      </main>
    </div>
  );
}

export default SalesRepShell;
