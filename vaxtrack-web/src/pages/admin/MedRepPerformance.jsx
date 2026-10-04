import { useEffect, useMemo, useState } from "react";
import { Loader2, Trophy } from "lucide-react";
import KpiCard from "../../components/ui/KpiCard";
import { subscribeUsers } from "../../services/userService";
import { subscribeAreas } from "../../services/areaService";
import {
  DEFAULT_PERFORMANCE_RANGE,
  EMPTY_PERFORMANCE_MESSAGE,
  PERFORMANCE_RANGES,
  computeMedRepPerformance,
  exclusionNote,
} from "../../services/medRepPerformance";
import "./MedRepPerformance.css";

const manilaDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** 'YYYY-MM-DD' (a Manila calendar day) → "Oct 4, 2026". */
function formatManilaDay(ymd) {
  return ymd ? manilaDate.format(new Date(`${ymd}T12:00:00+08:00`)) : "";
}

/**
 * Admin → Analytics → Med Rep Performance. Read-only.
 *
 * Reuses the orders Analytics already subscribes to (passed in), and adds ONE
 * users subscription and ONE areas subscription for the whole table — never a
 * listener per Med Rep. All counting is in services/medRepPerformance.js.
 */
export default function MedRepPerformance({ orders, ordersLoading, ordersError, nowMs }) {
  const [rangeKey, setRangeKey] = useState(DEFAULT_PERFORMANCE_RANGE);
  const [users, setUsers] = useState([]);
  const [areas, setAreas] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");

  useEffect(() => {
    const unsubUsers = subscribeUsers(
      (docs) => {
        setUsers(docs);
        setUsersLoading(false);
      },
      (error) => {
        setUsersError(error?.message || "Med Rep accounts could not be loaded.");
        setUsersLoading(false);
      }
    );
    // Area names for the territory column; a failure only drops the names.
    const unsubAreas = subscribeAreas((docs) => setAreas(docs), () => setAreas([]));
    return () => {
      unsubUsers();
      unsubAreas();
    };
  }, []);

  const loading = ordersLoading || usersLoading || nowMs == null;
  const error = ordersError || usersError;

  const result = useMemo(
    () => (loading || error ? null : computeMedRepPerformance({ orders, users, nowMs, rangeKey })),
    [loading, error, orders, users, nowMs, rangeKey]
  );
  const areaName = useMemo(() => new Map(areas.map((a) => [a.id, a.name || a.id])), [areas]);

  const territoryLabel = (territory) => {
    if (!territory.assigned) return "Not assigned";
    const names = territory.areaIds.map((id) => areaName.get(id) || "Unknown area");
    const clinics = territory.clinicIds.length;
    return `${names.join(", ")} · ${clinics} clinic${clinics === 1 ? "" : "s"}`;
  };

  const rangeText = result
    ? result.range.startDate
      ? `${result.range.label} · ${formatManilaDay(result.range.startDate)} – ${formatManilaDay(result.range.endDate)} (Asia/Manila)`
      : `${result.range.label} · through ${formatManilaDay(result.range.endDate)} (Asia/Manila)`
    : "";
  const note = result ? exclusionNote(result.exclusions) : "";

  return (
    <section className="analytics-card mrp-card" aria-labelledby="mrp-title">
      <div className="mrp-head">
        <div>
          <h2 id="mrp-title">Med Rep Performance</h2>
          <p className="mrp-sub">
            Ranked by delivered orders, counted on the day each delivery was completed.
          </p>
        </div>
        <div className="mrp-ranges" role="group" aria-label="Performance date range">
          {PERFORMANCE_RANGES.map((range) => (
            <button
              key={range.key}
              type="button"
              className={range.key === rangeKey ? "active" : ""}
              aria-pressed={range.key === rangeKey}
              onClick={() => setRangeKey(range.key)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="mrp-state" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> Loading Med Rep performance…
        </p>
      ) : error ? (
        <p className="mrp-state mrp-error" role="alert">
          Med Rep performance could not be loaded: {error}
        </p>
      ) : (
        <>
          <p className="mrp-range" aria-live="polite">{rangeText}</p>

          <div className="mrp-kpis">
            <KpiCard
              label="Leading Med Rep"
              value={result.leader ? result.leader.names.join(", ") : "—"}
              context={
                result.leader
                  ? `${result.leader.names.length > 1 ? "Tied · " : ""}${result.leader.delivered} delivered`
                  : "No completed deliveries in this period"
              }
              tone={result.leader ? "success" : "neutral"}
            />
            <KpiCard label="Delivered orders" value={result.totals.delivered} context={result.range.label} tone="success" />
            <KpiCard label="Delivered vials" value={result.totals.vials} context="From the same delivered orders" tone="success" />
          </div>

          {result.totals.delivered === 0 && <p className="mrp-empty">{EMPTY_PERFORMANCE_MESSAGE}</p>}

          {result.rows.length > 0 && (
            <div className="mrp-table-wrap">
              <table className="mrp-table">
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Med Rep</th>
                    <th scope="col">Territory</th>
                    <th scope="col" className="num">Delivered orders</th>
                    <th scope="col" className="num">Delivered vials</th>
                    <th scope="col">Last delivery</th>
                    <th scope="col" className="num">Orders placed</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
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
                      <td className="mrp-muted">{territoryLabel(row.territory)}</td>
                      <td className="num">{row.delivered}</td>
                      <td className="num">{row.vials}</td>
                      <td>{row.lastDeliveredMs == null ? "—" : manilaDate.format(new Date(row.lastDeliveredMs))}</td>
                      <td className="num">{row.ordersPlaced}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {note && <p className="mrp-note">{note}</p>}
        </>
      )}
    </section>
  );
}
