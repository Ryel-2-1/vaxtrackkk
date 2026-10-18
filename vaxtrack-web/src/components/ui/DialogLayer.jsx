// Renders a modal overlay at the top level of the page (a React portal into
// document.body), so it is positioned and stacked against the VIEWPORT.
//
// Why a portal: every Admin page's <main> keeps `transform: translateY(0)`
// after its entrance animation (shell-transitions.css, fill-mode `both`). Any
// transform makes that element the containing block for `position: fixed`
// descendants and gives it its own stacking context, so an overlay rendered
// inside it covered the whole long page instead of the screen — a dialog
// opened after scrolling sat low and ran off the bottom — and the fixed
// sidebar and top bar painted over its backdrop.
//
// `scope` re-applies the page's scoping classes (e.g. "inventory-page
// adl-root") on the layer, because role styles are written as
// `.inventory-page …` and would otherwise stop matching. The layer itself is
// `display: contents` (DialogLayer.css): it generates no box, so the page
// classes bring their descendant styles but none of their own layout, and the
// layer can never become a containing block or a stacking context.
import { createPortal } from "react-dom";
import "./DialogLayer.css";

export default function DialogLayer({ scope = "", children }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={`vt-dialog-layer ${scope}`.trim()}>{children}</div>,
    document.body
  );
}
