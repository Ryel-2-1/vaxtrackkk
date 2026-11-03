import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAdminOnlyAlert, presentAlert } from "../src/services/alertPresentation.js";
import { buildDispatcherNotificationFeed } from "../src/services/dispatcherNotificationFeed.js";

// Stock and expiry alerts (functions/src/stockAlerts.js) as the Admin reads
// them, and kept off every Dispatcher surface.

const low = {
  id: "stock_low_v1", type: "stock_low", status: "active", severity: "warning", audience: "admin",
  title: "Low stock: Hep B", message: "Hep B has 48 vials available, at or below its safety stock of 60 vials. Reorder or add stock.",
  vaccineName: "Hep B", availableQuantity: 48, safetyStockQuantity: 60,
};
const expiring = {
  id: "batch_expiry_b2", type: "batch_expiry", status: "active", severity: "warning", audience: "admin",
  title: "Expiring soon: Hep B", message: "Batch HEP-002 of Hep B expires on 2026-11-20 with 8 vials in stock. Use or allocate it first.",
  vaccineName: "Hep B", batchId: "HEP-002", expiryDate: "2026-11-20", holdingQuantity: 8,
};

test("an Admin reads the server's sentence, the figures behind it, and a link to Inventory", () => {
  const view = presentAlert(low, { role: "admin", nowMs: 0 });
  assert.equal(view.title, "Low stock: Hep B");
  assert.match(view.message, /48 vials available/);
  assert.equal(view.path, "/admin/inventory");
  const labels = Object.fromEntries(view.details.map((d) => [d.label, d.value]));
  assert.equal(labels["Available to order"], "48 vials");
  assert.equal(labels["Safety stock"], "60 vials");
  const exp = Object.fromEntries(presentAlert(expiring, { role: "admin", nowMs: 0 }).details.map((d) => [d.label, d.value]));
  assert.deepEqual([exp.Batch, exp["Expiry date"], exp["Vials in stock"]], ["HEP-002", "2026-11-20", "8"]);
});

test("stock and expiry alerts are Admin-only: never in the Dispatcher's bell or dashboard", () => {
  assert.equal(isAdminOnlyAlert(low), true);
  assert.equal(isAdminOnlyAlert({ type: "batch_expiry" }), true, "by type, even without the audience field");
  assert.equal(isAdminOnlyAlert({ type: "route_deviation" }), false);
  for (const file of ["src/pages/dispatcher/DispatcherLayout.jsx", "src/pages/dispatcher/DispatcherDashboard.jsx"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /\.filter\(\(a\) => !isAdminOnlyAlert\(a\)\)/, file);
  }
  // The feed itself shows whatever it is given; the layout filters first.
  const feed = buildDispatcherNotificationFeed({ alerts: [low].filter((a) => !isAdminOnlyAlert(a)), orders: [], near: [], nowMs: 0 });
  assert.equal(feed.actions.length + feed.updates.length, 0);
});

test("Admin Alerts counts both categories and offers Check stock now", () => {
  const page = readFileSync(new URL("../src/pages/admin/Alerts.jsx", import.meta.url), "utf8");
  assert.match(page, /stock: kpi\(activeAlertCountOfType\(alerts, "stock_low"\)\)/);
  assert.match(page, /expiry: kpi\(activeAlertCountOfType\(alerts, "batch_expiry"\)\)/);
  assert.match(page, /await recheckStockAlerts\(\)/);
  assert.equal(/no automatic low-stock alert writer exists/.test(page), false, "the outdated claim is gone");
});
