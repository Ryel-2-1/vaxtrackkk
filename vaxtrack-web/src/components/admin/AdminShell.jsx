import { Suspense } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import { AdminSidebar } from "./AdminSidebar";
import "./AdminLayout.css";

/**
 * Persistent Admin shell.
 *
 * Rendered ONCE as the parent layout route for every /admin/* page, so the
 * sidebar (and its mobile drawer) mount once and stay put across navigation —
 * pages swap through the <Outlet/> only. Previously each admin page rendered its
 * own `.inventory-page` wrapper + <AdminSidebar>, so the rail unmounted and
 * "reset" on every click.
 *
 * The wrapper class is chosen per route so the existing shell CSS still applies
 * unchanged: `.adl-root` for the AdminLayout pages, `.clinics-shell` (+ page
 * modifiers) for the clinic screens, plain `.inventory-page` otherwise. The
 * sidebar and the page's own <main> stay DIRECT children of `.inventory-page`
 * (no wrapper div around the Outlet), so every `.inventory-page > …` and
 * `.adl-root > .adx-main` selector keeps matching.
 */
const WRAPPER_CLASS = {
  "/admin": "inventory-page adl-root",
  "/admin/inventory": "inventory-page adl-root",
  "/admin/allocation": "inventory-page adl-root",
  "/admin/analytics": "inventory-page adl-root",
  "/admin/delivery-calendar": "inventory-page adl-root",
  "/admin/clinics": "inventory-page clinics-shell",
  "/admin/register-clinic": "inventory-page clinics-shell register-clinic-shell",
  "/admin/clinic-success": "inventory-page clinics-shell clinic-success-shell",
};

function wrapperClassFor(pathname) {
  return WRAPPER_CLASS[pathname] || "inventory-page";
}

// The page title shown in the shared top bar — the same pattern the Sales Rep
// and Dispatcher shells use. The top bar owns each page's <h1> (DESIGN.md ›
// Layout), so admin pages no longer render their own large heading.
const ROUTE_TITLE = {
  "/admin": "Dashboard",
  "/admin/inventory": "Inventory",
  "/admin/add-stock": "Add Stock",
  "/admin/add-vaccine": "Add Vaccine",
  "/admin/allocation": "Stock Allocation",
  "/admin/deliveries": "Deliveries",
  "/admin/delivery-calendar": "Delivery Calendar",
  "/admin/riders": "Riders",
  "/admin/alerts": "Alerts",
  "/admin/analytics": "Analytics",
  "/admin/settings": "Settings",
  "/admin/clinics": "Clinics",
  "/admin/invoices": "Invoices",
  "/admin/register-clinic": "Register Clinic",
  "/admin/clinic-success": "Clinics",
};

function adminTitleFor(pathname) {
  if (ROUTE_TITLE[pathname]) return ROUTE_TITLE[pathname];
  if (pathname.startsWith("/admin/invoices/")) return "Invoice";
  return "Admin";
}

function AdminShell() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      navigate("/login");
    }
  };

  return (
    <div className={wrapperClassFor(location.pathname)}>
      <AdminSidebar onLogout={handleLogout} />

      {/* The shared top bar (same as Sales Rep and Dispatcher). Fixed beside
          the rail, like the rail itself, so the page's own <main> remains the
          direct flex child the existing admin page CSS expects. Admin has no
          global search or notification feed, so it carries the title only. */}
      <header className="m-topbar admin-shell-topbar">
        <h1 className="m-topbar-title">{adminTitleFor(location.pathname)}</h1>
      </header>

      {/* No wrapper div here on purpose: the page's own <main> must stay a
          direct flex child of `.inventory-page`. The Suspense fallback is scoped
          to the content area so a lazy chunk load never blanks the sidebar; the
          per-page entrance animation is applied to `.inventory-page > main` in
          shell-transitions.css (a fresh <main> mounts on each navigation). */}
      <Suspense
        fallback={
          <div className="route-view-fallback" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            <span>Loading…</span>
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </div>
  );
}

export default AdminShell;
