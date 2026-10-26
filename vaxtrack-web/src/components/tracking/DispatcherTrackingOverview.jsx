import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Clock3, MapPinOff, Navigation, ShieldCheck, Users } from "lucide-react";
import FleetMap from "./FleetMap";
import TrackingStateBadge from "./TrackingStateBadge";
import useRiderTrackingFeeds from "./useRiderTrackingFeeds";
import { useNow } from "../useRiderLiveLocation";
import { buildFleet, trackingOverviewRows, trackingOverviewState } from "../../services/riderTracking";
import "./DispatcherTrackingOverview.css";

export const LIVE_TRACKING_ROUTE = "/dispatcher/live-tracking";

/**
 * Dispatcher dashboard › "Active delivery overview".
 *
 * A compact live-tracking preview: a small map of riders on delivery, the
 * first riders with their state badge, and a link to the full Live Tracking
 * page. Every state (Fresh / Stale / Offline / Route Deviating / Location
 * Unavailable) and every threshold comes from services/riderTracking.js — the
 * same rules as Live Tracking. Locations come from the same authorized
 * subscriptions (useRiderTrackingFeeds); orders and riders are the
 * dashboard's own subscriptions, passed in. Read-only: nothing here writes.
 *
 * Counts in the header and footer are the dashboard's real order and rider
 * figures, passed in as props.
 */
function DispatcherTrackingOverview({
  orders,
  riders,
  activeCount,
  delayedCount,
  pendingCount,
  availableCount,
}) {
  const nowMs = useNow();
  const { locations, deviations, tripStates, error, deviationError, retry } = useRiderTrackingFeeds();
  const ridersById = useMemo(() => Object.fromEntries((riders || []).map((r) => [r.uid, r])), [riders]);

  const fleet = useMemo(
    () => (orders && locations ? buildFleet({ orders, locations, deviations, riders: ridersById, tripStates, nowMs }) : []),
    [orders, locations, deviations, ridersById, tripStates, nowMs],
  );
  const view = trackingOverviewState({ error, orders, locations, fleet });
  const { rows, moreLabel } = trackingOverviewRows(fleet, nowMs);
  const mapRiders = useMemo(() => fleet.filter((r) => r.latLng), [fleet]);

  return (
    <div className="dispatcher-dash-monitor-card dto">
      <div className="dispatcher-dash-card-head">
        <div>
          <span className="card-kicker">Delivery monitoring</span>
          <h2>Active delivery overview</h2>
        </div>
        <div className="dispatcher-dash-badges">
          <span className="green tnum">{activeCount} active</span>
          {delayedCount > 0 && <span className="red tnum">{delayedCount} delayed</span>}
        </div>
      </div>

      <div className="dto-body">
        {view === "loading" && (
          <p className="dto-state" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            Loading live locations…
          </p>
        )}

        {view === "permission" && (
          <div className="dto-state dto-state-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <p>You do not have permission to view live Rider locations.</p>
          </div>
        )}

        {view === "error" && (
          <div className="dto-state dto-state-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <p>Live Rider locations could not be loaded.</p>
            <button type="button" className="dto-retry" onClick={retry}>
              Try again
            </button>
          </div>
        )}

        {view === "empty" && (
          <div className="dto-state">
            <p>No riders are currently on delivery or returning to the hub.</p>
            <Link className="dto-open" to={LIVE_TRACKING_ROUTE}>
              <Navigation size={15} aria-hidden="true" />
              Open Live Tracking
            </Link>
          </div>
        )}

        {(view === "waiting" || view === "live") && (
          <div className="dto-grid">
            <div className="dto-map-col">
              {view === "live" ? (
                <FleetMap riders={mapRiders} className="dto-map" />
              ) : (
                <div className="dto-waiting" role="status">
                  <MapPinOff size={18} aria-hidden="true" />
                  <strong>Waiting for Rider location updates.</strong>
                  <p>Riders appear on the map once their app is sharing location. The Rider must keep location sharing active during the delivery.</p>
                </div>
              )}
            </div>

            <div className="dto-list-col">
              <h3 className="dto-h">Riders on delivery or returning</h3>
              <ul className="dto-list">
                {rows.map((r) => (
                  <li key={r.uid} className="dto-row">
                    <div className="dto-row-main">
                      <span className="dto-name" title={r.name}>{r.name}</span>
                      <TrackingStateBadge state={r.state} />
                    </div>
                    <div className="dto-row-meta">
                      <span className="tnum">{r.deliveryLabel}</span>
                      {r.orderNumbers && (
                        <span className="dto-orders tnum" title={r.orderNumbers}>{r.orderNumbers}</span>
                      )}
                      <span className="dto-age tnum">{r.age ? `Updated ${r.age}` : "No update yet"}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {moreLabel && <p className="dto-more tnum">{moreLabel}</p>}
              {deviationError && (
                <p className="dto-note" role="status">Route-deviation status is unavailable; positions are still live.</p>
              )}
              <Link className="dto-open" to={LIVE_TRACKING_ROUTE}>
                <Navigation size={15} aria-hidden="true" />
                Open Live Tracking
              </Link>
            </div>
          </div>
        )}
      </div>

      <dl className="dto-summary">
        <div className="dto-cell">
          <Clock3 size={15} aria-hidden="true" />
          <dt>Pending orders</dt>
          <dd className="tnum">{pendingCount} waiting for dispatch</dd>
        </div>
        <div className="dto-cell">
          <Users size={15} aria-hidden="true" />
          <dt>Riders available</dt>
          <dd className="tnum" title="Approved riders not currently on a delivery">
            {availableCount} free to assign
          </dd>
        </div>
        <div className="dto-cell">
          <ShieldCheck size={15} aria-hidden="true" />
          <dt>Delayed deliveries</dt>
          <dd className={`tnum${delayedCount > 0 ? " dto-dd-danger" : ""}`}>{delayedCount} delayed</dd>
        </div>
      </dl>
    </div>
  );
}

export default DispatcherTrackingOverview;
