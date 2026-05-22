import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import {
  AlertTriangle,
  Bell,
  CheckCircle,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Package,
  Search,
  Settings,
  ShoppingCart,
  Truck,
  User,
} from "lucide-react";
import { auth, db } from "../firebase";

function SalesRepDashboard() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("Sales Rep");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        navigate("/");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));

        if (!userSnap.exists()) {
          navigate("/");
          return;
        }

        const userData = userSnap.data();

        if (userData.status === "pending") {
          navigate("/pending");
          return;
        }

        if (
          userData.role !== "sales_rep" ||
          userData.department !== "sales" ||
          userData.status !== "approved"
        ) {
          navigate("/");
          return;
        }

        setFullName(userData.fullName || "Sales Rep");
      } catch (error) {
        console.error(error);
        navigate("/");
      } finally {
        setChecking(false);
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  if (checking) {
    return (
      <div className="screen-loader">
        <p>Checking sales rep access...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-layout sales-dashboard-layout">
      <aside className="sidebar">
        <h2>VaxTrack</h2>

        <div className="profile-mini">
          <div className="avatar">🧑‍💼</div>
          <div>
            <h3>{fullName}</h3>
            <p>Sales Department</p>
          </div>
        </div>

        <nav className="side-nav">
          <a className="active">
            <LayoutDashboard size={16} />
            Dashboard
          </a>
          <a>
            <Package size={16} />
            Inventory
          </a>
          <a>
            <Truck size={16} />
            Deliveries
          </a>
          <a>
            <AlertTriangle size={16} />
            Alerts
          </a>
          <a>
            <Settings size={16} />
            Settings
          </a>
        </nav>

        <button className="logout-button" onClick={handleLogout}>
          <LogOut size={16} />
          Logout
        </button>
      </aside>

      <main className="sales-main">
        <header className="sales-topbar">
          <h1>Sales Pro Dashboard</h1>

          <div className="sales-search">
            <Search size={16} />
            <input placeholder="Search orders, SKU..." />
          </div>

          <Bell size={19} />
        </header>

        <section className="sales-stats">
          <div className="sales-stat-card">
            <div className="sales-stat-icon blue">
              <ShoppingCart size={24} />
            </div>
            <div>
              <p>Total Orders (30D)</p>
              <h2>1,284</h2>
              <span>↗ +12% vs last month</span>
            </div>
          </div>

          <div className="sales-stat-card">
            <div className="sales-stat-icon green">
              <CheckCircle size={24} />
            </div>
            <div>
              <p>Fulfillment Rate</p>
              <h2>98.2%</h2>
              <span>Peak Efficiency</span>
            </div>
          </div>

          <div className="sales-stat-card">
            <div className="sales-stat-icon gray">
              <Truck size={24} />
            </div>
            <div>
              <p>Active Shipments</p>
              <h2>42</h2>
              <span>8 arriving today</span>
            </div>
          </div>
        </section>

        <section className="sales-content-grid">
          <div className="sales-map-panel">
            <div className="panel-header">
              <h2>Live Delivery Monitoring</h2>
              <div className="sales-badges">
                <span className="sales-badge-green">8 On-Time</span>
                <span className="sales-badge-red">2 Delayed</span>
              </div>
            </div>

            <div className="sales-map">
              <div className="glow glow-one"></div>
              <div className="glow glow-two"></div>
              <div className="route route-one"></div>
              <div className="route route-two"></div>
              <div className="route route-three"></div>

              <span className="map-marker m1">📍</span>
              <span className="map-marker m2">📍</span>
              <span className="map-marker m3">📍</span>
              <span className="map-marker m4">📍</span>

              <div className="map-alert left">
                <p>Next Arrival</p>
                <h3>St. Luke&apos;s Medical Center</h3>
                <span>12 mins away • 4.2km</span>
              </div>

              <div className="map-alert right">
                <p>Critical Delay</p>
                <h3>Cardinal Santos</h3>
                <span>Traffic Halt • +15m</span>
              </div>
            </div>
          </div>

          <aside className="sales-right-panel">
            <div className="activity-card">
              <div className="panel-header">
                <h2>Recent Activity</h2>
                <button>View All</button>
              </div>

              <ActivityItem
                icon={<CheckCircle size={16} />}
                title="Order #VX-8821 delivered to Manila Doctors Hospital."
                time="2 mins ago"
                type="success"
              />

              <ActivityItem
                icon={<ClipboardList size={16} />}
                title="Batch Release: Lot B-1049 approved for distribution."
                time="15 mins ago"
                type="info"
              />

              <ActivityItem
                icon={<AlertTriangle size={16} />}
                title="Temperature Alert: Cold chain deviation detected."
                time="1 hour ago"
                type="danger"
              />

              <ActivityItem
                icon={<User size={16} />}
                title="New Client: Makati Health District joined the portal."
                time="3 hours ago"
                type="neutral"
              />
            </div>

            <div className="approval-card">
              <h2>Review Pending Approvals</h2>

              <ApprovalRow id="ORDER #VX-6608" place="San Pedro City" status="Pending" />
              <ApprovalRow id="ORDER #VX-6667" place="Cavite, Imus" status="Approved" />
              <ApprovalRow id="ORDER #VX-6669" place="BGC, Taguig" status="Decline" />
            </div>
          </aside>
        </section>

        <section className="inventory-snapshot">
          <div className="panel-header">
            <div>
              <h2>Inventory Snapshot</h2>
              <p>Monitoring 12 active vaccine variants across 4 sub-depots.</p>
            </div>
            <button>+ New Order</button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Product Name</th>
                <th>SKU / Batch</th>
                <th>Stock Level</th>
                <th>Expiration</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              <InventoryRow
                name="VaxPro-22 mRNA"
                manufacturer="BioSystems Inc."
                sku="VX-22-990-B"
                stock="14,200"
                expiration="Oct 12, 2026"
                status="Optimal"
                statusType="optimal"
              />

              <InventoryRow
                name="Influen-Z Quad"
                manufacturer="GlobalMed"
                sku="IZ-44-112-Q"
                stock="2,400"
                expiration="Jun 22, 2026"
                status="Critical Stock"
                statusType="critical"
              />

              <InventoryRow
                name="PediaShield-5"
                manufacturer="VacTrac Labs"
                sku="PS-55-883-M"
                stock="8,900"
                expiration="Dec 05, 2026"
                status="Stable"
                statusType="stable"
              />
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

function ActivityItem({ icon, title, time, type }) {
  return (
    <div className={`activity-item ${type}`}>
      <div className="activity-icon">{icon}</div>
      <div>
        <h3>{title}</h3>
        <p>{time}</p>
      </div>
    </div>
  );
}

function ApprovalRow({ id, place, status }) {
  return (
    <div className="approval-row">
      <div>
        <h3>{id}</h3>
        <p>{place}</p>
      </div>
      <span className={`approval-status ${status.toLowerCase()}`}>
        {status}
      </span>
    </div>
  );
}

function InventoryRow({
  name,
  manufacturer,
  sku,
  stock,
  expiration,
  status,
  statusType,
}) {
  return (
    <tr>
      <td>
        <div className="product-cell">
          <span>💉</span>
          <div>
            <h3>{name}</h3>
            <p>Manufacturer: {manufacturer}</p>
          </div>
        </div>
      </td>
      <td>{sku}</td>
      <td>
        <strong>{stock}</strong> units
        <div className="stock-line">
          <span className={statusType}></span>
        </div>
      </td>
      <td>{expiration}</td>
      <td>
        <span className={`inventory-status ${statusType}`}>{status}</span>
      </td>
      <td>
        <button className="view-all-btn">VIEW ALL</button>
      </td>
    </tr>
  );
}

export default SalesRepDashboard;