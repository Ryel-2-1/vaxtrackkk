/**
 * Which map the web app draws (decision 2026-11-15): GOOGLE MAPS.
 *
 * Google is used whenever a Google Maps API key is configured
 * (VITE_GOOGLE_MAPS_API_KEY). OpenStreetMap (Leaflet) remains only as an
 * invisible safety net: it is drawn when no key is configured, when the build
 * forces it (VITE_MAP_PROVIDER=osm — an emergency switch, e.g. a billing
 * problem), or when Google fails to load or refuses the key at runtime
 * (useMapProvider / useGoogleMap fall back on their own). Users are never
 * offered a choice.
 */

/** Pure decision: Google unless there is no key or the build forces osm. */
export function resolveMapProvider({ envProvider, apiKey } = {}) {
  const hasKey = typeof apiKey === "string" && apiKey.trim() !== "";
  if (!hasKey) return "osm";
  return envProvider === "osm" ? "osm" : "google";
}

/** The Google Maps API key, or "" when none is configured. */
export function googleMapsApiKey() {
  return String(import.meta.env?.VITE_GOOGLE_MAPS_API_KEY ?? "").trim();
}

/** The provider for this build. */
export function currentMapProvider() {
  return resolveMapProvider({
    envProvider: import.meta.env?.VITE_MAP_PROVIDER,
    apiKey: googleMapsApiKey(),
  });
}
