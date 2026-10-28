// Dispatcher-initiated motorcycle routing for the below-400 cc fleet.
// OpenStreetMap tiles stay unchanged. Never falls back to car/bicycle routes.
import { UserMessageError } from "./userMessageError.js";
import { ROUTE_PROVIDER, ROUTE_PROFILE } from "./routeMetadata.js";
export { ROUTE_PROVIDER, ROUTE_PROFILE } from "./routeMetadata.js";
const ROUTING_URL = import.meta.env?.VITE_MOTORCYCLE_ROUTING_URL ?? "https://valhalla1.openstreetmap.de";
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
  "route-restricted": "The returned route includes a highway, toll road or ferry. It was not saved because this fleet uses motorcycles below 400 cc. Check the locations before trying again.",
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
    minute: "2-digit"
  });
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
export function motorcycleRequest() {
  // Preferences alone cannot enforce restrictions. The public server ignores
  // hard exclusions: the ACTUAL returned path is validated before any save.
  return {
    costing: "motorcycle",
    costing_options: {
      motorcycle: {
        use_highways: 0,
        use_tolls: 0,
        use_ferry: 0,
        use_trails: 0
      }
    },
    units: "kilometers"
  };
}
function noWarnings(data) {
  for (const w of [data?.warnings, data?.trip?.warnings]) {
    if (w != null && (!Array.isArray(w) || w.length)) throw fail("route-unverified");
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
export function parseMotorcycleRoute(data, legCount) {
  noWarnings(data);
  const t = data?.trip;
  if (t?.status !== 0 || t.units !== "kilometers" || !Array.isArray(t.legs) || t.legs.length !== legCount) throw fail("route-not-found");
  checkedSummary(t.summary);
  const points = [],
    arrivals = [];
  let elapsed = 0;
  for (const leg of t.legs) {
    checkedSummary(leg.summary);
    if (!Array.isArray(leg.maneuvers) || !leg.maneuvers.length) throw fail("route-unverified");
    for (const m of leg.maneuvers) {
      if (m.highway === true || m.toll === true || m.ferry === true) throw fail("route-restricted");
      if (m.travel_mode !== "drive" || m.travel_type !== "motorcycle") throw fail("route-unverified");
    }
    const shape = providerShape(leg.shape);
    if (points.length) {
      const a = points.at(-1),
        b = shape[0];
      if (Math.abs(a[0] - b[0]) > 0.00002 || Math.abs(a[1] - b[1]) > 0.00002) throw fail("route-not-found");
      shape.shift();
    }
    for (const point of shape) points.push(point);
    elapsed += leg.summary.time;
    arrivals.push(Math.round(elapsed));
  }
  const length = t.legs.reduce((sum, leg) => sum + leg.summary.length, 0);
  if (Math.abs(elapsed - t.summary.time) > Math.max(1, legCount * 0.01) || Math.abs(length - t.summary.length) > Math.max(0.01, legCount * 0.002)) throw fail("route-not-found");
  return {
    polyline: encodePolyline(points),
    distanceMeters: Math.round(t.summary.length * 1000),
    durationSeconds: Math.round(t.summary.time),
    provider: ROUTE_PROVIDER,
    profile: ROUTE_PROFILE,
    arrivals
  };
}
export function parseMotorcycleMatrix(data, size) {
  noWarnings(data);
  const rows = data?.sources_to_targets;
  if (!Array.isArray(rows) || rows.length !== size || rows.some(r => !Array.isArray(r) || r.length !== size)) throw fail("route-not-found");
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
      if (!res.ok) throw fail(res.status === 429 ? "route-rate-limited" : "route-provider-error");
      try {
        return await res.json();
      } catch {
        throw fail("route-provider-error");
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async function routeThrough(points) {
    if (!points.every(validLocation)) throw fail("route-invalid-stops");
    return parseMotorcycleRoute(await request("route", {
      ...motorcycleRequest(),
      locations: points.map(location)
    }), points.length - 1);
  }
  return {
    // Motorcycle travel seconds between every pair of points (Infinity when a
    // pair is unreachable). One request; reordering stops reuses it.
    async travelMatrix(points) {
      if (!Array.isArray(points) || points.length < 2 || !points.every(validLocation)) throw fail("route-invalid-stops");
      const locations = points.map(location);
      const data = await request("sources_to_targets", {
        ...motorcycleRequest(),
        sources: locations,
        targets: locations
      });
      return parseMotorcycleMatrix(data, points.length);
    },
    // The route through stops in the order given (the Dispatcher's plan), not
    // reordered. `legArrivals` are cumulative riding seconds to each stop.
    async routeThroughStops(start, stops) {
      if (!Array.isArray(stops) || stops.length < 1 || stops.some(s => typeof s?.orderId !== "string" || !s.orderId.trim() || !validLocation(s.latLng)) || new Set(stops.map(s => s.orderId)).size !== stops.length) throw fail("route-invalid-stops");
      const route = await routeThrough([start, ...stops.map(s => s.latLng)]);
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
      const points = [start, ...stops.map(s => s.latLng)],
        locations = points.map(location);
      const data = await request("sources_to_targets", {
        ...motorcycleRequest(),
        sources: locations,
        targets: locations
      });
      const order = motorcycleStopOrder(parseMotorcycleMatrix(data, points.length));
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
