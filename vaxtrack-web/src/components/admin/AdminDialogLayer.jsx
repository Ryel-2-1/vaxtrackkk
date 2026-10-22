// An Admin dialog rendered at the top level of the page.
//
// Every Admin page's <main> keeps `transform: translateY(0)` after its entrance
// animation (shell-transitions.css), which makes it the containing block for
// `position: fixed` descendants: a dialog rendered inside it was centred in the
// whole long page, not the screen, and opened off-screen once the page was
// scrolled. AdminDialogLayer portals the dialog to <body> (DialogLayer) and
// re-applies the current route's shell wrapper classes, so the page-scoped
// Admin styles still match while nothing of the page's layout comes along.
//
// `pageClass` adds the page's own <main> class when its dialogs inherit from
// it (Settings: `settings-v3-main` sets the text colour). The layer is
// `display: contents`, so that class brings its descendant styles and
// inherited values, never its box, padding or entrance animation (which
// targets `.inventory-page > main` only).
import { useLocation } from "react-router-dom";
import DialogLayer from "../ui/DialogLayer";
import { adminWrapperClassFor } from "./adminShellClasses";

export default function AdminDialogLayer({ pageClass = "", children }) {
  const { pathname } = useLocation();
  return (
    <DialogLayer scope={`${adminWrapperClassFor(pathname)} ${pageClass}`.trim()}>
      {children}
    </DialogLayer>
  );
}
