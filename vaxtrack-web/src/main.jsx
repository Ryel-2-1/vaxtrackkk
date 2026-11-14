import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/meridian-shell.css";
import "./styles/shell-transitions.css"; /* Persistent-shell route transition + in-content Suspense fallback */
import "./pages/admin/admin-polish.css"; /* Admin-only cohesion layer (scoped to .inventory-page / aside.inventory-sidebar) */
import "./pages/admin/admin-foundation.css"; /* Admin-only ops-console foundation (H1 pilot; scoped to .inventory-page / aside.inventory-sidebar) */
import "./pages/salesRep/salesrep-polish.css"; /* Sales-Rep-only cohesion layer (scoped to .salesrep-page / .salesrep-main / aside.salesrep-sidebar) */
import "./pages/dispatcher/dispatcher-polish.css"; /* Dispatcher-only cohesion layer (scoped to .dispatcher-page / .dispatcher-main / aside.dispatcher-sidebar) */
import "./styles/paged-tables.css";
import "./styles/dialog-fit.css"; /* Every floating window fits the screen */
import "./styles/shell-chrome.css"; /* One sidebar + top bar for all three roles (scoped to the role shells); last so it settles shell geometry */
import { installFloatingWindows } from "./components/ui/floatingWindow.js";

// Every modal window can be moved and resized, with its buttons pinned at the
// bottom (floatingWindow.js; styles in dialog-fit.css).
installFloatingWindows();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
