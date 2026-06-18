import {
  CheckCircle2,
  Clock3,
  Filter,
  PackageCheck,
  Search,
  ShoppingCart,
  Truck,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";
function SalesRepDashboard() {
  const inventoryRows = [
    ["Pfizer-BioNTech", "PFZ-2023-A01", "85,000", "blue"],
    ["Sinovac", "SNO-2023-C44", "120,000", "gold"],
    ["Moderna", "MOD-2023-B12", "45,000", "blue"],
    ["J&J Janssen", "JNJ-2023-X99", "10,000", "gray"],
  ];

  return (
    <SalesRepLayout active="dashboard" title="Sales Pro Dashboard">
      <section className="salesrep-metrics three">
        <MetricCard icon={<ShoppingCart size={28} />} label="Total Orders (30D)" value="1,284" note="↗ +12% vs last month" tone="blue" />
        <MetricCard icon={<CheckCircle2 size={28} />} label="Fulfillment Rate" value="98.2%" note="Peak Efficiency" tone="green" />
        <MetricCard icon={<Truck size={28} />} label="Active Shipments" value="42" note="8 arriving today" tone="blue" />
      </section>

      <section className="salesrep-dashboard-grid">
        <div className="salesrep-card salesrep-table-card">
          <div className="salesrep-card-toolbar">
            <div className="salesrep-inline-search">
              <Search size={15} />
              <input placeholder="Search batch ID..." />
            </div>

            <div className="salesrep-toolbar-actions">
              <button type="button" className="salesrep-pill primary">All Vaccines</button>
              <button type="button" className="salesrep-pill"><Filter size={13} /> Filter</button>
            </div>
          </div>

          <table className="salesrep-data-table">
            <thead>
              <tr>
                <th>Vaccine Type</th>
                <th>Batch ID</th>
                <th>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {inventoryRows.map((row) => (
                <tr key={row[1]}>
                  <td>
                    <div className="salesrep-product-cell">
                      <span className={`salesrep-product-icon ${row[3]}`}><PackageCheck size={15} /></span>
                      <strong>{row[0]}</strong>
                    </div>
                  </td>
                  <td>{row[1]}</td>
                  <td>{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="salesrep-pagination-row">
            <p>Showing 1 to 4 of 24 batches</p>
            <div>
              <button>‹</button>
              <button className="active">1</button>
              <button>2</button>
              <button>3</button>
              <button>›</button>
            </div>
          </div>
        </div>

        <aside className="salesrep-side-stack">
          <div className="salesrep-card">
            <div className="salesrep-section-title compact">
              <Clock3 size={16} />
              <h2>Recent Activity</h2>
              <a>View All</a>
            </div>

            <ActivityItem tone="green" title="Order #VX-8821 delivered to Manila Doctors Hospital." time="2 mins ago" />
            <ActivityItem tone="blue" title="Batch Release: Lot B-1049 verified for distribution." time="15 mins ago" />
            <ActivityItem tone="red" title="Temperature Alert! Cold chain deviation detected in Truck #042." time="1 hour ago" />
            <ActivityItem tone="blue" title="New Client: Makati Health District joined the portal." time="3 hours ago" />
          </div>

          <div className="salesrep-card approvals-card">
            <h2>Review Pending Approvals</h2>
            <Approval order="ORDER #VX-6608" city="San Pedro City" status="Pending" />
            <Approval order="ORDER #VX-6667" city="Cavite, Imus" status="Approved" />
            <Approval order="ORDER #VX-6669" city="BGC, Taguig" status="Decline" />
          </div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

function MetricCard({ icon, label, value, note, tone }) {
  return (
    <div className="salesrep-metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <h2>{value}</h2>
        <p>{note}</p>
      </div>
    </div>
  );
}

function ActivityItem({ tone, title, time }) {
  return (
    <div className="activity-item">
      <span className={tone}></span>
      <div>
        <strong>{title}</strong>
        <p>{time}</p>
      </div>
    </div>
  );
}

function Approval({ order, city, status }) {
  return (
    <div className="approval-row">
      <div>
        <strong>{order}</strong>
        <p>{city}</p>
      </div>
      <span className={status.toLowerCase()}>{status}</span>
    </div>
  );
}

export default SalesRepDashboard;
