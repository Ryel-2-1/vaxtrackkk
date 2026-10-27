// Alert presentation: what every notification surface (Admin Alerts, its
// detail dialog, the Admin and Dispatcher dashboards, the Dispatcher bell)
// shows for an alert.
//
// Two layers, as elsewhere in this repo (no DOM renderer is installed):
//   1. Behaviour of src/services/alertPresentation.js, including parity with
//      the server wording in functions/src/riderTracking.js.
//   2. Source contracts for the page wiring, which cannot run without a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALERT_ACTION_LABEL,
  deviationAlertText,
  formatDistanceMeters,
  friendlyTime,
  orderCodeOf,
  presentAlert,
} from "../src/services/alertPresentation.js";

const require = createRequire(import.meta.url);
const server = require("../functions/src/riderTracking.js");

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
const ts = (ms) => ({ toMillis: () => ms });
const ORDER_ID = "IwBLnhfY6qUqwQ28Z2co";
const RIDER_UID = "Zx9KpQ2rT7bV4nWmLs8YcHd31Fa2";
const ALERT_ID = `route_deviation_${ORDER_ID}_${RIDER_UID}_sess_ab12cd34`;

const activeDeviation = (over = {}) => ({
  id: ALERT_ID,
  type: "route_deviation",
  title: "Route Deviation Detected",
  severity: "critical",
  status: "active",
  riderId: RIDER_UID,
  riderName: "Abdul Malik",
  orderId: ORDER_ID,
  deliveryId: ORDER_ID,
  orderNumber: "VT-ORD-1785072279117-6IMB",
  navigationSessionId: "sess_ab12cd34",
  distanceMeters: 1648.6,
  presentationVersion: 1,
  thresholdMeters: 500,
  minimumDurationMinutes: 3,
  path: `/dispatcher/shipments?order=${ORDER_ID}`,
  createdAt: ts(NOW - 5 * 60000),
  read: false,
  ...over,
});

const everythingRendered = (view) =>
  JSON.stringify({ ...view, path: undefined });

// ------------------------------------------------------------ formatting

test("the order reference is the official short code, never a Firestore document id", () => {
  assert.equal(orderCodeOf("VT-ORD-1785072279117-6IMB"), "6IMB");
  assert.equal(orderCodeOf("  VT-ORD-1785072279117-AB12  "), "AB12");
  // Legacy numbers have no code: the whole human number is the reference.
  assert.equal(orderCodeOf("VT-ORD-1784056096300"), "VT-ORD-1784056096300");
  for (const missing of [undefined, null, "", "   ", 42]) assert.equal(orderCodeOf(missing), null);
});

test("distances read 650 m below a kilometre and 1.65 km above it", () => {
  assert.equal(formatDistanceMeters(650), "650 m");
  assert.equal(formatDistanceMeters(649.6), "650 m");
  assert.equal(formatDistanceMeters(1648.6), "1.65 km");
  assert.equal(formatDistanceMeters(1000), "1 km");
  assert.equal(formatDistanceMeters(1500), "1.5 km");
  // The unit follows the rounded value: never "1000 m".
  assert.equal(formatDistanceMeters(999.6), "1 km");
  for (const bad of [undefined, null, -1, NaN, Infinity, "650"]) assert.equal(formatDistanceMeters(bad), null);
});

test("times are friendly", () => {
  assert.equal(friendlyTime(NOW - 20000, NOW), "just now");
  assert.equal(friendlyTime(NOW - 60000, NOW), "1 minute ago");
  assert.equal(friendlyTime(NOW - 5 * 60000, NOW), "5 minutes ago");
  assert.equal(friendlyTime(NOW - 2 * 3600000, NOW), "2 hours ago");
  assert.equal(friendlyTime(NOW - 30 * 3600000, NOW), "yesterday");
  assert.match(friendlyTime(NOW - 5 * 86400000, NOW), /^Oct \d{1,2}$/);
  assert.equal(friendlyTime(undefined, NOW), null);
});

test("the web wording is the server's wording (parity)", () => {
  assert.equal(server.ALERT_PRESENTATION_VERSION, 1);
  for (const n of ["VT-ORD-1785072279117-6IMB", "VT-ORD-1784056096300", "", null, undefined]) {
    assert.equal(orderCodeOf(n), server.orderCodeOf(n), String(n));
  }
  for (const m of [0, 1, 499.4, 650, 999.4, 999.6, 1000, 1648.6, 12345.678, -5, NaN, null]) {
    assert.equal(formatDistanceMeters(m), server.formatDistanceMeters(m), String(m));
  }
  const cases = [
    { status: "active", riderName: "Abdul Malik", orderNumber: "VT-ORD-1785072279117-6IMB", distanceMeters: 1648.6 },
    { status: "active", riderName: "", orderNumber: null, distanceMeters: undefined },
    { status: "resolved", riderName: "Abdul Malik", orderNumber: "VT-ORD-1785072279117-6IMB", resolutionReason: "returned_to_route" },
    { status: "resolved", riderName: null, orderNumber: "VT-ORD-1784056096300", resolutionReason: "completed" },
    { status: "resolved", riderName: "Abdul Malik", orderNumber: undefined, resolutionReason: "session_closed" },
  ];
  for (const c of cases) assert.equal(deviationAlertText(c), server.deviationAlertText(c), JSON.stringify(c));
});

// ------------------------------------------------------------ active vs resolved

test("an active route deviation reads as the spec example", () => {
  const view = presentAlert(activeDeviation(), { role: "admin", nowMs: NOW });
  assert.equal(view.title, "Route deviation");
  assert.equal(
    view.message,
    "Abdul Malik is 1.65 km away from the planned route for Order 6IMB. The deviation has continued for at least 3 minutes."
  );
  assert.equal(view.metaText, "Rider: Abdul Malik · Order: 6IMB · 5 minutes ago");
  assert.equal(view.actionLabel, "View details");
  assert.equal(ALERT_ACTION_LABEL, "View details");
  assert.equal(view.statusLabel, "Active");
  assert.equal(view.resolved, false);
  assert.equal(view.orderCode, "6IMB");
});

test("a resolved route deviation never still says the rider is off route", () => {
  const raw = activeDeviation({
    status: "resolved",
    resolutionReason: "returned_to_route",
    resolvedAt: ts(NOW - 2 * 60000),
    // The stored message of an alert resolved before this change still says
    // "off route"; it must not reach the screen.
    message: `Rider Abdul Malik has been more than 500 m from the assigned route for order ${ORDER_ID} for at least 3 minutes (now 1649 m off route).`,
  });
  const view = presentAlert(raw, { role: "admin", nowMs: NOW });
  assert.equal(view.title, "Route deviation resolved");
  assert.equal(view.message, "Abdul Malik returned to the planned route for Order 6IMB.");
  assert.equal(view.metaText, "Rider: Abdul Malik · Order: 6IMB · Resolved 2 minutes ago");
  assert.equal(view.statusLabel, "Resolved");
  assert.equal(view.resolved, true);
  assert.equal(view.actionLabel, "View details");
  assert.doesNotMatch(everythingRendered(view), /away from|off route|more than 500 m|has continued/);
  assert.ok(view.details.some((d) => d.label === "Resolved" && d.value === "2 minutes ago"));
});

test("a deviation that ended without a return says monitoring ended, not that the rider returned", () => {
  for (const reason of ["completed", "cancelled", "replaced", "abandoned", "tracking_stopped"]) {
    const view = presentAlert(activeDeviation({ status: "resolved", resolutionReason: reason }), { nowMs: NOW });
    assert.equal(view.message, "Route monitoring for Order 6IMB has ended.", reason);
  }
});

// ------------------------------------------------------------ privacy

test("ids, uids, raw paths and addresses are never rendered", () => {
  const raw = activeDeviation({
    clinicAddress: "12 Private St, Quezon City",
    destinationAddress: "Dr. Home, 7 Residence Ave",
    location: "7 Residence Ave",
    // A historical alert whose message embedded the order document id.
    message: `Rider Abdul Malik has been more than 500 m from the assigned route for order ${ORDER_ID}.`,
  });
  for (const role of ["admin", "dispatcher"]) {
    for (const status of ["active", "resolved"]) {
      const view = presentAlert({ ...raw, status }, { role, nowMs: NOW });
      const shown = everythingRendered(view);
      for (const secret of [ORDER_ID, RIDER_UID, ALERT_ID, "sess_ab12cd34", "alerts/", "orders/", "Private St", "Residence Ave"]) {
        assert.ok(!shown.includes(secret), `${role}/${status}: ${secret} must not be rendered`);
      }
      // The full human order number is fine (it is what staff quote).
      assert.ok(view.details.some((d) => d.label === "Order" && d.value === "VT-ORD-1785072279117-6IMB"));
    }
  }
});

test("historical alerts fall back to safe generic wording", () => {
  const legacy = {
    id: ALERT_ID,
    type: "route_deviation",
    title: "Route Deviation Detected",
    status: "active",
    severity: "critical",
    riderId: RIDER_UID,
    orderId: ORDER_ID,
    message: `Rider  has been more than 500 m from the assigned route for order ${ORDER_ID} for at least 3 minutes.`,
    createdAt: ts(NOW - 3600000),
  };
  const view = presentAlert(legacy, { role: "admin", nowMs: NOW });
  assert.equal(view.title, "Route deviation");
  assert.equal(
    view.message,
    "The rider is more than 500 m away from the planned route for this order. The deviation has continued for at least 3 minutes."
  );
  assert.equal(view.metaText, "1 hour ago");
  assert.ok(view.details.some((d) => d.label === "Rider" && d.value === "Not recorded"));
  assert.ok(view.details.some((d) => d.label === "Order" && d.value === "Not recorded"));
  assert.ok(!everythingRendered(view).includes(ORDER_ID));

  // Nothing at all: still a readable card.
  const bare = presentAlert({ type: "route_deviation" }, { nowMs: NOW });
  assert.equal(bare.title, "Route deviation");
  assert.match(bare.message, /^The rider is more than 500 m away from the planned route for this order\./);
  assert.deepEqual(bare.meta, []);
  assert.equal(bare.path, null);
});

test("late-delivery and other alerts keep their own wording", () => {
  const late = presentAlert(
    { type: "delivery_delay", status: "active", riderName: "Abdul Malik", orderId: ORDER_ID, orderNumber: "VT-ORD-1785072279117-6IMB", message: "Order 6IMB is 12 minutes past its expected arrival.", path: `/dispatcher/shipments?order=${ORDER_ID}`, createdAt: ts(NOW - 60000) },
    { role: "dispatcher", nowMs: NOW }
  );
  assert.equal(late.title, "Delivery running late");
  assert.equal(late.message, "Order 6IMB is 12 minutes past its expected arrival.");
  assert.equal(late.metaText, "Rider: Abdul Malik · Order: 6IMB · 1 minute ago");

  const stock = presentAlert({ type: "low_stock", title: "Low stock: BCG", message: "BCG is below its reorder level.", riderName: "Abdul Malik", createdAt: ts(NOW - 60000) }, { nowMs: NOW });
  assert.equal(stock.title, "Low stock: BCG");
  assert.equal(stock.metaText, "1 minute ago", "rider/order metadata only on order-linked alerts");
  assert.equal(stock.path, null);
});

// ------------------------------------------------------------ navigation

test("the action opens the delivery for the viewer's role", () => {
  assert.equal(presentAlert(activeDeviation(), { role: "admin", nowMs: NOW }).path, `/admin/deliveries?order=${ORDER_ID}`);
  assert.equal(presentAlert(activeDeviation(), { role: "dispatcher", nowMs: NOW }).path, `/dispatcher/shipments?order=${ORDER_ID}`);
  // Older alerts with no stored path still get the Shipments link.
  assert.equal(presentAlert(activeDeviation({ path: undefined }), { role: "dispatcher", nowMs: NOW }).path, `/dispatcher/shipments?order=${ORDER_ID}`);
  // A stored path is only followed when it is a Dispatcher route.
  assert.equal(presentAlert(activeDeviation({ path: "https://example.com/x" }), { role: "dispatcher", nowMs: NOW }).path, `/dispatcher/shipments?order=${ORDER_ID}`);
  // Resolved alerts keep the link — "View details" on a resolved card still reviews the delivery.
  assert.equal(presentAlert(activeDeviation({ status: "resolved", resolutionReason: "returned_to_route" }), { role: "admin", nowMs: NOW }).path, `/admin/deliveries?order=${ORDER_ID}`);
});

test("presenting an alert is pure: it never changes the alert", () => {
  const raw = activeDeviation();
  const before = JSON.stringify(raw);
  presentAlert(raw, { role: "admin", nowMs: NOW });
  presentAlert(raw, { role: "dispatcher", nowMs: NOW });
  assert.equal(JSON.stringify(raw), before);
  const src = read("src/services/alertPresentation.js");
  assert.doesNotMatch(src, /^\s*import\s/m, "no imports");
  assert.doesNotMatch(src, /from "firebase|getFirestore|updateDoc|setDoc|writeBatch/, "no Firebase access");
});

// ------------------------------------------------------------ surface wiring (source contracts)

test("Admin Alerts renders presented fields only — no alert id, source id or raw message", () => {
  const page = read("src/pages/admin/Alerts.jsx");
  assert.match(page, /import \{ presentAlert \} from "\.\.\/\.\.\/services\/alertPresentation";/);
  assert.match(page, /const view = presentAlert\(raw, \{ role: "admin", fallbackTitle: mapped\.display \}\);/);
  // The old metadata row printed the alert document id and the order document id.
  assert.doesNotMatch(page, /<small>\{alert\.id\}<\/small>|\{alert\.source\}|\{alert\.deliveryId\}|<strong>\{alert\.id\}<\/strong>/);
  assert.doesNotMatch(page, /<span>Alert ID<\/span>|<span>Source<\/span>/);
  assert.doesNotMatch(page, /raw\.deliveryId \|\| raw\.orderId/);
  // Titles, messages and metadata come from the presentation.
  assert.match(page, /<h3>\{alert\.title\}<\/h3>/);
  assert.match(page, /<p className="alert-row-meta">\{alert\.meta\.join\(" · "\)\}<\/p>/);
  assert.match(page, /<h2 id="alert-review-title">\{alert\.title\}<\/h2>/);
  assert.match(page, /\{alert\.details\.map\(/);
  assert.match(page, /<strong>\{alert\.statusLabel\}<\/strong>/);
  // "Review" became "View details" on both the row and the priority card.
  assert.doesNotMatch(page, />\s*Review( Alert)?\s*</);
  assert.match(page, /\{alert\.actionLabel\}/);
  assert.match(page, /\{priorityAlert\.actionLabel\}/);
  // The confirmation names the presented title and the human order code.
  assert.match(page, /target=\{selectedAlert\.orderCode \? `\$\{selectedAlert\.title\} · Order \$\{selectedAlert\.orderCode\}` : selectedAlert\.title\}/);
  // "Open delivery" is a real navigation to the presented path.
  assert.match(page, /onOpenDelivery=\{selectedAlert\.path \? \(\) => navigate\(selectedAlert\.path\) : null\}/);
  assert.match(page, /\{onOpenDelivery && \(\s*<button type="button" className="alerts-light-action" onClick=\{onOpenDelivery\}>/);
  // A resolved alert does not keep asking for action.
  assert.match(page, /status === "resolved" \? "No further action required\."/);
  // Reading only marks the alert read — it never writes to an order or a session.
  assert.doesNotMatch(page, /updateOrder|orderService|navigationSessions|riderTrackingState/);
});

test("unread is a neutral 'New' label, distinct from operational status colours", () => {
  const page = read("src/pages/admin/Alerts.jsx");
  assert.match(page, /\{!alert\.read && <span className="alert-unread-tag">New<\/span>\}/);
  const css = read("src/pages/admin/Alerts.css");
  assert.doesNotMatch(css, /\.alert-row\.unread::after/, "the green status-like dot is gone");
  const tag = /\.alert-row-title \.alert-unread-tag \{([^}]*)\}/.exec(css);
  assert.ok(tag, "the New label is styled");
  assert.doesNotMatch(tag[1], /green|success|danger|warning|#16a34a|#dc2626/i, "neutral, not a status colour");
});

test("the dashboards and the Dispatcher bell use the same presentation", () => {
  const admin = read("src/pages/admin/AdminDashboard.jsx");
  assert.match(admin, /const view = presentAlert\(raw, \{ role: "admin", fallbackTitle: raw\.type \|\| "Alert" \}\);/);
  assert.match(admin, /title: view\.title,\s*desc: view\.message \|\| raw\.description \|\| "—",/);

  const disp = read("src/pages/dispatcher/DispatcherDashboard.jsx");
  assert.match(disp, /presentAlert\(activeAlerts\[0\], \{ role: "dispatcher" \}\)/);
  // The banner printed the raw riderName and an undefined `location`.
  assert.doesNotMatch(disp, /latestAlert\.location|latestAlert\.riderName/);

  const bell = read("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.match(bell, /const view = presentAlert\(notification, \{ role: "dispatcher", nowMs: minuteNow \}\);/);
  assert.match(bell, /<strong>\{view\.title\}<\/strong>/);
  assert.match(bell, /<p>\{view\.message \|\| "No additional details\."\}<\/p>/);
  assert.doesNotMatch(bell, /notification\.title|notification\.message\b/);
});

test("Admin Deliveries opens the drawer for an alert's ?order= link", () => {
  const page = read("src/pages/admin/Deliveries.jsx");
  assert.match(page, /const linkedOrderId = searchParams\.get\("order"\) \|\| "";/);
  assert.match(page, /deliveryList\.find\(\(d\) => d\.uid === linkedOrderId\)/);
  // A manually opened drawer follows the live order after loading or cancellation.
  assert.match(page, /const openDelivery = selectedDelivery\s*\? deliveryList\.find\(\(delivery\) => delivery\.uid === selectedDelivery\.uid\) \?\? null\s*: linkedDelivery;/);
  assert.match(page, /\{openDelivery && \(\s*<DeliveryModal\s*delivery=\{openDelivery\}/);
  // Closing drops the parameter so the drawer does not reopen.
  assert.match(page, /next\.delete\("order"\);/);
});

test("alert authorization is unchanged: Admin/Dispatcher read, Admin writes", () => {
  const rules = read("firestore.rules");
  const block = /match \/alerts\/\{id\} \{([\s\S]*?)\n\s*\}/.exec(rules);
  assert.ok(block, "alerts rule block");
  assert.equal(
    block[1].trim().replace(/\s+/g, " "),
    "allow get, list: if isAdmin() || isDispatcher(); allow create, update, delete: if isAdmin();"
  );
});
