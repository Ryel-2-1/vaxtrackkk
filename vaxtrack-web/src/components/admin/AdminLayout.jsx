import "./AdminLayout.css";

/// Content region for the AdminLayout-based admin pages (Dashboard, Inventory,
/// Analytics). It renders ONLY the `<main class="adx-main">` — the persistent
/// `.inventory-page.adl-root` wrapper, the shared AdminSidebar AND the shared
/// top bar (which carries the page title as its <h1>) are owned by AdminShell.
/// `<main>` stays a direct child of `.adl-root`, so the `.adl-root .adx-main` /
/// `.adl-root > .adx-main` styling still applies.
///
/// Callers may still pass `title` and `eyebrow`; they are deliberately ignored:
/// the top bar shows the title, and a second large heading under it was the
/// inconsistency being removed. The intro line and any page actions stay.
function AdminLayout({ description, actions, children }) {
  return (
    <main className="adx-main">
      {(description || actions) && (
        <header className="adl-topbar adl-page-intro">
          {description && <p className="adl-topbar-desc">{description}</p>}
          {actions && <div className="adl-topbar-actions">{actions}</div>}
        </header>
      )}
      {children}
    </main>
  );
}

export default AdminLayout;
