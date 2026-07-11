// Meridian shared KPI / summary card. Quiet white card: label, tabular
// number, one context line with a semantic dot. Renders as a <button>
// when onClick is provided (e.g. summary cards that set a filter).
import "./ui.css";

const DOT_COLOR = {
  neutral: "var(--gray-300)",
  success: "var(--success-text)",
  info: "var(--info-text)",
  warning: "var(--warning-text)",
  danger: "var(--danger-text)",
};

/**
 * @param {string}  label      sentence-case metric label
 * @param {*}       value      the number/text (rendered with tabular figures)
 * @param {string}  [context]  small line under the value
 * @param {string}  [tone]     neutral | success | info | warning | danger (context dot)
 * @param {boolean} [attention] red top rule + red value, for delayed/critical
 * @param {func}    [onClick]  renders the card as a button
 */
function KpiCard({ label, value, context, tone = "neutral", attention = false, onClick }) {
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`m-kpi${attention ? " m-kpi-attention" : ""}`}
    >
      <span className="m-kpi-label">{label}</span>
      <span className={`m-kpi-value${attention ? " m-kpi-value-danger" : ""}`}>
        {value}
      </span>
      {context ? (
        <span className="m-kpi-context">
          <span
            className="m-kpi-dot"
            style={{ background: DOT_COLOR[tone] || DOT_COLOR.neutral }}
          />
          {context}
        </span>
      ) : null}
    </Tag>
  );
}

export default KpiCard;
