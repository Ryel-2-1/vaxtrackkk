import "./Analytics.css";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Clock,
  MoreVertical,
  Truck,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";

function Analytics() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const volumeData = [
    { label: "1st", value: 40 },
    { label: "7th", value: 55 },
    { label: "14th", value: 68 },
    { label: "21st", value: 78 },
    { label: "29th", value: 62 },
  ];

  const regions = [
    { name: "Cavite", value: "4,200", width: "100%" },
    { name: "Batangas", value: "3,350", width: "80%" },
    { name: "Central Luzon", value: "2,800", width: "66%" },
    { name: "Central Visayas", value: "1,600", width: "38%" },
    { name: "Davao Region", value: "900", width: "22%" },
  ];

  const hubs = [
    {
      location: "Manila Central",
      rate: "94.5%",
      incidents: 2,
      status: "Optimal",
    },
    {
      location: "Cebu Hub Alpha",
      rate: "96.2%",
      incidents: 5,
      status: "Optimal",
    },
    {
      location: "Davao Logistics Ctr",
      rate: "91.4%",
      incidents: 12,
      status: "Review",
    },
    {
      location: "Baguio Sub-Hub",
      rate: "88.9%",
      incidents: 0,
      status: "Critical",
    },
  ];

  const heatmap = [
    [1, 2, 3, 2, 1],
    [2, 3, 4, 3, 2],
    [1, 2, 4, 2, 1],
  ];

  return (
    <div className="inventory-page">
      <AdminSidebar active="analytics" onLogout={handleLogout} />

      <main className="analytics-main compact-analytics">
        <header className="analytics-compact-header">
          <div>
            <h1>Analytics Overview</h1>
            <p>System-wide logistics performance metrics.</p>
          </div>

          <div className="analytics-filter-row">
            <select>
              <option>Last 30 Days</option>
            </select>

            <select>
              <option>All Regions</option>
            </select>

            <select>
              <option>All Vaccines</option>
            </select>
          </div>
        </header>

        <section className="analytics-summary-row">
          <div className="mini-metric-card">
            <div>
              <p>Total Deliveries</p>
              <h2>12,450</h2>
              <small className="positive">+8.2% from last month</small>
            </div>

            <span>
              <Truck size={18} />
            </span>
          </div>

          <div className="mini-metric-card">
            <div>
              <p>Average Delivery Time</p>
              <h2>2h 15m</h2>
              <small className="positive">−12m from average</small>
            </div>

            <span>
              <Clock size={18} />
            </span>
          </div>
        </section>

        <section className="analytics-main-grid">
          <div className="analytics-chart-card">
            <div className="compact-card-header">
              <h2>Delivery Volume (30 Days)</h2>
              <button>
                <MoreVertical size={16} />
              </button>
            </div>

            <div className="area-chart-mock">
              <div className="chart-grid-lines"></div>

              {volumeData.map((item, index) => (
                <div className="area-bar-group" key={item.label}>
                  <div
                    className={`area-bar bar-${index}`}
                    style={{ height: `${item.value}%` }}
                  ></div>
                  <small>{item.label}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="region-card">
            <div className="compact-card-header">
              <h2>Distribution by Region</h2>
              <button>
                <MoreVertical size={16} />
              </button>
            </div>

            <div className="region-list">
              {regions.map((region) => (
                <div className="region-item" key={region.name}>
                  <div>
                    <span>{region.name}</span>
                    <strong>{region.value}</strong>
                  </div>

                  <div className="region-progress">
                    <span style={{ width: region.width }}></span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="hub-ranking-card">
            <div className="compact-card-header">
              <h2>Hub Performance Ranking</h2>
              <button>View All +</button>
            </div>

            <table className="hub-table">
              <thead>
                <tr>
                  <th>Hub Location</th>
                  <th>On-Time Rate</th>
                  <th>Incident Reports</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {hubs.map((hub) => (
                  <tr key={hub.location}>
                    <td>{hub.location}</td>
                    <td>{hub.rate}</td>
                    <td>{hub.incidents}</td>
                    <td>
                      <span className={`hub-status ${hub.status.toLowerCase()}`}>
                        {hub.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="heatmap-card">
            <div className="compact-card-header">
              <h2>Peak Delivery Hours</h2>
              <div className="heatmap-legend">
                <span>Low</span>
                <i></i>
                <span>High</span>
              </div>
            </div>

            <div className="heatmap-labels">
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            <div className="heatmap-grid">
              {heatmap.flatMap((row, rowIndex) =>
                row.map((level, colIndex) => (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`heat-cell level-${level}`}
                  ></div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default Analytics;