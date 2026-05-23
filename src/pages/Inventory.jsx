import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Box,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
  LayoutDashboard,
  LogOut,
  Package,
  Plus,
  Search,
  Settings,
  Truck,
  Users,
} from "lucide-react";
import { auth, db } from "../firebase";

function Inventory() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [vaccines, setVaccines] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadInventory = async () => {
    try {
      setLoading(true);

      const inventoryQuery = query(
        collection(db, "inventory"),
        orderBy("createdAt", "desc")
      );

      const vaccineQuery = query(
        collection(db, "vaccines"),
        orderBy("createdAt", "desc")
      );

      const [inventorySnap, vaccineSnap] = await Promise.all([
        getDocs(inventoryQuery),
        getDocs(vaccineQuery),
      ]);

      setItems(
        inventorySnap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
      );

      setVaccines(
        vaccineSnap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
      );
    } catch (error) {
      console.error("Inventory load error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) {
        navigate("/");
        return;
      }

      loadInventory();
    });

    return () => unsub();
  }, [navigate]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const totalStock = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const expiringSoon = items.filter((item) => item.status === "Critical").length;

  return (
    <div className="inventory-page">
      <AdminSidebar active="inventory" onLogout={handleLogout} />

      <main className="inventory-main">
        <header className="inventory-topbar">
          <div>
            <h1>Inventory Monitoring</h1>
            <p>Real-time stock and cold-chain status</p>
          </div>

          <div className="inventory-actions">
            <div className="inventory-search">
              <Search size={16} />
              <input placeholder="Search batches, vaccines..." />
            </div>

            <Bell size={18} />

            <button onClick={() => navigate("/add-stock")}>
              <Plus size={15} />
              Add Stock
            </button>

            <button onClick={() => navigate("/add-vaccine")}>
              <Plus size={15} />
              Add Vaccine
            </button>
          </div>
        </header>

        <section className="inventory-summary-grid">
          <div className="capacity-card">
            <h2>Central Hub Capacity</h2>

            <div className="capacity-bars">
              <div className="capacity-item">
                <div className="bar-wrap">
                  <span className="bar pfizer"></span>
                </div>
                <p>Pfizer</p>
              </div>

              <div className="capacity-item">
                <div className="bar-wrap">
                  <span className="bar moderna"></span>
                </div>
                <p>Moderna</p>
              </div>

              <div className="capacity-item">
                <div className="bar-wrap">
                  <span className="bar sinovac"></span>
                </div>
                <p>Sinovac</p>
              </div>

              <div className="capacity-item">
                <div className="bar-wrap">
                  <span className="bar jnj"></span>
                </div>
                <p>J&J</p>
              </div>
            </div>
          </div>

          <div className="inventory-kpi-column">
            <div className="inventory-kpi">
              <div className="kpi-icon amber">
                <CalendarDays size={22} />
              </div>
              <div>
                <p>Expiring &lt; 30 Days</p>
                <h2>{expiringSoon || 0}</h2>
                <span>vials</span>
              </div>
            </div>

            <div className="inventory-kpi">
              <div className="kpi-icon green">
                <Package size={22} />
              </div>
              <div>
                <p>Total Safe Stock</p>
                <h2>{totalStock.toLocaleString()}</h2>
                <span>Optimal</span>
              </div>
            </div>
          </div>
        </section>

        <section className="inventory-table-card">
          <div className="inventory-table-toolbar">
            <div className="inventory-search small">
              <Search size={16} />
              <input placeholder="Search batch ID..." />
            </div>

            <div className="filter-buttons">
              <button className="active">All Vaccines</button>
              <button>Pfizer</button>
              <button>Sinovac</button>
              <button>Moderna</button>
              <button>
                <Filter size={14} />
                Filter
              </button>
            </div>
          </div>

          <table className="inventory-table">
            <thead>
             <tr>
  <th>Vaccine</th>
  <th>Type</th>
  <th>Batch ID</th>
  <th>Expiry Date</th>
  <th>Quantity</th>
  <th>Storage Temp</th>
  <th>Status</th>
  <th>Action</th>
</tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="8">Loading inventory...</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan="8">No inventory records yet. Add stock first.</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                   <td>
  <div className="vaccine-cell">
    <span>💉</span>
    <div>
      <h3>{item.vaccineName}</h3>
      <p>{item.manufacturer || "No manufacturer"}</p>
    </div>
  </div>
</td>

<td>{item.vaccineType || "N/A"}</td>

<td>{item.batchId}</td>

<td>{item.expiryDate || "N/A"}</td>

<td>{Number(item.quantity || 0).toLocaleString()}</td>

<td>
  <span className={`temp-pill ${getTempClass(item.storageTemp)}`}>
    {item.storageTemp}
  </span>
</td>

<td>
  <span className={`status-pill ${getStatusClass(item.status)}`}>
    {item.status}
  </span>
</td>

<td>
  <button className="view-all-btn">VIEW ALL</button>
</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="inventory-pagination">
            <p>
              Showing 1 to {items.length} of {items.length} batch
              {items.length === 1 ? "" : "es"}
            </p>

            <div>
              <button>
                <ChevronLeft size={14} />
              </button>
              <button className="active">1</button>
              <button>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>

        <section className="vaccine-mini-card">
          <h2>Registered Vaccines</h2>
          <p>{vaccines.length} vaccine profile{vaccines.length === 1 ? "" : "s"} registered</p>
        </section>
      </main>
    </div>
  );
}

function getStatusClass(status) {
  if (status === "Critical") return "critical";
  if (status === "Warning") return "warning";
  return "stable";
}

function getTempClass(temp) {
  if (!temp) return "";
  if (temp.includes("-70")) return "deep-freeze";
  if (temp.includes("-15")) return "alert";
  return "normal";
}

function AdminSidebar({ active, onLogout }) {
  return (
    <aside className="inventory-sidebar">
      <h2>VaxTrack</h2>

      <div className="profile-mini">
        <div className="avatar">🧑‍💼</div>
        <div>
          <h3>Logistics Admin</h3>
          <p>Manila Central Hub</p>
          <small>VaxTrack Web</small>
        </div>
      </div>

      <nav>
        <Link className={active === "dashboard" ? "active" : ""} to="/admin">
          <LayoutDashboard size={16} />
          Dashboard
        </Link>

        <Link className={active === "inventory" ? "active" : ""} to="/inventory">
          <Box size={16} />
          Inventory
        </Link>

        <a>
          <Truck size={16} />
          Deliveries
        </a>

        <a>
          <Users size={16} />
          Riders
        </a>

        <a>
          <BarChart3 size={16} />
          Analytics
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

      <button className="sidebar-logout" onClick={onLogout}>
        <LogOut size={16} />
        Logout
      </button>
    </aside>
  );
}

export { AdminSidebar };
export default Inventory;