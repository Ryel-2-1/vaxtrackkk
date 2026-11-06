import { forecastAdvice } from "../../services/inventoryAnalytics";

/**
 * One answer per vaccine: is it OK, and what should the Admin do? Everything
 * else about a forecast lives in its details panel.
 */
export default function ForecastList({ rows, selectedId, onSelect, emptyText }) {
  return (
    <div className="aia-table-wrap">
      <table className="aia-table aia-main-table">
        <thead>
          <tr>
            <th>Vaccine</th>
            <th>Status</th>
            <th className="aia-num">In stock</th>
            <th className="aia-num">Expected need</th>
            <th>What to do</th>
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const advice = forecastAdvice(r);
            return (
              <tr key={r.vaccineId} className={selectedId === r.vaccineId ? "aia-selected" : ""}>
                <td className="aia-name">
                  <span className={r.nameMissing ? "aia-missing" : ""}>{r.name}</span>
                  <small className={`aia-sku${r.skuMissing ? " aia-missing" : ""}`}>{r.sku}</small>
                </td>
                <td data-label="Status">
                  <span className={`aia-risk aia-risk--${advice.tone}`}>{advice.status}</span>
                </td>
                <td className="aia-num" data-label="In stock">{r.available}</td>
                <td className="aia-num" data-label="Expected need">{r.insufficient ? "—" : r.predicted}</td>
                <td className="aia-advice" data-label="What to do">
                  <strong>{advice.action}</strong>
                  {advice.why && <small>{advice.why}</small>}
                </td>
                <td className="aia-row-action">
                  <button
                    type="button"
                    className="aia-row-btn"
                    aria-label={`${advice.button}: ${r.name}`}
                    onClick={() => onSelect(r.vaccineId)}
                  >
                    {advice.button}
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="aia-no-match">{emptyText}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
