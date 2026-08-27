import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/meridian-shell.css";
import "./pages/admin/admin-polish.css"; /* Admin-only cohesion layer (scoped to .inventory-page / aside.inventory-sidebar) */

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);