// A Dispatcher dialog rendered at the top level of the page.
//
// Every Dispatcher page renders inside `.dispatcher-content.route-view`, whose
// entrance animation (shell-transitions.css, fill-mode `both`) leaves
// `transform: translateY(0)` on it. A transformed ancestor is the containing
// block for `position: fixed`, so a dialog rendered inside it is centred in
// the whole long page — off-screen once the page is scrolled — and sits under
// the shell's fixed chrome. This portals it to <body> (DialogLayer) and
// re-applies the scope classes its text inherits from — the shell
// (`dispatcher-page`) and the content area (`dispatcher-content`, which sets
// the dialog type weights) — so the role-scoped styles still match. The layer
// is `display: contents`, so neither brings its box; `route-view`, which
// carries the animation, is deliberately not applied. (Measured: no computed
// style differs from the dialog rendered in the page.)
import DialogLayer from "../../components/ui/DialogLayer";

export const DISPATCHER_DIALOG_SCOPE = "dispatcher-page dispatcher-content";

export default function DispatcherDialogLayer({ children }) {
  return <DialogLayer scope={DISPATCHER_DIALOG_SCOPE}>{children}</DialogLayer>;
}
