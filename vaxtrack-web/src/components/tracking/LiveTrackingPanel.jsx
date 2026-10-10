import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import KpiCard from "../ui/KpiCard";
import { useNow } from "../useRiderLiveLocation";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiders } from "../../services/riderService";
import { subscribeAllDeviationStates, subscribeAllRiderLocations } from "../../services/riderTrackingService";
import {
  DEVIATION_RULES,
  MARKER_LABELS,
  MARKER_STATES,
  buildFleet,
  countByState,
  formatAge,
} from "../../services/riderTracking";
import "./LiveTracking.css";

/**
 * Admin / Dispatcher › Live Tracking.
 *
 * One map of every rider who has an active delivery (assigned, loading, in
 * transit or delayed). Each marker shows ONE state: Route Deviating (decided by
 * the server), Fresh, Stale, Offline — or the rider is listed as Location
 * Unavailable when no position exists. Read-only: nothing here writes, and no
 * position is ever drawn that the rider app did not report.
 */

const METRO_MANILA = [14.5995, 120.9842];
const STATE_TONE = { deviating: "danger", fresh: "success", stale: "warning", offline: "neutral", unavailable: "neutral" };

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

/** The Leaflet canvas: one marker per rider with a position. */
function FleetMap({ riders, selectedUid, onSelect }) {
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
      m.on("click", () => onSelect(r.uid));
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

  return <div ref={containerRef} className="ltp-map" role="region" aria-label="Live rider map" />;
}

function RiderDetails({ rider, nowMs }) {
  if (!rider) {
    return <p className="ltp-muted">Select a rider on the map or in the list.</p>;
  }
  const age = formatAge(rider.locationAtMs, nowMs);
  return (
    <div className="ltp-details">
      <div className="ltp-details-head">
        <strong>{rider.name}</strong>
        <span className={`ltp-badge ltp-badge-${rider.state}`}>{MARKER_LABELS[rider.state]}</span>
      </div>
      {rider.phone && (
        <p className="ltp-row">
          <span>Phone</span>
          <a href={`tel:${rider.phone}`}>{rider.phone}</a>
        </p>
      )}
      <p className="ltp-row">
        <span>Last update</span>
        <strong className="tnum">{age || "—"}</strong>
      </p>
      {rider.latLng && (
        <p className="ltp-row">
          <span>Position</span>
          <span className="tnum">
            {rider.latLng[0].toFixed(5)}, {rider.latLng[1].toFixed(5)}
            {rider.accuracyMeters !== null && ` (±${Math.round(rider.accuracyMeters)} m)`}
          </span>
        </p>
      )}
      <p className="ltp-row">
        <span>Route monitoring</span>
        <strong>
          {rider.deviationText}
          {(rider.deviation === "deviating" || rider.deviation === "pending_deviation") &&
            rider.deviationDistanceMeters !== null &&
            ` · ${Math.round(rider.deviationDistanceMeters).toLocaleString()} m from route when this began`}
        </strong>
      </p>
      <div className="ltp-orders">
        <span>Active deliveries</span>
        <ul>
          {rider.orders.map((o) => (
            <li key={o.id}>
              <strong className="tnum">{o.orderNumber}</strong>
              {o.clinicName && ` · ${o.clinicName}`}
              <span className="ltp-muted"> · {o.status.replace(/_/g, " ")}</span>
              {o.id === rider.navigatingOrderId && <span className="ltp-nav-tag">Navigating</span>}
            </li>
          ))}
        </ul>
      </div>
      {rider.state === "unavailable" && (
        <p className="ltp-muted">
          No position yet. The rider app shares location once the rider allows it; nothing is shown until then.
        </p>
      )}
    </div>
  );
}

function LiveTrackingPanel() {
  const nowMs = useNow();
  const [orders, setOrders] = useState(null);
  const [locations, setLocations] = useState(null);
  const [deviations, setDeviations] = useState({});
  const [riders, setRiders] = useState({});
  const [error, setError] = useState(null);
  const [deviationError, setDeviationError] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selectedUid, setSelectedUid] = useState(null);

  useEffect(() => {
    const fail = (err) => setError(err?.code === "permission-denied" ? "permission" : "error");
    const unsubs = [
      subscribeDeliveries(setOrders, fail),
      subscribeAllRiderLocations(setLocations, fail),
      // Deviation state enriches markers; its failure must not blank the map.
      subscribeAllDeviationStates(
        (d) => {
          setDeviations(d);
          setDeviationError(false);
        },
        () => setDeviationError(true),
      ),
      subscribeRiders(
        (list) => setRiders(Object.fromEntries(list.map((r) => [r.uid, r]))),
        () => setRiders({}),
      ),
    ];
    return () => unsubs.forEach((u) => typeof u === "function" && u());
  }, []);

  const fleet = useMemo(
    () => (orders && locations ? buildFleet({ orders, locations, deviations, riders, nowMs }) : []),
    [orders, locations, deviations, riders, nowMs],
  );
  const counts = useMemo(() => countByState(fleet), [fleet]);
  const shown = filter === "all" ? fleet : fleet.filter((r) => r.state === filter);
  const selected = fleet.find((r) => r.uid === selectedUid) || null;

  if (error) {
    return (
      <div className="ltp-state ltp-state-error" role="alert">
        <strong>{error === "permission" ? "You do not have access to live tracking." : "Live tracking could not be loaded."}</strong>
        <p>
          {error === "permission"
            ? "Live rider locations are visible to Admin and Dispatcher accounts only."
            : "Check your connection and reload the page."}
        </p>
      </div>
    );
  }
  if (!orders || !locations) {
    return (
      <div className="ltp-state" role="status" aria-live="polite">
        <span className="rv-spinner" aria-hidden="true" />
        <span>Loading live tracking…</span>
      </div>
    );
  }

  return (
    <div className="ltp">
      <div className="ltp-kpis">
        <KpiCard label="Riders on delivery" value={fleet.length} context="With an active delivery" onClick={() => setFilter("all")} />
        {MARKER_STATES.map((s) => (
          <KpiCard
            key={s}
            label={MARKER_LABELS[s]}
            value={counts[s]}
            tone={STATE_TONE[s]}
            context={filter === s ? "Filtered" : "Show only"}
            attention={s === "deviating" && counts[s] > 0}
            onClick={() => setFilter(filter === s ? "all" : s)}
          />
        ))}
      </div>

      <p className="ltp-note">
        Riders appear only while they have an active delivery. Fresh: updated within 2 min · Stale: 2–10 min ·
        Offline: over 10 min or sharing stopped. Route deviation is decided by VaxTrack: more than{" "}
        {DEVIATION_RULES.offRouteMeters} m from the assigned route for {DEVIATION_RULES.confirmDeviationMs / 60000}{" "}
        minutes while the rider is navigating.
      </p>
      {deviationError && (
        <p className="ltp-warn" role="status">Route-deviation status could not be loaded; positions are still live.</p>
      )}

      {fleet.length === 0 ? (
        <div className="ltp-state">
          <strong>No rider has an active delivery right now.</strong>
          <p>Riders appear here once an order is assigned to them.</p>
        </div>
      ) : (
        <div className="ltp-grid">
          <section className="ltp-card ltp-map-card">
            <FleetMap riders={shown} selectedUid={selectedUid} onSelect={setSelectedUid} />
            {shown.every((r) => !r.latLng) && (
              <p className="ltp-muted ltp-map-empty">No rider in this view has reported a position yet.</p>
            )}
          </section>

          <aside className="ltp-side">
            <section className="ltp-card">
              <h2 className="ltp-h">Rider</h2>
              <RiderDetails rider={selected} nowMs={nowMs} />
            </section>
            <section className="ltp-card">
              <h2 className="ltp-h">
                {filter === "all" ? "All riders" : MARKER_LABELS[filter]} <span className="ltp-muted tnum">({shown.length})</span>
              </h2>
              {shown.length === 0 ? (
                <p className="ltp-muted">No rider in this state.</p>
              ) : (
                <ul className="ltp-list">
                  {shown.map((r) => (
                    <li key={r.uid}>
                      <button
                        type="button"
                        className={`ltp-list-item${r.uid === selectedUid ? " active" : ""}`}
                        onClick={() => setSelectedUid(r.uid)}
                        aria-pressed={r.uid === selectedUid}
                      >
                        <span className={`ltp-dot ltp-dot-${r.state}`} aria-hidden="true" />
                        <span className="ltp-list-name">{r.name}</span>
                        <span className="ltp-muted tnum">{formatAge(r.locationAtMs, nowMs) || MARKER_LABELS[r.state]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

export default LiveTrackingPanel;
