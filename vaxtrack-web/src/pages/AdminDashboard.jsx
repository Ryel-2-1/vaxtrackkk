import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";
import {
  AlertTriangle,
  Bike,
  Clock,
  LayoutDashboard,
  LogOut,
  Package,
  Settings,
  Truck,
  Users,
} from "lucide-react";
import { auth, db } from "../firebase";

function AdminDashboard() {
  const navigate = useNavigate();

  const [inventoryCount, setInventoryCount] = useState(0);
  const [deliveryCount, setDeliveryCount] = useState(0);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadDashboardData = async () => {
    try {
      const inventorySnap = await getDocs(collection(db, "inventory"));
      const deliveriesQuery = query(
        collection(db, "deliveries"),
        orderBy("createdAt", "desc")
      );
      const deliveriesSnap = await getDocs(deliveriesQuery);

      setInventoryCount(inventorySnap.size);
      setDeliveryCount(deliveriesSnap.size);

      const deliveryList = deliveriesSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      setDeliveries(deliveryList);
    } catch (error) {
      console.error("Dashboard load error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        navigate("/");
      } else {
        loadDashboardData();
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <h2>VaxTrack</h2>

        <div className="profile-mini">
          <div className="avatar">🛵</div>
          <div>
            <h3>Logistics Admin</h3>
            <p>Manila Central Hub</p>
          </div>
        </div>

        <nav className="side-nav">
          <a className="active">
            <LayoutDashboard size={16} />
            Dashboard
          </a>
         <Link to="/inventory">
  <Package size={16} />
  Inventory
</Link>
          <a>
            <Truck size={16} />
            Deliveries
          </a>
          <a>
            <Bike size={16} />
            Riders
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

      <main className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <h1>VaxTrack Logistics Command</h1>
            <p>Overview of current operations and active alerts.</p>
          </div>
        </header>

        <section className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon blue">🚚</div>
            <h2>{loading ? "..." : deliveryCount}</h2>
            <p>Active Deliveries</p>
          </div>

          <div className="stat-card">
            <div className="stat-icon yellow">⏱</div>
            <h2>3</h2>
            <p>Delayed Warning</p>
          </div>

          <div className="stat-card">
            <div className="stat-icon red">📦</div>
            <h2>{loading ? "..." : inventoryCount}</h2>
            <p>Inventory Items</p>
          </div>

          <div className="stat-card">
            <div className="stat-icon green">🏍</div>
            <h2>1</h2>
            <p>Riders Online</p>
          </div>
        </section>

        <section className="dashboard-content">
          <div className="tracking-panel">
            <div className="panel-header">
              <h2>Real-time Rider Tracking</h2>
              <button>All Regions</button>
            </div>

            <div className="map-placeholder">
              <div className="map-line"></div>
              <div className="map-pin pin-one">📍</div>
              <div className="map-pin pin-two">📍</div>
              <div className="rider-badge">🏍 Rider 0809 — Delayed</div>
              <div className="rider-badge second">🏍 Rider 1104 — On route</div>
            </div>
          </div>

          <div className="alerts-panel">
            <div className="panel-header">
              <h2>Recent Alerts</h2>
              <span className="badge">4 New</span>
            </div>

            <div className="alert-card danger">
              <h3>Temp Warning</h3>
              <p>Delivery TRK-892 reporting temperature deviation.</p>
            </div>

            <div className="alert-card warning">
              <h3>Route Delay</h3>
              <p>Rider 0809 delayed due to heavy congestion.</p>
            </div>

            <div className="alert-card info">
              <h3>Stock Alert</h3>
              <p>Flu vaccine inventory needs monitoring.</p>
            </div>

            <div className="alert-card success">
              <h3>Delivery Completed</h3>
              <p>Health center delivery marked as completed.</p>
            </div>
          </div>
        </section>

        <section className="table-section">
          <h2>Recent Deliveries From Firestore</h2>

          {deliveries.length === 0 ? (
            <p className="empty-text">No deliveries found.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Destination</th>
                  <th>Rider</th>
                  <th>Items</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{delivery.destination}</td>
                    <td>{delivery.riderName}</td>
                    <td>{delivery.items}</td>
                    <td>
                      <span className="status-pill">
                        {delivery.deliveryStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}

export default AdminDashboard;