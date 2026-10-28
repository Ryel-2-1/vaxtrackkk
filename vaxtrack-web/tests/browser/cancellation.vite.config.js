import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated visual QA: real shipped components/styles, simulated identity/callable.
// This config is never imported by the application's build or deployment.
export default defineConfig({
  plugins: [{
    name: "cancellation-qa-fixtures",
    enforce: "pre",
    load(id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/components/profile/useOwnProfile.js")) return `
        export default function useOwnProfile() { return window.cancellationQA.identity; }
      `;
      if (path.endsWith("/services/inventoryCallables.js")) return `
        import { UserMessageError } from '/src/services/userMessageError.js';
        export async function cancelOrderWithInventoryRelease(orderId, reason) {
          const qa = window.cancellationQA;
          qa.calls.push({ orderId, reason }); qa.refresh();
          await new Promise(resolve => setTimeout(resolve, 1200));
          if (qa.refuse) throw new UserMessageError('Loading was already confirmed. Refresh the order and contact the Dispatcher.');
          qa.cancelled();
          return { orderId, status: 'cancelled' };
        }
      `;
    },
  }, react()],
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
