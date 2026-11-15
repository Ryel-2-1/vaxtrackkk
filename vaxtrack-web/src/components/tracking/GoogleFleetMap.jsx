import { useEffect, useRef } from "react";
import useGoogleMap from "../maps/useGoogleMap";
import { MARKER_LABELS, RETURNING_TO_HUB_LABEL } from "../../services/riderTracking";

/**
 * Google Maps version of the live rider map (the web map since 2026-11-15). Same
 * contract and behaviour as the OpenStreetMap FleetMap: one marker per rider
 * with a position, coloured by state (same CSS classes), a tooltip, click to
 * select, and the view re-fits only when the SET of riders changes. Calls
 * `onUnavailable` if Google cannot load, so FleetMap shows OpenStreetMap.
 */

function dot(state, selected) {
  const el = document.createElement("span");
  el.className = "ltp-marker gfm-marker";
  el.innerHTML = `<span class="ltp-dot ltp-dot-${state}${selected ? " ltp-dot-selected" : ""}"></span>`;
  return el;
}

function GoogleFleetMap({ riders, selectedUid = null, onSelect, className = "ltp-map", onUnavailable }) {
  const containerRef = useRef(null);
  const markersRef = useRef(new Map());
  const fittedKeyRef = useRef("");
  const { status, map, lib } = useGoogleMap(containerRef, { gestureHandling: "greedy" });

  useEffect(() => {
    if (status === "failed") onUnavailable?.();
  }, [status, onUnavailable]);

  useEffect(() => {
    if (!map || !lib) return;
    const markers = markersRef.current;
    const seen = new Set();
    for (const r of riders) {
      if (!r.latLng) continue;
      seen.add(r.uid);
      const [lat, lng] = r.latLng;
      const tip = `${r.name} — ${MARKER_LABELS[r.state]}${r.returningToHub ? ` · ${RETURNING_TO_HUB_LABEL}` : ""}`;
      const selected = r.uid === selectedUid;
      let m = markers.get(r.uid);
      if (!m) {
        m = new lib.AdvancedMarkerElement({ map, position: { lat, lng }, title: tip, gmpClickable: true });
        markers.set(r.uid, m);
      }
      m.position = { lat, lng };
      m.title = tip;
      m.content = dot(r.state, selected);
      m.zIndex = selected ? 1000 : r.state === "deviating" ? 500 : 0;
      // `gmp-click` is the advanced marker's own click event (the older
      // addListener("click") is deprecated).
      if (m.__vaxClick) m.removeEventListener("gmp-click", m.__vaxClick);
      m.__vaxClick = onSelect ? () => onSelect(r.uid) : null;
      if (m.__vaxClick) m.addEventListener("gmp-click", m.__vaxClick);
    }
    for (const [uid, m] of markers) {
      if (!seen.has(uid)) {
        if (m.__vaxClick) m.removeEventListener("gmp-click", m.__vaxClick);
        m.map = null;
        markers.delete(uid);
      }
    }
    const key = [...seen].sort().join(",");
    if (key !== fittedKeyRef.current) {
      fittedKeyRef.current = key;
      const pts = riders.filter((r) => r.latLng).map((r) => ({ lat: r.latLng[0], lng: r.latLng[1] }));
      if (pts.length === 1) {
        map.setCenter(pts[0]);
        map.setZoom(15);
      } else if (pts.length > 1) {
        const bounds = new lib.LatLngBounds();
        pts.forEach((p) => bounds.extend(p));
        map.fitBounds(bounds, 48);
      }
    }
  }, [map, lib, riders, selectedUid, onSelect]);

  useEffect(() => {
    const r = riders.find((x) => x.uid === selectedUid);
    if (map && r?.latLng) map.panTo({ lat: r.latLng[0], lng: r.latLng[1] });
    // Pan only when the selection changes, not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, map]);

  useEffect(() => {
    const markers = markersRef.current;
    return () => {
      for (const m of markers.values()) {
        if (m.__vaxClick) m.removeEventListener("gmp-click", m.__vaxClick);
        m.map = null;
      }
      markers.clear();
    };
  }, []);

  return <div ref={containerRef} className={className} role="region" aria-label="Live rider map" />;
}

export default GoogleFleetMap;
