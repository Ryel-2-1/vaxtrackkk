import { useEffect, useState } from "react";
import { googleMapId, googleMapsAuthFailed, loadGoogleMapsLibraries, onGoogleMapsAuthFailure } from "./googleMapsLoader";

/**
 * Creates one Google map in `containerRef` (the web map since 2026-11-15).
 *
 * Returns { status, map, lib }: status is "loading", "ready" or "failed". A
 * caller shows its OpenStreetMap version on "failed" — the key missing or
 * refused, the script blocked, or the API not enabled — so a map is always
 * shown. `options` are read once, when the map is created.
 */
export default function useGoogleMap(containerRef, options = {}) {
  const [state, setState] = useState({ status: "loading", map: null, lib: null });

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setState({ status: "failed", map: null, lib: null });
    };
    const unsubscribe = onGoogleMapsAuthFailure(fail);
    loadGoogleMapsLibraries()
      .then((lib) => {
        if (cancelled || !containerRef.current) return;
        if (googleMapsAuthFailed()) return fail();
        const map = new lib.Map(containerRef.current, {
          center: options.center ?? { lat: 14.5995, lng: 120.9842 },
          zoom: options.zoom ?? 11,
          mapId: googleMapId(),
          // Inside scrolling pages and dialogs the wheel scrolls the page;
          // Ctrl + wheel (or two fingers) zooms the map.
          gestureHandling: options.gestureHandling ?? "cooperative",
          clickableIcons: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        });
        setState({ status: "ready", map, lib });
      })
      .catch(fail);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // The map is created once; later option changes are applied by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

/** A Google LatLng or LatLngLiteral as plain numbers, or null. */
export function latLngOf(value) {
  if (!value) return null;
  const lat = typeof value.lat === "function" ? value.lat() : value.lat;
  const lng = typeof value.lng === "function" ? value.lng() : value.lng;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
