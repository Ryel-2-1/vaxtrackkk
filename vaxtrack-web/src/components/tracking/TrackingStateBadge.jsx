import { MARKER_LABELS } from "../../services/riderTracking";
import "./LiveTracking.css";

/**
 * One rider's location state (Fresh / Stale / Offline / Route Deviating /
 * Location Unavailable) as a badge. The state itself is computed once, by
 * services/riderTracking.js — this only shows it.
 */
function TrackingStateBadge({ state }) {
  return <span className={`ltp-badge ltp-badge-${state}`}>{MARKER_LABELS[state]}</span>;
}

export default TrackingStateBadge;
