// Shared summary card with optional action and contextual help.
import { useId } from "react";
import "./ui.css";
import InfoHint from "./InfoHint";

/**
 * @param {string}  label      sentence-case metric label
 * @param {*}       value      the number/text (rendered with tabular figures)
 * @param {string}  [context]  explanation shown through the information icon
 * @param {string}  [tone]     neutral | success | info | warning | danger
 * @param {boolean} [attention] red top rule + red value, for delayed/critical
 * @param {func}    [onClick]  activates the card independently of its help icon
 * @param {boolean} [active]   the card is the selected filter tab (a clickable
 *                             card only): green tint + border, aria-pressed
 */
function KpiCard({ label, value, context, tone = "neutral", attention = false, onClick, active }) {
  const id = useId();
  return (
    <div
      data-tone={tone}
      className={`m-kpi${onClick ? " m-kpi-clickable" : ""}${attention ? " m-kpi-attention" : ""}${active ? " m-kpi-active" : ""}`}
    >
      {onClick && (
        <button
          type="button"
          className="m-kpi-target"
          onClick={onClick}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-pressed={active !== undefined ? Boolean(active) : undefined}
        />
      )}
      <span className="m-kpi-label">
        <span id={`${id}-label`}>{label}</span>
        {context && <InfoHint label={`About ${label}`}>{context}</InfoHint>}
      </span>
      <span id={`${id}-value`} className={`m-kpi-value${attention ? " m-kpi-value-danger" : ""}`}>
        {value}
      </span>
    </div>
  );
}

export default KpiCard;
