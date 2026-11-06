import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAST_REQUESTED_LABEL, isRunningLate, requestedArrivalMiss } from "../src/services/deliveryTiming.js";

// "Past requested arrival": the server's marker, shown beside the lifecycle
// status. It is a separate fact from timingStatus, which measures the route.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ts = (text) => ({ toMillis: () => Date.parse(text) });
const missed = (over = {}) => ({
  statusKey: "in_transit",
  requestedArrivalMissedAt: ts("2026-11-04T16:15:00Z"),
  requestedArrivalDeadlineAt: ts("2026-11-04T11:01:00Z"),
  ...over,
});

test("the chip names the last requested minute, in Manila time", () => {
  const miss = requestedArrivalMiss(missed());
  assert.equal(miss.label, PAST_REQUESTED_LABEL);
  assert.match(miss.detail, /^Requested by 7:00 PM, Nov 4$/i);
});

test("it comes only from the server's marker, and only while the order is still undelivered", () => {
  assert.equal(requestedArrivalMiss({ statusKey: "in_transit" }), null, "never worked out from the viewer's clock");
  assert.equal(requestedArrivalMiss(missed({ requestedArrivalDeadlineAt: null })), null);
  for (const statusKey of ["delivered", "cancelled", "delivery_failed", "pending_dispatch"]) {
    assert.equal(requestedArrivalMiss(missed({ statusKey })), null, statusKey);
  }
  for (const statusKey of ["assigned", "loading", "in_transit", "delayed"]) {
    assert.ok(requestedArrivalMiss(missed({ statusKey })), statusKey);
  }
});

test("'On time' never sits beside 'Past requested arrival'", () => {
  const src = read("src/components/ui/TimingIndicator.jsx");
  assert.match(src, /const showTiming = t && !\(miss && t\.status === "on_time"\);/);
  assert.match(src, /if \(!t && !miss\) return null;/, "an assigned order has a miss but no timing");
});

test("both order pages pass the marker through, and no client may write it", () => {
  for (const page of ["src/pages/admin/Deliveries.jsx", "src/pages/salesRep/SalesRepOrderTracking.jsx"]) {
    assert.match(read(page), /requestedArrivalMissedAt: raw\.requestedArrivalMissedAt \?\? null/, page);
    assert.match(read(page), /requestedArrivalDeadlineAt: raw\.requestedArrivalDeadlineAt \?\? null/, page);
  }
  const rules = read("firestore.rules");
  const block = rules.slice(rules.indexOf("function serverOnlyOrderFields()"), rules.indexOf("];", rules.indexOf("function serverOnlyOrderFields()")));
  assert.match(block, /'requestedArrivalMissedAt', 'requestedArrivalDeadlineAt'/);
});

test("the Dispatcher sees it on the live map, in the list and the overview", () => {
  const src = read("src/pages/dispatcher/DispatcherGeofence.jsx");
  assert.ok(src.includes("<TimingIndicator order={order} detail={false} />"));
  assert.ok(src.includes("<TimingIndicator order={selected} />"));
  assert.ok(read("src/pages/dispatcher/DispatcherShipments.jsx").includes('<TimingIndicator order={order} detail="primary" />'));
});

test("the Dispatcher dashboard counts automatic delays and past-requested orders", () => {
  assert.equal(isRunningLate({ statusKey: "delayed" }), true, "a Rider's hold");
  assert.equal(isRunningLate({ statusKey: "in_transit", timingStatus: "delayed" }), true, "the server's automatic delay");
  assert.equal(isRunningLate({ statusKey: "in_transit", timingStatus: "on_time" }), false);
  assert.equal(isRunningLate({ statusKey: "delivered", timingStatus: "delayed" }), false, "finished orders are not running late");
  const src = read("src/pages/dispatcher/DispatcherDashboard.jsx");
  assert.ok(src.includes("allOrders.filter(isRunningLate)"));
  assert.match(src, /title="Requested Arrival"/);
});
