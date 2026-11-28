import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VaxTrackSystemExplorer from "./VaxTrackSystemExplorer.jsx";

createRoot(document.getElementById("system-explorer-root")).render(
  <StrictMode>
    <VaxTrackSystemExplorer />
  </StrictMode>
);
