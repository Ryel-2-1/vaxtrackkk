import "./Analytics.css";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Building2,
  Lightbulb,
  MoreVertical,
  X,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeAllAlerts } from "../../services/alertService";
import KpiCard from "../../components/ui/KpiCard";

const MS_PER_DAY = 86400000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_PERIODS = ["Morning", "Afternoon", "Evening"];

const RANGE_LABELS = { "7": "Last 7 Days", "30": "Last 30 Days", "90": "Last 90 Days" };

function getOrderMs(order) {
  return order.createdAt?.toMillis?.() ?? 0;
}

// Milliseconds from a value in any timestamp shape used in the project:
// a Firestore Timestamp (.toMillis / .toDate), a Date, or an epoch-ms number.
// Returns null when the value is missing or unrecognized (never NaN).
function timestampMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

// Average LATEST-TRANSIT-SEGMENT duration in minutes over the given orders:
// startedAt -> deliveredAt.
//
// `startedAt` is not the original dispatch. Every transition into in_transit
// stamps it, and `resumeTransit` fires that transition again when a delayed
// order goes back on the road — so on a resumed delivery this measures the
// final leg only, with the earlier transit and the delay excluded. That is a
// real, server-stamped segment; it is simply not the whole journey, and the
// metric is labelled accordingly. Recording total elapsed time would need a
// first-dispatch timestamp the schema does not keep.
//
// Counts ONLY completed deliveries where both timestamps are valid and
// delivery happened strictly after that transit start (end > start). Returns
// null when no such order exists, so the UI can show an honest empty state.
function computeAvgDeliveryMinutes(orders) {
  let sum = 0;
  let count = 0;
  for (const order of orders) {
    const isDelivered =
      order.statusKey === "delivered" || order.statusKey === "completed";
    if (!isDelivered) continue;
    const start = timestampMs(order.startedAt);
    const end = timestampMs(order.deliveredAt);
    if (start == null || end == null || end <= start) continue;
    sum += end - start;
    count++;
  }
  if (count === 0) return null;
  return sum / count / 60000;
}

// "42 min" below an hour; "1h 25m" at an hour or more; "—" when unavailable.
function formatAvgDelivery(minutes) {
  if (minutes == null) return "—";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

// `now` is passed in rather than read here. Every range on this page — the
// filter cutoff and these buckets — is then measured from one instant, so the
// chart and the filter cannot disagree about when "now" was.
function computeVolumeBuckets(orders, days, now) {
  if (days <= 7) {
    const buckets = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * MS_PER_DAY);
      buckets.push({ label: DAY_NAMES[d.getDay()], count: 0, dayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() });
    }
    orders.forEach((o) => {
      const ms = getOrderMs(o);
      if (!ms) return;
      for (let i = 0; i < buckets.length; i++) {
        const next = i < buckets.length - 1 ? buckets[i + 1].dayStart : buckets[i].dayStart + MS_PER_DAY;
        if (ms >= buckets[i].dayStart && ms < next) { buckets[i].count++; break; }
      }
    });
    return buckets.map((b) => ({ label: b.label, adjustedValue: b.count }));
  }

  const bucketCount = 5;
  const cutoff = now - days * MS_PER_DAY;
  const span = days * MS_PER_DAY;
  const bucketSize = span / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(cutoff + i * bucketSize);
    const label = days <= 30 ? `${d.getDate()}${ordSuffix(d.getDate())}` : `Week ${i * 2 + 1}`;
    return { label, count: 0 };
  });
  orders.forEach((o) => {
    const ms = getOrderMs(o);
    if (!ms || ms < cutoff) return;
    const idx = Math.min(bucketCount - 1, Math.floor((ms - cutoff) / bucketSize));
    buckets[idx].count++;
  });
  return buckets.map((b) => ({ label: b.label, adjustedValue: b.count }));
}

function ordSuffix(n) {
  if (n >= 11 && n <= 13) return "th";
  switch (n % 10) { case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th"; }
}

function computeHeatmap(orders) {
  const grid = {};
  HEATMAP_DAYS.forEach((day) => HEATMAP_PERIODS.forEach((period) => { grid[`${day}-${period}`] = 0; }));

  orders.forEach((o) => {
    const ms = getOrderMs(o);
    if (!ms) return;
    const d = new Date(ms);
    const dayIdx = d.getDay();
    if (dayIdx === 0) return;
    const dayName = DAY_NAMES[dayIdx];
    if (!HEATMAP_DAYS.includes(dayName)) return;
    const hour = d.getHours();
    const period = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    grid[`${dayName}-${period}`]++;
  });

  // `level` is a SHADE, relative to the busiest cell in the current range — it
  // is not a quantity. With three orders in the whole range the busiest cell is
  // still level 4, so the level alone says nothing about volume. The real
  // `count` therefore travels with it and is what the UI reports; the level
  // only picks a colour.
  const maxVal = Math.max(...Object.values(grid), 1);
  return HEATMAP_PERIODS.map((period) =>
    HEATMAP_DAYS.map((day) => {
      const count = grid[`${day}-${period}`];
      return {
        day,
        period,
        count,
        // An empty cell stays at the lowest shade rather than being promoted
        // to 1 by Math.max, so "no orders" and "a few orders" look different.
        level: count === 0 ? 0 : Math.max(1, Math.ceil((count / maxVal) * 4)),
      };
    })
  );
}

/*
  "Distribution by Region" was removed, along with its computation, its filter
  and its card.

  It read `order.region`, which the live order-creation path
  (`createOrderWithReservation`) does not write — only the superseded
  `createSalesRepOrder` ever did. So no order created today can carry one, and
  the section could only ever show an empty state or a distribution of legacy
  documents presented as current.

  Nothing replaced it. A region is not derivable from what an order does hold:
  `clinicAddress` is free text, and parsing a region out of it would be
  inference presented as fact. Restoring the section means adding a canonical
  region to order creation first — a schema and rules change, not a UI one.
*/

function Analytics() {
  const [allOrders, setAllOrders] = useState([]);
  const [alertCount, setAlertCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [timeRange, setTimeRange] = useState("30");
  const [vaccineFilter, setVaccineFilter] = useState("all");
  const [selectedModal, setSelectedModal] = useState(null);

  // The instant every range on this page is measured from. Reading the clock
  // during render made the render impure — two renders with identical props and
  // state could produce different cutoffs. It is now stamped on exactly the two
  // occasions that previously caused a fresh read: an arriving orders snapshot,
  // and the operator changing the range. Both are events rather than render, so
  // the date-range behaviour is unchanged.
  const [nowMs, setNowMs] = useState(null);

  useEffect(() => {
    let loaded = { orders: false, alerts: false };
    const checkDone = () => { if (loaded.orders && loaded.alerts) setLoading(false); };

    const unsubOrders = subscribeDeliveries(
      (orders) => {
        setAllOrders(orders);
        // Stamped where the data arrives, not during render.
        setNowMs(Date.now());
        loaded.orders = true;
        checkDone();
      },
      (error) => {
        console.error("Analytics orders error:", error);
        setLoadError(error.message || "Failed to load order data.");
        // The error banner renders alongside the page, so the ranges still
        // need a reference time even though no orders arrived.
        setNowMs(Date.now());
        loaded.orders = true;
        checkDone();
      }
    );

    let unsubAlerts = () => {};
    try {
      unsubAlerts = subscribeAllAlerts((alerts) => {
        setAlertCount(alerts.filter((a) => a.status !== "resolved").length);
        loaded.alerts = true;
        checkDone();
      });
    } catch (e) {
      console.error("Analytics alerts error:", e);
      loaded.alerts = true;
      checkDone();
    }

    return () => { unsubOrders(); unsubAlerts(); };
  }, []);

  const days = parseInt(timeRange);
  const rangeLabel = RANGE_LABELS[timeRange];

  const timeFiltered = useMemo(() => {
    // Before the reference time is established the page is still in its loading
    // state, so this only ever returns [] for renders nothing reads.
    if (nowMs == null) return [];
    const cutoff = nowMs - days * MS_PER_DAY;
    return allOrders.filter((o) => getOrderMs(o) >= cutoff);
  }, [allOrders, days, nowMs]);

  const vaccineNames = useMemo(() => {
    const set = new Set(allOrders.map((o) => o.vaccineName).filter(Boolean));
    return Array.from(set).sort();
  }, [allOrders]);

  const filtered = useMemo(() => {
    let result = timeFiltered;
    if (vaccineFilter !== "all") result = result.filter((o) => o.vaccineName === vaccineFilter);
    return result;
  }, [timeFiltered, vaccineFilter]);

  const totalDeliveries = filtered.length;
  const delayedCount = filtered.filter((o) => o.statusKey === "delayed").length;
  const completedCount = filtered.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed").length;
  const onTimeRate = totalDeliveries > 0
    ? `${Math.round((completedCount / totalDeliveries) * 100)}%`
    : "—";

  const avgDeliveryMinutes = useMemo(
    () => computeAvgDeliveryMinutes(filtered),
    [filtered]
  );
  const avgDeliveryText = formatAvgDelivery(avgDeliveryMinutes);

  const volumeData = useMemo(() => {
    if (nowMs == null) return [{ label: "—", adjustedValue: 0 }];
    const buckets = computeVolumeBuckets(filtered, days, nowMs);
    return buckets.length > 0 ? buckets : [{ label: "—", adjustedValue: 0 }];
  }, [filtered, days, nowMs]);

  const maxVolume = Math.max(...volumeData.map((d) => d.adjustedValue), 1);

  const heatmapData = useMemo(() => computeHeatmap(timeFiltered), [timeFiltered]);

  const openModal = (modal) => setSelectedModal(modal);


  if (loading) {
    return (
      <AdminLayout
        active="analytics"
        title="Analytics Overview"
        description="Loading analytics data…"
      />
    );
  }

  if (loadError) {
    return (
      <AdminLayout active="analytics" title="Analytics Overview">
        <div className="analytics-error-banner" role="alert">
          {loadError}
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      active="analytics"
      title="Analytics Overview"
      description="System-wide logistics performance metrics."
      actions={
        <>
          {/* "Export Report" was removed. It produced no file — it raised
              "Analytics report generated." and nothing else, so an admin could
              believe a report had been generated and downloaded. A real export
              is small but it is work, and inventing one here would exceed an
              audit. */}
          <select
            value={timeRange}
            onChange={(e) => {
              setTimeRange(e.target.value);
              // The other occasion the clock was read before this change:
              // choosing a range re-measures it from now, not from whenever the
              // last snapshot happened to land.
              setNowMs(Date.now());
            }}
            aria-label="Time range"
          >
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
          </select>

          <select
            value={vaccineFilter}
            onChange={(e) => setVaccineFilter(e.target.value)}
            aria-label="Vaccine"
          >
            <option value="all">All Vaccines</option>
            {vaccineNames.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </>
      }
    >

        <section className="analytics-kpi-grid">
          <KpiCard
            label="Total orders"
            value={totalDeliveries.toLocaleString()}
            context={`${rangeLabel}${vaccineFilter !== "all" ? ` · ${vaccineFilter}` : ""}`}
            tone="neutral"
            onClick={() =>
              openModal({
                title: "Total orders",
                description: `Orders for ${rangeLabel}.`,
                rows: [
                  ["Selected vaccine", vaccineFilter === "all" ? "All vaccines" : vaccineFilter],
                  ["Order count", totalDeliveries.toLocaleString()],
                ],
              })
            }
          />

          {/* Was "Average delivery time", described as "hub dispatch to clinic
              delivery". That overstated what the figure covers: `resumeTransit`
              re-stamps `startedAt` every time a delayed order goes back on the
              road, so for any resumed delivery the value measures only the last
              leg — the earlier transit and the delay itself are not in it. The
              label now says which segment it is rather than implying the whole
              journey. The computation is unchanged; only the claim about it is. */}
          <KpiCard
            label="Average latest transit segment"
            value={avgDeliveryText}
            context={
              avgDeliveryMinutes == null
                ? "No completed delivery timing data yet."
                : "Latest transit start → delivery, completed orders in range"
            }
            tone="neutral"
            onClick={() =>
              openModal({
                title: "Average latest transit segment",
                description:
                  "Calculated from each delivered order's latest startedAt timestamp to deliveredAt. Resumed deliveries exclude earlier transit and delayed time.",
                rows:
                  avgDeliveryMinutes == null
                    ? [
                        ["Current average", "Not available"],
                        ["Reason", "No completed order has both a startedAt and a deliveredAt timestamp yet"],
                      ]
                    : [
                        ["Current average", avgDeliveryText],
                        ["Measured from", "startedAt (latest transit start) → deliveredAt"],
                        ["Scope", "Completed orders in the selected range/filters"],
                      ],
              })
            }
          />

          <KpiCard
            label="Completion rate"
            value={onTimeRate}
            context={totalDeliveries > 0 ? `${completedCount} of ${totalDeliveries} completed` : "No orders in range"}
            tone="success"
            onClick={() =>
              openModal({
                title: "Completion rate",
                description: "Percentage of orders with delivered/completed status.",
                rows: [
                  ["Completed", completedCount],
                  ["Total orders", totalDeliveries],
                  ["Rate", onTimeRate],
                ],
              })
            }
          />

          <KpiCard
            label="Active alerts"
            value={alertCount}
            context={`${delayedCount} delayed order${delayedCount !== 1 ? "s" : ""}`}
            tone="danger"
            attention={alertCount > 0 || delayedCount > 0}
            onClick={() =>
              openModal({
                title: "Active alerts",
                description: "Unresolved alerts and delayed orders.",
                rows: [
                  // A "Suggested action" row sat here reading "Review alerts
                  // and delayed orders for intervention" — fixed text shown
                  // whatever the counts were, including when both were zero.
                  // Nothing computed it, so it is the same invented advice the
                  // heatmap and the insight card carried.
                  ["Unresolved alerts", alertCount],
                  ["Delayed orders", delayedCount],
                ],
              })
            }
          />
        </section>

        <section className="analytics-v2-grid">
          <section className="analytics-card analytics-volume-card">
            <CardHeader
              title={`Order Volume (${days} Days)`}
              onClick={() =>
                openModal({
                  title: "Order Volume Details",
                  description: "Volume trend based on selected filters.",
                  rows: volumeData.length > 0 && volumeData[0].adjustedValue > 0
                    ? [
                        ["Highest Point", `${findHighest(volumeData).label} — ${findHighest(volumeData).adjustedValue.toLocaleString()}`],
                        ["Lowest Point", `${findLowest(volumeData).label} — ${findLowest(volumeData).adjustedValue.toLocaleString()}`],
                        ["Total", totalDeliveries.toLocaleString()],
                      ]
                    : [["Status", "No orders in this period"]],
                })
              }
            />

            <div className="analytics-bar-chart">
              <div className="analytics-chart-grid"></div>

              {volumeData.map((item) => (
                <button
                  type="button"
                  key={item.label}
                  className="analytics-bar-group"
                  title={`${item.label}: ${item.adjustedValue.toLocaleString()} orders`}
                  onClick={() =>
                    openModal({
                      title: `${item.label} Order Volume`,
                      description: "Selected chart point details.",
                      rows: [
                        ["Period", item.label],
                        ["Orders", item.adjustedValue.toLocaleString()],
                        ["Filter", `${rangeLabel}, ${vaccineFilter === "all" ? "All Vaccines" : vaccineFilter}`],
                      ],
                    })
                  }
                >
                  <span
                    className="analytics-bar"
                    style={{ height: `${(item.adjustedValue / maxVolume) * 100}%` }}
                  ></span>
                  <small>{item.label}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="analytics-card analytics-ai-card">
            <div className="analytics-ai-icon">
              <Lightbulb size={22} />
            </div>

            {/* Was "Operational insight" with a recommendation attached. The
                COUNTS were real; the advice was not — nothing analyses peak
                hours or rider capacity, and the cold-chain procedures the old
                copy told admins to maintain do not exist in this system at all.
                What is left states the two figures and stops there. */}
            <div>
              <h2>Current exceptions</h2>
              <p>
                {delayedCount > 0 || alertCount > 0
                  ? `${delayedCount} delayed order${delayedCount !== 1 ? "s" : ""} and ${alertCount} active alert${alertCount !== 1 ? "s" : ""} in the selected range.`
                  : "No delayed orders and no active alerts in the selected range."}
              </p>

              <button
                type="button"
                onClick={() =>
                  openModal({
                    title: "Current exceptions",
                    description:
                      "Counted directly from orders and alerts. No recommendation is derived — nothing in the system analyses cause or capacity.",
                    rows: [
                      ["Delayed orders", delayedCount],
                      ["Active alerts", alertCount],
                      ["Range", rangeLabel],
                    ],
                  })
                }
              >
                View details
              </button>
            </div>
          </section>

          <section className="analytics-card analytics-hub-card">
            <div className="analytics-card-title-row">
              <h2>Hub performance ranking</h2>
            </div>

            <div className="analytics-empty-state">
              <Building2 size={26} />
              <strong>Hub ranking not available yet</strong>
              <p>
                Per-hub on-time and incident metrics will appear here once a hubs
                data source and per-order hub assignment are recorded. No hub data
                is fabricated in the meantime.
              </p>
            </div>
          </section>

          <section className="analytics-card analytics-heatmap-card">
            <div className="analytics-card-title-row">
              {/* Was "Peak Order Hours", which promised an hour-level reading
                  the grid does not provide and a "peak" judgement nothing
                  computed. It counts when orders were CREATED, grouped into
                  three broad periods — that is what the title now says. */}
              <h2>Order activity by day and period</h2>

              <div className="analytics-heatmap-legend">
                <span>Fewer</span>
                <i></i>
                <span>More</span>
              </div>
            </div>

            <p className="analytics-heatmap-note">
              Counts orders by their creation time, {rangeLabel.toLowerCase()}.
              Shading is relative to the busiest cell in this range, so it shows
              distribution rather than volume — select a cell for its order count.
            </p>

            <div className="analytics-heatmap-labels">
              <span className="analytics-heatmap-period" aria-hidden="true"></span>
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            {/* One labelled row per period. The grid previously rendered three
                unlabelled rows under six day headings, so nothing on screen
                said which row was morning, afternoon or evening. */}
            {heatmapData.map((row, rowIndex) => (
              <div className="analytics-heatmap-row" key={HEATMAP_PERIODS[rowIndex]}>
                <span className="analytics-heatmap-period">{HEATMAP_PERIODS[rowIndex]}</span>

                <div className="analytics-heatmap-grid">
                  {row.map((cell) => (
                    <button
                      type="button"
                      key={`${cell.day}-${cell.period}`}
                      className={`analytics-heat-cell level-${cell.level}`}
                      // The cells are empty elements, so without this a screen
                      // reader announces eighteen unnamed buttons. The name is
                      // the real figure, not the shade.
                      aria-label={`${cell.day} ${cell.period}: ${cell.count} ${cell.count === 1 ? "order" : "orders"}`}
                      title={`${cell.day} ${cell.period}: ${cell.count} ${cell.count === 1 ? "order" : "orders"}`}
                      onClick={() =>
                        openModal({
                          title: `${cell.day} ${cell.period}`,
                          description: `Orders created in this period across ${rangeLabel.toLowerCase()}.`,
                          rows: [
                            ["Orders created", cell.count.toLocaleString()],
                            ["Day", cell.day],
                            ["Period", cell.period],
                          ],
                        })
                      }
                    ></button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </section>
      {selectedModal && (
        <AnalyticsModal modal={selectedModal} onClose={() => setSelectedModal(null)} />
      )}
    </AdminLayout>
  );
}

function CardHeader({ title, onClick }) {
  return (
    <div className="analytics-card-title-row">
      <h2>{title}</h2>
      <button type="button" onClick={onClick}>
        <MoreVertical size={16} />
      </button>
    </div>
  );
}

function AnalyticsModal({ modal, onClose }) {
  return (
    <div className="analytics-modal-backdrop">
      <div className="analytics-modal">
        <button type="button" className="analytics-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className="analytics-modal-icon">
          <Activity size={24} />
        </div>

        <h2>{modal.title}</h2>
        <p>{modal.description}</p>

        <div className="analytics-modal-grid">
          {modal.rows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        <div className="analytics-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function findHighest(data) {
  return data.reduce((highest, item) =>
    item.adjustedValue > highest.adjustedValue ? item : highest
  );
}

function findLowest(data) {
  return data.reduce((lowest, item) =>
    item.adjustedValue < lowest.adjustedValue ? item : lowest
  );
}

export default Analytics;
