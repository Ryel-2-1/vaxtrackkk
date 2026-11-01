import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { subscribeActiveAlerts } from "../../services/alertService";
import { logSafeError } from "../../services/liveDataErrors";
import "./AdminAlertsBell.css";

/**
 * The Admin top bar's alerts button: opens the Alerts page, with a badge
 * counting unread active system alerts. Delivery exceptions remain in the
 * Alerts page until their order status changes; they have no read flag.
 */
export default function AdminAlertsBell() {
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => subscribeActiveAlerts(
    (rows) => { setUnreadAlerts(rows.filter((alert) => alert.read !== true).length); setUnavailable(false); },
    (error) => { logSafeError("AdminAlertsBell alerts", error); setUnreadAlerts(0); setUnavailable(true); }
  ), []);

  const label = unavailable ? "Alerts unavailable" : unreadAlerts > 0
    ? `Alerts — ${unreadAlerts} unread system ${unreadAlerts === 1 ? "alert" : "alerts"}`
    : "Alerts — no unread system alerts";
  return (
    <Link to="/admin/alerts" className="m-topbar-icon-btn admin-alerts-bell" aria-label={label} title={label}>
      <Bell size={16} aria-hidden="true" />
      {unreadAlerts > 0 && <span className="admin-alerts-bell-badge tnum" aria-hidden="true">{unreadAlerts > 99 ? "99+" : unreadAlerts}</span>}
    </Link>
  );
}
