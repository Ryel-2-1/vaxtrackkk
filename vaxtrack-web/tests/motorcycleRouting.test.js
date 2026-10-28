import test from "node:test";
import assert from "node:assert/strict";
import {
  createMotorcycleRouteService, motorcycleRequest, parseMotorcycleRoute,
  parseMotorcycleMatrix, motorcycleStopOrder, encodePolyline, decodePolyline,
} from "../src/services/routeService.js";
import {
  ROUTE_PROVIDER, ROUTE_PROFILE, motorcycleRouteMetadata, savedRouteDescription,
} from "../src/services/routeMetadata.js";

const A = [14.329, 121.081], B = [14.338, 121.087], C = [14.313, 121.111];
const summary = (time, length) => ({ time, length, has_highway: false, has_toll: false, has_ferry: false });
function route(points = [A, B], times = [60], lengths = [1]) {
  return { trip: {
    status: 0, units: "kilometers",
    summary: summary(times.reduce((a, b) => a + b, 0), lengths.reduce((a, b) => a + b, 0)),
    legs: times.map((time, i) => ({
      summary: summary(time, lengths[i]),
      shape: encodePolyline([points[i], points[i + 1]], 6),
      maneuvers: [{ travel_mode: "drive", travel_type: "motorcycle" }],
    })),
  } };
}
function matrix(times) {
  return { sources_to_targets: times.map((row, i) => row.map((time, j) => ({ from_index: i, to_index: j, time }))) };
}
function client(responses, options = {}) {
  const calls = [];
  const service = createMotorcycleRouteService({
    waitForSlot: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body) });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
    ...options,
  });
  return { ...service, calls };
}
const rejectsCode = (fn, code) => assert.rejects(fn, e => e.code === code);
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

test("single route requests motorcycle costing, safe snapping and identified public-service access", async () => {
  const c = client([route()]);
  const result = await c.fetchRoute(A, B);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].url, "https://valhalla1.openstreetmap.de/route");
  assert.equal(c.calls[0].method, "POST");
  assert.equal(c.calls[0].headers["X-Client-Id"], "vaxtrack-capstone");
  assert.equal(c.calls[0].body.costing, "motorcycle");
  assert.deepEqual(c.calls[0].body.costing_options.motorcycle, {
    use_highways: 0, use_tolls: 0, use_ferry: 0, use_trails: 0,
  });
  assert.deepEqual(c.calls[0].body.locations[0], {
    lat: A[0], lon: A[1], search_filter: { max_road_class: "trunk", exclude_toll: true, exclude_ferry: true },
  });
  assert.deepEqual(result, {
    polyline: encodePolyline([A, B]), distanceMeters: 1000, durationSeconds: 60,
    provider: ROUTE_PROVIDER, profile: ROUTE_PROFILE,
  });
});
test("precision conversion preserves the standard polyline and every leg boundary", () => {
  const points = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  assert.equal(encodePolyline(points), "_p~iF~ps|U_ulLnnqC_mqNvxq" + String.fromCharCode(96) + "@");
  assert.deepEqual(decodePolyline(encodePolyline(points)), points);
  const result = parseMotorcycleRoute(route([A, B, C], [60.3, 70.3], [1, 2]), 2);
  assert.deepEqual(decodePolyline(result.polyline), [A, B, C]);
  assert.deepEqual(result.arrivals, [60, 131]);
  assert.equal(result.durationSeconds, 131);
  assert.equal(result.distanceMeters, 3000);
});
for (const flag of ["has_highway", "has_toll", "has_ferry"]) {
  test("reject " + flag + " on trip or leg, including endpoint segments", () => {
    for (const target of ["trip", "leg"]) {
      const data = route();
      (target === "trip" ? data.trip.summary : data.trip.legs[0].summary)[flag] = true;
      throwsCode(() => parseMotorcycleRoute(data, 1), "route-restricted");
    }
    const data = route();
    delete data.trip.legs[0].summary[flag];
    throwsCode(() => parseMotorcycleRoute(data, 1), "route-unverified");
  });
}
test("maneuver restrictions and non-motorcycle fallback responses are rejected", () => {
  for (const flag of ["highway", "toll", "ferry"]) {
    const data = route();
    data.trip.legs[0].maneuvers[0][flag] = true;
    throwsCode(() => parseMotorcycleRoute(data, 1), "route-restricted");
  }
  for (const type of ["car", "bicycle", "motor_scooter", undefined]) {
    const data = route();
    data.trip.legs[0].maneuvers[0].travel_type = type;
    throwsCode(() => parseMotorcycleRoute(data, 1), "route-unverified");
  }
});
test("warnings, missing restriction evidence and malformed outputs fail closed", () => {
  for (const mutate of [
    d => { d.trip.warnings = [{ code: 208 }]; },
    d => { d.warnings = [{ code: 1 }]; },
    d => { d.trip.legs[0].maneuvers = []; },
  ]) {
    const d = route(); mutate(d);
    throwsCode(() => parseMotorcycleRoute(d, 1), "route-unverified");
  }
  for (const mutate of [
    d => { d.trip.units = "miles"; },
    d => { d.trip.summary.time = NaN; },
    d => { d.trip.legs[0].shape = " "; },
    d => { d.trip.legs[0].shape = "???~"; },
    d => { d.trip.legs[0].shape = "~~~~~~~?"; },
    d => { d.trip.legs = []; },
    d => { d.trip.summary.length = 500; },
  ]) {
    const d = route(); mutate(d);
    throwsCode(() => parseMotorcycleRoute(d, 1), "route-not-found");
  }
});
test("disconnected leg shapes never become a synthetic straight-line link", () => {
  const d = route([A, B, C], [60, 70], [1, 2]);
  d.trip.legs[1].shape = encodePolyline([A, C], 6);
  throwsCode(() => parseMotorcycleRoute(d, 2), "route-not-found");
});
test("optimization uses motorcycle costs, an open tour, and actual final-leg arrival times", async () => {
  const c = client([
    matrix([[0, 1, 2], [100, 0, 100], [100, 1, 0]]),
    route([A, C, B], [30.4, 40.4], [1, 2]),
  ]);
  const stops = [{ orderId: "b", latLng: B }, { orderId: "c", latLng: C }];
  const before = structuredClone(stops);
  const result = await c.optimizeTrip(A, stops);
  assert.equal(c.calls.length, 2);
  assert.match(c.calls[0].url, /sources_to_targets$/);
  assert.equal(c.calls[0].body.costing, "motorcycle");
  assert.deepEqual(c.calls[0].body.costing_options, c.calls[1].body.costing_options);
  assert.deepEqual(c.calls[1].body.locations.map(p => [p.lat, p.lon]), [A, C, B]);
  assert.deepEqual(result.stops, [
    { orderId: "c", sequence: 1, etaSeconds: 30 },
    { orderId: "b", sequence: 2, etaSeconds: 71 },
  ]);
  assert.deepEqual(stops, before);
  assert.deepEqual(decodePolyline(result.polyline), [A, C, B]);
});
test("directed roads and unreachable pairs do not invent arrival times", () => {
  assert.deepEqual(motorcycleStopOrder([[0, 1, 2], [100, 0, 100], [100, 1, 0]]), [2, 1]);
  assert.deepEqual(motorcycleStopOrder([[0, Infinity, 2], [100, 0, 100], [100, 1, 0]]), [2, 1]);
  throwsCode(() => motorcycleStopOrder([[0, 1, Infinity], [100, 0, Infinity], [100, 1, 0]]), "route-not-found");
  assert.equal(parseMotorcycleMatrix(matrix([[0, null], [5, 0]]), 2)[0][1], Infinity);
  const bad = matrix([[0, 1], [1, 0]]);
  bad.sources_to_targets[0][1].to_index = 0;
  throwsCode(() => parseMotorcycleMatrix(bad, 2), "route-not-found");
});
test("larger groups preserve every stop exactly once without a forced return", () => {
  const times = Array.from({ length: 15 }, (_, i) => Array.from({ length: 15 }, (_, j) => Math.abs(i - j)));
  assert.deepEqual(motorcycleStopOrder(times), Array.from({ length: 14 }, (_, i) => i + 1));
});
test("a restricted optimized route rejects the entire result with no car retry", async () => {
  const bad = route([A, B, C], [60, 70], [1, 2]);
  bad.trip.legs[1].summary.has_highway = true;
  const c = client([matrix([[0, 1, 2], [1, 0, 1], [2, 1, 0]]), bad]);
  await rejectsCode(() => c.optimizeTrip(A, [{ orderId: "b", latLng: B }, { orderId: "c", latLng: C }]), "route-restricted");
  assert.equal(c.calls.length, 2);
});
test("invalid locations, duplicate IDs and too few stops make no request", async () => {
  const c = client([]);
  for (const point of [null, [91, 0], [0, 181], ["14", 121], [NaN, 0]]) {
    await rejectsCode(() => c.fetchRoute(point, B), "route-invalid-stops");
  }
  await rejectsCode(() => c.optimizeTrip(A, []), "route-too-few-stops");
  await rejectsCode(() => c.optimizeTrip(A, [{ orderId: "b", latLng: B }, { orderId: "b", latLng: C }]), "route-invalid-stops");
  assert.equal(c.calls.length, 0);
});
test("network, provider and JSON failures never fall back or retry automatically", async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw Error("private internals"); }, "route-unreachable"],
    [async () => ({ ok: false, status: 429 }), "route-rate-limited"],
    [async () => ({ ok: false, status: 500 }), "route-provider-error"],
    [async () => ({ ok: true, json: async () => { throw Error("bad JSON"); } }), "route-provider-error"],
  ]) {
    let calls = 0;
    const c = client([], { fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    await rejectsCode(() => c.fetchRoute(A, B), code);
    assert.equal(calls, 1);
  }
  const c = client([], { baseUrl: "http://example.com" });
  await rejectsCode(() => c.fetchRoute(A, B), "route-not-configured");
  assert.equal(c.calls.length, 0);
});
test("slow provider requests are aborted rather than leaving Generate stuck", async () => {
  const c = client([], {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
    }),
  });
  await rejectsCode(() => c.fetchRoute(A, B), "route-unreachable");
});
test("refreshing one route cannot relabel the other route's legacy geometry", () => {
  const verified = { provider: ROUTE_PROVIDER, profile: ROUTE_PROFILE };
  const single = motorcycleRouteMetadata(verified);
  assert.deepEqual(single, { routeProvider: ROUTE_PROVIDER, routeProfile: ROUTE_PROFILE });
  assert.deepEqual(motorcycleRouteMetadata(verified, true), {
    routeProvider: ROUTE_PROVIDER, tripRouteProvider: ROUTE_PROVIDER, tripRouteProfile: ROUTE_PROFILE,
  });
  assert.throws(() => motorcycleRouteMetadata({ provider: "openrouteservice" }));
  assert.match(savedRouteDescription(single), /^Motorcycle route/);
  assert.match(savedRouteDescription(single, true), /^Existing route is not verified/);
  assert.match(savedRouteDescription({ routeProvider: "openrouteservice" }), /^Existing route is not verified/);
  assert.match(savedRouteDescription({ ...single, ...motorcycleRouteMetadata(verified, true) }, true), /^Motorcycle route/);
  assert.equal(motorcycleRequest().costing, "motorcycle");
});

// ---------------------------------------------------------------- departure planning (time-aware)

test("travel matrix: one motorcycle request, every pair, unreachable kept as Infinity", async () => {
  const c = client([matrix([[0, 300, 420], [310, 0, null], [400, 500, 0]])]);
  const seconds = await c.travelMatrix([A, B, C]);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].url, /sources_to_targets$/);
  assert.equal(c.calls[0].body.costing, "motorcycle");
  assert.deepEqual(c.calls[0].body.sources, c.calls[0].body.targets);
  assert.deepEqual(seconds, [[0, 300, 420], [310, 0, Infinity], [400, 500, 0]]);
  await rejectsCode(() => client([]).travelMatrix([A]), "route-invalid-stops");
  await rejectsCode(() => client([]).travelMatrix([A, [99, 0]]), "route-invalid-stops");
});

test("a planned trip is routed in the Dispatcher's order — never reordered — with the motorcycle checks", async () => {
  const c = client([route([A, C, B], [30, 40], [1, 2])]);
  const r = await c.routeThroughStops(A, [{ orderId: "c", latLng: C }, { orderId: "b", latLng: B }]);
  assert.equal(c.calls.length, 1, "no matrix, no reordering");
  assert.deepEqual(c.calls[0].body.locations.map(p => [p.lat, p.lon]), [A, C, B]);
  assert.deepEqual(r.legArrivals, [30, 70]);
  assert.equal(r.provider, ROUTE_PROVIDER);
  assert.equal(r.profile, ROUTE_PROFILE);
  assert.deepEqual(motorcycleRouteMetadata(r, true).tripRouteProfile, ROUTE_PROFILE, "saveable as a motorcycle trip");
  const restricted = route([A, C, B], [30, 40], [1, 2]);
  restricted.trip.legs[1].summary.has_highway = true;
  await rejectsCode(() => client([restricted]).routeThroughStops(A, [{ orderId: "c", latLng: C }, { orderId: "b", latLng: B }]), "route-restricted");
  await rejectsCode(() => client([]).routeThroughStops(A, [{ orderId: "c", latLng: C }, { orderId: "c", latLng: B }]), "route-invalid-stops");
});
