import "./RouteFallback.css";

/// Fixed, full-viewport loader shown while a code-split route chunk downloads.
/// Position-fixed so it never shifts page content; announced to assistive tech.
function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback-spinner" aria-hidden="true" />
      <span className="route-fallback-label">Loading…</span>
    </div>
  );
}

export default RouteFallback;
