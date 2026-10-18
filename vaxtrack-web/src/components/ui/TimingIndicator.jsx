// Secondary delivery-timing indicator (services/deliveryTiming.js), shown
// next to — never instead of — the lifecycle StatusBadge. A Rider-reported
// hold gets its own chip, so it is never confused with automatic lateness.
import useMinuteClock from "../useMinuteClock";
import { deliveryTiming, HOLD_LABEL } from "../../services/deliveryTiming";
import "./ui.css";

/**
 * @param {object} order  order data with status/statusKey and timing fields
 * @param {boolean} [detail] also show the explanatory line
 */
function TimingIndicator({ order, detail = true }) {
  const now = useMinuteClock();
  const t = deliveryTiming(order, now);
  if (!t) return null;
  return (
    <span className={`m-timing m-timing-${t.tone}`} title={`${t.combinedLabel}. ${t.detail}`} aria-label={`${t.combinedLabel}. ${t.detail}`}>
      {t.onHold && <span className="m-timing-label m-timing-hold">{HOLD_LABEL}</span>}
      <span className="m-timing-label">{t.label}</span>
      {detail && <span className="m-timing-detail">{t.detail}</span>}
    </span>
  );
}

export default TimingIndicator;
