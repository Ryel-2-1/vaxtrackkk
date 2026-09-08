import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServiceLoader } from "./serviceHarness.js";
import { ORDER_STATUSES, STATUS_LABELS } from "../src/services/orderWorkflow.js";

/**
 * Admin Deliveries shows the orders collection and nothing else.
 *
 * Negative controls were run first against the unfixed page and all ten
 * passed, proving: `delivery_failed` had no count on any card; an unrecognised
 * status was labelled "Pending" and bucketed with orders progressing normally;
 * the "transit" bucket absorbed delivered and completed orders so finished
 * deliveries were reported as on route, and "delayed" absorbed cancelled ones
 * so closed orders inflated the delayed figure and its red banner; `vehicle`
 * and `plate` were read from fields NOTHING in the system has ever written;
 * the ETA column restated the status; `storageTemp` and `region` came only
 * from the superseded client order path; five controls raised a toast and did
 * nothing, one of them announcing a state change ("marked as reviewed") that
 * was never written; and a document with no status field became "Pending".
 *
 * Nothing was invented to replace any of it. Admin stays read-only: the page
 * performs no write, and the only action added is a tel: link built from the
 * rider phone number the order already carries.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PAGE = read("src/pages/admin/Deliveries.jsx");
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const SERVICE = read("src/services/deliveryService.js");

const loader = createServiceLoader();
const svc = await loader.load("deliveryService.js");
const {
  getOrderStatusValue,
  mapOrderStatusLabel,
  mapOrderStatusType,
  normalizeStatusKey,
  resolveStatusKey,
  UNKNOWN_STATUS_KEY,
  UNKNOWN_STATUS_LABEL,
} = svc;

// -------------------------------------------------- the canonical status list

test("every canonical status is its own category, labelled from one place", () => {
  for (const key of ORDER_STATUSES) {
    assert.equal(mapOrderStatusType(key), key, `${key} must be its own category`);
    assert.equal(mapOrderStatusLabel(key), STATUS_LABELS[key]);
  }
  // No two statuses share a bucket any more, so a count can never include a
  // state its label does not name.
  const categories = ORDER_STATUSES.map(mapOrderStatusType);
  assert.equal(new Set(categories).size, ORDER_STATUSES.length);
});

test("delivery_failed is visible, labelled, filterable and counted", () => {
  assert.equal(mapOrderStatusType("delivery_failed"), "delivery_failed");
  assert.equal(mapOrderStatusLabel("delivery_failed"), "Delivery Failed");
  // It has its own KPI card — it previously had none.
  assert.match(PAGE, /label="Delivery failed"/);
  assert.match(PAGE, /value=\{failedCount\}/);
  assert.match(PAGE, /const failedCount = countOf\("delivery_failed"\);/);
  assert.match(PAGE, /setStatusFilter\("delivery_failed"\)/);
  // And it is one of the two statuses the review banner covers.
  assert.match(PAGE, /d\.statusType === "delayed" \|\| d\.statusType === "delivery_failed"/);
  // The filter options come from the canonical list, so it cannot be dropped.
  assert.match(PAGE, /\{ORDER_STATUSES\.map\(\(key\) => \(/);
  assert.match(PAGE, /<option key=\{key\} value=\{key\}>\s*\n?\s*\{STATUS_LABELS\[key\]\}/);
});

test("a delivered order is not counted as in transit, nor a cancelled one as delayed", () => {
  assert.notEqual(mapOrderStatusType("delivered"), mapOrderStatusType("in_transit"));
  assert.notEqual(mapOrderStatusType("completed"), mapOrderStatusType("in_transit"));
  assert.notEqual(mapOrderStatusType("cancelled"), mapOrderStatusType("delayed"));
  assert.notEqual(mapOrderStatusType("canceled"), mapOrderStatusType("delayed"));
  // The legacy aliases still DISPLAY as their canonical synonym.
  assert.equal(mapOrderStatusLabel("completed"), STATUS_LABELS.delivered);
  assert.equal(mapOrderStatusLabel("canceled"), STATUS_LABELS.cancelled);
  assert.equal(mapOrderStatusType("completed"), "delivered");
  assert.equal(mapOrderStatusType("canceled"), "cancelled");
  // Each card counts exactly the status it names.
  assert.match(PAGE, /const inTransitCount = countOf\("in_transit"\);/);
  assert.match(PAGE, /const delayedCount = countOf\("delayed"\);/);
});

// ------------------------------------------------------ the unknown state

test("an unrecognised status becomes Unknown, never a real lifecycle state", () => {
  for (const bogus of ["picked_up", "returned", "on_hold", "reviewed", "zzz", ""]) {
    assert.equal(resolveStatusKey(bogus), null);
    assert.equal(mapOrderStatusLabel(bogus), UNKNOWN_STATUS_LABEL);
    assert.equal(mapOrderStatusType(bogus), UNKNOWN_STATUS_KEY);
  }
  // "pending" was never a canonical status — it only ever arrived from the old
  // `|| "pending"` fallback — so it resolves to unknown like anything else.
  assert.equal(mapOrderStatusLabel("pending"), UNKNOWN_STATUS_LABEL);
  assert.equal(ORDER_STATUSES.includes("pending"), false);
  // And unknown is neither of the states it used to be mistaken for.
  assert.notEqual(UNKNOWN_STATUS_KEY, "pending_dispatch");
  assert.notEqual(UNKNOWN_STATUS_KEY, "delayed");
  // The page surfaces such documents rather than hiding them.
  assert.match(PAGE, /unrecognised status/);
  assert.match(PAGE, /setStatusFilter\(UNKNOWN_STATUS_KEY\)/);
});

test("a document with no status field is unknown, not pending", () => {
  assert.equal(getOrderStatusValue({}), null);
  assert.equal(getOrderStatusValue({ status: "" }), null);
  assert.equal(getOrderStatusValue({ status: "   " }), null);
  assert.equal(getOrderStatusValue({ status: 7 }), null);
  assert.equal(mapOrderStatusType(normalizeStatusKey(null)), UNKNOWN_STATUS_KEY);
});

// ------------------------------------------------------- field precedence

test("the canonical field wins over every obsolete one", () => {
  // Present and canonical: nothing else is consulted, whatever it says.
  assert.equal(
    getOrderStatusValue({ status: "delivered", orderStatus: "in_transit" }),
    "delivered"
  );
  assert.equal(
    getOrderStatusValue({
      status: "cancelled",
      orderStatus: "assigned",
      deliveryStatus: "loading",
      shipmentStatus: "delayed",
      dispatchStatus: "in_transit",
    }),
    "cancelled"
  );
  // Present but unrecognised still wins — it is the current field, and falling
  // through to a legacy one would let an obsolete value describe the order.
  assert.equal(getOrderStatusValue({ status: "zzz", orderStatus: "delivered" }), "zzz");

  // Absent: the legacy fields answer in a fixed, documented order.
  assert.equal(getOrderStatusValue({ orderStatus: "in_transit" }), "in_transit");
  assert.equal(
    getOrderStatusValue({ deliveryStatus: "loading", shipmentStatus: "delayed" }),
    "loading"
  );
  assert.equal(getOrderStatusValue({ dispatchStatus: "assigned" }), "assigned");
  assert.deepEqual(svc.STATUS_FIELDS, [
    "status",
    "orderStatus",
    "deliveryStatus",
    "shipmentStatus",
    "dispatchStatus",
  ]);
});

// ---------------------------------------------------- identity and sources

test("the Firestore document id cannot be shadowed by a stored field", () => {
  assert.match(SERVICE, /\.\.\.data,\s*\n\s*id: d\.id,/);
  const spreadAt = SERVICE.indexOf("...data,");
  const idAt = SERVICE.indexOf("id: d.id,");
  assert.ok(spreadAt !== -1 && idAt > spreadAt, "the id must be assigned last");
  // The page keeps the real id separate from the display label.
  assert.match(PAGE, /uid: raw\.id,/);
  assert.match(PAGE, /id: raw\.orderNumber \|\| raw\.id\.slice\(0, 10\)\.toUpperCase\(\),/);
});

test("no rider, vehicle, location, ETA, proof or temperature is invented", () => {
  // Fields nothing writes are not read at all, rather than dashed forever.
  for (const phantom of ["raw.vehicle", "raw.plate", "raw.storageTemp", "raw.region"]) {
    assert.equal(CODE.includes(phantom), false, `${phantom} has no writer`);
  }
  assert.equal(/Vehicle not assigned/.test(CODE), false, "no vehicle is implied");
  assert.equal(/<th>Rider &amp; vehicle<\/th>/.test(CODE), false);
  // The ETA was the status restated under an arrival heading.
  assert.equal(/\beta:/.test(CODE), false, "no ETA field");
  assert.equal(/etaType/.test(CODE), false);
  // No location or route source is reached for.
  for (const f of ["lastLocation", "routePolyline", "routeEtaText", "clinicLat", "geofence"]) {
    assert.equal(CODE.includes(f), false, `${f} has no authoritative Admin source`);
  }
  // Proof is a pass-through of what the rider uploaded, never a placeholder.
  assert.match(PAGE, /proofOfDeliveryUrl: raw\.proofOfDeliveryUrl \|\| "",/);
  assert.match(PAGE, /invoiceUrl: raw\.invoiceUrl \|\| "",/);
});

test("no timestamp is shown under the wrong meaning", () => {
  // Each label names the field beneath it.
  assert.match(PAGE, /<span>Order created<\/span>\s*\n\s*<strong className="tnum">\{created\}/);
  assert.match(PAGE, /<span>Rider assigned<\/span>\s*\n\s*<strong className="tnum">\{assigned\}/);
  assert.match(PAGE, /<span>Last status update<\/span>\s*\n\s*<strong className="tnum">\{statusUpdated\}/);
  assert.match(PAGE, /const created = formatDateTime\(delivery\.createdAt\);/);
  assert.match(PAGE, /const assigned = formatDateTime\(delivery\.assignedAt\);/);
  assert.match(PAGE, /const statusUpdated = formatDateTime\(delivery\.statusUpdatedAt\);/);
  // createdAt is never presented as an update, a dispatch or a delivery.
  for (const wrong of ["Updated", "Delivered at", "Dispatched"]) {
    assert.equal(
      new RegExp(`<span>${wrong}[^<]*</span>\\s*\\n?\\s*<strong[^>]*>\\{created\\}`).test(PAGE),
      false,
      `createdAt must not be labelled ${wrong}`
    );
  }
  // An absent timestamp renders nothing rather than a guess.
  assert.match(PAGE, /if \(!ts\) return null;/);
  assert.match(PAGE, /No activity recorded yet\./);
});

// ------------------------------------------------------- read-only, real

test("every retained action is real, and the page writes nothing", () => {
  // The five toast-only controls are gone, and so is the toast itself.
  for (const gone of [
    "showToast", "Mark Reviewed", "View Route", "Contact Rider",
    "marked as reviewed", "Live route view activates", "New delivery",
  ]) {
    assert.equal(CODE.includes(gone), false, `"${gone}" reported work it never did`);
  }
  assert.equal(/onResolve|onRoute|onContact/.test(CODE), false);

  // What remains: filters and selection (local view state), a real tel: link
  // built from the order's own field, and the logout navigation.
  assert.match(PAGE, /href=\{`tel:\$\{delivery\.riderPhone\}`\}/);
  assert.match(PAGE, /\{delivery\.riderPhone \?/, "the link only appears with a number");
  assert.match(PAGE, /navigate\("\/login"\)/);

  // Admin remains read-only: no write of any kind, and no local mutation of a
  // status after an action — the subscription stays authoritative.
  for (const w of ["updateDoc", "setDoc", "addDoc", "deleteDoc", "writeBatch", "runTransaction"]) {
    assert.equal(CODE.includes(w), false, `Admin Deliveries must not ${w}`);
  }
  assert.equal(
    /setDeliveryList\((?!raw\.map)/.test(CODE),
    false,
    "the list is only ever replaced from a snapshot"
  );
  assert.equal(/from ["']firebase\/firestore["']/.test(CODE), false);
});

test("loading, error and empty states are preserved", () => {
  assert.match(PAGE, /const \[loading, setLoading\] = useState\(true\);/);
  assert.match(PAGE, /setLoadError\(error\.message \|\| "Failed to load deliveries\."\)/);
  assert.match(PAGE, /\{loading &&/);
  assert.match(PAGE, /subscribeDeliveries\(/);
});
