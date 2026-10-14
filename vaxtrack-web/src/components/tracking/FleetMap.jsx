import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MARKER_LABELS } from "../../services/riderTracking";
import "./LiveTracking.css";

/**
 * The live rider map, shared by Live Tracking (full page) and the Dispatcher
 * dashboard overview. One marker per rider with a position, coloured by the
 * rider's single state (services/riderTracking.js riderMarkerState). Read-only.
 *
 * The view fits the riders shown; it re-fits only when the SET of riders on
 * the map changes, so live updates never yank the view. Callers that have no
 * positions to show should not mount it (the overview shows a message instead).
 */

const METRO_MANILA = [14.5995, 120.9842];

function markerIcon(state, selected) {
  return L.divIcon({
    className: "ltp-marker",
    html: `<span class="ltp-dot ltp-dot-${state}${selected ? " ltp-dot-selected" : ""}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * @param {object[]} riders      fleet rows (buildFleet); only those with latLng get a marker
 * @param {string}   [selectedUid]
 * @param {Function} [onSelect]  called with a rider uid when a marker is clicked
 * @param {string}   [className] sizing class (default "ltp-map")
 */
function FleetMap({ riders, selectedUid = null, onSelect, className = "ltp-map" }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const fittedKeyRef = useRef("");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current).setView(METRO_MANILA, 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapRef.current = map;
    const onResize = () => map.invalidateSize();
    window.addEventListener("resize", onResize);
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(containerRef.current);
    }
    // invalidateSize after layout settles (setTimeout, not rAF — rAF is paused
    // in embedded panes).
    const timer = setTimeout(onResize, 50);
    const markers = markersRef.current;
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      map.remove();
      mapRef.current = null;
      markers.clear();
      fittedKeyRef.current = "";
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const seen = new Set();
    for (const r of riders) {
      if (!r.latLng) continue;
      seen.add(r.uid);
      const icon = markerIcon(r.state, r.uid === selectedUid);
      const tip = `${escapeHtml(r.name)} — ${escapeHtml(MARKER_LABELS[r.state])}`;
      let m = markers.get(r.uid);
      if (!m) {
        m = L.marker(r.latLng, { icon, keyboard: true, title: r.name }).addTo(map);
        m.bindTooltip(tip, { direction: "top", offset: [0, -10] });
        markers.set(r.uid, m);
      } else {
        m.setLatLng(r.latLng);
        m.setIcon(icon);
        m.setTooltipContent(tip);
      }
      m.off("click");
      if (onSelect) m.on("click", () => onSelect(r.uid));
      m.setZIndexOffset(r.uid === selectedUid ? 1000 : r.state === "deviating" ? 500 : 0);
    }
    for (const [uid, m] of markers) {
      if (!seen.has(uid)) {
        m.remove();
        markers.delete(uid);
      }
    }
    // Fit only when the SET of riders on the map changes, so live updates
    // never yank the view the dispatcher is looking at.
    const key = [...seen].sort().join(",");
    if (key !== fittedKeyRef.current) {
      fittedKeyRef.current = key;
      const points = riders.filter((r) => r.latLng).map((r) => r.latLng);
      if (points.length === 1) map.setView(points[0], 15, { animate: false });
      else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.2), { animate: false });
    }
  }, [riders, selectedUid, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    const r = riders.find((x) => x.uid === selectedUid);
    if (map && r?.latLng) map.panTo(r.latLng, { animate: true });
    // Pan only when the selection changes, not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid]);

  return <div ref={containerRef} className={className} role="region" aria-label="Live rider map" />;
}

export default FleetMap;
