import "./Analytics.css";
import { useMemo, useState } from "react";
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
  Package,
  TrendingUp,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

const rangeStats = {
  "7": {
    label: "Last 7 Days",
    totalDeliveries: 2860,
    deliveryTime: "2h 08m",
    onTimeRate: "95.1%",
    routeAlerts: 3,
    trend: "+4.1% from previous week",
    volumeTitle: "Delivery Volume (7 Days)",
    volumeData: [
      { label: "Mon", value: 280 },
      { label: "Tue", value: 360 },
      { label: "Wed", value: 420 },
      { label: "Thu", value: 390 },
      { label: "Fri", value: 510 },
      { label: "Sat", value: 470 },
      { label: "Sun", value: 430 },
    ],
  },
  "30": {
    label: "Last 30 Days",
    totalDeliveries: 12450,
    deliveryTime: "2h 15m",
    onTimeRate: "94.2%",
    routeAlerts: 8,
    trend: "+8.2% from last month",
    volumeTitle: "Delivery Volume (30 Days)",
    volumeData: [
      { label: "1st", value: 2400 },
      { label: "7th", value: 3200 },
      { label: "14th", value: 4100 },
      { label: "21st", value: 4700 },
      { label: "29th", value: 3600 },
    ],
  },
  "90": {
    label: "Last 90 Days",
    totalDeliveries: 36420,
    deliveryTime: "2h 22m",
    onTimeRate: "92.8%",
    routeAlerts: 21,
    trend: "+12.6% from previous quarter",
    volumeTitle: "Delivery Volume (90 Days)",
    volumeData: [
      { label: "Week 1", value: 7200 },
      { label: "Week 3", value: 8400 },
      { label: "Week 5", value: 9600 },
      { label: "Week 7", value: 11200 },
      { label: "Week 9", value: 10100 },
    ],
  },
};

const regions = [
  { name: "Cavite", value: 4200, percent: 32 },
  { name: "Batangas", value: 3350, percent: 25 },
  { name: "Central Luzon", value: 2800, percent: 21 },
  { name: "Central Visayas", value: 1600, percent: 12 },
  { name: "Davao Region", value: 900, percent: 7 },
];

const vaccineMultipliers = {
  all: 1,
  Pfizer: 0.31,
  Moderna: 0.22,
  Sinovac: 0.28,
  "J&J": 0.19,
};

const hubs = [
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

const heatmap = [
  [
    { day: "Mon", period: "Morning", level: 1 },
    { day: "Tue", period: "Morning", level: 2 },
    { day: "Wed", period: "Morning", level: 3 },
    { day: "Thu", period: "Morning", level: 2 },
    { day: "Fri", period: "Morning", level: 1 },
    { day: "Sat", period: "Morning", level: 1 },
  ],
  [
    { day: "Mon", period: "Afternoon", level: 2 },
    { day: "Tue", period: "Afternoon", level: 3 },
    { day: "Wed", period: "Afternoon", level: 4 },
    { day: "Thu", period: "Afternoon", level: 3 },
    { day: "Fri", period: "Afternoon", level: 2 },
    { day: "Sat", period: "Afternoon", level: 1 },
  ],
  [
    { day: "Mon", period: "Evening", level: 1 },
    { day: "Tue", period: "Evening", level: 2 },
    { day: "Wed", period: "Evening", level: 4 },
    { day: "Thu", period: "Evening", level: 2 },
    { day: "Fri", period: "Evening", level: 1 },
    { day: "Sat", period: "Evening", level: 1 },
  ],
];

function Analytics() {
  const navigate = useNavigate();

  const [timeRange, setTimeRange] = useState("30");
  const [regionFilter, setRegionFilter] = useState("all");
  const [vaccineFilter, setVaccineFilter] = useState("all");
  const [selectedModal, setSelectedModal] = useState(null);
  const [toast, setToast] = useState("");

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const activeStats = rangeStats[timeRange];

  const selectedRegion = regions.find((region) => region.name === regionFilter);
  const regionMultiplier =
    regionFilter === "all" ? 1 : selectedRegion ? selectedRegion.percent / 100 : 1;

  const vaccineMultiplier = vaccineMultipliers[vaccineFilter] || 1;

  const adjustedTotal = Math.round(
    activeStats.totalDeliveries * regionMultiplier * vaccineMultiplier
  ).toLocaleString();

  const adjustedAlerts = Math.max(
    1,
    Math.round(activeStats.routeAlerts * regionMultiplier * vaccineMultiplier)
  );

  const visibleRegions =
    regionFilter === "all"
      ? regions
      : regions.filter((region) => region.name === regionFilter);

  const volumeData = useMemo(() => {
    return activeStats.volumeData.map((item) => ({
      ...item,
      adjustedValue: Math.max(80, Math.round(item.value * vaccineMultiplier)),
    }));
  }, [activeStats, vaccineMultiplier]);

  const maxVolume = Math.max(...volumeData.map((item) => item.adjustedValue));

  const openModal = (modal) => {
    setSelectedModal(modal);
  };

  const handleExport = () => {
    showToast("Analytics report generated.");
  };

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

            <select
              value={vaccineFilter}
              onChange={(e) => setVaccineFilter(e.target.value)}
            >
              <option value="all">All Vaccines</option>
              <option value="Pfizer">Pfizer</option>
              <option value="Moderna">Moderna</option>
              <option value="Sinovac">Sinovac</option>
              <option value="J&J">J&amp;J</option>
            </select>
          </div>
        </header>

        <section className="analytics-kpi-grid">
          <MetricCard
            icon={<Truck size={20} />}
            title="Total Deliveries"
            value={adjustedTotal}
            note={activeStats.trend}
            type="blue"
            onClick={() =>
              openModal({
                title: "Total Deliveries",
                description: `Total deliveries for ${activeStats.label}.`,
                rows: [
                  ["Selected Region", regionFilter === "all" ? "All Regions" : regionFilter],
                  ["Selected Vaccine", vaccineFilter === "all" ? "All Vaccines" : vaccineFilter],
                  ["Delivery Count", adjustedTotal],
                ],
              })
            }
          />

          <MetricCard
            icon={<Clock size={20} />}
            title="Average Delivery Time"
            value={activeStats.deliveryTime}
            note="−12m from average"
            type="amber"
            onClick={() =>
              openModal({
                title: "Average Delivery Time",
                description: "Average time from hub dispatch to clinic delivery.",
                rows: [
                  ["Current Average", activeStats.deliveryTime],
                  ["Comparison", "12 minutes faster than baseline"],
                  ["Recommendation", "Maintain current dispatch preparation window"],
                ],
              })
            }
          />

          <MetricCard
            icon={<CheckCircle2 size={20} />}
            title="On-Time Rate"
            value={activeStats.onTimeRate}
            note="Stable delivery compliance"
            type="green"
            onClick={() =>
              openModal({
                title: "On-Time Delivery Rate",
                description: "Percentage of deliveries completed within expected ETA.",
                rows: [
                  ["On-Time Rate", activeStats.onTimeRate],
                  ["Best Hub", "Cebu Hub Alpha"],
                  ["Lowest Hub", "Baguio Sub-Hub"],
                ],
              })
            }
          />

          <MetricCard
            icon={<AlertTriangle size={20} />}
            title="Route Alerts"
            value={adjustedAlerts}
            note="Route deviation incidents"
            type="red"
            onClick={() =>
              openModal({
                title: "Route Deviation Alerts",
                description: "Detected route anomalies for the selected filters.",
                rows: [
                  ["Route Alerts", adjustedAlerts],
                  ["Most Common Issue", "Delayed rerouting"],
                  ["Suggested Action", "Review rider route compliance"],
                ],
              })
            }
          />
        </section>

        <section className="analytics-v2-grid">
          <section className="analytics-card analytics-volume-card">
            <CardHeader
              title={activeStats.volumeTitle}
              onClick={() =>
                openModal({
                  title: "Delivery Volume Details",
                  description: "Volume trend based on selected filters.",
                  rows: [
                    ["Highest Point", `${findHighest(volumeData).label} — ${findHighest(volumeData).adjustedValue.toLocaleString()}`],
                    ["Lowest Point", `${findLowest(volumeData).label} — ${findLowest(volumeData).adjustedValue.toLocaleString()}`],
                    ["Trend", "Increasing delivery activity"],
                  ],
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
                  title={`${item.label}: ${item.adjustedValue.toLocaleString()} deliveries`}
                  onClick={() =>
                    openModal({
                      title: `${item.label} Delivery Volume`,
                      description: "Selected chart point details.",
                      rows: [
                        ["Period", item.label],
                        ["Deliveries", item.adjustedValue.toLocaleString()],
                        ["Filter", `${activeStats.label}, ${vaccineFilter === "all" ? "All Vaccines" : vaccineFilter}`],
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
                  description: "Delivery distribution across operating regions.",
                  rows: visibleRegions.map((region) => [
                    region.name,
                    `${region.value.toLocaleString()} deliveries — ${region.percent}%`,
                  ]),
                })
              }
            />

            <div className="analytics-region-list">
              {visibleRegions.map((region) => (
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
              ))}
            </div>
          </section>

          <section className="analytics-card analytics-ai-card">
            <div className="analytics-ai-icon">
              <Lightbulb size={22} />
            </div>

            <div>
              <h2>AI Logistics Insight</h2>
              <p>
                Most delays occur during Wednesday afternoon deliveries. Prepare
                additional riders and cold-chain backup units during peak delivery
                hours.
              </p>

              <button
                type="button"
                onClick={() =>
                  openModal({
                    title: "AI Logistics Insight",
                    description: "Prototype decision-support insight for VaxTrack.",
                    rows: [
                      ["Detected Pattern", "Wednesday afternoon has the highest load"],
                      ["Risk", "Delayed dispatch and route deviation"],
                      ["Suggested Action", "Assign extra riders before peak hours"],
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
                    description: "Full hub performance overview.",
                    rows: hubs.map((hub) => [
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
                {hubs.map((hub) => (
                  <tr
                    key={hub.location}
                    onClick={() =>
                      openModal({
                        title: hub.location,
                        description: "Hub performance details and recommendation.",
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
              <h2>Peak Delivery Hours</h2>

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
              {heatmap.flatMap((row) =>
                row.map((cell) => (
                  <button
                    type="button"
                    key={`${cell.day}-${cell.period}`}
                    className={`analytics-heat-cell level-${cell.level}`}
                    title={`${cell.day} ${cell.period}: Level ${cell.level}`}
                    onClick={() =>
                      openModal({
                        title: `${cell.day} ${cell.period}`,
                        description: "Peak delivery heatmap detail.",
                        rows: [
                          ["Delivery Load", `Level ${cell.level}`],
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