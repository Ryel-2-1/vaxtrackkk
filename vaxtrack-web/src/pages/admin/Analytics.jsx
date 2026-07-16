import "./Analytics.css";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Activity,
  Building2,
  FileDown,
  Lightbulb,
  MoreVertical,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
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

function computeVolumeBuckets(orders, days) {
  const now = Date.now();
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

  const maxVal = Math.max(...Object.values(grid), 1);
  return HEATMAP_PERIODS.map((period) =>
    HEATMAP_DAYS.map((day) => ({
      day,
      period,
      level: Math.max(1, Math.ceil((grid[`${day}-${period}`] / maxVal) * 4)),
    }))
  );
}

function computeRegions(orders) {
  const counts = {};
  let withRegion = 0;
  orders.forEach((o) => {
    const r = (o.region || "").trim();
    if (!r) return;
    counts[r] = (counts[r] || 0) + 1;
    withRegion++;
  });
  if (withRegion === 0) return [];
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({
      name,
      value,
      percent: Math.round((value / withRegion) * 100),
    }));
}

function Analytics() {
  const navigate = useNavigate();

  const [allOrders, setAllOrders] = useState([]);
  const [alertCount, setAlertCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [timeRange, setTimeRange] = useState("30");
  const [regionFilter, setRegionFilter] = useState("all");
  const [vaccineFilter, setVaccineFilter] = useState("all");
  const [selectedModal, setSelectedModal] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let loaded = { orders: false, alerts: false };
    const checkDone = () => { if (loaded.orders && loaded.alerts) setLoading(false); };

    const unsubOrders = subscribeDeliveries(
      (orders) => {
        setAllOrders(orders);
        loaded.orders = true;
        checkDone();
      },
      (error) => {
        console.error("Analytics orders error:", error);
        setLoadError(error.message || "Failed to load order data.");
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

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const days = parseInt(timeRange);
  const rangeLabel = RANGE_LABELS[timeRange];

  const timeFiltered = useMemo(() => {
    const cutoff = Date.now() - days * MS_PER_DAY;
    return allOrders.filter((o) => getOrderMs(o) >= cutoff);
  }, [allOrders, days]);

  const vaccineNames = useMemo(() => {
    const set = new Set(allOrders.map((o) => o.vaccineName).filter(Boolean));
    return Array.from(set).sort();
  }, [allOrders]);

  const filtered = useMemo(() => {
    let result = timeFiltered;
    if (vaccineFilter !== "all") result = result.filter((o) => o.vaccineName === vaccineFilter);
    if (regionFilter !== "all") result = result.filter((o) => (o.region || "").trim() === regionFilter);
    return result;
  }, [timeFiltered, vaccineFilter, regionFilter]);

  const totalDeliveries = filtered.length;
  const delayedCount = filtered.filter((o) => o.statusKey === "delayed").length;
  const completedCount = filtered.filter((o) => o.statusKey === "delivered" || o.statusKey === "completed").length;
  const onTimeRate = totalDeliveries > 0
    ? `${Math.round((completedCount / totalDeliveries) * 100)}%`
    : "—";

  const regions = useMemo(() => computeRegions(timeFiltered), [timeFiltered]);
  const hasRegions = regions.length > 0;

  const visibleRegions = regionFilter === "all"
    ? regions
    : regions.filter((r) => r.name === regionFilter);

  const volumeData = useMemo(() => {
    const buckets = computeVolumeBuckets(filtered, days);
    return buckets.length > 0 ? buckets : [{ label: "—", adjustedValue: 0 }];
  }, [filtered, days]);

  const maxVolume = Math.max(...volumeData.map((d) => d.adjustedValue), 1);

  const heatmapData = useMemo(() => computeHeatmap(timeFiltered), [timeFiltered]);

  const openModal = (modal) => setSelectedModal(modal);

  const handleExport = () => showToast("Analytics report generated.");

  if (loading) {
    return (
      <div className="inventory-page">
        <AdminSidebar active="analytics" onLogout={handleLogout} />
        <main className="analytics-v2-main">
          <header className="analytics-v2-header">
            <div>
              <h1>Analytics Overview</h1>
              <p>Loading analytics data…</p>
            </div>
          </header>
        </main>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="inventory-page">
        <AdminSidebar active="analytics" onLogout={handleLogout} />
        <main className="analytics-v2-main">
          <header className="analytics-v2-header">
            <div>
              <h1>Analytics Overview</h1>
              <p style={{ color: "#c0392b" }}>{loadError}</p>
            </div>
          </header>
        </main>
      </div>
    );
  }

  return (
    <div className="inventory-page">
      <AdminSidebar active="analytics" onLogout={handleLogout} />

      <main className="analytics-v2-main">
        {toast && <div className="analytics-toast">{toast}</div>}

        <header className="analytics-v2-header">
          <div>
            <h1>Analytics Overview</h1>
            <p>System-wide logistics performance metrics.</p>
          </div>

          <div className="analytics-v2-actions">
            <button type="button" className="analytics-export-btn" onClick={handleExport}>
              <FileDown size={15} />
              Export Report
            </button>

            <select value={timeRange} onChange={(e) => setTimeRange(e.target.value)}>
              <option value="7">Last 7 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
            </select>

            {hasRegions && (
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
              >
                <option value="all">All Regions</option>
                {regions.map((region) => (
                  <option key={region.name} value={region.name}>
                    {region.name}
                  </option>
                ))}
              </select>
            )}

            <select
              value={vaccineFilter}
              onChange={(e) => setVaccineFilter(e.target.value)}
            >
              <option value="all">All Vaccines</option>
              {vaccineNames.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        </header>

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
                  ["Selected region", regionFilter === "all" ? "All regions" : regionFilter],
                  ["Selected vaccine", vaccineFilter === "all" ? "All vaccines" : vaccineFilter],
                  ["Order count", totalDeliveries.toLocaleString()],
                ],
              })
            }
          />

          <KpiCard
            label="Average delivery time"
            value="—"
            context="No dispatch/arrival timestamps yet"
            tone="neutral"
            onClick={() =>
              openModal({
                title: "Average delivery time",
                description: "Average time from hub dispatch to clinic delivery.",
                rows: [
                  ["Current average", "Not available"],
                  ["Reason", "No dispatch or arrival timestamps are recorded in orders yet"],
                  ["Recommendation", "Add dispatch and delivery timestamps to enable this metric"],
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
                  ["Unresolved alerts", alertCount],
                  ["Delayed orders", delayedCount],
                  ["Suggested action", "Review alerts and delayed orders for intervention"],
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

          <section className="analytics-card analytics-region-card">
            <CardHeader
              title="Distribution by Region"
              onClick={() =>
                openModal({
                  title: "Distribution by Region",
                  description: hasRegions
                    ? "Order distribution across regions."
                    : "No region data available on orders.",
                  rows: hasRegions
                    ? visibleRegions.map((r) => [r.name, `${r.value.toLocaleString()} orders — ${r.percent}%`])
                    : [["Status", "Orders do not have a region field yet"]],
                })
              }
            />

            <div className="analytics-region-list">
              {hasRegions ? (
                visibleRegions.map((region) => (
                  <button
                    type="button"
                    className="analytics-region-item"
                    key={region.name}
                    onClick={() => setRegionFilter(region.name)}
                  >
                    <div>
                      <span>{region.name}</span>
                      <strong>{region.value.toLocaleString()}</strong>
                    </div>

                    <div>
                      <small>{region.percent}%</small>
                      <div className="analytics-region-progress">
                        <span style={{ width: `${region.percent * 3}%` }}></span>
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <p style={{ padding: "1rem", color: "#888", fontSize: "0.85rem" }}>
                  No region data available. Add a region field to orders to enable this section.
                </p>
              )}
            </div>
          </section>

          <section className="analytics-card analytics-ai-card">
            <div className="analytics-ai-icon">
              <Lightbulb size={22} />
            </div>

            <div>
              <h2>Operational insight</h2>
              <p>
                {delayedCount > 0
                  ? `There ${delayedCount === 1 ? "is" : "are"} currently ${delayedCount} delayed order${delayedCount !== 1 ? "s" : ""}. Review delayed shipments and consider assigning additional riders during peak hours.`
                  : "No delayed orders detected. Maintain current dispatch schedules and cold-chain procedures."}
              </p>

              <button
                type="button"
                onClick={() =>
                  openModal({
                    title: "Operational insight",
                    description: "Rule-based insight derived from current order and alert data.",
                    rows: [
                      ["Delayed Orders", delayedCount],
                      ["Active Alerts", alertCount],
                      ["Suggested Action", delayedCount > 0 ? "Review delayed orders and assign backup riders" : "Continue current operations"],
                    ],
                  })
                }
              >
                View Recommendation
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
              <h2>Peak Order Hours</h2>

              <div className="analytics-heatmap-legend">
                <span>Low</span>
                <i></i>
                <span>High</span>
              </div>
            </div>

            <div className="analytics-heatmap-labels">
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            <div className="analytics-heatmap-grid">
              {heatmapData.flatMap((row) =>
                row.map((cell) => (
                  <button
                    type="button"
                    key={`${cell.day}-${cell.period}`}
                    className={`analytics-heat-cell level-${cell.level}`}
                    title={`${cell.day} ${cell.period}: Level ${cell.level}`}
                    onClick={() =>
                      openModal({
                        title: `${cell.day} ${cell.period}`,
                        description: "Peak order heatmap detail.",
                        rows: [
                          ["Order Load", `Level ${cell.level}`],
                          ["Interpretation", cell.level >= 4 ? "Peak demand" : "Normal demand"],
                          ["Suggested Action", cell.level >= 4 ? "Prepare backup riders" : "Standard schedule is enough"],
                        ],
                      })
                    }
                  ></button>
                ))
              )}
            </div>
          </section>
        </section>
      </main>

      {selectedModal && (
        <AnalyticsModal modal={selectedModal} onClose={() => setSelectedModal(null)} />
      )}
    </div>
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
        <button type="button" className="analytics-modal-close" onClick={onClose}>
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
