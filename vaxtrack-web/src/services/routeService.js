// Dispatcher-initiated motorcycle routing for the below-400 cc fleet.
// OpenStreetMap tiles stay unchanged. Never falls back to car/bicycle routes.
import { UserMessageError } from "./userMessageError.js";
import { ROUTE_PROVIDER, ROUTE_PROFILE } from "./routeMetadata.js";
export { ROUTE_PROVIDER, ROUTE_PROFILE } from "./routeMetadata.js";
const ROUTING_URL = import.meta.env?.VITE_MOTORCYCLE_ROUTING_URL ?? "https://valhalla1.openstreetmap.de";
const MAX_MATRIX_LOCATION_PAIRS = 100;
// Keep room for at least two source rows per full batch on large trips.
const MAX_MATRIX_TARGETS = MAX_MATRIX_LOCATION_PAIRS / 2;
const MAX_ROUTE_LOCATIONS = 10;
const MAX_DETOUR_ATTEMPTS = 2;
const MAX_EXCLUDED_LOCATIONS = 48;
const EXCLUSIONS_PER_ATTEMPT = 32;
const TOLL_PIN_MATCH_METERS = 25;
const RESTRICTED_EDGE_ATTRIBUTES = ["shape", "edge.begin_shape_index", "edge.end_shape_index", "edge.road_class", "edge.use", "edge.toll"];
export class RouteServiceError extends UserMessageError {
  constructor(code, message) {
    super(message);
    this.name = "RouteServiceError";
    this.code = code;
  }
}
const MESSAGES = Object.freeze({
  "route-not-configured": "Motorcycle route planning isn't set up for this site yet. Contact an administrator.",
  "route-unreachable": "We couldn't reach the routing service. Nothing was saved — check your connection and try again.",
  "route-provider-error": "The routing service couldn't plan this route right now. Nothing was saved — try again in a moment.",
  "route-rate-limited": "The routing service is busy. Nothing was saved — wait a minute and try again.",
  "route-not-found": "No usable motorcycle route was found. Nothing was saved — check the locations and try again.",
  "route-destination-toll": "The routing map places this delivery pin on a toll road. Confirm a toll-free delivery entrance before trying again.",
  "route-restricted": "No motorcycle route without toll roads or expressways was found. Nothing was saved — move the pin to an entrance on a regular road and try again.",
  "route-unverified": "The service could not verify the motorcycle route restrictions. Nothing was saved — try again later.",
  "route-invalid-stops": "Check the stop locations and order references before planning this route.",
  "route-too-few-stops": "Optimizing a trip needs at least two stops with locations."
});
const fail = code => new RouteServiceError(code, MESSAGES[code]);
function validBaseUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}
export function isRouteServiceConfigured() {
  return validBaseUrl(ROUTING_URL);
}

// Decode a Google/ORS encoded polyline (precision 5) into [[lat, lng], ...].
// Self-contained (no @mapbox/polyline dependency).
export function decodePolyline(str, precision = 5) {
  if (!str || typeof str !== "string") return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coords = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

// "4.2 km" / "850 m"
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

// "23 min" / "1 h 5 min" / "45 s"
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

// Arrival clock time = base + durationSeconds, e.g. "3:45 PM".
export function formatEta(baseDate, durationSeconds) {
  if (!(baseDate instanceof Date) || isNaN(baseDate.getTime()) || !Number.isFinite(durationSeconds)) {
    return "—";
  }
  const eta = new Date(baseDate.getTime() + durationSeconds * 1000);
  return eta.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila"
  });
}

/** The saved clock time includes the departure selected in Cargo Loading. */
export function savedOrderRouteEta(order) {
  const saved = typeof order?.routeEtaText === "string" ? order.routeEtaText.trim() : "";
  if (/^(?:[1-9]|1[0-2]):[0-5]\d\s+(?:am|pm|noon|midnight)$/i.test(saved)) return saved;
  const generated = order?.routeGeneratedAt;
  const date = generated?.toDate?.() ?? (generated == null ? null : new Date(generated));
  const calculated = formatEta(date, order?.routeDurationSeconds);
  return calculated === "—" && saved ? saved : calculated;
}

// Valhalla shapes are precision 6; Firestore/web/Flutter retain precision 5.
export function encodePolyline(points, precision = 5) {
  let lat = 0,
    lng = 0;
  const encode = delta => {
    let v = delta < 0 ? ~(delta << 1) : delta << 1,
      out = "";
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | v & 0x1f) + 63);
      v >>>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  return points.map(([a, b]) => {
    const x = Math.round(a * 10 ** precision),
      y = Math.round(b * 10 ** precision);
    const part = encode(x - lat) + encode(y - lng);
    lat = x;
    lng = y;
    return part;
  }).join("");
}
const validLocation = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
function location([lat, lon]) {
  return {
    lat,
    lon,
    search_filter: {
      max_road_class: "trunk",
      exclude_toll: true,
      exclude_ferry: true
    }
  };
}
// Motorcycles below 400 cc may ride national highways (trunk roads such as
// EDSA or MacArthur) but not expressways, toll roads or ferries (2026-11-27).
// `use_highways` only weighs motorway AND trunk roads, so it stays at 1 to keep
// national highways usable. The `exclude_*` options keep the search off
// motorway-class roads, tolls and ferries: the public server downgrades them
// (warning 208) yet still returned toll-free routes on the NLEX, SLEX and
// CAVITEX corridors, where use_highways alone took the expressway. They are
// NOT a guarantee: the ACTUAL returned path is validated before any save.
const MOTORCYCLE_PREFERENCES = Object.freeze({
  use_highways: 1,
  use_tolls: 0,
  use_ferry: 0,
  use_trails: 0
});
export function motorcycleRequest() {
  return {
    costing: "motorcycle",
    costing_options: {
      motorcycle: {
        ...MOTORCYCLE_PREFERENCES,
        exclude_tolls: true,
        exclude_highways: true,
        exclude_ferries: true
      }
    },
    units: "kilometers"
  };
}
// Map-matching a REJECTED route must be allowed onto the restricted roads it
// uses, or the match fails and no detour can be computed.
function motorcycleTraceRequest() {
  return {
    costing: "motorcycle",
    costing_options: { motorcycle: { ...MOTORCYCLE_PREFERENCES } },
    units: "kilometers"
  };
}
// Valhalla 208: "Hard exclusions are not allowed on this server, ignoring hard
// excludes". The public server sends it for the exclude_* options above; they
// still steer the search off tolls there, and every returned path is checked
// for highway/toll/ferry flags anyway, so this one warning is not a reason to
// refuse. Any other warning still fails closed.
const EXCLUSIONS_DOWNGRADED = 208;
function noWarnings(data) {
  for (const w of [data?.warnings, data?.trip?.warnings]) {
    if (w == null) continue;
    if (!Array.isArray(w) || w.some(item => item?.code !== EXCLUSIONS_DOWNGRADED)) throw fail("route-unverified");
  }
}
function checkedSummary(s) {
  if (!s || !Number.isFinite(s.length) || s.length < 0 || !Number.isFinite(s.time) || s.time < 0) throw fail("route-not-found");
  for (const flag of ["has_highway", "has_toll", "has_ferry"]) {
    if (s[flag] === true) throw fail("route-restricted");
    if (s[flag] !== false) throw fail("route-unverified");
  }
}
function providerShape(encoded) {
  if (typeof encoded !== "string" || !encoded || !/^[?-~]+$/.test(encoded)) throw fail("route-not-found");
  let values = 0,
    chunks = 0;
  for (const char of encoded) {
    if (++chunks > 6) throw fail("route-not-found");
    if (char.charCodeAt(0) - 63 < 0x20) {
      values++;
      chunks = 0;
    }
  }
  if (chunks || values % 2) throw fail("route-not-found");
  const points = decodePolyline(encoded, 6);
  if (points.length < 2 || !points.every(validLocation)) throw fail("route-not-found");
  return points;
}
function shapesConnect(previous, next) {
  return !previous.length || (Math.abs(previous.at(-1)[0] - next[0][0]) <= 0.00002 &&
    Math.abs(previous.at(-1)[1] - next[0][1]) <= 0.00002);
}

function appendShape(points, shape) {
  if (!shapesConnect(points, shape)) throw fail("route-not-found");
  for (let i = points.length ? 1 : 0; i < shape.length; i++) points.push(shape[i]);
}

function readMotorcycleRoute(data, legCount) {
  noWarnings(data);
  const t = data?.trip;
  if (t?.status !== 0 || t.units !== "kilometers" || !Array.isArray(t.legs) || t.legs.length !== legCount) throw fail("route-not-found");
  checkedSummary(t.summary);
  const points = [], arrivals = [];
  let elapsed = 0;
  let length = 0;
  for (const leg of t.legs) {
    checkedSummary(leg.summary);
    if (!Array.isArray(leg.maneuvers) || !leg.maneuvers.length) throw fail("route-unverified");
    for (const m of leg.maneuvers) {
      if (m.highway === true || m.toll === true || m.ferry === true) throw fail("route-restricted");
      if (m.travel_mode !== "drive" || m.travel_type !== "motorcycle") throw fail("route-unverified");
    }
    appendShape(points, providerShape(leg.shape));
    elapsed += leg.summary.time;
    length += leg.summary.length;
    arrivals.push(elapsed);
  }
  if (Math.abs(elapsed - t.summary.time) > Math.max(1, legCount * 0.01) || Math.abs(length - t.summary.length) > Math.max(0.01, legCount * 0.002)) throw fail("route-not-found");
  return { points, arrivals, legDuration: elapsed, distanceKm: t.summary.length, durationSeconds: t.summary.time };
}

function appendMotorcycleRoute(result, next) {
  appendShape(result.points, next.points);
  for (const arrival of next.arrivals) result.arrivals.push(result.legDuration + arrival);
  result.legDuration += next.legDuration;
  result.distanceKm += next.distanceKm;
  result.durationSeconds += next.durationSeconds;
}

function formatMotorcycleRoute(result) {
  return {
    polyline: encodePolyline(result.points),
    distanceMeters: Math.round(result.distanceKm * 1000),
    durationSeconds: Math.round(result.durationSeconds),
    provider: ROUTE_PROVIDER,
    profile: ROUTE_PROFILE,
    arrivals: result.arrivals.map(Math.round)
  };
}

export function parseMotorcycleRoute(data, legCount) {
  return formatMotorcycleRoute(readMotorcycleRoute(data, legCount));
}

function fastestVerifiedLeg(data, previousShape) {
  noWarnings({ warnings: data?.warnings });
  const alternates = Array.isArray(data?.alternates) ? data.alternates : [];
  let best = null, reason = null, restricted = null;
  for (const trip of [data?.trip, ...alternates.map((candidate) => candidate?.trip)]) {
    try {
      const candidate = readMotorcycleRoute({ trip }, 1);
      if (!shapesConnect(previousShape, candidate.points)) throw fail("route-not-found");
      if (!best || candidate.durationSeconds < best.durationSeconds) best = candidate;
    } catch (error) {
      if (!(error instanceof RouteServiceError)) throw error;
      reason ??= error;
      const shape = trip?.legs?.[0]?.shape;
      if (error.code === "route-restricted" && typeof shape === "string" && shape) {
        error.restrictedShape = shape;
        restricted ??= error;
      }
    }
  }
  if (!best) throw restricted ?? reason;
  return best;
}

function exclusionKey({ lat, lon }) {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function detourExclusions(trace, excluded, destination) {
  noWarnings(trace);
  if (!Array.isArray(trace?.edges) || !trace.shape) return { points: [], destinationToll: false };
  const shape = providerShape(trace.shape);
  const [endLat, endLon] = shape.at(-1);
  const lastEdge = trace.edges.at(-1);
  const snapDistance = 111195 * Math.hypot(endLat - destination.lat,
    (endLon - destination.lon) * Math.cos(destination.lat * Math.PI / 180));
  const destinationToll = lastEdge?.toll === true && lastEdge.end_shape_index === shape.length - 1 && snapDistance <= TOLL_PIN_MATCH_METERS;
  const existing = new Set(excluded.map(exclusionKey));
  const candidates = [];
  for (const edge of trace.edges) {
    const { toll, road_class: roadClass, use, begin_shape_index: start, end_shape_index: end } = edge || {};
    if (toll !== true && roadClass !== "motorway" && use !== "ferry" && use !== "rail_ferry" && use !== "rail-ferry") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end >= shape.length) continue;
    // Use a point inside a mapped edge rather than a junction shared with
    // other roads. A narrow search radius avoids picking adjacent streets.
    const index = Math.floor((start + end - 1) / 2);
    const [a, b] = [shape[index], shape[index + 1]];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const point = { lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2, radius: 2 };
    const key = exclusionKey(point);
    if (existing.has(key)) continue;
    existing.add(key);
    candidates.push(point);
  }
  const count = Math.min(candidates.length, EXCLUSIONS_PER_ATTEMPT, MAX_EXCLUDED_LOCATIONS - excluded.length);
  // Spread the exclusions across the rejected route, including its far end.
  const points = Array.from({ length: count }, (_, i) => candidates[count === 1 ? 0 : Math.round(i * (candidates.length - 1) / (count - 1))]);
  return { points, destinationToll };
}
export function parseMotorcycleMatrix(data, sourceCount, targetCount = sourceCount) {
  noWarnings(data);
  const rows = data?.sources_to_targets;
  if (!Array.isArray(rows) || rows.length !== sourceCount || rows.some(r => !Array.isArray(r) || r.length !== targetCount)) throw fail("route-not-found");
  return rows.map((row, i) => row.map((c, j) => {
    if (!c || c.from_index !== i || c.to_index !== j) throw fail("route-not-found");
    if (c.time === null) return Infinity;
    if (!Number.isFinite(c.time) || c.time < 0) throw fail("route-not-found");
    return c.time;
  }));
}
// Open tour: no fixed final clinic or forced return. Exact duration ordering up
// to 12 stops; nearest-neighbour heuristic above that to bound browser work.
export function motorcycleStopOrder(matrix) {
  const n = matrix.length - 1;
  if (n < 1) throw fail("route-too-few-stops");
  if (n > 12) {
    const left = new Set(Array.from({
        length: n
      }, (_, i) => i + 1)),
      order = [];
    let current = 0;
    while (left.size) {
      let next = -1,
        best = Infinity;
      for (const j of left) if (matrix[current][j] < best) {
        next = j;
        best = matrix[current][j];
      }
      if (next < 0) throw fail("route-not-found");
      order.push(next);
      left.delete(next);
      current = next;
    }
    return order;
  }
  const states = 1 << n,
    costs = new Float64Array(states * n).fill(Infinity),
    prev = new Int16Array(states * n).fill(-1);
  for (let j = 0; j < n; j++) costs[(1 << j) * n + j] = matrix[0][j + 1];
  for (let mask = 1; mask < states; mask++) for (let last = 0; last < n; last++) {
    const cost = costs[mask * n + last];
    if (!Number.isFinite(cost)) continue;
    for (let next = 0; next < n; next++) {
      if (mask & 1 << next) continue;
      const index = (mask | 1 << next) * n + next,
        candidate = cost + matrix[last + 1][next + 1];
      if (candidate < costs[index]) {
        costs[index] = candidate;
        prev[index] = last;
      }
    }
  }
  let mask = states - 1,
    last = -1,
    best = Infinity;
  for (let j = 0; j < n; j++) if (costs[mask * n + j] < best) {
    last = j;
    best = costs[mask * n + j];
  }
  if (last < 0) throw fail("route-not-found");
  const order = [];
  while (last >= 0) {
    order.push(last + 1);
    const before = prev[mask * n + last];
    mask ^= 1 << last;
    last = before;
  }
  return order.reverse();
}
let nextPublicRequest = 0;
async function publicRequestSlot() {
  const slot = Math.max(Date.now(), nextPublicRequest);
  nextPublicRequest = slot + 1100;
  const delay = slot - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}
export function createMotorcycleRouteService({
  baseUrl = ROUTING_URL,
  fetchImpl = (...a) => globalThis.fetch(...a),
  waitForSlot = publicRequestSlot,
  timeoutMs = 25000
} = {}) {
  async function request(action, body) {
    if (!validBaseUrl(baseUrl)) throw fail("route-not-configured");
    await waitForSlot();
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/${action}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Client-Id": "vaxtrack-capstone"
          },
          body: JSON.stringify(body)
        });
      } catch {
        throw fail("route-unreachable");
      }
      if (!res.ok) {
        if (action === "route" && res.status === 400) {
          const details = await res.json().catch(() => null);
          if ([170, 171, 441, 442].includes(details?.error_code)) {
            const error = fail("route-not-found");
            error.providerCode = details.error_code;
            throw error;
          }
        }
        throw fail(res.status === 429 ? "route-rate-limited" : "route-provider-error");
      }
      try {
        return await res.json();
      } catch {
        throw fail("route-provider-error");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestDetour(options, previousShape, excluded, additional) {
    const full = [...excluded, ...additional];
    let noPath;
    try {
      return { data: await request("route", { ...options, exclude_locations: full }), excluded: full };
    } catch (error) {
      if (error.providerCode !== 442 || additional.length < 2) throw error;
      noPath = error;
    }

    // Nearby eligible streets may share a snap candidate with a restricted
    // edge. Try two complementary sets when excluding every new point cuts
    // off the path. Every result still has to pass the same road checks.
    let best = null, nextSearch = null;
    for (const parity of [0, 1]) {
      const subset = [...excluded, ...additional.filter((_, index) => index % 2 === parity)];
      let data;
      try {
        data = await request("route", { ...options, exclude_locations: subset });
      } catch (error) {
        if (error.providerCode === 442) continue;
        if (best && (error.code === "route-rate-limited" || error.code === "route-unreachable")) break;
        throw error;
      }
      try {
        const route = fastestVerifiedLeg(data, previousShape);
        if (!best || route.durationSeconds < best.durationSeconds) best = route;
      } catch (error) {
        if (!(error instanceof RouteServiceError)) throw error;
        if (error.restrictedShape) nextSearch ??= { data, excluded: subset };
      }
    }

    if (best) return { route: best };
    if (nextSearch) return nextSearch;
    throw noPath;
  }

  async function verifiedLeg(locations, previousShape) {
    const options = { ...motorcycleRequest(), locations, alternates: 2 };
    let data = await request("route", options);
    let excluded = [];
    let destinationToll = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return fastestVerifiedLeg(data, previousShape);
      } catch (error) {
        if (!error.restrictedShape || attempt >= MAX_DETOUR_ATTEMPTS) throw error;
        let additional;
        try {
          const trace = await request("trace_attributes", {
            ...motorcycleTraceRequest(),
            encoded_polyline: error.restrictedShape,
            shape_match: "edge_walk",
            filters: { action: "include", attributes: RESTRICTED_EDGE_ATTRIBUTES },
          });
          const exclusions = detourExclusions(trace, excluded, locations.at(-1));
          additional = exclusions.points;
          destinationToll ||= exclusions.destinationToll;
        } catch (traceError) {
          if (traceError.code === "route-unreachable" || traceError.code === "route-rate-limited") throw traceError;
          throw error;
        }
        if (additional.length === 0) throw error;
        let detour;
        try {
          detour = await requestDetour(options, previousShape, excluded, additional);
        } catch (detourError) {
          if (!destinationToll || detourError.providerCode !== 442) throw detourError;
          const tollError = fail("route-destination-toll");
          tollError.providerCode = detourError.providerCode;
          throw tollError;
        }
        if (detour.route) return detour.route;
        ({ data, excluded } = detour);
      }
    }
  }

  async function routeThrough(points) {
    if (!points.every(validLocation)) throw fail("route-invalid-stops");
    const result = { points: [], arrivals: [], legDuration: 0, distanceKm: 0, durationSeconds: 0 };
    // Each section begins at the previous section's final stop. The route
    // parser checks that the returned shapes meet before joining them.
    for (let start = 0; start < points.length - 1; start += MAX_ROUTE_LOCATIONS - 1) {
      const locations = points.slice(start, start + MAX_ROUTE_LOCATIONS).map(location);
      if (locations.length > 2) {
        try {
          const data = await request("route", { ...motorcycleRequest(), locations });
          appendMotorcycleRoute(result, readMotorcycleRoute(data, locations.length - 1));
          continue;
        } catch (error) {
          if (error.code !== "route-restricted" && error.code !== "route-not-found") throw error;
        }
      }
      // Valhalla only offers alternatives for a two-point request. When a
      // multi-stop route contains a restricted road, try its legs separately.
      for (let i = 0; i < locations.length - 1; i++) {
        try {
          appendMotorcycleRoute(result, await verifiedLeg(locations.slice(i, i + 2), result.points));
        } catch (error) {
          if (["route-restricted", "route-not-found", "route-unverified", "route-destination-toll"].includes(error.code)) error.legIndex = start + i;
          throw error;
        }
      }
    }
    return formatMotorcycleRoute(result);
  }
  // Matrix indices restart within each request. Append target batches to the
  // original source rows so the planner still sees every directed pair.
  async function travelMatrix(points) {
    if (!Array.isArray(points) || points.length < 2 || !points.every(validLocation)) throw fail("route-invalid-stops");
    const locations = points.map(location);
    const seconds = locations.map(() => []);
    for (let targetStart = 0; targetStart < locations.length; targetStart += MAX_MATRIX_TARGETS) {
      const targets = locations.slice(targetStart, targetStart + MAX_MATRIX_TARGETS);
      const sourceLimit = Math.floor(MAX_MATRIX_LOCATION_PAIRS / targets.length);
      for (let sourceStart = 0; sourceStart < locations.length; sourceStart += sourceLimit) {
        const sources = locations.slice(sourceStart, sourceStart + sourceLimit);
        const data = await request("sources_to_targets", { ...motorcycleRequest(), sources, targets });
        const rows = parseMotorcycleMatrix(data, sources.length, targets.length);
        rows.forEach((row, index) => seconds[sourceStart + index].push(...row));
      }
    }
    return seconds;
  }
  return {
    // Motorcycle travel seconds between every pair of points (Infinity when a
    // pair is unreachable). Reordering stops reuses the complete result.
    travelMatrix,
    // The route through stops in the order given (the Dispatcher's plan), not
    // reordered. `legArrivals` are cumulative riding seconds to each stop.
    async routeThroughStops(start, stops) {
      if (!Array.isArray(stops) || stops.length < 1 || stops.some(s => typeof s?.orderId !== "string" || !s.orderId.trim() || !validLocation(s.latLng)) || new Set(stops.map(s => s.orderId)).size !== stops.length) throw fail("route-invalid-stops");
      let route;
      try {
        route = await routeThrough([start, ...stops.map(s => s.latLng)]);
      } catch (error) {
        // Leg i ends at stop i: name that stop so the Dispatcher knows which
        // pin to check. Nothing is saved.
        const stop = Number.isInteger(error?.legIndex) ? stops[error.legIndex] : null;
        if (stop && error instanceof RouteServiceError) {
          error.stopOrderId = stop.orderId;
          const label = typeof stop.label === "string" ? stop.label.trim() : "";
          if (label) error.message = `${label}: ${error.message}`;
        }
        throw error;
      }
      return {
        polyline: route.polyline,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        provider: route.provider,
        profile: route.profile,
        legArrivals: route.arrivals
      };
    },
    async fetchRoute(start, destination) {
      const route = await routeThrough([start, destination]);
      return {
        polyline: route.polyline,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        provider: route.provider,
        profile: route.profile
      };
    },
    async optimizeTrip(start, stops) {
      if (!Array.isArray(stops) || stops.length < 2) throw fail("route-too-few-stops");
      if (!validLocation(start) || stops.some(s => typeof s?.orderId !== "string" || !s.orderId.trim() || !validLocation(s.latLng)) || new Set(stops.map(s => s.orderId)).size !== stops.length) throw fail("route-invalid-stops");
      const points = [start, ...stops.map(s => s.latLng)];
      const order = motorcycleStopOrder(await travelMatrix(points));
      const route = await routeThrough([start, ...order.map(i => points[i])]);
      return {
        polyline: route.polyline,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        provider: route.provider,
        profile: route.profile,
        stops: order.map((index, i) => ({
          orderId: stops[index - 1].orderId,
          sequence: i + 1,
          etaSeconds: route.arrivals[i]
        }))
      };
    }
  };
}
const service = createMotorcycleRouteService();
export const fetchRoute = (...args) => service.fetchRoute(...args);
export const optimizeTrip = (...args) => service.optimizeTrip(...args);
export const fetchTravelMatrix = (...args) => service.travelMatrix(...args);
export const routeThroughStops = (...args) => service.routeThroughStops(...args);
// Pure compatibility helpers for old response fixtures, not route generation.
export function parseOptimizedJobOrder(response) {
  const steps = response?.routes?.[0]?.steps;
  return Array.isArray(steps) ? steps.filter(s => s?.type === "job" && Number.isFinite(s.id)).map(s => s.id) : [];
}
export function cumulativeLegSeconds(segments) {
  if (!Array.isArray(segments)) return [];
  let sum = 0;
  return segments.map(s => {
    sum += Number(s?.duration) || 0;
    return Math.round(sum);
  });
}
