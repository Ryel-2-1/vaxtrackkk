"use strict";

// The route deviation is measured against (routeForOrder) is the route the
// Rider app shows as the VaxTrack plan (SavedRoutePlan.of in
// vaxtrack_mobile/lib/utils/saved_route_plan.dart). Both run the same cases.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const T = require("../src/riderTracking");

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "vaxtrack_mobile", "test", "fixtures", "saved_route_plan_cases.json"), "utf8")
);

function orderFrom(spec) {
  const order = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === "@verified" || key === "@verifiedTrip") Object.assign(order, fixture[key.slice(1)]);
    else if (typeof value === "string" && value.startsWith("@")) order[key] = fixture.polylines[value.slice(1)];
    else order[key] = value; // times stay epoch millis, which millisOf accepts
  }
  return order;
}

for (const c of fixture.cases) {
  test(`server baseline: ${c.name}`, () => {
    const route = T.routeForOrder(orderFrom(c.order));
    assert.equal(route.available, c.expect.available);
    if (c.expect.available) {
      assert.equal(route.source, c.expect.source);
      assert.ok(route.points.length >= 2);
    } else {
      assert.equal(route.reason, c.expect.reason);
    }
  });
}

test("the shared reason codes are the server's", () => {
  const reasons = new Set(fixture.cases.filter((c) => !c.expect.available).map((c) => c.expect.reason));
  assert.deepEqual([...reasons].sort(), Object.values(T.ROUTE_UNAVAILABLE_REASONS).sort());
});
