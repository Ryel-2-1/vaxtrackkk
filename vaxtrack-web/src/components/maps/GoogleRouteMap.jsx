import { useEffect, useRef } from "react";
import useGoogleMap from "./useGoogleMap";
import { decodePolyline } from "../../services/routeService";
import "./GoogleRouteMap.css";

/**
 * Google Maps version of the read-only delivery maps (the web map since 2026-11-15):
 * the Admin/Med Rep delivery map (LiveDeliveryMap) and the Dispatcher Geofence
 * map. Draws exactly what their OpenStreetMap canvases draw — rider marker,
 * destination marker or numbered trip stops, the order's arrival circle and
 * the saved route line — with the same fit rules, and the SAME marker markup
 * and CSS classes (passed in), so a stop looks identical on both maps.
 *
 * Read-only: nothing here writes. Calls `onUnavailable` if Google cannot load,
 * so the caller falls back to its OpenStreetMap canvas.
 *
 * @param {object} props
 * @param {string} props.className        the map box class (sets its height)
 * @param {number} props.lat              rider position
 * @param {number} props.lng
 * @param {number} [props.clinicLat]      single destination (omit in trip mode)
 * @param {number} [props.clinicLng]
 * @param {number} [props.circleLat]      arrival circle centre (defaults to the clinic)
 * @param {number} [props.circleLng]
 * @param {number} [props.geofenceRadiusM]
 * @param {string} [props.routePolyline]  encoded saved route/trip line
 * @param {{lat:number,lng:number,html:string,className?:string,title?:string}[]} [props.stops]
 * @param {{html:string,className:string}} props.riderMarker
 * @param {{html:string,className:string}} [props.clinicMarker]
 * @param {() => void} props.onUnavailable
 */

function markerContent({ html, className }) {
  const el = document.createElement("span");
  el.className = `${className || ""} grm-marker`.trim();
  el.innerHTML = html;
  return el;
}

const finite = (n) => Number.isFinite(n);

function GoogleRouteMap({
  className,
  lat,
  lng,
  clinicLat,
  clinicLng,
  circleLat,
  circleLng,
  geofenceRadiusM,
  routePolyline,
  stops,
  riderMarker,
  clinicMarker,
  onUnavailable,
}) {
  const containerRef = useRef(null);
  const riderRef = useRef(null);
  const clinicRef = useRef(null);
  const circleRef = useRef(null);
  const lineRef = useRef(null);
  const stopRefs = useRef([]);
  const { status, map, lib } = useGoogleMap(containerRef, { center: { lat, lng }, zoom: 15 });

  useEffect(() => {
    if (status === "failed") onUnavailable?.();
  }, [status, onUnavailable]);

  const riderHtml = riderMarker.html;
  const riderClass = riderMarker.className;
  const clinicHtml = clinicMarker?.html;
  const clinicClass = clinicMarker?.className;
  const cLat = finite(circleLat) ? circleLat : clinicLat;
  const cLng = finite(circleLng) ? circleLng : clinicLng;

  useEffect(() => {
    if (!map || !lib) return;
    const stopList = Array.isArray(stops) ? stops : [];

    // Rider (always).
    if (!riderRef.current) {
      riderRef.current = new lib.AdvancedMarkerElement({ map, title: "Rider", zIndex: 1000 });
    }
    riderRef.current.position = { lat, lng };
    riderRef.current.content = markerContent({ html: riderHtml, className: riderClass });

    // Single destination marker.
    const hasClinic = finite(clinicLat) && finite(clinicLng) && clinicHtml;
    if (hasClinic) {
      if (!clinicRef.current) clinicRef.current = new lib.AdvancedMarkerElement({ map, title: "Destination" });
      clinicRef.current.position = { lat: clinicLat, lng: clinicLng };
      clinicRef.current.content = markerContent({ html: clinicHtml, className: clinicClass });
    } else if (clinicRef.current) {
      clinicRef.current.map = null;
      clinicRef.current = null;
    }

    // Numbered trip stops — rebuilt when the set changes (small list).
    stopRefs.current.forEach((m) => {
      m.map = null;
    });
    stopRefs.current = stopList.map(
      (s) =>
        new lib.AdvancedMarkerElement({
          map,
          position: { lat: s.lat, lng: s.lng },
          title: s.title || "",
          content: markerContent({ html: s.html, className: s.className }),
        })
    );

    // Arrival circle.
    const hasCircle = finite(cLat) && finite(cLng) && finite(geofenceRadiusM);
    if (hasCircle) {
      if (!circleRef.current) {
        circleRef.current = new lib.Circle({
          map,
          clickable: false,
          strokeColor: "#b45309",
          strokeWeight: 2,
          fillColor: "#f59e0b",
          fillOpacity: 0.12,
        });
      }
      circleRef.current.setCenter({ lat: cLat, lng: cLng });
      circleRef.current.setRadius(geofenceRadiusM);
    } else if (circleRef.current) {
      circleRef.current.setMap(null);
      circleRef.current = null;
    }

    // Saved route / trip line.
    const routePoints = routePolyline ? decodePolyline(routePolyline) : [];
    const path = routePoints.map(([pLat, pLng]) => ({ lat: pLat, lng: pLng }));
    const hasRoute = path.length > 1;
    if (hasRoute) {
      if (!lineRef.current) {
        lineRef.current = new lib.Polyline({ map, clickable: false, strokeColor: "#047857", strokeWeight: 4, strokeOpacity: 0.85 });
      }
      lineRef.current.setPath(path);
    } else if (lineRef.current) {
      lineRef.current.setMap(null);
      lineRef.current = null;
    }

    // Same framing order as the OpenStreetMap canvases.
    const frame = (points, padding) => {
      const bounds = new lib.LatLngBounds();
      points.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, padding);
    };
    if (hasRoute) frame(path, 40);
    else if (stopList.length > 0) frame([{ lat, lng }, ...stopList.map((s) => ({ lat: s.lat, lng: s.lng }))], 56);
    else if (hasClinic) frame([{ lat, lng }, { lat: clinicLat, lng: clinicLng }], 64);
    else {
      map.setCenter({ lat, lng });
      map.setZoom(15);
    }
  }, [map, lib, lat, lng, clinicLat, clinicLng, cLat, cLng, geofenceRadiusM, routePolyline, stops, riderHtml, riderClass, clinicHtml, clinicClass]);

  // Remove everything drawn when the map goes away.
  useEffect(
    () => () => {
      [riderRef.current, clinicRef.current, ...stopRefs.current].forEach((m) => {
        if (m) m.map = null;
      });
      circleRef.current?.setMap(null);
      lineRef.current?.setMap(null);
    },
    []
  );

  return <div ref={containerRef} className={className} />;
}

export default GoogleRouteMap;
