// Secondary delivery-timing indicator (services/deliveryTiming.js), shown
// next to — never instead of — the lifecycle StatusBadge. A Rider-reported
// hold gets its own chip, so it is never confused with automatic lateness.
import useMinuteClock from "../useMinuteClock";
import { deliveryTiming, requestedArrivalMiss, HOLD_LABEL } from "../../services/deliveryTiming";
import "./ui.css";

/**
 * @param {object} order  order data with status/statusKey and timing fields
 * @param {boolean|"primary"} [detail] also show the explanatory line; "primary"
 *   keeps one line for tight table cells, and the rest stays in the tooltip
 */
function TimingIndicator({ order, detail = true }) {
  const now = useMinuteClock();
  const t = deliveryTiming(order, now);
  const miss = requestedArrivalMiss(order);
  if (!t && !miss) return null;
  // Past what was requested, "On time" (against the route) would only contradict it.
  const showTiming = t && !(miss && t.status === "on_time");
  const tone = miss ? "late" : t.tone;
  const summary = [t ? `${t.combinedLabel}. ${t.detail}` : null, miss ? `${miss.label}. ${miss.detail}` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={`m-timing m-timing-${tone}`} title={summary} aria-label={summary}>
      {t?.onHold && <span className="m-timing-label m-timing-hold">{HOLD_LABEL}</span>}
      {miss && <span className="m-timing-label">{miss.label}</span>}
      {showTiming && <span className="m-timing-label">{t.label}</span>}
      {detail && miss && <span className="m-timing-detail">{miss.detail}</span>}
      {detail && t && !(detail === "primary" && miss) && <span className="m-timing-detail">{t.detail}</span>}
    </span>
  );
}

export default TimingIndicator;
