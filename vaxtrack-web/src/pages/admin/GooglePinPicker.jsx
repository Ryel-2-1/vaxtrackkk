import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import useGoogleMap, { latLngOf } from "../../components/maps/useGoogleMap";

/**
 * Google Maps version of the clinic pin picker, with ADDRESS SEARCH (the web
 * map since 2026-11-15). Used by ClinicLocationSection; the OpenStreetMap
 * picker is only the safety net if Google cannot load.
 *
 * Search uses Google Places (Philippines only). Choosing a result drops the
 * pin there and offers its address; the admin still confirms the pin is at
 * the entrance riders use (moving the pin clears that confirmation, exactly
 * as on the OpenStreetMap picker). Clicking the map or dragging the pin works
 * as before.
 *
 * Places is asked only for `location` and `formattedAddress` — the basic
 * fields — and nothing is stored except the coordinates (and the address, if
 * the admin chooses to use it).
 */

const FALLBACK_CENTER = { lat: 14.5995, lng: 120.9842 };
const FALLBACK_ZOOM = 11;
const PLACED_ZOOM = 16; // same as the OpenStreetMap picker; the arrival circle stays in view

function pinElement() {
  const el = document.createElement("span");
  el.className = "clinic-loc-marker gmp-clinic-pin";
  el.innerHTML = '<span class="clinic-loc-marker-dot"></span>';
  return el;
}

const fixed = (n) => n.toFixed(6);

/**
 * @param {object} props
 * @param {number|null} props.lat
 * @param {number|null} props.lng
 * @param {number|null} props.radius   circle to draw (m), or null for none
 * @param {boolean} props.disabled
 * @param {(patch: {latitude: string, longitude: string}) => void} props.onPick
 * @param {(address: string) => void} [props.onUseAddress]  offers "Use this address"
 * @param {() => void} props.onUnavailable  Google could not load: show OpenStreetMap
 * @param {string} props.ariaLabel
 * @param {string} props.idPrefix
 */
function GooglePinPicker({ lat, lng, radius, disabled, onPick, onUseAddress, onUnavailable, ariaLabel, idPrefix }) {
  const hasPin = lat !== null && lng !== null;
  const mapRef = useRef(null);
  const searchRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const latest = useRef({ onPick, disabled });
  useEffect(() => {
    latest.current = { onPick, disabled };
  });
  const [found, setFound] = useState(null); // { address }
  const [searchState, setSearchState] = useState("loading"); // loading | ready | unavailable

  const { status, map, lib } = useGoogleMap(mapRef, {
    center: hasPin ? { lat, lng } : FALLBACK_CENTER,
    zoom: hasPin ? PLACED_ZOOM : FALLBACK_ZOOM,
  });

  useEffect(() => {
    if (status === "failed") onUnavailable();
  }, [status, onUnavailable]);

  // Clicking the map places the pin.
  useEffect(() => {
    if (!map) return undefined;
    const listener = map.addListener("click", (event) => {
      const point = latLngOf(event.latLng);
      if (!point || latest.current.disabled) return;
      latest.current.onPick({ latitude: fixed(point.lat), longitude: fixed(point.lng) });
    });
    return () => listener.remove();
  }, [map]);

  // Pin + arrival circle follow the value.
  useEffect(() => {
    if (!map || !lib) return;
    if (!hasPin) {
      if (markerRef.current) markerRef.current.map = null;
      markerRef.current = null;
      circleRef.current?.setMap(null);
      circleRef.current = null;
      return;
    }
    const point = { lat, lng };
    if (!markerRef.current) {
      const marker = new lib.AdvancedMarkerElement({
        map,
        position: point,
        content: pinElement(),
        gmpDraggable: !disabled,
        title: "Clinic pin",
      });
      marker.addListener("dragend", () => {
        const moved = latLngOf(marker.position);
        if (moved) latest.current.onPick({ latitude: fixed(moved.lat), longitude: fixed(moved.lng) });
      });
      markerRef.current = marker;
      map.setCenter(point);
      map.setZoom(PLACED_ZOOM);
    } else {
      markerRef.current.position = point;
      markerRef.current.gmpDraggable = !disabled;
    }
    if (radius === null || radius === undefined) {
      circleRef.current?.setMap(null);
      circleRef.current = null;
    } else if (!circleRef.current) {
      circleRef.current = new lib.Circle({
        map,
        center: point,
        radius,
        clickable: false,
        strokeColor: "#b45309",
        strokeWeight: 2,
        fillColor: "#f59e0b",
        fillOpacity: 0.12,
      });
    } else {
      circleRef.current.setCenter(point);
      circleRef.current.setRadius(radius);
    }
  }, [map, lib, hasPin, lat, lng, radius, disabled]);

  // Address search (Google Places). If Places is not enabled for the key, the
  // map and the coordinate fields still work; only the search box is absent.
  useEffect(() => {
    if (!map || !lib || !searchRef.current) return undefined;
    let cancelled = false;
    let element = null;
    const onSelect = async (event) => {
      try {
        const place = event.placePrediction ? event.placePrediction.toPlace() : event.place;
        if (!place) return;
        await place.fetchFields({ fields: ["location", "formattedAddress"] });
        const point = latLngOf(place.location);
        if (cancelled || !point || latest.current.disabled) return;
        latest.current.onPick({ latitude: fixed(point.lat), longitude: fixed(point.lng) });
        map.setCenter(point);
        map.setZoom(PLACED_ZOOM);
        setFound(place.formattedAddress ? { address: place.formattedAddress } : null);
      } catch {
        if (!cancelled) setSearchState("unavailable");
      }
    };
    lib.maps
      .importLibrary("places")
      .then(({ PlaceAutocompleteElement }) => {
        if (cancelled || !searchRef.current || !PlaceAutocompleteElement) return;
        element = new PlaceAutocompleteElement({ includedRegionCodes: ["ph"] });
        element.id = `${idPrefix}-place-search`;
        element.setAttribute("placeholder", "Search the clinic name or address");
        element.addEventListener("gmp-select", onSelect);
        element.addEventListener("gmp-placeselect", onSelect); // older API versions
        element.addEventListener("gmp-error", () => setSearchState("unavailable"));
        element.addEventListener("gmp-requesterror", () => setSearchState("unavailable"));
        searchRef.current.replaceChildren(element);
        setSearchState("ready");
      })
      .catch(() => {
        if (!cancelled) setSearchState("unavailable");
      });
    return () => {
      cancelled = true;
      element?.remove();
    };
  }, [map, lib, idPrefix]);

  // Tear the map objects down with the component.
  useEffect(
    () => () => {
      if (markerRef.current) markerRef.current.map = null;
      circleRef.current?.setMap(null);
    },
    []
  );

  return (
    <div className="gmp-picker">
      <div className="gmp-search" aria-disabled={disabled ? "true" : undefined}>
        <label className="gmp-search-label" htmlFor={`${idPrefix}-place-search`}>
          <Search size={14} aria-hidden="true" /> Find the clinic
        </label>
        <div ref={searchRef} className="gmp-search-box" />
        {searchState === "loading" && <small className="clinic-loc-hint">Loading address search…</small>}
        {searchState === "unavailable" && (
          <small className="clinic-loc-hint">
            Address search is unavailable right now. Click the map or enter the coordinates below.
          </small>
        )}
        {found && (
          <div className="gmp-found" role="status">
            <span>
              Found: <strong>{found.address}</strong>
            </span>
            {onUseAddress && (
              <button
                type="button"
                className="gmp-use-address"
                onClick={() => onUseAddress(found.address)}
                disabled={disabled}
              >
                Use as the clinic address
              </button>
            )}
          </div>
        )}
      </div>
      <div ref={mapRef} className="clinic-loc-map" role="application" aria-label={ariaLabel} />
      {status === "loading" && <small className="clinic-loc-hint">Loading Google map…</small>}
    </div>
  );
}

export default GooglePinPicker;
