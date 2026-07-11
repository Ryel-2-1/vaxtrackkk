// Meridian shared status badge — the single badge implementation for all
// roles. Consumes the same normalized status keys the services already
// produce; purely presentational, no data logic.
import { normalizeStatusKey } from "../../services/deliveryService";
import "./ui.css";

const STATUS_META = {
  pending: { tone: "pending", label: "Pending" },
  pending_dispatch: { tone: "pending", label: "Pending Dispatch" },
  assigned: { tone: "assigned", label: "Assigned" },
  loading: { tone: "loading", label: "Loading" },
  in_transit: { tone: "transit", label: "In Transit" },
  delayed: { tone: "delayed", label: "Delayed" },
  delivered: { tone: "delivered", label: "Delivered" },
  completed: { tone: "delivered", label: "Delivered" },
  cancelled: { tone: "cancelled", label: "Cancelled" },
  canceled: { tone: "cancelled", label: "Cancelled" },
};

/**
 * @param {string} [statusKey] already-normalized status key (preferred)
 * @param {string} [status]    raw status value; normalized internally
 * @param {string} [label]     optional label override
 */
function StatusBadge({ statusKey, status, label }) {
  const key = normalizeStatusKey(statusKey ?? status ?? "");
  const meta = STATUS_META[key] || { tone: "pending", label: "Pending" };

  return (
    <span className={`m-badge m-badge-${meta.tone}`}>
      <span className="m-badge-dot" />
      {label || meta.label}
    </span>
  );
}

export default StatusBadge;
