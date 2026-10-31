import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { subscribeActiveAlerts } from "../../services/alertService";
import { subscribeDeliveryExceptions } from "../../services/deliveryService";
import { logSafeError } from "../../services/liveDataErrors";
import "./AdminAlertsBell.css";

/**
 * The Admin top bar's alerts button: opens the Alerts page, with a badge
 * counting what needs review there — active system alerts plus delivery
 * exceptions (delayed or failed orders). Two narrow listeners; a source that
 * fails simply stops counting (the Alerts page itself reports the failure).
 */
export default function AdminAlertsBell() {
  const [activeAlerts, setActiveAlerts] = useState(0);
  const [exceptions, setExceptions] = useState(0);
  useEffect(() => subscribeActiveAlerts(
    (rows) => setActiveAlerts(rows.length),
    (error) => { logSafeError("AdminAlertsBell alerts", error); setActiveAlerts(0); }
  ), []);
  useEffect(() => subscribeDeliveryExceptions(
    (rows) => setExceptions(rows.length),
    (error) => { logSafeError("AdminAlertsBell exceptions", error); setExceptions(0); }
  ), []);

  const count = activeAlerts + exceptions;
  const label = count > 0 ? `Alerts — ${count} need${count === 1 ? "s" : ""} review` : "Alerts — nothing needs review";
  return (
    <Link to="/admin/alerts" className="m-topbar-icon-btn admin-alerts-bell" aria-label={label} title={label}>
      <Bell size={16} aria-hidden="true" />
      {count > 0 && <span className="admin-alerts-bell-badge tnum" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
    </Link>
  );
}
