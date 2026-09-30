import "./AdminLayout.css";

/// Topbar + content region for the AdminLayout-based admin pages (Dashboard,
/// Inventory, Analytics). It renders ONLY the `<main class="adx-main">` now — the
/// persistent `.inventory-page.adl-root` wrapper and the shared AdminSidebar are
/// owned by AdminShell (the parent layout route), so the sidebar no longer
/// unmounts on navigation. `<main>` stays a direct child of `.adl-root`, so the
/// `.adl-root .adx-main` / `.adl-root > .adx-main` styling still applies.
function AdminLayout({ title, description, eyebrow, actions, children }) {
  return (
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
  );
}

export default AdminLayout;
