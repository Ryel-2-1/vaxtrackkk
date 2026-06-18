import { Link, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Box,
  Building2,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Package,
  Plus,
  Search,
  Settings,
  Truck,
  Users,
} from "lucide-react";
import { auth } from "../../firebase";
import "./Inventory.css";

function Inventory() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const vaccines = [
    {
      name: "VaxCora-19",
      type: "mRNA",
      batch: "BT-2024-991",
      expiry: "Oct 24, 2026",
      qty: "14,250",
      temp: "-80°C",
      status: "Critical",
      level: "critical",
    },
    {
      name: "Influenza-Plus",
      type: "Doses",
      batch: "INF-2027-OP",
      expiry: "Dec 12, 2026",
      qty: "8,400",
      temp: "2-8°C",
      status: "Warning",
      level: "warning",
    },
    {
      name: "Polio-Zero",
      type: "Injectable",
      batch: "PO-982-ZR",
      expiry: "Mar 30, 2027",
      qty: "52,000",
      temp: "2-8°C",
      status: "Stable",
      level: "stable",
    },
  ];

  return (
    <div className="inventory-page">
      <AdminSidebar active="inventory" onLogout={handleLogout} />

      <main className="v2-inventory-main">
        <header className="v2-inventory-topbar">
          <div>
            <h1>Inventory Monitoring</h1>
            <p>Real-time stock and cold-chain status</p>
          </div>

          <div className="v2-inventory-icons">
            <button>
              <Bell size={15} />
            </button>
            <button>
              <Settings size={15} />
            </button>
          </div>
        </header>

        <section className="v2-hub-grid">
          <HubCapacityCard />
          <HubCapacityCard />
          <HubCapacityCard warning />
        </section>

        <section className="v2-inventory-table-card">
          <div className="v2-inventory-toolbar">
            <div className="v2-inventory-search">
              <Search size={14} />
              <input placeholder="Search vaccine..." />
            </div>

            <div className="v2-inventory-filters">
              <button>
                All Vaccine Types
                <ChevronDown size={14} />
              </button>

              <button>
                Expiry: Next 90 Days
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          <table className="v2-vaccine-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" />
                </th>
                <th>Vaccine Name</th>
                <th>Batch ID</th>
                <th>Expiry Date</th>
                <th>Remaining Qty</th>
                <th>Temp</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {vaccines.map((item) => (
                <tr key={item.batch}>
                  <td>
                    <input type="checkbox" />
                  </td>

                  <td>
                    <div className="v2-vaccine-cell">
                      <span>
                        <Package size={15} />
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.type}</small>
                      </div>
                    </div>
                  </td>

                  <td>{item.batch}</td>

                  <td>{item.expiry}</td>

                  <td>{item.qty}</td>

                  <td>
                    <span className="v2-temp-pill">{item.temp}</span>
                  </td>

                  <td>
                    <span className={`v2-stock-status ${item.level}`}>
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="v2-inventory-footer">
            <p>Displaying 1-10 of 124 batches</p>

            <div>
              <button onClick={() => navigate("/add-vaccine")}>
                <Plus size={14} />
                Add Vaccine
              </button>

              <button onClick={() => navigate("/add-stock")}>
                <Plus size={14} />
                Add Stock
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function HubCapacityCard() {
  const bars = [
    { label: "Pfizer", height: "86%", type: "blue" },
    { label: "Moderna", height: "60%", type: "green" },
    { label: "Sinovac", height: "78%", type: "amber" },
    { label: "J&J", height: "50%", type: "light" },
  ];

  return (
    <div className="v2-hub-card">
      <h2>Central Hub Capacity</h2>

      <div className="v2-hub-bars">
        {bars.map((bar) => (
          <div className="v2-hub-bar-item" key={bar.label}>
            <div>
              <span className={bar.type} style={{ height: bar.height }}></span>
            </div>
            <small>{bar.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdminSidebar({ active, onLogout }) {
  return (
    <aside className="inventory-sidebar">
      <h2>VaxTrack</h2>

      <div className="profile-mini">
        <div className="avatar">🧑‍💼</div>

        <div className="profile-mini-text">
          <h3>Logistics Admin</h3>
          <p>Manila Central Hub</p>
          <small>VaxTrack Web</small>
        </div>
      </div>

      <nav>
        <Link className={active === "dashboard" ? "active" : ""} to="/admin">
          <LayoutDashboard size={16} />
          <span>Dashboard</span>
        </Link>

        <Link className={active === "inventory" ? "active" : ""} to="/inventory">
          <Box size={16} />
          <span>Inventory</span>
        </Link>

        <Link className={active === "deliveries" ? "active" : ""} to="/deliveries">
          <Truck size={16} />
          <span>Deliveries</span>
        </Link>

        <Link className={active === "riders" ? "active" : ""} to="/riders">
          <Users size={16} />
          <span>Riders</span>
        </Link>

        <Link className={active === "clinics" ? "active" : ""} to="/clinics">
         <Building2 size={16} />
         <span>Clinics</span>
         </Link>

        <Link className={active === "analytics" ? "active" : ""} to="/analytics">
          <BarChart3 size={16} />
          <span>Analytics</span>
        </Link>

        <Link className={active === "alerts" ? "active" : ""} to="/alerts">
          <AlertTriangle size={16} />
          <span>Alerts</span>
        </Link>

        <Link className={active === "settings" ? "active" : ""} to="/settings">
          <Settings size={16} />
          <span>Settings</span>
        </Link>
      </nav>

      <button className="sidebar-logout" onClick={onLogout}>
        <LogOut size={16} />
        <span>Logout</span>
      </button>
    </aside>
  );
}

export default Inventory;
