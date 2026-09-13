import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Box,
  Truck,
  Users,
  Building2,
  FileText,
  BarChart3,
  AlertTriangle,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import "./AdminSidebar.css";

/// Shared Admin navigation sidebar. The single source of the sidebar markup —
/// used by AdminLayout (and directly by admin pages not yet on AdminLayout).
/// Keeps the `.inventory-sidebar` class so the existing green shell styling +
/// AdminSidebar.css layout apply; `active` drives the highlight + aria-current.
///
/// This component also owns the ONE mobile drawer for every Admin page. It used
/// to live in AdminLayout, which only three of the thirteen Admin pages use, so
/// the other ten had no way to reach navigation on a narrow viewport at all.
/// Moving it here means every page that renders a sidebar gets the same drawer,
/// and there is still exactly one implementation — AdminLayout now delegates
/// rather than rendering a second toggle and overlay of its own.
///
/// The breakpoint is 1000px in BOTH the markup behaviour and AdminSidebar.css,
/// matching the legacy `.inventory-page` stacking rule (styles.css:1836). The
/// drawer previously ended at 900px while the desktop rail began at 1001px,
/// leaving 901–1000px with neither.
export function AdminSidebar({ active, onLogout }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const toggleRef = useRef(null);
  const asideRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // Selecting a destination closes the drawer. Syncing UI to a route change is
  // a legitimate effect; the setState only fires when the pathname changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [location.pathname]);

  // Growing past the breakpoint must not leave a stuck overlay behind: the
  // drawer is a mobile affordance, so the desktop rail always wins.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1000px)");
    const sync = () => {
      if (!mq.matches) setOpen(false);
    };
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // While open: Escape closes, background scroll is locked, focus moves into
  // the drawer and returns to the toggle on close. Controls that are off-canvas
  // are made unfocusable by `visibility: hidden` in the stylesheet rather than
  // by a JS focus trap — a closed drawer must never be reachable by Tab.
  useEffect(() => {
    if (!open) return;
    const toggle = toggleRef.current; // captured for the cleanup closure
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    asideRef.current?.querySelector("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      toggle?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="admin-nav-toggle"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls="admin-nav"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      {open && (
        <div className="admin-nav-backdrop" onClick={close} aria-hidden="true" />
      )}

      <aside
        ref={asideRef}
        className={`inventory-sidebar${open ? " admin-nav-open" : ""}`}
        id="admin-nav"
        aria-label="Admin navigation"
      >
        <h2>VaxTrack</h2>

        <span className="m-role-chip">
          <span className="m-role-dot" />
          Admin Console
        </span>

        <div className="profile-mini">
          <div className="avatar">LA</div>
          <div className="profile-mini-text">
            <h3>Logistics Admin</h3>
            <p>Manila Central Hub</p>
            <small>VaxTrack Web</small>
          </div>
        </div>

        <nav>
          <Link
            className={active === "dashboard" ? "active" : ""}
            aria-current={active === "dashboard" ? "page" : undefined}
            to="/admin"
          >
            <LayoutDashboard size={16} aria-hidden="true" />
            <span>Dashboard</span>
          </Link>

          <p className="admin-nav-group">Operations</p>

          <Link
            className={active === "inventory" ? "active" : ""}
            aria-current={active === "inventory" ? "page" : undefined}
            to="/admin/inventory"
          >
            <Box size={16} aria-hidden="true" />
            <span>Inventory</span>
          </Link>

          <Link
            className={active === "deliveries" ? "active" : ""}
            aria-current={active === "deliveries" ? "page" : undefined}
            to="/admin/deliveries"
          >
            <Truck size={16} aria-hidden="true" />
            <span>Deliveries</span>
          </Link>

          <Link
            className={active === "riders" ? "active" : ""}
            aria-current={active === "riders" ? "page" : undefined}
            to="/admin/riders"
          >
            <Users size={16} aria-hidden="true" />
            <span>Riders</span>
          </Link>

          <Link
            className={active === "clinics" ? "active" : ""}
            aria-current={active === "clinics" ? "page" : undefined}
            to="/admin/clinics"
          >
            <Building2 size={16} aria-hidden="true" />
            <span>Clinics</span>
          </Link>

          <p className="admin-nav-group">Records</p>

          <Link
            className={active === "invoices" ? "active" : ""}
            aria-current={active === "invoices" ? "page" : undefined}
            to="/admin/invoices"
          >
            <FileText size={16} aria-hidden="true" />
            <span>Invoices</span>
          </Link>

          <Link
            className={active === "analytics" ? "active" : ""}
            aria-current={active === "analytics" ? "page" : undefined}
            to="/admin/analytics"
          >
            <BarChart3 size={16} aria-hidden="true" />
            <span>Analytics</span>
          </Link>

          <p className="admin-nav-group">System</p>

          <Link
            className={active === "alerts" ? "active" : ""}
            aria-current={active === "alerts" ? "page" : undefined}
            to="/admin/alerts"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Alerts</span>
          </Link>

          <Link
            className={active === "settings" ? "active" : ""}
            aria-current={active === "settings" ? "page" : undefined}
            to="/admin/settings"
          >
            <Settings size={16} aria-hidden="true" />
            <span>Settings</span>
          </Link>
        </nav>

        <button type="button" className="sidebar-logout" onClick={onLogout}>
          <LogOut size={16} aria-hidden="true" />
          <span>Logout</span>
        </button>
      </aside>
    </>
  );
}

export default AdminSidebar;
