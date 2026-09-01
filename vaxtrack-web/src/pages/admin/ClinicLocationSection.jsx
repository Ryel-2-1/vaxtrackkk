import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin } from "lucide-react";
import {
  DEFAULT_GEOFENCE_RADIUS_M,
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
  toFiniteNumber,
} from "../../services/clinicLocation";

// Fallback view when a clinic has no pin yet: Metro Manila, the service area.
// Deliberately NOT the browser's geolocation — that is the admin's desk, not
// the clinic.
const FALLBACK_CENTER = [14.5995, 120.9842];
const FALLBACK_ZOOM = 11;
const PLACED_ZOOM = 16;

// DOM marker (no image asset) — Leaflet's default icon PNGs break under
// bundlers. Amber matches the destination marker on Dispatcher Geofence, so
// the same clinic reads the same way on both surfaces.
const clinicIcon = L.divIcon({
  className: "clinic-loc-marker",
  html: '<span class="clinic-loc-marker-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/**
 * Reusable "Location and service area" section.
 *
 * Used by BOTH the Register Clinic form and the Manage location dialog, so the
 * picker, the numeric fallback and the radius rules exist once.
 *
 * The map and the numeric inputs are two views of the same value: clicking or
 * dragging writes the inputs, and typing moves the marker. The inputs are the
 * accessible path — everything here is reachable and completable without the
 * map.
 */
function ClinicLocationSection({
  value,
  onChange,
  errors = {},
  disabled = false,
  idPrefix = "clinic-loc",
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  // Keep the latest onChange without re-running the map effect on every render.
  // Assigned in an effect, never during render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const lat = toFiniteNumber(value.latitude);
  const lng = toFiniteNumber(value.longitude);
  const hasPin =
    lat !== null &&
    lng !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  // Radius preview. A BLANK radius previews the 300 m default, because blank
  // genuinely means "use the default". An INVALID radius previews nothing:
  // drawing a fallback circle would silently show the admin a service area
  // they did not choose and cannot save.
  // Same type-aware "blank" test as validateClinicLocation, so the preview and
  // the validator never disagree about whether a radius was supplied.
  const rawRadius = value.geofenceRadiusM;
  const radiusProvided =
    rawRadius !== undefined &&
    rawRadius !== null &&
    !(typeof rawRadius === "string" && rawRadius.trim() === "");
  const parsedRadius = toFiniteNumber(value.geofenceRadiusM);
  const radiusInRange =
    parsedRadius !== null &&
    parsedRadius >= MIN_GEOFENCE_RADIUS_M &&
    parsedRadius <= MAX_GEOFENCE_RADIUS_M;
  const radiusForCircle = !radiusProvided
    ? DEFAULT_GEOFENCE_RADIUS_M
    : radiusInRange
      ? parsedRadius
      : null; // null => no circle drawn
  const radiusPreviewHidden = radiusProvided && !radiusInRange;

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { zoomControl: true }).setView(
      FALLBACK_CENTER,
      FALLBACK_ZOOM
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    map.on("click", (event) => {
      if (disabled) return;
      const { lat: clickLat, lng: clickLng } = event.latlng;
      onChangeRef.current({
        latitude: clickLat.toFixed(6),
        longitude: clickLng.toFixed(6),
      });
    });

    mapRef.current = map;

    // The section is often mounted inside a dialog that sizes after paint.
    const timer = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(timer);
    // `disabled` is read through the closure guard above; re-creating the map
    // when it toggles would drop the user's pin mid-save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tear down on unmount so reopening the dialog never hits
  // "Map container is already initialized".
  useEffect(
    () => () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        circleRef.current = null;
      }
    },
    []
  );

  // Keep marker + circle in step with the current value.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!hasPin) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
      return;
    }

    const point = [lat, lng];

    if (!markerRef.current) {
      markerRef.current = L.marker(point, {
        icon: clinicIcon,
        draggable: !disabled,
        keyboard: false,
      }).addTo(map);
      markerRef.current.on("dragend", () => {
        const moved = markerRef.current.getLatLng();
        onChangeRef.current({
          latitude: moved.lat.toFixed(6),
          longitude: moved.lng.toFixed(6),
        });
      });
      map.setView(point, PLACED_ZOOM);
    } else {
      markerRef.current.setLatLng(point);
      if (markerRef.current.dragging) {
        if (disabled) markerRef.current.dragging.disable();
        else markerRef.current.dragging.enable();
      }
    }

    // An invalid radius removes the circle rather than falling back to a
    // default the admin did not type.
    if (radiusForCircle === null) {
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
    } else if (!circleRef.current) {
      circleRef.current = L.circle(point, {
        radius: radiusForCircle,
        color: "#b45309",
        weight: 2,
        fillColor: "#f59e0b",
        fillOpacity: 0.12,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng(point);
      circleRef.current.setRadius(radiusForCircle);
    }
  }, [hasPin, lat, lng, radiusForCircle, disabled]);

  const latId = `${idPrefix}-lat`;
  const lngId = `${idPrefix}-lng`;
  const radiusId = `${idPrefix}-radius`;

  return (
    <section className="clinic-loc" aria-labelledby={`${idPrefix}-heading`}>
      <div className="clinic-loc-head">
        <h4 id={`${idPrefix}-heading`}>Location and service area</h4>
        <span
          className={`clinic-loc-state ${hasPin ? "is-set" : "is-unset"}`}
        >
          {hasPin ? "Location verified" : "Needs location"}
        </span>
      </div>

      <p className="clinic-loc-help">
        Click the map to place this clinic&apos;s pin, or drag it to adjust.
        This location is reused for dispatch routing and delivery arrival
        monitoring, so place it on the building entrance riders should reach.
      </p>

      <div
        ref={containerRef}
        className="clinic-loc-map"
        role="application"
        aria-label="Clinic location picker. Click the map to place the pin, or use the latitude and longitude fields below."
      />

      <div className="clinic-loc-fields">
        <label htmlFor={latId}>
          Latitude
          <input
            id={latId}
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="14.599500"
            value={value.latitude ?? ""}
            onChange={(e) => onChange({ latitude: e.target.value })}
            disabled={disabled}
            aria-invalid={errors.latitude ? "true" : undefined}
            aria-describedby={errors.latitude ? `${latId}-error` : undefined}
          />
          {errors.latitude && (
            <small id={`${latId}-error`} className="clinic-loc-error">
              {errors.latitude}
            </small>
          )}
        </label>

        <label htmlFor={lngId}>
          Longitude
          <input
            id={lngId}
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="120.984200"
            value={value.longitude ?? ""}
            onChange={(e) => onChange({ longitude: e.target.value })}
            disabled={disabled}
            aria-invalid={errors.longitude ? "true" : undefined}
            aria-describedby={errors.longitude ? `${lngId}-error` : undefined}
          />
          {errors.longitude && (
            <small id={`${lngId}-error`} className="clinic-loc-error">
              {errors.longitude}
            </small>
          )}
        </label>

        <label htmlFor={radiusId}>
          Arrival radius (m)
          <input
            id={radiusId}
            type="number"
            step="10"
            min={MIN_GEOFENCE_RADIUS_M}
            max={MAX_GEOFENCE_RADIUS_M}
            inputMode="numeric"
            placeholder={String(DEFAULT_GEOFENCE_RADIUS_M)}
            value={value.geofenceRadiusM ?? ""}
            onChange={(e) => onChange({ geofenceRadiusM: e.target.value })}
            disabled={disabled}
            aria-invalid={errors.geofenceRadiusM ? "true" : undefined}
            aria-describedby={
              errors.geofenceRadiusM
                ? `${radiusId}-error`
                : `${radiusId}-hint`
            }
          />
          {errors.geofenceRadiusM ? (
            <small id={`${radiusId}-error`} className="clinic-loc-error">
              {errors.geofenceRadiusM}
            </small>
          ) : (
            <small id={`${radiusId}-hint`} className="clinic-loc-hint">
              {MIN_GEOFENCE_RADIUS_M}–{MAX_GEOFENCE_RADIUS_M} m. Defaults to{" "}
              {DEFAULT_GEOFENCE_RADIUS_M} m.
            </small>
          )}
        </label>
      </div>

      {radiusPreviewHidden && (
        <p className="clinic-loc-preview-warn" role="status">
          Radius preview hidden — the circle is only drawn for a radius between{" "}
          {MIN_GEOFENCE_RADIUS_M} and {MAX_GEOFENCE_RADIUS_M} m. This value
          cannot be saved.
        </p>
      )}

      {!hasPin && (
        <p className="clinic-loc-empty">
          <MapPin size={14} aria-hidden="true" />
          No pin placed yet. This clinic can still be saved — it will show as
          Needs location until a pin is added.
        </p>
      )}
    </section>
  );
}

export default ClinicLocationSection;
