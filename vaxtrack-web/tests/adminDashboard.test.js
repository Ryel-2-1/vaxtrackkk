import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The Admin Dashboard shows only what its subscriptions support.
 *
 * Negative controls were run first against the unfixed page and all five
 * passed, proving: the removed fake map still shipped its entire stylesheet
 * (a painted canvas, a dashed "planned route", a rider marker pinned at
 * left:307px pulsing as though live, and a tooltip at fixed coordinates); none
 * of that markup existed anywhere, so ~1,000 lines were pure dead weight; the
 * "Updated" column and its caption claimed an update time while rendering
 * `createdAt`; the "Delayed / missing" KPI counted cancelled orders as missing;
 * and "Stock healthy" rested on an `inventory.status` no writer ever
 * recomputes.
 *
 * Nothing was invented to replace any of it. No collection, field, writer,
 * location stream or localStorage fallback was added, and Admin live rider
 * mapping remains a client/adviser decision that is deliberately not
 * implemented here.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SRC = read("src/pages/admin/AdminDashboard.jsx");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const CSS = read("src/pages/admin/AdminDashboard.css");
/** JSX text nodes — what a reader actually sees. */
const TEXT = [...CODE.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean);

// ------------------------------------------- no fabricated operational data

test("no hardcoded rider, map or marker styling can return", () => {
  // The fake map was drawn entirely in CSS at literal pixel offsets. Any of
  // these coming back means a rider is being placed somewhere by hand again.
  for (const cls of [
    "v2-live-map", "v2-planned-route", "v2-current-route", "v2-map-dot",
    "v2-rider-tooltip", "v2-map-controls", "v2-recenter-btn", "v2-map-legend",
    "v2-map-card", "v2-rider-panel", "v2-rider-avatar", "v2-rider-info",
    "v2-contact-btn", "v2-notification-panel", "v2-inspect-modal", "v2-toast",
    "v2-trend", "v2-metric-card",
  ]) {
    assert.equal(CSS.includes(cls), false, `${cls} styled fabricated content`);
  }
  assert.equal(/v2PulseRider/.test(CSS), false, "the pulsing rider marker must not return");

  // And nothing may position an operational element by hand.
  assert.equal(
    /position:\s*absolute[\s\S]{0,200}?(left|top):\s*\d{2,}px/.test(CSS),
    false,
    "no element may be pinned to an invented coordinate"
  );
});

test("no live-tracking claim appears anywhere the admin reads", () => {
  // "Live" survives only where it is true — these are Firestore onSnapshot
  // subscriptions, so "live counts" is accurate. What may not appear is any
  // claim to be tracking a person or a vehicle.
  for (const phrase of [
    "live map", "live tracking", "tracking", "en route", "gps",
    "route history", "view full route", "recenter", "last seen",
    "km away", "arriving", "on the way", "current location",
  ]) {
    for (const text of TEXT) {
      assert.equal(
        text.toLowerCase().includes(phrase),
        false,
        `"${text}" claims ${phrase}, which this page has no source for`
      );
    }
  }
});

test("no ETA, vehicle, route or location is rendered", () => {
  // Fields that exist elsewhere in the system but have no authoritative Admin
  // source. Reading any of them here would be the start of implying live
  // tracking from Dispatcher-only or rider-foreground data.
  for (const field of [
    "lastLocation", "locationAccuracy", "routePolyline", "routeEtaText",
    "routeDurationSeconds", "routeDistanceMeters", "clinicLat", "clinicLng",
    "latitude", "longitude", "vehiclePlate", "motorcycle", "geofence",
    "GEOFENCE_RADIUS", "heading", "speed",
  ]) {
    assert.equal(CODE.includes(field), false, `${field} has no authoritative Admin source`);
  }
  // Nor may an ETA be shown under any wording.
  for (const text of TEXT) {
    assert.equal(/\beta\b|estimated arrival/i.test(text), false, `"${text}" promises an ETA`);
  }
});

test("no static array, sample row or fixed percentage supplies a metric", () => {
  // Every figure comes from state fed by a subscription. A literal array of
  // operational objects is how the old rider panel and alert list were built.
  assert.equal(
    /const \w*(riders?|deliveries|orders|alerts|markers|hubs)\w*\s*=\s*\[\s*\{/i.test(CODE),
    false,
    "no seeded array of operational records"
  );
  // The only percentage on the page is the breakdown bar, computed from counts.
  assert.match(SRC, /const pct = activeCount > 0 \? Math\.round\(\(count \/ activeCount\) \* 100\) : 0;/);
  assert.equal(
    /width:\s*`?\$?\{?\s*\d+%/.test(CODE),
    false,
    "no bar may be drawn at a fixed width"
  );
});

// ------------------------------------------------ genuine data stays wired

test("all four Firestore subscriptions remain connected", () => {
  for (const sub of [
    "subscribeDeliveries", "subscribeAllAlerts", "subscribeRiders", "subscribeInventory",
  ]) {
    assert.match(CODE, new RegExp(`${sub}\\(`), `${sub} must still feed the page`);
  }
  // Read through services only — the page opens no Firestore handle of its own.
  assert.equal(/from ["']firebase\/firestore["']/.test(CODE), false);
  assert.equal(/collection\(db,/.test(CODE), false);
  // Every KPI is a state value, never a literal.
  const values = [...CODE.matchAll(/value: (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(values, ["deliveryCount", "delayedCount", "criticalCount", "riderCount"]);
  // Alerts are the unresolved ones, counted from the collection.
  assert.match(SRC, /\.filter\(\(a\) => a\.status !== "resolved"\)/);
});

test("the breakdown covers every canonical status", () => {
  // `delivery_failed` was omitted from a hand-written list, so a failed
  // delivery counted toward the total and the percentage denominator but had
  // no row. Taking the order from the canonical export makes that impossible.
  assert.match(SRC, /import \{ ORDER_STATUSES \} from "\.\.\/\.\.\/services\/orderWorkflow"/);
  assert.match(SRC, /const BREAKDOWN_ORDER = ORDER_STATUSES;/);

  // And every one of those statuses has a bar tone, so no row renders blank.
  const statuses = [...read("src/services/orderWorkflow.js")
    .match(/export const ORDER_STATUSES = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(statuses.includes("delivery_failed"), "the canonical list must include it");
  for (const s of statuses) {
    assert.match(CSS, new RegExp(`i\\.tone-${s}\\b`), `${s} needs a bar tone`);
  }
});

test("the Placed column is named for the value it carries", () => {
  // It renders `createdAt`. It was headed "Updated".
  assert.match(SRC, /<th scope="col">Placed<\/th>/);
  assert.match(SRC, /time: formatRelativeTime\(o\.createdAt\)/);
  assert.equal(/<th scope="col">Updated<\/th>/.test(CODE), false);
  assert.equal(/since the last update/.test(CODE), false);
});

test("no KPI states a verdict its field cannot support", () => {
  // "Stock healthy" claimed a condition from a flag stamped once at creation
  // and never recomputed. The KPI now measures the expiry date itself — see
  // tests/expiryStatus.test.js for the derivation and its boundaries.
  assert.equal(/Stock healthy/.test(CODE), false);
  assert.match(SRC, /label: "Expiring or expired stock"/);
  assert.match(SRC, /deriveExpiryCondition\(b, today\)/);
  // And nothing is called missing: the figure is delayed plus cancelled.
  assert.equal(/missing/i.test(CODE), false, "no order is described as missing");
  assert.match(SRC, /label: "Delayed \/ cancelled"/);
});

// ------------------------------------------------------- neutral fallbacks

test("absent data renders a neutral state, never a filled-in one", () => {
  // No timestamp shows a dash rather than "Just now".
  assert.match(SRC, /if \(!timestamp\) return "—";/);
  // An alert whose type is unmapped gets the neutral dot, not an invented
  // severity. It used to default to "warning".
  assert.match(SRC, /ALERT_TYPE_MAP\[raw\.type\] \|\| "unknown"/);
  assert.match(SRC, /ALERT_DOT\[alert\.type\] \|\| "var\(--gray-400,#9ca3af\)"/);
  assert.equal(/\|\| "warning"/.test(CODE), false, "severity may not be assumed");
  // Each section has its own empty state, and the page keeps loading and error
  // handling rather than rendering zeros over missing data.
  assert.match(SRC, /No orders yet/);
  assert.match(SRC, /No active alerts right now/);
  assert.match(SRC, /\{loadError && \(/);
  assert.match(SRC, /role="alert"/);
  assert.match(SRC, /loading \?/);
});

// ------------------------------------------------------------- every action

test("every action leads somewhere real", () => {
  // Collected from both shapes on the page: the literal navigate() calls and
  // the ledger cells' `to` values.
  const targets = [
    ...[...CODE.matchAll(/navigate\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...CODE.matchAll(/to: "([^"]+)"/g)].map((m) => m[1]),
  ];
  assert.ok(targets.length >= 6, "the page must still navigate");

  const routes = new Set(
    [...read("src/App.jsx").matchAll(/path="([^"]+)"/g)].map((m) => m[1])
  );
  for (const t of new Set(targets)) {
    assert.ok(routes.has(t), `${t} is not a declared route`);
  }

  // No handler may report work instead of doing it: there is no toast, no
  // alert(), and no click that only sets a message.
  for (const fake of ["showToast", "window.alert", "Coming soon", "not implemented"]) {
    assert.equal(CODE.includes(fake), false, `${fake} must not appear`);
  }
  // The page writes nothing at all — it is a read-only summary.
  for (const w of ["setDoc", "updateDoc", "addDoc", "deleteDoc", "writeBatch", "localStorage"]) {
    assert.equal(CODE.includes(w), false, `the dashboard must not ${w}`);
  }
});

test("the dashboard stylesheet no longer carries anything it cannot render", () => {
  // Every class the stylesheet defines must be one the component can produce.
  const defined = new Set(
    [...CSS.matchAll(/^\s*\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1])
  );
  const layoutOwned = new Set(["adx-main", "adx-header", "adx-kpis"]);
  const statuses = [...read("src/services/orderWorkflow.js")
    .match(/export const ORDER_STATUSES = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .matchAll(/"([^"]+)"/g)].map((m) => `tone-${m[1]}`);

  for (const cls of defined) {
    if (layoutOwned.has(cls) || statuses.includes(cls)) continue;
    assert.ok(
      SRC.includes(cls),
      `.${cls} has no markup — dead rules are where the fake map survived`
    );
  }
});

test("no other admin page depends on the removed rules", () => {
  // The stylesheet is global once imported, so a deleted rule could in
  // principle have been styling someone else's markup.
  const files = readdirSync(new URL("../src/pages/admin/", import.meta.url))
    .filter((f) => f.endsWith(".jsx"));
  for (const f of files) {
    const src = read(`src/pages/admin/${f}`);
    for (const cls of ["v2-map", "v2-rider", "v2-metric-card", "v2-trend", "v2-toast"]) {
      assert.equal(src.includes(cls), false, `${f} still references ${cls}`);
    }
  }
});
