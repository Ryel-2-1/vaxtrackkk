import "./Analytics.css";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileDown,
  Lightbulb,
  MoreVertical,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeAllAlerts } from "../../services/alertService";

const MS_PER_DAY = 86400000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_PERIODS = ["Morning", "Afternoon", "Evening"];

const RANGE_LABELS = { "7": "Last 7 Days", "30": "Last 30 Days", "90": "Last 90 Days" };

// No hubs collection exists — kept as static reference data
const STATIC_HUBS = [
  {
    location: "Manila Central",
    rate: "94.5%",
    incidents: 2,
    status: "Optimal",
    statusKey: "optimal",
    recommendation: "Continue current dispatch schedule.",
  },
  {
    location: "Cebu Hub Alpha",
    rate: "96.2%",
    incidents: 5,
    status: "Optimal",
    statusKey: "optimal",
    recommendation: "Maintain current staffing and cold-chain process.",
  },
  {
    location: "Davao Logistics Ctr",
    rate: "91.4%",
    incidents: 12,
    status: "Review",
    statusKey: "review",
    recommendation: "Review rider availability during afternoon peak hours.",
  },
  {
    location: "Baguio Sub-Hub",
    rate: "88.9%",
    incidents: 14,
    status: "Critical",
    statusKey: "critical",
    recommendation: "Increase monitoring for route deviation and delayed trips.",
  },
];

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
          <MetricCard
            icon={<Truck size={20} />}
            title="Total Orders"
            value={totalDeliveries.toLocaleString()}
            note={`${rangeLabel}${vaccineFilter !== "all" ? ` · ${vaccineFilter}` : ""}`}
            type="blue"
            onClick={() =>
              openModal({
                title: "Total Orders",
                description: `Orders for ${rangeLabel}.`,
                rows: [
                  ["Selected Region", regionFilter === "all" ? "All Regions" : regionFilter],
                  ["Selected Vaccine", vaccineFilter === "all" ? "All Vaccines" : vaccineFilter],
                  ["Order Count", totalDeliveries.toLocaleString()],
                ],
              })
            }
          />

          <MetricCard
            icon={<Clock size={20} />}
            title="Average Delivery Time"
            value="—"
            note="No dispatch/arrival timestamps yet"
            type="amber"
            onClick={() =>
              openModal({
                title: "Average Delivery Time",
                description: "Average time from hub dispatch to clinic delivery.",
                rows: [
                  ["Current Average", "Not available"],
                  ["Reason", "No dispatch or arrival timestamps are recorded in orders yet"],
                  ["Recommendation", "Add dispatch and delivery timestamps to enable this metric"],
                ],
              })
            }
          />

          <MetricCard
            icon={<CheckCircle2 size={20} />}
            title="Completion Rate"
            value={onTimeRate}
            note={totalDeliveries > 0 ? `${completedCount} of ${totalDeliveries} completed` : "No orders in range"}
            type="green"
            onClick={() =>
              openModal({
                title: "Completion Rate",
                description: "Percentage of orders with delivered/completed status.",
                rows: [
                  ["Completed", completedCount],
                  ["Total Orders", totalDeliveries],
                  ["Rate", onTimeRate],
                ],
              })
            }
          />

          <MetricCard
            icon={<AlertTriangle size={20} />}
            title="Active Alerts"
            value={alertCount}
            note={`${delayedCount} delayed order${delayedCount !== 1 ? "s" : ""}`}
            type="red"
            onClick={() =>
              openModal({
                title: "Active Alerts",
                description: "Unresolved alerts and delayed orders.",
                rows: [
                  ["Unresolved Alerts", alertCount],
                  ["Delayed Orders", delayedCount],
                  ["Suggested Action", "Review alerts and delayed orders for intervention"],
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
              <h2>AI Logistics Insight</h2>
              <p>
                {delayedCount > 0
                  ? `There ${delayedCount === 1 ? "is" : "are"} currently ${delayedCount} delayed order${delayedCount !== 1 ? "s" : ""}. Review delayed shipments and consider assigning additional riders during peak hours.`
                  : "No delayed orders detected. Maintain current dispatch schedules and cold-chain procedures."}
              </p>

              <button
                type="button"
                onClick={() =>
                  openModal({
                    title: "AI Logistics Insight",
                    description: "Decision-support insight based on current order data.",
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
              <h2>Hub Performance Ranking</h2>
              <button
                type="button"
                onClick={() =>
                  openModal({
                    title: "All Hub Rankings",
                    description: "Hub performance data is static — no hubs collection exists yet.",
                    rows: STATIC_HUBS.map((hub) => [
                      hub.location,
                      `${hub.rate} on-time, ${hub.incidents} incidents, ${hub.status}`,
                    ]),
                  })
                }
              >
                View All +
              </button>
            </div>

            <table className="analytics-hub-table">
              <thead>
                <tr>
                  <th>Hub Location</th>
                  <th>On-Time Rate</th>
                  <th>Incidents</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {STATIC_HUBS.map((hub) => (
                  <tr
                    key={hub.location}
                    onClick={() =>
                      openModal({
                        title: hub.location,
                        description: "Hub performance details (static data).",
                        rows: [
                          ["On-Time Rate", hub.rate],
                          ["Incident Reports", hub.incidents],
                          ["Status", hub.status],
                          ["Recommendation", hub.recommendation],
                        ],
                      })
                    }
                  >
                    <td>{hub.location}</td>
                    <td>{hub.rate}</td>
                    <td>{hub.incidents}</td>
                    <td>
                      <span className={`analytics-hub-status ${hub.statusKey}`}>
                        {hub.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

function MetricCard({ icon, title, value, note, type, onClick }) {
  return (
    <button type="button" className={`analytics-metric-card ${type}`} onClick={onClick}>
      <div className="analytics-metric-icon">{icon}</div>

      <div>
        <p>{title}</p>
        <h2>{value}</h2>
        <small>{note}</small>
      </div>
    </button>
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
