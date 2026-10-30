import { useEffect, useMemo, useRef, useState } from "react";
import { useRiderLiveLocation } from "../../components/useRiderLiveLocation";
import { FRESHNESS, deviationDisplayState, deviationText, locationLatLng, locationTimeMs } from "../../services/riderTracking";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  AlertTriangle,
  Clock3,
  Flag,
  Info,
  Loader2,
  MapPin,
  Navigation,
  Package,
  RefreshCw,
  Route as RouteIcon,
  User,
  X,
} from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { saveOrderRoute, saveRiderTripRoute } from "../../services/orderService";
import {
  decodePolyline,
  fetchRoute,
  formatDistance,
  formatDuration,
  fetchTravelMatrix,
  formatEta,
  isRouteServiceConfigured,
  routeThroughStops,
} from "../../services/routeService";
import { DEADLINE_SLACK_MINUTES, arrivalCheck, bufferedMinutes, matrixMinutes, planTrip } from "../../services/timeAwareRouting";
import { subscribeRoutingSettings } from "../../services/routingSettingsService";
import { subscribeClinics } from "../../services/clinicService";
import { clinicsById } from "../../services/destinationFreshness";
import DestinationNotes from "../../components/dispatch/DestinationNotes";
import TripProgress, { StopProgressBadge } from "../../components/dispatch/TripProgress";
import { shipmentProgress, tripProgress } from "../../services/stopProgress";
import { routingSettingsOf } from "../../services/routingSettings";
import StatusBadge from "../../components/ui/StatusBadge";
import DialogLayer from "../../components/ui/DialogLayer";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { savedRouteDescription } from "../../services/routeMetadata.js";
import { manilaTime } from "../../services/deliveryTiming";
import { manilaClock, requestedArrivalOf, requestedScheduleLabel } from "../../services/requestedArrival";

/** Epoch ms of a Firestore Timestamp / Date / number, or null. */
function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Computed once — whether a valid motorcycle routing endpoint is configured.
const ROUTE_CONFIGURED = isRouteServiceConfigured();
// Geofence plans from the rider's live position, now. Re-optimize orders the
// stops to meet requested arrival times (timeAwareRouting.planTrip, the same
// logic as Cargo Loading's Plan trip, with the departure fixed at now) and
// replaces the saved trip. A single route reports whether its arrival meets
// the request — one stop has no order to choose.
const ROUTE_TIMING_NOTICE =
  "Plans from the rider's live position now: the arrival is checked against the requested time.";
const TRIP_TIMING_NOTICE =
  "Re-optimize plans from the rider's live position now, ordering stops to meet requested arrival times, and replaces the saved trip. To plan the departure from the hub, use Plan trip in Cargo Loading.";

// DOM-based marker (no image assets) — Leaflet's default icon PNGs break under
// bundlers, and a divIcon lets the marker use Meridian green via CSS.
// "geo3-live-*" names: the legacy removed fake-map CSS still defines
// .geo3-rider-marker with absolute left/top offsets that corrupt Leaflet's
// transform positioning.
const riderIcon = L.divIcon({
  className: "geo3-live-rider-marker",
  html: '<span class="geo3-live-rider-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// Destination (clinic) marker — visually distinct from the green rider dot.
const clinicIcon = L.divIcon({
  className: "geo3-live-clinic-marker",
  html: '<span class="geo3-live-clinic-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// Numbered destination marker for a multi-stop trip — shows the visiting order.
function numberedStopIcon(n, state, navigating) {
  const badge = state === "delivered" ? "✓" : navigating ? "➜" : state === "proof" ? "P" : "";
  return L.divIcon({
    className: "geo3-live-clinic-marker",
    html: `<span class="geo3-live-stop-dot stop-marker-${state}${navigating ? " stop-marker-navigating" : ""}">${n}${badge ? `<span class="stop-marker-badge">${badge}</span>` : ""}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// Stable empty stops list, so the non-trip case passes the SAME array reference
// every render — a fresh `[]` literal would change the map effect's deps on
// every render and re-initialise the Leaflet map constantly.
const NO_STOPS = Object.freeze([]);

// Manual geofence radius around the clinic (metres). No routing/ETA — just a
// simple "is the rider within this circle" visualization.
const GEOFENCE_RADIUS_M = 300;

const ACTIVE_STATUSES = new Set(["assigned", "loading", "in_transit", "delayed"]);

// A live-location fix older than this reads as stale. One boundary for every
// web view: FRESHNESS.freshMs in services/riderTracking.js (3 min — longer than
// the rider app's 2-minute stationary heartbeat).
const STALE_LOCATION_MS = FRESHNESS.freshMs;

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
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
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

// The order's manual clinic coordinates (plain numbers copied from the clinic
// at order-creation time), or null when the clinic had no coordinates.
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

// Leaflet + OpenStreetMap tiles (no API key). Always shows the rider marker;
// when the order carries manual clinic coordinates it also shows a destination
// marker + a geofence circle. No routing, ETA, or automatic alerts.
// Renders only when a rider lastLocation exists.
function RiderLocationMap({ lat, lng, clinicLat, clinicLng, routePolyline, stops = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const clinicMarkerRef = useRef(null);
  const circleRef = useRef(null);
  const routeLineRef = useRef(null);
  const stopMarkersRef = useRef([]);

  const hasClinic = Number.isFinite(clinicLat) && Number.isFinite(clinicLng);
  const hasStops = stops.length > 0;

  useEffect(() => {
    if (!containerRef.current) return;

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(mapRef.current);
    }
    const map = mapRef.current;

    // Rider marker (always).
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { icon: riderIcon }).addTo(map);
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }

    // Clinic marker + geofence circle (only when coordinates exist).
    if (hasClinic) {
      if (!clinicMarkerRef.current) {
        clinicMarkerRef.current = L.marker([clinicLat, clinicLng], { icon: clinicIcon }).addTo(map);
      } else {
        clinicMarkerRef.current.setLatLng([clinicLat, clinicLng]);
      }
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
      // Clinic coords went away (different order selected) — remove overlays.
      if (clinicMarkerRef.current) { clinicMarkerRef.current.remove(); clinicMarkerRef.current = null; }
      if (circleRef.current) { circleRef.current.remove(); circleRef.current = null; }
    }

    // Numbered multi-stop markers (trip mode). Rebuilt when the set changes; the
    // list is small and only changes when a trip is (re)generated. When `stops`
    // is empty this loop does nothing, so the single-clinic path above is the
    // sole behaviour — unchanged from before multi-stop.
    stopMarkersRef.current.forEach((m) => m.remove());
    stopMarkersRef.current = [];
    for (const s of stops) {
      const tooltip = document.createElement("span");
      tooltip.textContent = s.description;
      stopMarkersRef.current.push(
        L.marker([s.lat, s.lng], {
          icon: numberedStopIcon(s.label, s.state, s.navigating), title: s.description,
        }).addTo(map).bindTooltip(tooltip)
      );
    }

    // Route polyline — decode the stored encoded string here (runs only when
    // the string changes, so no per-render array churn re-fits the map).
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
        // Fit the whole road route (spans rider -> stops along real roads).
        map.fitBounds(L.latLngBounds(routePoints).pad(0.2), { animate: false });
      } else if (hasStops) {
        // No route yet but multiple stops — frame the rider and every stop.
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

    // Leaflet measures the container at construction time, which can happen
    // before flex layout settles — recalc after layout so markers aren't offset
    // from the visible container. setTimeout (not rAF): rAF can be suspended in
    // embedded/headless panes.
    const timer = setTimeout(() => {
      map.invalidateSize();
      fit();
    }, 50);
    return () => clearTimeout(timer);
  }, [lat, lng, clinicLat, clinicLng, hasClinic, routePolyline, hasStops, stops]);

  // Re-measure on viewport resize so the responsive height breakpoints
  // (480 / 390 / 320px) don't leave the map with stale dimensions (gray
  // strips / off-center tiles). ResizeObserver on the container also catches
  // sidebar/layout reflows, not just window resizes.
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

  // Tear the map down on unmount so HMR / re-selection never hits
  // "Map container is already initialized".
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

  // "geo3-live-map" (not "geo3-map") — the legacy removed fake-map CSS still
  // defines .geo3-map with a 520px gradient background, which would collide.
  return <div ref={containerRef} className="geo3-live-map" />;
}

function ShipmentDrawer({ onDismiss, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss });

  return (
    <DialogLayer scope="geo3-drawer-scope">
      <div className="geo3-drawer-overlay">
        <div className="geo3-drawer-backdrop" onClick={onDismiss} aria-hidden="true" />
        <aside id="geo3-shipment-drawer" className="geo3-drawer" role="dialog" aria-modal="true" aria-labelledby="geo3-drawer-title" ref={dialogRef}>
          <div className="geo3-drawer-header">
            <h2 id="geo3-drawer-title">Shipment details</h2>
            <button type="button" ref={closeRef} onClick={onDismiss} aria-label="Close shipment details">
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="geo3-drawer-content">{children}</div>
        </aside>
      </div>
    </DialogLayer>
  );
}

function DispatcherGeofence() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chosenId, setSelectedId] = useState("");
  const [drawerOrderId, setDrawerOrderId] = useState(null);
  // Route generation state, scoped to the order it belongs to (so an error or
  // in-flight request never bleeds onto a different selected order).
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [routeError, setRouteError] = useState(null); // { orderId, message } | null
  // Multi-stop trip optimization, scoped to the rider it belongs to.
  const [tripBusyRider, setTripBusyRider] = useState(null);
  const [tripError, setTripError] = useState(null); // { riderId, message } | null
  // Synchronous guards: one routing request per click, however fast the clicks.
  const routeInFlight = useRef(false);
  const tripInFlight = useRef(false);
  // Planning defaults (time at each stop, traffic buffer). Defaults until loaded
  // or when unreadable — the hub is not needed here: Geofence plans from the
  // rider's live position.
  const [routing, setRouting] = useState(() => routingSettingsOf(null));
  const [tripNotice, setTripNotice] = useState(null); // { riderId, allMet, text } | null
  // Clinics, to tell when an order's saved pin is older than its clinic's
  // (DestinationNotes). A failed read only hides that note.
  const [clinicMap, setClinicMap] = useState(() => new Map());
  useEffect(
    () =>
      subscribeClinics(
        (list) => setClinicMap(clinicsById(list)),
        (err) => logSafeError("Clinics for destination notes", err)
      ),
    []
  );

  useEffect(
    () =>
      subscribeRoutingSettings(
        (docData) => setRouting(routingSettingsOf(docData)),
        () => setRouting(routingSettingsOf(null))
      ),
    []
  );

  useEffect(() => {
    const unsub = subscribeDeliveries(
      (all) => {
        setOrders(all);
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(liveErrorMessage(err, "live monitoring"));
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const activeOrders = useMemo(
    () => orders.filter((o) => ACTIVE_STATUSES.has(o.statusKey)),
    [orders]
  );

  // The operator's pick while it is still an active order; otherwise the first
  // active order (or none). Derived, so the list and the selection can never
  // disagree for a render.
  const selectedId = activeOrders.some((o) => o.id === chosenId)
    ? chosenId
    : activeOrders[0]?.id ?? "";

  const selectedOrder = activeOrders.find((o) => o.id === selectedId) || null;
  // The rider's live position comes from riderLocations/{assignedRiderId}; the
  // order document no longer carries a location copy. It is overlaid in the
  // GeoPoint shape the map code below already reads, so that verified code is
  // unchanged. An ended or never-reported location yields null ("No live
  // location yet"), never a stale or invented position.
  const live = useRiderLiveLocation(selectedOrder?.assignedRiderId, {
    enabled: !!selectedOrder,
    withDeviation: true,
  });
  const selected = useMemo(() => {
    if (!selectedOrder) return null;
    const ll = locationLatLng(live.location);
    const atMs = locationTimeMs(live.location);
    return {
      ...selectedOrder,
      lastLocation: ll ? { latitude: ll[0], longitude: ll[1] } : null,
      lastLocationUpdate: ll && atMs !== null ? new Date(atMs) : null,
    };
  }, [selectedOrder, live.location]);
  const routeMonitoring = deviationDisplayState(live.deviation);

  const routeBusy = !!selected && busyOrderId === selected.id;
  const activeRouteError =
    routeError && selected && routeError.orderId === selected.id
      ? routeError.message
      : "";

  // All active orders for the selected order's rider that have clinic coords —
  // the candidate stops for a multi-stop trip.
  const riderStops = useMemo(() => {
    const riderId = selected?.assignedRiderId;
    if (!riderId) return [];
    return activeOrders
      .filter((o) => o.assignedRiderId === riderId && getClinicLatLng(o))
      .map((o) => ({ order: o, latLng: getClinicLatLng(o) }));
  }, [activeOrders, selected]);

  const progress = useMemo(
    () => tripProgress(orders, selectedOrder, live.deviation),
    [orders, selectedOrder, live.deviation]
  );

  // Keep completed stops visible in the current plan. Progress doesn't depend
  // on coordinates; only the map markers require a valid destination point.
  const tripStops = useMemo(() => {
    return (progress?.stops ?? [])
      .filter((s) => getClinicLatLng(s.order))
      .map((s) => ({ ...s, latLng: getClinicLatLng(s.order) }));
  }, [progress]);

  // Stable numbered-marker list for the map (visiting order).
  const tripStopMarkers = useMemo(
    () =>
      tripStops.map((s) => ({
        lat: s.latLng[0],
        lng: s.latLng[1],
        label: s.order.stopSequence,
        state: s.state,
        navigating: s.navigating,
        description: `Stop ${s.order.stopSequence} · ${s.order.clinicName || "Destination"} · ${s.label}${s.navigating ? " · Navigation target" : ""}`,
      })),
    [tripStops]
  );

  const hasTrip = !!selected?.tripId && !!selected?.tripPolyline;
  const tripBusy = !!selected && tripBusyRider === selected?.assignedRiderId;
  const activeTripError =
    tripError && selected && tripError.riderId === selected?.assignedRiderId
      ? tripError.message
      : "";
  const activeTripNotice =
    tripNotice && selected && tripNotice.riderId === selected?.assignedRiderId ? tripNotice : null;
  const canOptimize =
    !!getLatLng(selected?.lastLocation) && riderStops.length >= 2;

  async function handleOptimizeTrip() {
    if (!selected) return;
    const riderLL = getLatLng(selected.lastLocation);
    const riderId = selected.assignedRiderId;
    if (!riderLL || !riderId || riderStops.length < 2) return;
    if (tripInFlight.current) return;
    tripInFlight.current = true;
    setTripBusyRider(riderId);
    setTripError(null);
    setTripNotice(null);
    try {
      // Time-aware from where the rider is NOW: motorcycle times from the live
      // position (+ traffic buffer), the order that meets requested arrivals
      // first, departure fixed at the current minute.
      const points = [riderLL, ...riderStops.map((s) => s.latLng)];
      const seconds = await fetchTravelMatrix(points);
      const clock = manilaClock(new Date());
      const result = planTrip({
        stops: riderStops.map((s, i) => ({
          id: s.order.id,
          label: s.order.clinicName || s.order.orderNumber || "Destination",
          matrixIndex: i + 1,
          requestedDeliveryDate: s.order.requestedDeliveryDate,
          requestedArrival: s.order.requestedArrival,
          serviceMinutes: routing.serviceMinutes,
        })),
        minutes: matrixMinutes(seconds, routing.trafficBufferPercent),
        planDate: clock.date,
        nowMinute: clock.minute,
        fixedDeparture: clock.minute,
        allowWaiting: true,
        slackMinutes: DEADLINE_SLACK_MINUTES,
        longWaitMinutes: routing.longWaitMinutes,
      });
      if (!result || !result.etas) {
        throw new Error("No reachable visiting order for these stops.");
      }
      const byId = new Map(riderStops.map((s) => [s.order.id, s]));
      const route = await routeThroughStops(
        riderLL,
        result.order.map((id) => ({ orderId: id, latLng: byId.get(id).latLng }))
      );
      await saveRiderTripRoute({ ...route, stops: result.etas });
      const missed = result.plan.stops.filter((r) => r.outcome !== "ok").length;
      setTripNotice({
        riderId,
        allMet: result.allMet,
        text: result.allMet
          ? "Re-planned from the rider's position: every requested arrival is met."
          : `Re-planned from the rider's position: ${missed} requested arrival${missed === 1 ? "" : "s"} cannot be met from here — this is the order that misses by the least. Tell the clinic${missed === 1 ? "" : "s"} concerned.`,
      });
      // subscribeDeliveries refreshes the group's orders with the trip fields,
      // so the numbered markers + trip line + stop list redraw automatically.
    } catch (err) {
      // RouteServiceError carries its own safe sentence; a failed save of
      // the optimized trip goes through the shared mapper.
      logSafeError("Optimize trip", err);
      setTripError({
        riderId,
        message: friendlyErrorMessage(err, "The trip could not be optimized. Nothing was saved — please try again."),
      });
    } finally {
      tripInFlight.current = false;
      setTripBusyRider((cur) => (cur === riderId ? null : cur));
    }
  }

  async function handleGenerateRoute() {
    if (!selected) return;
    const riderLL = getLatLng(selected.lastLocation);
    const clinicLL = getClinicLatLng(selected);
    if (!riderLL || !clinicLL) return; // button is disabled in this case anyway
    const orderId = selected.id;
    if (routeInFlight.current) return;
    routeInFlight.current = true;
    setBusyOrderId(orderId);
    setRouteError(null);
    try {
      const route = await fetchRoute(riderLL, clinicLL);
      const etaText = formatEta(new Date(), route.durationSeconds);
      await saveOrderRoute(orderId, { ...route, etaText }, selected.destinationRevision ?? 0);
      // The subscribeDeliveries snapshot refreshes `selected` with the new
      // route fields, redrawing the polyline + metrics automatically.
    } catch (err) {
      logSafeError("Generate route", err);
      setRouteError({
        orderId,
        message: friendlyErrorMessage(err, "The route could not be generated. Nothing was saved — please try again."),
      });
    } finally {
      routeInFlight.current = false;
      setBusyOrderId((cur) => (cur === orderId ? null : cur));
    }
  }

  if (loading) {
    return (
      <>
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading live monitoring...</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="dispatcher-loading-state" role="alert">
          <AlertTriangle size={32} aria-hidden="true" />
          <p>{error}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <section className="geo3-page">
        <div className="geo3-top-row">
          <div>
            <h2 className="disp-section-title">Active monitoring</h2>
            <p>Track active vaccine shipments in real time from Firestore orders.</p>
          </div>
        </div>

        <div className="geo3-info-banner">
          <Info size={16} />
          <div>
            <strong>Follow trip progress and the Rider’s reported position.</strong>
            <p>
              Proof and delivery completion update automatically. Proof recorded
              does not confirm departure from a stop. The GPS marker shows the
              reported position; check its last update.
            </p>
          </div>
        </div>

        <TripProgress progress={progress} riderName={selected?.assignedRiderName} selectedId={selectedId} />

        {selected && getLatLng(selected.lastLocation) && (() => {
          const riderLL = getLatLng(selected.lastLocation);
          const clinicLL = getClinicLatLng(selected);
          const distM = clinicLL ? distanceMeters(riderLL, clinicLL) : null;
          const inside = distM != null && distM <= GEOFENCE_RADIUS_M;
          return (
            <div className="geo3-card geo3-live-map-card">
              <h3>Live map</h3>
              <RiderLocationMap
                lat={riderLL[0]}
                lng={riderLL[1]}
                clinicLat={hasTrip ? undefined : clinicLL ? clinicLL[0] : undefined}
                clinicLng={hasTrip ? undefined : clinicLL ? clinicLL[1] : undefined}
                routePolyline={hasTrip ? selected.tripPolyline : selected.routePolyline}
                stops={hasTrip ? tripStopMarkers : NO_STOPS}
              />
              {hasTrip && <p className="stop-progress-note">Stop markers: ✓ Delivered · P Proof recorded · ➜ Navigation target. The Rider’s position is the separate GPS dot.</p>}
              {clinicLL ? (
                <p className="geo3-live-map-note">
                  <span className={inside ? "geo3-geofence-in" : "geo3-geofence-out"}>
                    {inside
                      ? "Inside geofence"
                      : "Outside geofence"}
                  </span>{" "}
                  — rider is {Math.round(distM)} m from the destination
                  (geofence radius {GEOFENCE_RADIUS_M} m)
                  {isLocationStale(selected.lastLocationUpdate)
                    ? "; last update is stale"
                    : ""}
                  .
                </p>
              ) : (
                <p className="geo3-live-map-note">
                  Rider position only
                  {isLocationStale(selected.lastLocationUpdate)
                    ? " — last update is stale"
                    : ""}
                  . Add clinic coordinates in Admin → Clinics to show a
                  destination marker + geofence.
                </p>
              )}

              {(() => {
                const hasStoredRoute =
                  !!selected.routePolyline &&
                  Number.isFinite(selected.routeDistanceMeters);
                const genAt = selected.routeGeneratedAt?.toDate
                  ? selected.routeGeneratedAt.toDate()
                  : null;
                const liveEta = genAt
                  ? formatEta(genAt, selected.routeDurationSeconds)
                  : selected.routeEtaText || "—";
                const canGenerate = !!clinicLL; // rider location present here
                return (
                  <div className="geo3-live-route">
                    <div className="geo3-live-route-head">
                      <RouteIcon size={15} />
                      <span>Route &amp; ETA</span>
                    </div>

                    {hasStoredRoute && (
                      <div className="geo3-live-route-metrics">
                        <div>
                          <small>Distance</small>
                          <strong className="tnum">
                            {formatDistance(selected.routeDistanceMeters)}
                          </strong>
                        </div>
                        <div>
                          <small>Est. duration</small>
                          <strong className="tnum">
                            {formatDuration(selected.routeDurationSeconds)}
                          </strong>
                        </div>
                        <div>
                          <small>ETA</small>
                          <strong className="tnum">{liveEta}</strong>
                        </div>
                      </div>
                    )}

                    {hasStoredRoute && genAt && (() => {
                      // The arrival with the traffic buffer, against the requested time.
                      const buffered = bufferedMinutes(selected.routeDurationSeconds, routing.trafficBufferPercent);
                      const check = buffered === null ? null : arrivalCheck(selected, new Date(genAt.getTime() + buffered * 60000));
                      return check ? (
                        <p className={check.met || check.early ? "geo3-live-route-sub" : "geo3-live-route-error"} role="status">
                          {check.met ? "✓ " : check.early ? "" : "✗ "}
                          {check.text} With a {routing.trafficBufferPercent}% traffic buffer.
                        </p>
                      ) : null;
                    })()}

                    {hasStoredRoute && (
                      <p className="geo3-live-route-sub">
                        {savedRouteDescription(selected)}
                        {genAt
                          ? ` · generated ${formatRelativeTime(selected.routeGeneratedAt)}`
                          : ""}
                        .
                      </p>
                    )}

                    {!ROUTE_CONFIGURED ? (
                      <p className="geo3-live-route-missing">
                        Route and ETA planning isn't set up for this site yet. Contact an administrator.
                      </p>
                    ) : (
                      <>
                        <p className="geo3-live-route-sub">Motorcycle routing for the below-400 cc fleet. Routes flagged as using highways, toll roads or ferries are rejected. {ROUTE_TIMING_NOTICE}</p>
                        {hasTrip && riderStops.length >= 2 && (
                          <p className="geo3-live-route-sub">
                            The map shows the saved multi-stop trip. Use Re-optimize route below to refresh that trip.
                          </p>
                        )}
                        <button
                          type="button"
                          className="geo3-live-route-btn"
                          onClick={handleGenerateRoute}
                          disabled={!canGenerate || routeBusy}
                        >
                          {routeBusy ? (
                            <Loader2 size={14} className="spin" />
                          ) : hasStoredRoute ? (
                            <RefreshCw size={14} />
                          ) : (
                            <RouteIcon size={14} />
                          )}
                          {routeBusy
                            ? "Generating…"
                            : hasStoredRoute
                            ? "Refresh route"
                            : "Generate route & ETA"}
                        </button>
                        {!canGenerate && (
                          <p className="geo3-live-route-sub">
                            Add clinic coordinates (Admin → Clinics) to
                            enable routing to the destination.
                          </p>
                        )}
                        {activeRouteError && (
                          <p className="geo3-live-route-error" role="alert">{activeRouteError}</p>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {riderStops.length >= 2 && (
                <div className="geo3-live-trip">
                  <div className="geo3-live-route-head">
                    <RouteIcon size={15} />
                    <span>Multi-stop trip ({riderStops.length} stops)</span>
                  </div>

                  {hasTrip && (
                    <>
                      <p className="geo3-live-route-sub">{savedRouteDescription(selected, true)}</p>
                      <div className="geo3-live-route-metrics">
                        <div>
                          <small>Total distance</small>
                          <strong className="tnum">
                            {formatDistance(selected.tripDistanceMeters)}
                          </strong>
                        </div>
                        <div>
                          <small>Total duration</small>
                          <strong className="tnum">
                            {formatDuration(selected.tripDurationSeconds)}
                          </strong>
                        </div>
                        <div>
                          <small>Stops</small>
                          <strong className="tnum">{selected.tripStopCount}</strong>
                        </div>
                      </div>

                    </>
                  )}

                  {!ROUTE_CONFIGURED ? (
                    <p className="geo3-live-route-missing">
                      Trip optimization isn't set up for this site yet. Contact an administrator.
                    </p>
                  ) : (
                    <>
                      <p className="geo3-live-route-sub">{TRIP_TIMING_NOTICE}</p>
                      <button
                        type="button"
                        className="geo3-live-route-btn"
                        onClick={handleOptimizeTrip}
                        disabled={!canOptimize || tripBusy}
                      >
                        {tripBusy ? (
                          <Loader2 size={14} className="spin" />
                        ) : hasTrip ? (
                          <RefreshCw size={14} />
                        ) : (
                          <RouteIcon size={14} />
                        )}
                        {tripBusy
                          ? "Optimizing…"
                          : hasTrip
                          ? "Re-optimize route"
                          : `Optimize route (${riderStops.length} stops)`}
                      </button>
                      {!canOptimize && (
                        <p className="geo3-live-route-sub">
                          Needs the rider&apos;s live location and at least two
                          stops with clinic coordinates.
                        </p>
                      )}
                      {activeTripError && (
                        <p className="geo3-live-route-error" role="alert">{activeTripError}</p>
                      )}
                      {activeTripNotice && (
                        <p
                          className={activeTripNotice.allMet ? "geo3-live-route-sub" : "geo3-live-route-error"}
                          role="status"
                        >
                          {activeTripNotice.text}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {activeOrders.length === 0 ? (
          <div className="dispatcher-empty-queue">
            <Package size={28} />
            <p>No active shipments to monitor right now.</p>
            <small>Orders with status Assigned, Loading, In Transit, or Delayed will appear here.</small>
          </div>
        ) : (
          <div className="geo3-grid geo3-grid-single">
            <div className="geo3-left">
              <div className="geo3-card geo3-status-card">
                <h3>Active Shipments ({activeOrders.length})</h3>
                <div className="geo3-order-list">
                  {activeOrders.map((order) => {
                    const isActive = order.id === selectedId;
                    const stop = shipmentProgress(order);
                    return (
                      <button
                        key={order.id}
                        type="button"
                        className={`geo3-order-item ${isActive ? "active" : ""}`}
                        aria-haspopup="dialog"
                        aria-expanded={drawerOrderId === order.id && isActive}
                        aria-controls={drawerOrderId === order.id && isActive ? "geo3-shipment-drawer" : undefined}
                        onClick={() => {
                          setSelectedId(order.id);
                          setDrawerOrderId(order.id);
                        }}
                      >
                        <div className="geo3-order-item-head">
                          <strong>{order.orderNumber || order.id}</strong>
                          <StatusBadge statusKey={order.statusKey} label={order.statusLabel} />
                        </div>
                        <p>{order.clinicName || "—"}</p>
                        <StopProgressBadge progress={stop} />
                        {progress?.navigationTarget?.order.id === order.id && (
                          <span className="stop-progress-nav"><Navigation size={13} aria-hidden="true" />Navigation target</span>
                        )}
                        <small>
                          {order.assignedRiderName
                            ? `Rider: ${order.assignedRiderName}`
                            : "No rider assigned"}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {selected && drawerOrderId === selected.id && (
              <ShipmentDrawer onDismiss={() => setDrawerOrderId(null)}>
                  <div className="geo3-card geo3-info-card">
                    <div className="geo3-card-head">
                      <h3>Shipment overview</h3>
                      <StatusBadge statusKey={selected.statusKey} label={selected.statusLabel} />
                    </div>

                    <div className="geo3-info-list">
                      <div className="geo3-info-row">
                        <User size={15} />
                        <div>
                          <span>Rider</span>
                          <strong>{selected.assignedRiderName || "Unassigned"}</strong>
                          {selected.assignedRiderPhone && (
                            <p>{selected.assignedRiderPhone}</p>
                          )}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Package size={15} />
                        <div>
                          <span>Order</span>
                          <strong>{selected.orderNumber || selected.id}</strong>
                          <p>
                            {selected.vaccineName || "—"} · {selected.quantity || 0}{" "}
                            {selected.unit || "vials"}
                          </p>
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Flag size={15} />
                        <div>
                          <span>Priority</span>
                          <strong>{selected.priority || "Standard"}</strong>
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <MapPin size={15} />
                        <div>
                          <span>Destination</span>
                          <strong>{selected.clinicName || "—"}</strong>
                          {selected.clinicAddress && <p>{selected.clinicAddress}</p>}
                          <DestinationNotes order={selected} clinic={clinicMap.get(selected.clinicDocId)} />
                        </div>
                      </div>

                      {/* Requested arrival (the Med Rep's), the arrival
                          estimated when the trip left (frozen at dispatch), and
                          when it actually left — three different things. */}
                      <div className="geo3-info-row">
                        <Clock3 size={15} />
                        <div>
                          <span>Requested arrival</span>
                          <strong>{requestedScheduleLabel(selected.requestedDeliveryDate, requestedArrivalOf(selected))}</strong>
                          {millisOf(selected.expectedArrivalAt) !== null && (
                            <p>Estimated arrival at dispatch: {manilaTime(millisOf(selected.expectedArrivalAt))}</p>
                          )}
                          {millisOf(selected.dispatchedAt) !== null && (
                            <p>Left the hub: {manilaTime(millisOf(selected.dispatchedAt))}</p>
                          )}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Navigation size={15} />
                        <div>
                          <span>Live Location</span>
                          {formatCoords(selected.lastLocation) ? (
                            <>
                              <strong>{formatCoords(selected.lastLocation)}</strong>
                              <p>
                                Updated{" "}
                                {formatRelativeTime(selected.lastLocationUpdate) || "—"}
                                {isLocationStale(selected.lastLocationUpdate) && (
                                  <span className="geo3-stale"> · Stale (no recent update)</span>
                                )}
                              </p>
                              {routeMonitoring !== "not_navigating" && (
                                <p className={routeMonitoring === "deviating" ? "geo3-stale" : undefined}>
                                  Route monitoring: {deviationText(live.deviation)}
                                </p>
                              )}
                            </>
                          ) : (
                            <>
                              <strong className="geo3-muted">
                                {live.status === "loading" ? "Loading live location…" : "No live location yet"}
                              </strong>
                              <p>
                                {live.status === "error" || live.status === "denied"
                                  ? "The rider's location could not be loaded."
                                  : live.location?.trackingState === "ended"
                                    ? "The rider is not sharing location right now."
                                    : "Waiting for Rider mobile app location update."}
                              </p>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="geo3-info-row">
                        <Clock3 size={15} />
                        <div>
                          <span>Last Status Update</span>
                          <strong>
                            {formatRelativeTime(
                              selected.statusUpdatedAt || selected.updatedAt
                            ) || "—"}
                          </strong>
                          {millisOf(selected.statusUpdatedAt || selected.updatedAt) !== null && (
                            <p>{manilaTime(millisOf(selected.statusUpdatedAt || selected.updatedAt))}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {selected.deliveryInstructions && (
                    <div className="geo3-card geo3-timeline-card">
                      <h3>Delivery Instructions</h3>
                      <p style={{ fontSize: 13, color: "#475569", margin: 0 }}>
                        {selected.deliveryInstructions}
                      </p>
                    </div>
                  )}
              </ShipmentDrawer>
            )}
          </div>
        )}
      </section>
    </>
  );
}

export default DispatcherGeofence;
