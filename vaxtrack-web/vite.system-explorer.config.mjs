import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { systemExplorerPlugin } from "./scripts/system-explorer/api.mjs";

export default defineConfig({
  plugins: [react(), systemExplorerPlugin()],
  envPrefix: "VAXTRACK_EXPLORER_",
  server: {
    host: "127.0.0.1",
    port: 5193,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    headers: {
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws://127.0.0.1:5193; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    },
  },
});
