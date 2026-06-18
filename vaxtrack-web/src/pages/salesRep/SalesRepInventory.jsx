import { CalendarDays, CheckCircle2, Hourglass, PackageCheck } from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepInventory() {
  const stocks = [
    ["VaxCovar-19", "Moderna Pharma", "BT-2024-X91", "Oct 24, 2026", "12 Days Remaining", "14,250", "-70°C", "Critical"],
    ["Influenza-Plus", "Global Bio", "INF-221-Z67", "Dec 12, 2026", "61 Days Remaining", "8,400", "2-8°C", "Warning"],
    ["Polio-Zero", "Hygiela Lab", "PO-882-V69", "Mar 30, 2027", "170 Days Remaining", "52,000", "2-8°C", "Stable"],
  ];

  return (
    <SalesRepLayout active="inventory" title="Inventory Monitoring" showSearch={false}>
      <section className="salesrep-page-title">
        <h1>Inventory Monitoring</h1>
        <p>Real-time stock and cold-chain status</p>
      </section>

      <section className="salesrep-inventory-grid">
        <div className="salesrep-card capacity-card">
          <h2>Central Hub Capacity</h2>
          <div className="bar-chart">
            <Bar label="Pfizer" value="78" tone="blue" />
            <Bar label="Moderna" value="54" tone="green" />
            <Bar label="Sinovac" value="72" tone="gold" />
            <Bar label="J&J" value="12" tone="red" />
          </div>
        </div>

        <div className="inventory-side-metrics">
          <SmallMetric icon={<Hourglass size={24} />} label="Expiring < 30 Days" value="14,200" sub="vials" tone="gold" />
          <SmallMetric icon={<CheckCircle2 size={24} />} label="Total Safe Stock" value="260K" sub="Optimal" tone="green" />
        </div>
      </section>

      <section className="salesrep-card inventory-table-card">
        <div className="inventory-filter-row">
          <button>All Vaccine Types</button>
          <button><CalendarDays size={14} /> Expiry: Next 90 Days</button>
        </div>

        <table className="salesrep-inventory-table">
          <thead>
            <tr>
              <th></th>
              <th>Vaccine Name</th>
              <th>Batch ID</th>
              <th>Expiry Date</th>
              <th>Remaining Qty</th>
              <th>Temp</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((stock) => (
              <tr key={stock[2]}>
                <td><input type="checkbox" /></td>
                <td>
                  <div className="stock-name">
                    <span><PackageCheck size={16} /></span>
                    <div><strong>{stock[0]}</strong><small>{stock[1]}</small></div>
                  </div>
                </td>
                <td><span className="batch-chip">{stock[2]}</span></td>
                <td><strong>{stock[3]}</strong><small>{stock[4]}</small></td>
                <td>{stock[5]}</td>
                <td><span className="temp-chip">{stock[6]}</span></td>
                <td><span className={`status-chip ${stock[7].toLowerCase()}`}>• {stock[7]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="salesrep-pagination-row right">
          <p>Displaying 1-10 of 124 batches</p>
          <div><button>‹</button><button>›</button></div>
        </div>
      </section>
    </SalesRepLayout>
  );
}

function Bar({ label, value, tone }) {
  return (
    <div className="bar-item">
      <div className="bar-bg"><span className={tone} style={{ height: `${value}%` }}></span></div>
      <p>{label}</p>
    </div>
  );
}

function SmallMetric({ icon, label, value, sub, tone }) {
  return (
    <div className="small-metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div><span>{label}</span><h2>{value}</h2><p>{sub}</p></div>
    </div>
  );
}

export default SalesRepInventory;
