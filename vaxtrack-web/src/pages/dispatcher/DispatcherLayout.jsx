import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
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
  Search,
  Settings,
  Truck,
  UserPlus,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { subscribeActiveAlerts } from "../../services/alertService";
import {
  DRAWER_MEDIA_QUERY,
  nextNavState,
  sidebarClassName,
  toggleLabel,
} from "./navDrawer";
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
            <span>Schedule</span>
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
        <header className="dispatcher-topbar">
          <h1>{title}</h1>

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