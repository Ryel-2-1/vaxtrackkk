import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import KpiCard from "../ui/KpiCard";
import { useNow } from "../useRiderLiveLocation";
import FleetMap from "./FleetMap";
import TrackingStateBadge from "./TrackingStateBadge";
import useRiderTrackingFeeds from "./useRiderTrackingFeeds";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiders } from "../../services/riderService";
import {
  DEVIATION_RULES,
  FRESHNESS,
  MARKER_LABELS,
  MARKER_STATES,
  RETURNING_TO_HUB_LABEL,
  buildFleet,
  countByState,
  fleetCounts,
  formatAge,
} from "../../services/riderTracking";
import "./LiveTracking.css";

/**
 * Admin / Dispatcher › Live Tracking.
 *
 * One map of every rider who has an active delivery (assigned, loading, in
 * transit or delayed), and every rider the server says is returning to the
 * hub after their trip (until a Dispatcher confirms the return — arrival is
 * never inferred from a position or a missing one). Each marker shows ONE state: Route Deviating (decided by
 * the server), Fresh, Stale, Offline — or the rider is listed as Location
 * Unavailable when no position exists. Read-only: nothing here writes, and no
 * position is ever drawn that the rider app did not report.
 */

const STATE_TONE = { deviating: "danger", fresh: "success", stale: "warning", offline: "neutral", unavailable: "neutral" };

// What the states mean — shown on hover over the summary cards.
const TRACKING_LEGEND =
  "Riders appear while they have an active delivery, and while returning to the hub until a Dispatcher confirms " +
  `their return. Fresh: updated within ${FRESHNESS.freshMs / 60000} min · ` +
  `Stale: ${FRESHNESS.freshMs / 60000}–${FRESHNESS.offlineMs / 60000} min · ` +
  `Offline: over ${FRESHNESS.offlineMs / 60000} min or sharing stopped. ` +
  `Route deviation: more than ${DEVIATION_RULES.offRouteMeters} m from the assigned route for ` +
  `${DEVIATION_RULES.confirmDeviationMs / 60000} minutes while the rider is navigating.`;

function RiderDetails({ rider, nowMs }) {
  if (!rider) {
    return <p className="ltp-muted">Select a rider on the map or in the list.</p>;
  }
  const age = formatAge(rider.locationAtMs, nowMs);
  return (
    <div className="ltp-details">
      <div className="ltp-details-head">
        <strong>{rider.name}</strong>
        <TrackingStateBadge state={rider.state} />
      </div>
      {rider.phone && (
        <p className="ltp-row">
          <span>Phone</span>
          <a href={`tel:${rider.phone}`}>{rider.phone}</a>
        </p>
      )}
      {rider.returningToHub && (
        <p className="ltp-row">
          <span>Trip</span>
          <strong>{RETURNING_TO_HUB_LABEL}</strong>
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
        {rider.returningToHub ? (
          <p className="ltp-muted">
            None — every order on the trip is finished. The rider stays listed as returning until a Dispatcher
            confirms their return in Cargo Loading; their position is not used to decide that they arrived.
          </p>
        ) : (
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
        )}
      </div>
      {rider.state === "unavailable" && (
        <p className="ltp-muted">
          No position yet. The rider app shares location once the rider allows it; nothing is shown until then.
        </p>
      )}
      {rider.returningToHub && (rider.state === "offline" || rider.state === "stale" || rider.state === "unavailable") && (
        <p className="ltp-muted">
          A missing or old position does not mean the rider has arrived. They stay returning until their return is
          confirmed in Cargo Loading.
        </p>
      )}
    </div>
  );
}

function LiveTrackingPanel() {
  const nowMs = useNow();
  const [orders, setOrders] = useState(null);
  const [riders, setRiders] = useState({});
  const [ordersError, setOrdersError] = useState(null);
  const [filter, setFilter] = useState("all");
  // A stale-location alert links here as ?rider=<uid>: that Rider starts
  // selected. Only an id-shaped value is accepted; nothing is rendered from it.
  const [searchParams] = useSearchParams();
  const [selectedUid, setSelectedUid] = useState(() => {
    const linked = searchParams.get("rider");
    return typeof linked === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(linked) ? linked : null;
  });
  // Rider locations + server deviation state (shared with the dashboard overview).
  const {
    locations,
    deviations,
    tripStates,
    error: feedError,
    deviationError,
    tripStatesError,
    retry: retryFeeds,
  } = useRiderTrackingFeeds();
  const error = ordersError || feedError;
  // Bumped by "Try again": a failed listener is closed for good, so retrying
  // opens a new one (exactly one — the effect's cleanup closes the old).
  const [ordersAttempt, setOrdersAttempt] = useState(0);
  const retryTracking = () => {
    if (ordersError) {
      setOrdersError(null);
      setOrders(null);
      setOrdersAttempt((n) => n + 1);
    }
    if (feedError) retryFeeds();
  };

  useEffect(() => {
    const unsubs = [
      subscribeDeliveries(
        (list) => {
          setOrders(list);
          setOrdersError(null); // a recovered listener clears its failure
        },
        (err) => setOrdersError(err?.code === "permission-denied" ? "permission" : "error")
      ),
      subscribeRiders(
        (list) => setRiders(Object.fromEntries(list.map((r) => [r.uid, r]))),
        () => setRiders({}),
      ),
    ];
    return () => unsubs.forEach((u) => typeof u === "function" && u());
  }, [ordersAttempt]);

  const fleet = useMemo(
    () => (orders && locations ? buildFleet({ orders, locations, deviations, riders, tripStates, nowMs }) : []),
    [orders, locations, deviations, riders, tripStates, nowMs],
  );
  const counts = useMemo(() => countByState(fleet), [fleet]);
  const { onDelivery, returning } = useMemo(() => fleetCounts(fleet), [fleet]);
  const shown =
    filter === "all" ? fleet : filter === "returning" ? fleet.filter((r) => r.returningToHub) : fleet.filter((r) => r.state === filter);
  const selected = fleet.find((r) => r.uid === selectedUid) || null;

  if (error) {
    return (
      <div className="ltp-state ltp-state-error" role="alert">
        <strong>{error === "permission" ? "You do not have access to live tracking." : "Live tracking could not be loaded."}</strong>
        <p>
          {error === "permission"
            ? "Live rider locations are visible to Admin and Dispatcher accounts only."
            : "Check your connection, then try again."}
        </p>
        {error !== "permission" && (
          <button type="button" className="ltp-retry" onClick={retryTracking}>
            Try again
          </button>
        )}
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
      {/* The explanatory line under these cards was removed (2026-10-31) to
          give the map the height; its definitions stay one hover away. */}
      <div className="ltp-kpis" title={TRACKING_LEGEND}>
        <KpiCard label="Riders on delivery" value={onDelivery} context="With an active delivery" onClick={() => setFilter("all")} />
        <KpiCard
          label={RETURNING_TO_HUB_LABEL}
          value={returning}
          context={filter === "returning" ? "Filtered" : "Return not confirmed yet"}
          onClick={() => setFilter(filter === "returning" ? "all" : "returning")}
        />
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

      {deviationError && (
        <p className="ltp-warn" role="status">Route-deviation status could not be loaded; positions are still live.</p>
      )}
      {tripStatesError && (
        <p className="ltp-warn" role="status">
          Trip status could not be loaded, so riders returning to the hub may be missing; riders on delivery are still live.
        </p>
      )}

      {fleet.length === 0 ? (
        <div className="ltp-state">
          <strong>No rider has an active delivery or is returning to the hub right now.</strong>
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
                {filter === "all" ? "All riders" : filter === "returning" ? RETURNING_TO_HUB_LABEL : MARKER_LABELS[filter]}{" "}
                <span className="ltp-muted tnum">({shown.length})</span>
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
                        {r.returningToHub && <span className="ltp-trip-tag">{RETURNING_TO_HUB_LABEL}</span>}
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
