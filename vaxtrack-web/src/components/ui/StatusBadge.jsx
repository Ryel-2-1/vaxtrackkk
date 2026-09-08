// Meridian shared status badge — the single badge implementation for all
// roles. Consumes the same normalized status keys the services already
// produce; purely presentational, no data logic.
import {
  normalizeStatusKey,
  UNKNOWN_STATUS_KEY,
  UNKNOWN_STATUS_LABEL,
} from "../../services/deliveryService";
import "./ui.css";

const STATUS_META = {
  pending: { tone: "pending", label: "Pending" },
  pending_dispatch: { tone: "pending", label: "Pending Dispatch" },
  assigned: { tone: "assigned", label: "Assigned" },
  loading: { tone: "loading", label: "Loading" },
  in_transit: { tone: "transit", label: "In Transit" },
  delayed: { tone: "delayed", label: "Delayed" },
  // Shares the danger tone with `delayed` — both mean "needs attention" — but
  // keeps its own label. Without this entry it fell through to the "Pending"
  // default, which read as though nothing had gone wrong.
  delivery_failed: { tone: "delayed", label: "Delivery Failed" },
  delivered: { tone: "delivered", label: "Delivered" },
  completed: { tone: "delivered", label: "Delivered" },
  cancelled: { tone: "cancelled", label: "Cancelled" },
  canceled: { tone: "cancelled", label: "Cancelled" },
  // An explicitly unknown status resolves exactly as an unrecognised one does.
  [UNKNOWN_STATUS_KEY]: { tone: "unknown", label: UNKNOWN_STATUS_LABEL },
};

/**
 * What an absent, malformed or unrecognised status renders as.
 *
 * This used to be `{ tone: "pending", label: "Pending" }`, which presented a
 * status nobody could account for as a normal early-lifecycle order: a document
 * with no status field, a typo, or any value the system does not define all
 * read "Pending", in a badge indistinguishable from a genuinely pending order.
 * Every call site inherited that. It now reads "Unknown" in a neutral style
 * that matches no real state.
 */
const UNKNOWN_META = { tone: "unknown", label: UNKNOWN_STATUS_LABEL };

/**
 * @param {string} [statusKey] already-normalized status key (preferred)
 * @param {string} [status]    raw status value; normalized internally
 * @param {string} [label]     optional label override
 */
function StatusBadge({ statusKey, status, label }) {
  const key = normalizeStatusKey(statusKey ?? status ?? "");
  const meta = STATUS_META[key] || UNKNOWN_META;

  // A caller's label override cannot resurrect a real-sounding state for a
  // status this component could not resolve: the words and the tone have to
  // agree. The visible text is also the accessible name, so they cannot differ.
  const text = meta === UNKNOWN_META ? UNKNOWN_STATUS_LABEL : label || meta.label;

  return (
    <span className={`m-badge m-badge-${meta.tone}`}>
      <span className="m-badge-dot" />
      {text}
    </span>
  );
}

export default StatusBadge;
