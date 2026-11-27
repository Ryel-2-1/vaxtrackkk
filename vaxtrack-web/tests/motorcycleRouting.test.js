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
      if (response instanceof Response) return response;
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
  // Below 400 cc: national highways allowed; expressways, tolls and ferries
  // are hard-excluded from the search.
  assert.deepEqual(c.calls[0].body.costing_options.motorcycle, {
    use_highways: 1, use_tolls: 0, use_ferry: 0, use_trails: 0,
    exclude_tolls: true, exclude_highways: true, exclude_ferries: true,
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
    d => { d.trip.warnings = [{ code: 208 }, { code: 100 }]; },
    d => { d.warnings = [{ code: 1 }]; },
    d => { d.trip.warnings = "208"; },
    d => { d.trip.legs[0].maneuvers = []; },
  ]) {
    const d = route(); mutate(d);
    throwsCode(() => parseMotorcycleRoute(d, 1), "route-unverified");
  }
  // 208 = the server downgraded our exclude_* options. The path is still
  // checked, so a toll-free route is accepted and a toll route is not.
  const downgraded = route(); downgraded.trip.warnings = [{ code: 208, text: "ignoring hard excludes" }];
  assert.equal(parseMotorcycleRoute(downgraded, 1).durationSeconds, 60);
  const tollAnyway = route(); tollAnyway.trip.warnings = [{ code: 208 }]; tollAnyway.trip.summary.has_toll = true;
  throwsCode(() => parseMotorcycleRoute(tollAnyway, 1), "route-restricted");
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
test("a restricted optimized route rejects the entire result when its legs have no legal alternate", async () => {
  const bad = route([A, B, C], [60, 70], [1, 2]);
  bad.trip.legs[1].summary.has_highway = true;
  const blocked = route([B, C]);
  blocked.trip.summary.has_toll = true;
  const c = client([matrix([[0, 1, 2], [1, 0, 1], [2, 1, 0]]), bad, route([A, B]), blocked]);
  await assert.rejects(() => c.optimizeTrip(A, [{ orderId: "b", latLng: B }, { orderId: "c", latLng: C }]),
    (error) => error.code === "route-restricted" && error.legIndex === 1);
  assert.equal(c.calls.length, 5);
  assert.match(c.calls.at(-1).url, /trace_attributes$/);
  assert.ok(c.calls.every(({ body }) => body.costing === "motorcycle"));
});
test("a trip that cannot reach a stop without a toll road names that stop and saves nothing", async () => {
  const bad = route([A, B, C], [60, 70], [1, 2]);
  bad.trip.legs[1].summary.has_toll = true;
  bad.trip.summary.has_toll = true;
  const blocked = route([B, C]);
  blocked.trip.summary.has_toll = true;
  const c = client([bad, route([A, B]), blocked, new Response("{}", { status: 500 })]);
  await assert.rejects(
    () => c.routeThroughStops(A, [
      { orderId: "b", latLng: B, label: "Clinic Bravo" },
      { orderId: "c", latLng: C, label: "Clinic Charlie" },
    ]),
    (error) => error.code === "route-restricted" && error.legIndex === 1 && error.stopOrderId === "c"
      && error.message.startsWith("Clinic Charlie: "),
  );
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

test("large trips stay within Valhalla's pair limit and keep every directed travel time", async () => {
  for (const size of [11, 51]) {
    const points = Array.from({ length: size }, (_, index) => [14 + index / 1000, 121]);
    const pointIndices = new Map(points.map(([lat], index) => [lat, index]));
    const timeFromTo = (from, to) => from === size - 1 && to === 0 ? null : from * size + to;
    let calls = 0;
    const service = createMotorcycleRouteService({
      waitForSlot: async () => {},
      fetchImpl: async (_url, init) => {
        const { sources, targets, costing } = JSON.parse(init.body);
        assert.equal(costing, "motorcycle");
        assert.ok(sources.length * targets.length <= 100);
        calls++;
        return {
          ok: true,
          json: async () => matrix(sources.map(({ lat: from }) => targets.map(({ lat: to }) =>
            timeFromTo(pointIndices.get(from), pointIndices.get(to))))),
        };
      },
    });
    const expected = points.map((_, from) => points.map((_, to) => timeFromTo(from, to) ?? Infinity));
    assert.deepEqual(await service.travelMatrix(points), expected);
    if (size === 11) assert.equal(calls, 2, "the hub plus ten stops only needs two requests");
    else assert.ok(calls > 2, "larger trips batch both sources and targets");
  }
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
  const toll = route([C, B], [40]);
  toll.trip.summary.has_toll = true;
  toll.alternates = [route([C, B], [120]), route([C, B], [100])];
  const fallback = client([restricted, route([A, C], [30]), toll]);
  const legal = await fallback.routeThroughStops(A, [{ orderId: "c", latLng: C }, { orderId: "b", latLng: B }]);
  assert.deepEqual(fallback.calls.map(({ body }) => body.alternates), [undefined, 2, 2]);
  assert.deepEqual(legal.legArrivals, [30, 130]);
  assert.deepEqual(decodePolyline(legal.polyline), [A, C, B]);
  await rejectsCode(() => client([]).routeThroughStops(A, [{ orderId: "c", latLng: C }, { orderId: "c", latLng: B }]), "route-invalid-stops");
});

test("single route selects the fastest verified alternative instead of a toll shortcut", async () => {
  const toll = route([A, B], [25]);
  toll.trip.summary.has_toll = true;
  const ferry = route([A, B], [35]);
  ferry.trip.legs[0].summary.has_ferry = true;
  toll.alternates = [ferry, route([A, B], [80])];
  const c = client([toll]);
  assert.equal((await c.fetchRoute(A, B)).durationSeconds, 80);
  assert.equal(c.calls[0].body.alternates, 2);
});

test("when every candidate uses a restricted road, retry around the mapped segments", async () => {
  const toll = route([A, B], [30]);
  toll.trip.summary.has_toll = true;
  const trace = {
    shape: encodePolyline([A, [14.334, 121.083], [14.335, 121.086], B], 6),
    edges: [
      { toll: false, road_class: "secondary", begin_shape_index: 0, end_shape_index: 1 },
      { toll: true, road_class: "secondary", begin_shape_index: 1, end_shape_index: 2 },
      { toll: false, road_class: "motorway", begin_shape_index: 2, end_shape_index: 3 },
      { toll: true, road_class: "motorway", begin_shape_index: 2, end_shape_index: 99 },
    ],
  };
  const c = client([toll, trace, route([A, B], [90])]);
  const legal = await c.fetchRoute(A, B);
  assert.equal(legal.durationSeconds, 90);
  assert.deepEqual(c.calls.map(({ url }) => url.split("/").at(-1)), ["route", "trace_attributes", "route"]);
  assert.equal(c.calls[1].body.shape_match, "edge_walk");
  // Matching the rejected route must be allowed onto its restricted roads.
  assert.deepEqual(c.calls[1].body.costing_options.motorcycle, {
    use_highways: 1, use_tolls: 0, use_ferry: 0, use_trails: 0,
  });
  assert.equal(c.calls[2].body.costing_options.motorcycle.exclude_tolls, true);
  assert.equal(c.calls[1].body.encoded_polyline, toll.trip.legs[0].shape);
  assert.deepEqual(c.calls[2].body.locations, c.calls[0].body.locations);
  assert.equal(c.calls[2].body.costing, "motorcycle");
  assert.deepEqual(c.calls[2].body.exclude_locations, [
    { lat: (14.334 + 14.335) / 2, lon: (121.083 + 121.086) / 2, radius: 2 },
    { lat: (14.335 + B[0]) / 2, lon: (121.086 + B[1]) / 2, radius: 2 },
  ]);

  const stillBlocked = client([toll, trace, toll, trace]);
  await rejectsCode(() => stillBlocked.fetchRoute(A, B), "route-restricted");
  assert.equal(stillBlocked.calls.length, 4, "the same rejected segments never trigger another identical request");
});

test("Valhalla 442 on the detour triggers smaller exclusion sets and keeps road restrictions", async () => {
  const toll = route([A, B], [30]);
  toll.trip.summary.has_toll = true;
  const points = Array.from({ length: 14 }, (_, index) => A.map((value, axis) => value + (B[axis] - value) * index / 13));
  const trace = {
    shape: encodePolyline(points, 6),
    edges: points.slice(1).map((_, index) => ({ toll: true, begin_shape_index: index, end_shape_index: index + 1 })),
  };
  const disconnected = () => new Response(JSON.stringify({ error_code: 442 }), { status: 400 });
  const c = client([toll, trace, disconnected(), toll, route([A, B], [90])]);
  assert.equal((await c.fetchRoute(A, B)).durationSeconds, 90);
  assert.deepEqual(c.calls.slice(2).map(({ body }) => body.exclude_locations.length), [13, 7, 6]);
  assert.ok(c.calls.slice(2).every(({ body }) => body.costing === "motorcycle" && body.locations.length === 2));

  const fastest = client([toll, trace, disconnected(), route([A, B], [120]), route([A, B], [90])]);
  assert.equal((await fastest.fetchRoute(A, B)).durationSeconds, 90);

  const blocked = client([toll, trace, disconnected(), disconnected(), disconnected()]);
  await assert.rejects(() => blocked.fetchRoute(A, B), (error) => error.code === "route-destination-toll" && error.providerCode === 442);
  assert.equal(blocked.calls.length, 5);

  const intermediateToll = { ...trace, edges: trace.edges.slice(0, -1) };
  const unreachable = client([toll, intermediateToll, disconnected(), disconnected(), disconnected()]);
  await assert.rejects(() => unreachable.fetchRoute(A, B), (error) => error.code === "route-not-found" && error.providerCode === 442);
});

test("ten stops join overlapping route sections and keep the cumulative arrival times", async () => {
  const points = Array.from({ length: 11 }, (_, index) => [14 + index / 1000, 121]);
  const stops = points.slice(1).map((latLng, index) => ({ orderId: `stop-${index + 1}`, latLng }));
  const firstSection = route(points.slice(0, 10), Array(9).fill(60.6), Array(9).fill(0.1004));
  const lastSection = route(points.slice(9), [60.6], [0.1004]);
  const c = client([firstSection, lastSection]);
  const result = await c.routeThroughStops(points[0], stops);

  assert.deepEqual(c.calls.map(({ body }) => body.locations.length), [10, 2]);
  assert.deepEqual(c.calls[0].body.locations.at(-1), c.calls[1].body.locations[0]);
  assert.deepEqual(decodePolyline(result.polyline), points);
  assert.deepEqual(result.legArrivals, stops.map((_, index) => Math.round((index + 1) * 60.6)));
  assert.equal(result.distanceMeters, 1004);
  assert.equal(result.durationSeconds, 606);

  const disconnected = route([points[8], points[10]], [60.6], [0.1004]);
  await rejectsCode(() => client([firstSection, disconnected]).routeThroughStops(points[0], stops), "route-not-found");
  const restricted = structuredClone(lastSection);
  restricted.trip.summary.has_toll = true;
  await rejectsCode(() => client([firstSection, restricted]).routeThroughStops(points[0], stops), "route-restricted");
});
