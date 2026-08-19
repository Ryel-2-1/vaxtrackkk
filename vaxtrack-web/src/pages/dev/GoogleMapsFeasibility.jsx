import { useEffect, useRef, useState } from "react";

/**
 * TEMPORARY Google Maps feasibility spike page.
 *
 * Isolated + local-only: no Firestore, no app services, no styles.css. Reached
 * only when VITE_GOOGLE_MAPS_FEASIBILITY === "true" (guarded route in App.jsx).
 * Uses the Maps JavaScript API *client SDK* and its modern Routes Library
 * (importLibrary("routes") -> Route.computeRoutes). It does NOT use the legacy
 * Directions API, the Routes REST web service, a proxy, or a Cloud Function.
 * No traffic / alternatives / tolls / Places / premium fields are requested.
 */

const ORIGIN = { lat: 14.5625, lng: 121.0495 }; // rider
const DESTINATION = { lat: 14.5995, lng: 120.9842 }; // clinic
const CALLBACK = "__vaxtrackGmapsFeasibilityInit";

// Inject the Google Maps JS bootstrap exactly once. importLibrary becomes
// available on the `weekly` channel after the callback fires.
function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (window.__gmapsFeasibilityLoading) return window.__gmapsFeasibilityLoading;
  window.__gmapsFeasibilityLoading = new Promise((resolve, reject) => {
    window[CALLBACK] = () => resolve();
    const s = document.createElement("script");
    s.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&v=weekly&loading=async&callback=${CALLBACK}`;
    s.async = true;
    s.onerror = () =>
      reject(new Error("Google Maps JS failed to load (script/network/referrer)."));
    document.head.appendChild(s);
  });
  return window.__gmapsFeasibilityLoading;
}

export default function GoogleMapsFeasibility() {
  const mapRef = useRef(null);
  const [status, setStatus] = useState("Loading Google Maps…");
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      setError("VITE_GOOGLE_MAPS_API_KEY is not configured.");
      return;
    }
    let cancelled = false;

    // Google calls this global on auth failure (bad key / referrer / billing /
    // API not enabled) — surface it instead of a silent grey map.
    window.gm_authFailure = () => {
      if (!cancelled)
        setError(
          "Google Maps auth failure — key, HTTP-referrer restriction, billing, or Maps JavaScript API not enabled."
        );
    };

    (async () => {
      try {
        await loadGoogleMaps(apiKey);
        if (cancelled) return;
        const { Map } = await google.maps.importLibrary("maps");
        const { Route } = await google.maps.importLibrary("routes");
        if (cancelled) return;

        const map = new Map(mapRef.current, { center: ORIGIN, zoom: 12 });

        new google.maps.Marker({
          position: ORIGIN,
          map,
          label: "R",
          title: "Rider / origin (14.5625, 121.0495)",
        });
        new google.maps.Marker({
          position: DESTINATION,
          map,
          label: "C",
          title: "Clinic / destination (14.5995, 120.9842)",
        });

        // Modern client-side Routes Library — Route.computeRoutes (not the
        // legacy routing class). Smallest field mask; no traffic /
        // alternatives / tolls / Places.
        setStatus("Requesting Google route (Route.computeRoutes)…");
        const { routes } = await Route.computeRoutes({
          origin: ORIGIN,
          destination: DESTINATION,
          travelMode: "DRIVING",
          routingPreference: "TRAFFIC_UNAWARE",
          fields: ["path", "distanceMeters", "durationMillis"],
        });
        if (cancelled) return;
        if (!routes || routes.length === 0) {
          throw new Error("Route.computeRoutes returned no routes.");
        }
        const route = routes[0];

        // Normalise each path point (LatLng | LatLngAltitude | literal) to a
        // {lat,lng} literal usable by Polyline + LatLngBounds.
        const path = route.path.map((p) => ({
          lat: typeof p.lat === "function" ? p.lat() : p.lat,
          lng: typeof p.lng === "function" ? p.lng() : p.lng,
        }));

        // Draw the route path on the existing map.
        new google.maps.Polyline({
          path,
          map,
          strokeColor: "#1a73e8",
          strokeOpacity: 0.9,
          strokeWeight: 5,
        });

        // Fit the camera to every point in the route path.
        const bounds = new google.maps.LatLngBounds();
        path.forEach((p) => bounds.extend(p));
        map.fitBounds(bounds, 48);

        const km = (route.distanceMeters / 1000).toFixed(2);
        const min = Math.round(route.durationMillis / 60000);
        setMetrics({ km, min });
        setStatus("Route rendered (modern Routes Library).");
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <span
          style={{
            background: "#1a73e8",
            color: "#fff",
            padding: "6px 12px",
            borderRadius: 8,
            fontWeight: 700,
          }}
        >
          Google Maps feasibility test
        </span>
        <span style={{ color: error ? "#c5221f" : "#444" }}>
          {error ? `Error: ${error}` : status}
        </span>
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <Metric label="Distance" value={metrics ? `${metrics.km} km` : "—"} />
        <Metric label="Duration" value={metrics ? `${metrics.min} min` : "—"} />
      </div>
      <div
        ref={mapRef}
        style={{ width: "100%", height: 460, borderRadius: 10, background: "#e8eaed" }}
      />
      <p style={{ fontSize: 12, color: "#666", marginTop: 10 }}>
        Origin (rider) 14.5625, 121.0495 · Destination (clinic) 14.5995, 120.9842 ·
        Local feasibility spike — no Firestore, no REST Routes API.
      </p>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ border: "1px solid #dadce0", borderRadius: 10, padding: "10px 16px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "#5f6368" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
