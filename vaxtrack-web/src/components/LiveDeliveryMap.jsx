import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin } from "lucide-react";
import {
  decodePolyline,
  formatDistance,
  formatDuration,
  formatEta,
} from "../services/routeService";
import "./LiveDeliveryMap.css";

/**
 * Read-only live delivery map, shared by Admin (Deliveries drawer) and Sales Rep
 * (Order Tracking). It shows the rider's last reported position, and — when the
 * order carries clinic coordinates — the destination marker, the 300 m geofence
 * circle, and the dispatcher-generated route. It NEVER writes: no route
 * generation, no status changes. Route generation stays a Dispatcher action; the
 * other roles only view what has been saved.
 *
 * This is a deliberate, self-contained sibling of the Dispatcher Geofence map
 * rather than a shared extraction of it: the Dispatcher map is behaviour-verified
 * and its sizing lives in a dispatcher-only stylesheet, so this component carries
 * its own Leaflet lifecycle and its own CSS and never depends on Dispatcher.css.
 */

const GEOFENCE_RADIUS_M = 300;
const STALE_LOCATION_MS = 2 * 60 * 1000;
// Stable empty stops list — a fresh `[]` each render would re-run the map effect
// (its deps include `stops`) on every render.
const NO_STOPS = Object.freeze([]);

// DOM markers (no image assets — Leaflet's default icon PNGs break under
// bundlers). "ldm-" classes are private to this component.
const riderIcon = L.divIcon({
  className: "ldm-rider-marker",
  html: '<span class="ldm-rider-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
const clinicIcon = L.divIcon({
  className: "ldm-clinic-marker",
  html: '<span class="ldm-clinic-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// Numbered destination marker — shows this stop's place in a multi-stop trip.
function numberedClinicIcon(n) {
  return L.divIcon({
    className: "ldm-clinic-marker",
    html: `<span class="ldm-stop-dot">${n}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function isLocationStale(ts) {
  if (!ts) return false;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() > STALE_LOCATION_MS;
}

function formatRelativeTime(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return null;
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCoords(geoPoint) {
  if (!geoPoint) return null;
  const lat = geoPoint.latitude ?? geoPoint._lat;
  const lng = geoPoint.longitude ?? geoPoint._long;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// Handles both Firestore GeoPoint shapes (latitude/longitude and _lat/_long).
function getLatLng(geoPoint) {
  if (!geoPoint) return null;
  const lat = geoPoint.latitude ?? geoPoint._lat;
  const lng = geoPoint.longitude ?? geoPoint._long;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return [lat, lng];
}

function getClinicLatLng(order) {
  const lat = order?.clinicLat;
  const lng = order?.clinicLng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return [lat, lng];
}

// Great-circle distance in metres (Haversine) — no external API.
function distanceMeters([lat1, lng1], [lat2, lng2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toDate(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// The Leaflet canvas. Rider marker always; clinic marker + geofence circle when
// coordinates exist; route polyline when a saved route exists. Mirrors the
// Dispatcher map's lifecycle (fit, delayed invalidateSize, resize observer,
// unmount teardown) so it renders correctly inside a drawer/panel that lays out
// after mount.
function MapCanvas({ lat, lng, clinicLat, clinicLng, routePolyline, stopLabel, stops = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const clinicMarkerRef = useRef(null);
  const circleRef = useRef(null);
  const routeLineRef = useRef(null);
  const stopMarkersRef = useRef([]);

  const hasClinic = Number.isFinite(clinicLat) && Number.isFinite(clinicLng);
  // When the full stop set is supplied (admin overview) it replaces the single
  // clinic marker; the geofence circle still tracks this order's own clinic.
  const hasStops = stops.length > 0;

  useEffect(() => {
    if (!containerRef.current) return;
    // In a trip, this stop's clinic marker shows its visiting-order number.
    const destinationIcon = Number.isFinite(stopLabel)
      ? numberedClinicIcon(stopLabel)
      : clinicIcon;

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(mapRef.current);
    }
    const map = mapRef.current;

    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { icon: riderIcon }).addTo(map);
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }

    // Single clinic marker — only when the full stop set is NOT supplied, so the
    // numbered stops below don't double up on this order's clinic.
    if (hasClinic && !hasStops) {
      if (!clinicMarkerRef.current) {
        clinicMarkerRef.current = L.marker([clinicLat, clinicLng], {
          icon: destinationIcon,
        }).addTo(map);
      } else {
        clinicMarkerRef.current.setLatLng([clinicLat, clinicLng]);
        clinicMarkerRef.current.setIcon(destinationIcon);
      }
    } else if (clinicMarkerRef.current) {
      clinicMarkerRef.current.remove();
      clinicMarkerRef.current = null;
    }

    // Numbered markers for every stop (admin overview). Rebuilt on change.
    stopMarkersRef.current.forEach((m) => m.remove());
    stopMarkersRef.current = [];
    for (const s of stops) {
      stopMarkersRef.current.push(
        L.marker([s.lat, s.lng], { icon: numberedClinicIcon(s.label) }).addTo(map)
      );
    }

    // Geofence circle — always tracks THIS order's clinic when it has coords.
    if (hasClinic) {
      if (!circleRef.current) {
        circleRef.current = L.circle([clinicLat, clinicLng], {
          radius: GEOFENCE_RADIUS_M,
          color: "#b45309",
          weight: 2,
          fillColor: "#f59e0b",
          fillOpacity: 0.12,
        }).addTo(map);
      } else {
        circleRef.current.setLatLng([clinicLat, clinicLng]);
        circleRef.current.setRadius(GEOFENCE_RADIUS_M);
      }
    } else {
      if (clinicMarkerRef.current) {
        clinicMarkerRef.current.remove();
        clinicMarkerRef.current = null;
      }
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
    }

    const routePoints = routePolyline ? decodePolyline(routePolyline) : [];
    const hasRoute = routePoints.length > 1;
    if (hasRoute) {
      if (!routeLineRef.current) {
        routeLineRef.current = L.polyline(routePoints, {
          color: "#047857",
          weight: 4,
          opacity: 0.85,
        }).addTo(map);
      } else {
        routeLineRef.current.setLatLngs(routePoints);
      }
    } else if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }

    const fit = () => {
      if (hasRoute) {
        map.fitBounds(L.latLngBounds(routePoints).pad(0.2), { animate: false });
      } else if (hasStops) {
        map.fitBounds(
          L.latLngBounds([[lat, lng], ...stops.map((s) => [s.lat, s.lng])]).pad(0.3),
          { animate: false }
        );
      } else if (hasClinic) {
        map.fitBounds(
          L.latLngBounds([[lat, lng], [clinicLat, clinicLng]]).pad(0.35),
          { animate: false }
        );
      } else {
        map.setView([lat, lng], 15, { animate: false });
      }
    };
    fit();

    const timer = setTimeout(() => {
      map.invalidateSize();
      fit();
    }, 50);
    return () => clearTimeout(timer);
  }, [lat, lng, clinicLat, clinicLng, hasClinic, routePolyline, stopLabel, hasStops, stops]);

  useEffect(() => {
    const onResize = () => mapRef.current && mapRef.current.invalidateSize();
    window.addEventListener("resize", onResize);
    let ro;
    if (containerRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        clinicMarkerRef.current = null;
        circleRef.current = null;
        routeLineRef.current = null;
        stopMarkersRef.current = [];
      }
    };
  }, []);

  return <div ref={containerRef} className="ldm-map" />;
}

/**
 * @param {object} props
 * @param {object} props.order  a delivery/order with lastLocation, optional
 *   clinicLat/clinicLng, and optional saved route/trip fields.
 * @param {{lat:number,lng:number,label:number}[]} [props.tripStops]  every stop
 *   in the trip, numbered by visiting order — for callers that can read the
 *   whole group (Admin). Omitted for Sales Rep, who only sees their own stop.
 */
function LiveDeliveryMap({ order, tripStops = NO_STOPS }) {
  const riderLL = getLatLng(order?.lastLocation);
  const clinicLL = getClinicLatLng(order);

  // No rider fix yet — honest fallback, never a fake position.
  if (!riderLL) {
    return (
      <div className="ldm-fallback">
        <MapPin size={20} />
        <strong>No live location yet</strong>
        <p>
          Waiting for the rider app to send a GPS update
          {clinicLL ? "." : ", and this clinic has no coordinates yet."}
        </p>
      </div>
    );
  }

  const stale = isLocationStale(order?.lastLocationUpdate);
  const coords = formatCoords(order?.lastLocation);
  const rel = formatRelativeTime(order?.lastLocationUpdate);

  let geofence = null;
  if (clinicLL) {
    const dist = Math.round(distanceMeters(riderLL, clinicLL));
    geofence = { inside: dist <= GEOFENCE_RADIUS_M, dist };
  }

  // A multi-stop trip (optimized by the dispatcher) is drawn in preference to
  // the single-order route: the whole-trip polyline + this stop's numbered
  // marker. The order self-contains everything needed, so no sibling orders are
  // read — which also means a Sales Rep sees the trip path without needing read
  // access to other reps' stops.
  const hasTrip =
    typeof order?.tripPolyline === "string" && order.tripPolyline.length > 0;

  const hasRoute =
    typeof order?.routePolyline === "string" && order.routePolyline.length > 0;
  const genDate = toDate(order?.routeGeneratedAt);
  const eta =
    hasRoute && genDate && Number.isFinite(order?.routeDurationSeconds)
      ? formatEta(genDate, order.routeDurationSeconds)
      : order?.routeEtaText || null;

  return (
    <div className="ldm">
      <MapCanvas
        lat={riderLL[0]}
        lng={riderLL[1]}
        clinicLat={clinicLL ? clinicLL[0] : undefined}
        clinicLng={clinicLL ? clinicLL[1] : undefined}
        routePolyline={hasTrip ? order.tripPolyline : order?.routePolyline}
        stopLabel={hasTrip ? order.stopSequence : undefined}
        stops={hasTrip ? tripStops : NO_STOPS}
      />

      <div className="ldm-info">
        <div className="ldm-row">
          <span className="ldm-coords tnum">{coords || "—"}</span>
          {rel && <span className="ldm-muted">Updated {rel}</span>}
          {stale && <span className="ldm-stale">· Stale (no recent update)</span>}
        </div>

        {geofence && (
          <div className={`ldm-geofence ${geofence.inside ? "in" : "out"}`}>
            {geofence.inside ? "Inside geofence" : "Outside geofence"} — rider is{" "}
            {geofence.dist.toLocaleString()} m from the destination (radius{" "}
            {GEOFENCE_RADIUS_M} m)
          </div>
        )}

        {hasTrip ? (
          <div className="ldm-route">
            <span>
              Stop <strong className="tnum">{order.stopSequence}</strong> of{" "}
              <strong className="tnum">{order.tripStopCount}</strong>
            </span>
            <span>
              Trip distance{" "}
              <strong className="tnum">{formatDistance(order.tripDistanceMeters)}</strong>
            </span>
            <span>
              Trip duration{" "}
              <strong className="tnum">{formatDuration(order.tripDurationSeconds)}</strong>
            </span>
            <span>
              ETA <strong className="tnum">{order.stopEtaText || "—"}</strong>
            </span>
          </div>
        ) : hasRoute ? (
          <div className="ldm-route">
            <span>
              Distance <strong className="tnum">{formatDistance(order.routeDistanceMeters)}</strong>
            </span>
            <span>
              Est. duration{" "}
              <strong className="tnum">{formatDuration(order.routeDurationSeconds)}</strong>
            </span>
            <span>
              ETA <strong className="tnum">{eta || "—"}</strong>
            </span>
          </div>
        ) : null}
      </div>

      <p className="ldm-caption">
        Rider position only.{" "}
        {hasTrip
          ? "Numbered marker is this stop; the line is the rider's full optimized trip."
          : clinicLL
          ? "Destination marker and geofence shown."
          : "Destination marker and geofence require clinic coordinates."}
      </p>
    </div>
  );
}

export default LiveDeliveryMap;
