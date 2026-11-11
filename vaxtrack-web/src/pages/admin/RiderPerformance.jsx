import { useEffect, useMemo, useState } from "react";
import { Loader2, Trophy } from "lucide-react";
import KpiCard from "../../components/ui/KpiCard";
import PageNav, { PAGE_SIZE } from "../../components/ui/PageNav";
import { subscribeUsers } from "../../services/userService";
import { liveErrorMessage } from "../../services/liveDataErrors";
import { formatDuration, formatRate } from "../../services/deliveryMetrics";
import { DEFAULT_PERFORMANCE_RANGE, PERFORMANCE_RANGES } from "../../services/medRepPerformance";
import {
  EMPTY_RIDER_PERFORMANCE_MESSAGE,
  computeRiderPerformance,
  riderExclusionNote,
} from "../../services/riderPerformance";
import "./MedRepPerformance.css";

const manilaDate = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });

function formatManilaDay(ymd) {
  return ymd ? manilaDate.format(new Date(`${ymd}T12:00:00+08:00`)) : "";
}

/**
 * Admin → Analytics → Rider Performance. Read-only; the rider counterpart of
 * Med Rep Performance (same ranges, ranking and look). Reuses the orders
 * Analytics already subscribes to and adds one users subscription. All
 * counting is in services/riderPerformance.js.
 */
export default function RiderPerformance({ orders, ordersLoading, ordersError, nowMs }) {
  const [rangeKey, setRangeKey] = useState(DEFAULT_PERFORMANCE_RANGE);
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");

  useEffect(() => subscribeUsers(
    (docs) => { setUsers(docs); setUsersLoading(false); setUsersError(""); },
    (error) => { setUsersError(liveErrorMessage(error, "rider accounts")); setUsersLoading(false); }
  ), []);

  const loading = ordersLoading || usersLoading || nowMs == null;
  const error = ordersError || usersError;
  const result = useMemo(
    () => (loading || error ? null : computeRiderPerformance({ orders, users, nowMs, rangeKey })),
    [loading, error, orders, users, nowMs, rangeKey]
  );

  const rangeText = result
    ? result.range.startDate
      ? `${result.range.label} · ${formatManilaDay(result.range.startDate)} – ${formatManilaDay(result.range.endDate)} (Asia/Manila)`
      : `${result.range.label} · through ${formatManilaDay(result.range.endDate)} (Asia/Manila)`
    : "";
  const note = result ? riderExclusionNote(result.exclusions) : "";
  const rows = result?.rows ?? [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="analytics-card mrp-card" aria-labelledby="rp-title">
      <div className="mrp-head">
        <div>
          <h2 id="rp-title">Rider Performance</h2>
          <p className="mrp-sub">
            Ranked by delivered orders, counted on the day each delivery was completed.
          </p>
        </div>
        <div className="mrp-ranges" role="group" aria-label="Rider performance date range">
          {PERFORMANCE_RANGES.map((range) => (
            <button
              key={range.key}
              type="button"
              className={range.key === rangeKey ? "active" : ""}
              aria-pressed={range.key === rangeKey}
              onClick={() => { setRangeKey(range.key); setPage(1); }}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="mrp-state" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> Loading rider performance…
        </p>
      ) : error ? (
        <p className="mrp-state mrp-error" role="alert">{error}</p>
      ) : (
        <>
          <p className="mrp-range" aria-live="polite">{rangeText}</p>

          <div className="mrp-kpis">
            <KpiCard
              label="Leading rider"
              value={result.leader ? result.leader.names.join(", ") : "—"}
              context={
                result.leader
                  ? `${result.leader.names.length > 1 ? "Tied · " : ""}${result.leader.delivered} delivered`
                  : "No completed deliveries in this period"
              }
              tone={result.leader ? "success" : "neutral"}
            />
            <KpiCard label="Delivered orders" value={result.totals.delivered} context={result.range.label} tone="success" />
            <KpiCard
              label="On time"
              value={formatRate(result.totals.onTimeRate)}
              context={result.totals.onTimeMeasured
                ? `Delivered by the requested date · ${result.totals.onTimeMeasured} measured`
                : "No deliveries with a requested date"}
              tone={result.totals.onTimeRate == null ? "neutral" : result.totals.onTimeRate >= 0.9 ? "success" : "warning"}
            />
          </div>

          {result.totals.delivered === 0 && <p className="mrp-empty">{EMPTY_RIDER_PERFORMANCE_MESSAGE}</p>}

          {rows.length > 0 && (
            <div className="mrp-table-wrap">
              <table className="mrp-table">
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Rider</th>
                    <th scope="col" className="num">Delivered orders</th>
                    <th scope="col" className="num">Delivered vials</th>
                    <th scope="col" className="num">On time</th>
                    <th scope="col" className="num">Avg. delivery time</th>
                    <th scope="col">Last delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.uid}>
                      <td className="num">
                        {row.rank === 1 && row.delivered > 0 ? (
                          <span className="mrp-rank-top">
                            <Trophy size={13} aria-hidden="true" /> {row.rank}
                          </span>
                        ) : (
                          row.rank
                        )}
                      </td>
                      <td>
                        <strong>{row.name}</strong>
                        {row.accountStatus === "inactive" && <span className="mrp-badge">Inactive</span>}
                      </td>
                      <td className="num">{row.delivered}</td>
                      <td className="num">{row.vials}</td>
                      <td className="num" title={row.onTimeMeasured ? `${row.onTime} of ${row.onTimeMeasured} by the requested date` : undefined}>
                        {formatRate(row.onTimeRate)}
                      </td>
                      <td className="num">{formatDuration(row.averageMinutes)}</td>
                      <td>{row.lastDeliveredMs == null ? "—" : manilaDate.format(new Date(row.lastDeliveredMs))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <PageNav page={currentPage} total={rows.length} onPageChange={setPage} label="Rider performance pages" />
          )}

          {note && <p className="mrp-note">{note}</p>}
        </>
      )}
    </section>
  );
}
