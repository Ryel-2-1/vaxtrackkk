import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { subscribeActiveAlerts } from "../../services/alertService";
import { logSafeError } from "../../services/liveDataErrors";
import { subscribePendingZeroRateRequests } from "../../services/zeroRateRequests";
import "./AdminAlertsBell.css";

/**
 * The Admin top bar's alerts button: opens the Alerts page, with a badge
 * counting unread active system alerts. Delivery exceptions remain in the
 * Alerts page until their order status changes; they have no read flag.
 */
export default function AdminAlertsBell() {
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [alertsUnavailable, setAlertsUnavailable] = useState(false);
  const [reviewsUnavailable, setReviewsUnavailable] = useState(false);
  const [priorityNotice, setPriorityNotice] = useState(0);
  const seenReviews = useRef(new Set());
  useEffect(() => subscribeActiveAlerts(
    (rows) => { setUnreadAlerts(rows.filter((alert) => alert.read !== true).length); setAlertsUnavailable(false); },
    (error) => { logSafeError("AdminAlertsBell alerts", error); setUnreadAlerts(0); setAlertsUnavailable(true); }
  ), []);
  useEffect(() => subscribePendingZeroRateRequests(
    (rows) => {
      const newRows = rows.filter((row) => !seenReviews.current.has(row.id));
      rows.forEach((row) => seenReviews.current.add(row.id));
      setPendingReviews(rows.length);
      setReviewsUnavailable(false);
      if (newRows.length > 0) setPriorityNotice(newRows.length);
    },
    (error) => { logSafeError("AdminAlertsBell zero-rating", error); setPendingReviews(0); setReviewsUnavailable(true); }
  ), []);

  const count = unreadAlerts + pendingReviews;
  const badge = alertsUnavailable || reviewsUnavailable ? "!" : count > 99 ? "99+" : count > 0 ? count : null;
  const label = alertsUnavailable || reviewsUnavailable ? "Go to Alerts. Some alerts are unavailable." : count > 0
    ? `Go to Alerts. ${unreadAlerts} unread system alerts, ${pendingReviews} zero-rating reviews pending.`
    : "Go to Alerts. No unread alerts or pending reviews.";
  return <>
    <Link to="/admin/alerts" className="m-topbar-icon-btn admin-alerts-bell" aria-label={label} title={label}>
      Go to Alerts
      {badge !== null && <span className={`admin-alerts-bell-badge tnum${badge === "!" ? " is-unavailable" : ""}`} aria-hidden="true">{badge}</span>}
    </Link>
    {priorityNotice > 0 && !reviewsUnavailable && <div className="admin-zero-rate-notice" role="status" aria-live="polite">
      <div><strong>Zero-rating review needed</strong><p>{priorityNotice} {priorityNotice === 1 ? "request needs" : "requests need"} an Admin decision before order placement.</p></div>
      <button type="button" className="admin-zero-rate-notice-close" aria-label="Dismiss zero-rating notice" onClick={() => setPriorityNotice(0)}><X size={16} /></button>
      <Link to="/admin/alerts" onClick={() => setPriorityNotice(0)}>Review requests</Link>
    </div>}
  </>;
}
