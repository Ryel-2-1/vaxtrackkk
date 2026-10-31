import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Menu,
  Navigation,
  Settings,
  Truck,
  UserPlus,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { subscribeActiveAlerts } from "../../services/alertService";
import { lateAlertLiveText } from "../../services/deliveryTiming";
import { presentAlert } from "../../services/alertPresentation";
import useMinuteClock from "../../components/useMinuteClock";
import SidebarProfile from "../../components/shell/SidebarProfile";
import OfflineNotice from "../../components/shell/OfflineNotice";
import {
  DRAWER_MEDIA_QUERY,
  nextNavState,
  sidebarClassName,
  toggleLabel,
} from "./navDrawer";
import "./Dispatcher.css";

// Relative time from a Firestore Timestamp (or "" when unavailable) — an honest
// fallback, never a fabricated time.
// Map an alert's severity to the dropdown's existing tone classes.
function alertToneClass(severity) {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "info";
  return "normal";
}

// Per-route chrome for the persistent Dispatcher shell. Keys drive the sidebar
// highlight; titles drive the topbar. Pages render only their content into the
// shell's <Outlet/>, so the sidebar never unmounts on navigation.
const ROUTE_META = {
  "/dispatcher": { key: "dashboard", title: "Dashboard" },
  "/dispatcher/schedule": { key: "schedule", title: "Delivery Calendar" },
  "/dispatcher/assign-rider": { key: "assign-rider", title: "Assign Rider" },
  "/dispatcher/shipments": { key: "shipments", title: "Shipments" },
  "/dispatcher/cargo-loading": { key: "cargo-loading", title: "Cargo Loading" },
  "/dispatcher/geofence": { key: "geofence", title: "Live Monitoring" },
  "/dispatcher/live-tracking": { key: "live-tracking", title: "Live Tracking" },
  "/dispatcher/settings": { key: "settings", title: "Settings" },
};

function metaForDispatcher(pathname) {
  return ROUTE_META[pathname] || { key: "dashboard", title: "Dashboard" };
}

function DispatcherLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const meta = metaForDispatcher(location.pathname);
  const active = meta.key;
  const title = meta.title;

  const [showNotifications, setShowNotifications] = useState(false);

  // Mobile navigation drawer. Below `DRAWER_MEDIA_QUERY` the 260px rail cannot
  // sit beside the content, so it becomes an off-canvas panel; every decision
  // about whether it should be open is delegated to `nextNavState`.
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef(null);
  const sidebarRef = useRef(null);
  const applyNav = useCallback(
    (event) => setNavOpen((open) => nextNavState(open, event)),
    []
  );
  // Dismissing (backdrop, the close control, logout) and choosing a destination
  // both close the drawer, but they are distinct events so the state machine —
  // and its tests — describe what actually happened rather than collapsing
  // every close into one anonymous case.
  const closeNav = useCallback(
    () => applyNav({ type: "dismiss" }),
    [applyNav]
  );
  const selectDestination = useCallback(
    () => applyNav({ type: "navigate" }),
    [applyNav]
  );
  // No demo/sample data is seeded here — notifications start empty until wired
  // to real Firestore alerts.
  const [notifications, setNotifications] = useState([]);
  // Live "now N minutes past expected arrival" on late-delivery alerts.
  const minuteNow = useMinuteClock();
  // A failed feed is said as such — "No notifications." would be a false all-clear.
  const [notificationsError, setNotificationsError] = useState(false);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications]
  );

  // Live dispatcher notifications = the active Firestore alerts. No fake or
  // fallback entries are ever inserted; a failure just leaves the empty state.
  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeActiveAlerts(
        (alerts) => {
          setNotifications(Array.isArray(alerts) ? alerts : []);
          setNotificationsError(false);
        },
        () => setNotificationsError(true)
      );
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNotifications([]);
    }
    return () => unsubscribe();
  }, []);

  // Growing back past the breakpoint must not leave an overlay stranded on top
  // of the desktop rail: the backdrop is `position: fixed; inset: 0`, so an
  // open drawer that survived the resize would swallow every click on the page
  // and leave `body` scroll-locked.
  //
  // Both signals, deliberately. The media query is the precise one, but it is
  // not delivered by every viewport change — a CDP device-metric override
  // updates `mq.matches` and re-evaluates the stylesheet while firing no
  // `change` event at all, which is exactly how this was found. `resize`
  // covers those; the handler reads `mq.matches` fresh either way, so the two
  // cannot disagree.
  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MEDIA_QUERY);
    const sync = () => applyNav({ type: "viewport", matches: mq.matches });
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [applyNav]);

  // While open the drawer is modal to the keyboard as well as the pointer.
  //
  // Two mechanisms, each covering what the other cannot:
  //
  //  * `inert` on <main> (below) removes everything behind the backdrop from
  //    the tab order AND from hit-testing, in one declaration. It is reliable
  //    here because this component's DOM is flat and complete — the page is
  //    `.dispatcher-page > [toggle, backdrop, aside, main]`, and every
  //    focusable control the backdrop covers lives inside <main>. There is no
  //    sibling subtree to enumerate and nothing to un-set by hand: React drops
  //    the attribute when `navOpen` flips, so it cannot leak on close, on
  //    unmount, or if a render is interrupted.
  //
  //  * The Tab handler below wraps focus, which `inert` alone does not do:
  //    tabbing off the last control would otherwise move to the browser's own
  //    UI. The loop is [toggle, ...panel controls] because the toggle IS the
  //    close control and is painted above the panel; excluding it would make
  //    the visible X unreachable by keyboard.
  //
  // Deliberately NOT `role="dialog"` + `aria-modal`: the element is the same
  // <aside> that is a persistent navigation landmark at desktop widths, and
  // swapping its role per breakpoint would trade a real landmark for a
  // duplicate-labelled dialog. The behaviour is modal; the semantics stay
  // honest.
  useEffect(() => {
    if (!navOpen) return;
    const toggle = navToggleRef.current; // captured for the cleanup closure
    const panel = sidebarRef.current;

    // `getClientRects()`, NOT `offsetParent`: the toggle is `position: fixed`,
    // for which `offsetParent` is always null — that check silently dropped the
    // close control out of the loop and out of the focus-restore below. An
    // empty rect list is the honest "not rendered" signal, and it is still
    // false for the `display: none` toggle at desktop widths.
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const loop = () =>
      [toggle, ...(panel?.querySelectorAll("a[href], button:not([disabled])") ?? [])].filter(
        shown
      );

    const onKey = (e) => {
      if (e.key !== "Tab") {
        applyNav({ type: "key", key: e.key });
        return;
      }
      const items = loop();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = items.indexOf(document.activeElement);
      // `at === -1` means focus escaped the loop entirely (or never entered):
      // pull it back rather than letting Tab continue into inert content.
      if (e.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.querySelector("a[href], button:not([disabled])")?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Only when the toggle is still rendered AND still visible. Closing by
      // growing past the breakpoint hides it (`display: none`), and focusing a
      // hidden element silently drops focus to <body>; there, focus stays on
      // the rail control it was already on, which is visible at that width.
      if (toggle && toggle.isConnected && shown(toggle)) {
        toggle.focus();
      }
    };
  }, [navOpen, applyNav]);

  const handleLogout = async () => {
    closeNav();
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
    // Order-linked alerts open their shipment; others have nowhere to go.
    const { path } = presentAlert(notification, { role: "dispatcher" });
    if (path) {
      navigate(path);
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


  return (
    <div className="dispatcher-page">
      {/* Shown only under the breakpoint. It is also the close control: the
          stylesheet stacks it above the panel, so it stays reachable. */}
      <button
        ref={navToggleRef}
        type="button"
        className="dispatcher-nav-toggle"
        aria-label={toggleLabel(navOpen)}
        aria-expanded={navOpen}
        aria-controls="dispatcher-nav"
        onClick={() => applyNav({ type: "toggle" })}
      >
        {navOpen ? (
          <X size={20} aria-hidden="true" />
        ) : (
          <Menu size={20} aria-hidden="true" />
        )}
      </button>

      {navOpen && (
        <div
          className="dispatcher-nav-backdrop"
          onClick={closeNav}
          aria-hidden="true"
        />
      )}

      <aside
        ref={sidebarRef}
        className={sidebarClassName(navOpen)}
        id="dispatcher-nav"
        aria-label="Dispatcher navigation"
      >
        {/* The wordmark is not a heading: the top bar owns the page's one <h1>
            (this used to be a second <h1> on every Dispatcher page). */}
        <div className="dispatcher-brand">
          <div className="m-brand">VaxTrack</div>
          <span className="m-role-chip">
            <span className="m-role-dot" />
            Dispatch
          </span>
        </div>

        <SidebarProfile fallbackRole="Dispatcher" />

        <nav className="dispatcher-nav">
          <NavLink
            to="/dispatcher"
            end
            className={active === "dashboard" ? "active" : ""}
            onClick={selectDestination}
          >
            <LayoutDashboard size={16} />
            <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/dispatcher/schedule"
            className={active === "schedule" ? "active" : ""}
            onClick={selectDestination}
          >
            <CalendarClock size={16} />
            <span>Calendar</span>
          </NavLink>

          <NavLink
            to="/dispatcher/assign-rider"
            className={active === "assign-rider" ? "active" : ""}
            onClick={selectDestination}
          >
            <UserPlus size={16} />
            <span>Assign Rider</span>
          </NavLink>

          <NavLink
            to="/dispatcher/shipments"
            className={active === "shipments" ? "active" : ""}
            onClick={selectDestination}
          >
            <Truck size={16} />
            <span>Shipments</span>
          </NavLink>

          <NavLink
            to="/dispatcher/cargo-loading"
            className={active === "cargo-loading" ? "active" : ""}
            onClick={selectDestination}
          >
            <ClipboardCheck size={16} />
            <span>Cargo Loading</span>
          </NavLink>

          <NavLink
            to="/dispatcher/geofence"
            className={active === "geofence" ? "active" : ""}
            onClick={selectDestination}
          >
            <MapPinned size={16} />
            <span>Geofence</span>
          </NavLink>

          <NavLink
            to="/dispatcher/live-tracking"
            className={active === "live-tracking" ? "active" : ""}
            onClick={selectDestination}
          >
            <Navigation size={16} />
            <span>Live Tracking</span>
          </NavLink>

          <NavLink
            to="/dispatcher/settings"
            className={active === "settings" ? "active" : ""}
            onClick={selectDestination}
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

      {/* Everything the backdrop covers lives in here, so one `inert` takes the
          whole background out of the tab order and out of hit-testing while the
          drawer is open. `undefined` (not `false`) so the attribute is absent
          — and therefore inert is never in play at desktop widths. */}
      <main className="dispatcher-main" inert={navOpen || undefined}>
        <header className="dispatcher-topbar m-topbar" data-shipments-topbar={active === "shipments" || undefined}>
          <h1 className="m-topbar-title">{title}</h1>

          {/* The bell on the right, as in the Med Rep top bar. The keyword
              "search" that only navigated between pages was removed
              (2026-10-31); each page keeps its own real search. */}
          <div className="m-topbar-actions">

          <div className="dispatcher-notification-wrap">
            <button
              type="button"
              className="dispatcher-bell m-topbar-icon-btn"
              aria-label="Open notifications"
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
                  {notificationsError && (
                    <p
                      role="alert"
                      style={{
                        padding: "18px 16px",
                        margin: 0,
                        fontSize: 13,
                        color: "#b42318",
                        textAlign: "center",
                      }}
                    >
                      Notifications could not be loaded.
                    </p>
                  )}
                  {!notificationsError && notifications.length === 0 && (
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
                  {notifications.map((notification) => {
                    // Shared wording: names + the human order code, never ids.
                    const view = presentAlert(notification, { role: "dispatcher", nowMs: minuteNow });
                    return (
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
                        <strong>{view.title}</strong>
                        <p>{view.message || "No additional details."}</p>
                        {lateAlertLiveText(notification, minuteNow) && (
                          <small className="tnum">{lateAlertLiveText(notification, minuteNow)}</small>
                        )}
                        {view.metaText && <small>{view.metaText}</small>}
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

        {/* Keyed by route so only this content region replays the entrance
            animation; the sidebar/topbar above stay mounted. The Suspense
            fallback is scoped here, so a lazy chunk load never blanks the rail. */}
        <Suspense
          fallback={
            <div className="route-view-fallback" role="status" aria-live="polite">
              <span className="rv-spinner" aria-hidden="true" />
              <span>Loading…</span>
            </div>
          }
        >
          <div
            className={`dispatcher-content route-view${location.pathname === "/dispatcher/settings" ? " dispatcher-settings-content" : ""}`}
            key={location.pathname}
          >
            <Outlet />
          </div>
        </Suspense>
        <OfflineNotice />
      </main>
    </div>
  );
}

export default DispatcherLayout;
