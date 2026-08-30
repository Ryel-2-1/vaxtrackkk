import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { signOut } from "firebase/auth";
import { Menu } from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./AdminSidebar";
import "./AdminLayout.css";

/// Responsive Admin shell for the pilot. Keeps the existing `.inventory-page`
/// wrapper + shared AdminSidebar (so the foundation styling still applies) and
/// adds an accessible mobile drawer + a topbar that owns the page `<h1>`.
/// Scoped under `.adl-root`, so other admin pages are unaffected.
function AdminLayout({ active, title, description, eyebrow, actions, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const menuBtnRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // Close the drawer after navigating to another page. Syncing UI to a route
  // change is a legitimate effect; the setState only fires on pathname change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [location.pathname]);

  // While the mobile drawer is open: Escape closes it, background scroll is
  // locked, focus moves into the drawer, and returns to the menu button on close.
  useEffect(() => {
    if (!open) return;
    const menuBtn = menuBtnRef.current; // capture for the cleanup closure
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstFocusable = document.querySelector(
      ".adl-root.adl-open .inventory-sidebar a, .adl-root.adl-open .inventory-sidebar button"
    );
    firstFocusable?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      menuBtn?.focus();
    };
  }, [open]);

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      navigate("/login");
    }
  };

  return (
    <div className={`inventory-page adl-root${open ? " adl-open" : ""}`}>
      <AdminSidebar active={active} onLogout={handleLogout} />

      {open && (
        <div className="adl-overlay" onClick={close} aria-hidden="true" />
      )}

      <main className="adx-main">
        <header className="adl-topbar">
          <button
            ref={menuBtnRef}
            type="button"
            className="adl-menu-btn"
            aria-label="Open navigation menu"
            aria-expanded={open}
            aria-controls="admin-nav"
            onClick={() => setOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="adl-topbar-heading">
            {eyebrow && <p className="adx-eyebrow">{eyebrow}</p>}
            <h1>{title}</h1>
            {description && <p className="adl-topbar-desc">{description}</p>}
          </div>
          {actions && <div className="adl-topbar-actions">{actions}</div>}
        </header>
        {children}
      </main>
    </div>
  );
}

export default AdminLayout;
