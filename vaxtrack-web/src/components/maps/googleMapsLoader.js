import { googleMapsApiKey } from "../../services/mapProvider";

/**
 * Loads the Google Maps JavaScript API once (the web map since 2026-11-15) using
 * Google's own script host. Resolves to `google.maps`; rejects when no key is
 * configured or the script cannot load. A key Google refuses (wrong referrer,
 * API not enabled, billing) is reported through onGoogleMapsAuthFailure —
 * Google calls window.gm_authFailure for that, after the script has loaded.
 */

const CALLBACK = "__vaxtrackGoogleMapsReady";
let loading = null;
let authFailed = false;
const authListeners = new Set();

export function googleMapsAuthFailed() {
  return authFailed;
}

/** Subscribe to "Google refused the key". Returns an unsubscribe. */
export function onGoogleMapsAuthFailure(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** The Map ID advanced markers need. DEMO_MAP_ID is Google's test ID. */
export function googleMapId() {
  return String(import.meta.env?.VITE_GOOGLE_MAPS_MAP_ID ?? "").trim() || "DEMO_MAP_ID";
}

export function loadGoogleMaps() {
  const key = googleMapsApiKey();
  if (!key) return Promise.reject(new Error("google-maps-no-key"));
  if (authFailed) return Promise.reject(new Error("google-maps-auth-failed"));
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (loading) return loading;

  window.gm_authFailure = () => {
    authFailed = true;
    authListeners.forEach((listener) => listener());
  };
  loading = new Promise((resolve, reject) => {
    window[CALLBACK] = () => resolve(window.google.maps);
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key,
      v: "weekly",
      loading: "async",
      callback: CALLBACK,
      region: "PH",
      language: "en",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("google-maps-load-failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The libraries the VaxTrack maps use, loaded together. */
export async function loadGoogleMapsLibraries() {
  const maps = await loadGoogleMaps();
  const [core, marker] = await Promise.all([maps.importLibrary("maps"), maps.importLibrary("marker")]);
  return {
    Map: core.Map,
    Circle: core.Circle,
    Polyline: core.Polyline,
    AdvancedMarkerElement: marker.AdvancedMarkerElement,
    LatLngBounds: maps.LatLngBounds,
    event: maps.event,
    maps,
  };
}
