// OpenRouteService (ORS) directions client — road-route polyline + distance +
// duration/ETA for the Dispatcher Geofence map. No Google Maps, no Mapbox, no
// OR-Tools. ORS free tier; the key is a Vite env var.
//
// Design constraints (this phase — Route + ETA foundation):
//  - Called ONLY on explicit dispatcher action (the "Generate route & ETA" /
//    "Refresh route" button) — never automatically, never in a loop.
//  - The encoded polyline STRING is stored on the order (compact ~1 byte/point),
//    then decoded client-side for Leaflet. No route deviation, no auto-alerts.
//  - The ORS key is read from import.meta.env and is a PUBLIC client identifier
//    (like the Firebase web key). ORS free tier is rate-limited, so exposure is
//    low-risk; a server-side proxy to fully hide it is a later hardening step.

const ORS_KEY = import.meta.env.VITE_OPENROUTESERVICE_API_KEY;

// Base directions endpoint (JSON) returns routes[0].geometry as an ENCODED
// polyline string (precision 5) + summary.distance/duration — the compact form.
const ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car";

export const ROUTE_PROVIDER = "openrouteservice";

// True only when a non-empty key is configured. Drives the safe missing-key UI.
export function isRouteServiceConfigured() {
  return typeof ORS_KEY === "string" && ORS_KEY.trim().length > 0;
}

// Fetch a driving route from rider -> clinic.
// Inputs are [lat, lng]; ORS expects [lng, lat] order.
// Returns { polyline (encoded string), distanceMeters, durationSeconds }.
// Throws Error("MISSING_KEY") when no key, or a friendly Error on API failure.
export async function fetchRoute(riderLatLng, clinicLatLng) {
  if (!isRouteServiceConfigured()) {
    throw new Error("MISSING_KEY");
  }
  const [rLat, rLng] = riderLatLng;
  const [cLat, cLng] = clinicLatLng;

  let res;
  try {
    res = await fetch(ORS_URL, {
      method: "POST",
      headers: {
        Authorization: ORS_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ coordinates: [[rLng, rLat], [cLng, cLat]] }),
    });
  } catch {
    // Network / CSP / offline — surface a friendly message, don't leak internals.
    throw new Error("Could not reach the routing service. Check your connection.");
  }

  if (!res.ok) {
    let msg = `Routing service error (${res.status}).`;
    try {
      const e = await res.json();
      const detail = e?.error?.message || e?.error;
      if (detail) msg = String(detail);
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const route = data?.routes?.[0];
  if (!route || !route.geometry || !route.summary) {
    throw new Error("No drivable route found between the rider and the destination.");
  }
  return {
    polyline: route.geometry, // encoded polyline (precision 5)
    distanceMeters: Math.round(route.summary.distance),
    durationSeconds: Math.round(route.summary.duration),
  };
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
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
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
  if (
    !(baseDate instanceof Date) ||
    isNaN(baseDate.getTime()) ||
    !Number.isFinite(durationSeconds)
  ) {
    return "—";
  }
  const eta = new Date(baseDate.getTime() + durationSeconds * 1000);
  return eta.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
