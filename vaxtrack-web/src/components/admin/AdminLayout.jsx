import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import { AdminSidebar } from "./AdminSidebar";
import "./AdminLayout.css";

/// Responsive Admin shell for the pilot. Keeps the existing `.inventory-page`
/// wrapper + shared AdminSidebar (so the foundation styling still applies) and
/// adds a topbar that owns the page `<h1>`. Scoped under `.adl-root`, so other
/// admin pages are unaffected.
///
/// The mobile drawer used to live here — its state, its overlay, its Escape
/// handler and its menu button. That put navigation behind a shell only three
/// of the thirteen Admin pages use, so the other ten had no way to reach the
/// nav on a narrow viewport. It now lives in AdminSidebar, which every Admin
/// page renders. This component deliberately renders no toggle and no overlay
/// of its own — duplicating them would stack two scrims and two controls.
function AdminLayout({ active, title, description, eyebrow, actions, children }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      navigate("/login");
    }
  };

  return (
    <div className="inventory-page adl-root">
      <AdminSidebar active={active} onLogout={handleLogout} />

      <main className="adx-main">
        <header className="adl-topbar">
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
