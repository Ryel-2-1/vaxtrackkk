import { Link, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Box,
  LayoutDashboard,
  LogOut,
  Settings,
  Truck,
} from "lucide-react";
import { auth } from "../../firebase";
import "./SalesRep.css";

function SalesRepLayout({ active, title, children, topbarTitle, showSearch = true }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="salesrep-page">
      <aside className="salesrep-sidebar">
        <div className="salesrep-brand">VaxTrack</div>

        <div className="salesrep-profile">
          <div className="salesrep-profile-icon">👨‍💼</div>
          <div>
            <h3>Sales Representative</h3>
            <p>Manila Central Hub</p>
            <small>VaxTrack Web</small>
          </div>
        </div>

        <nav className="salesrep-nav">
          <Link className={active === "dashboard" ? "active" : ""} to="/sales-rep">
            <LayoutDashboard size={17} />
            <span>Dashboard</span>
          </Link>

          <Link className={active === "inventory" ? "active" : ""} to="/sales-rep/inventory">
            <Box size={17} />
            <span>Inventory</span>
          </Link>

          <Link className={active === "request" ? "active" : ""} to="/sales-rep/request-order">
            <Truck size={17} />
            <span>Request Order</span>
          </Link>

          <Link className={active === "alerts" ? "active" : ""} to="/sales-rep/alerts">
            <AlertTriangle size={17} />
            <span>Alerts</span>
          </Link>

          <Link className={active === "settings" ? "active" : ""} to="/sales-rep/settings">
            <Settings size={17} />
            <span>Settings</span>
          </Link>
        </nav>

        <button type="button" className="salesrep-logout" onClick={handleLogout}>
          <LogOut size={17} />
          <span>Logout</span>
        </button>
      </aside>

      <main className="salesrep-main">
        <header className="salesrep-topbar">
          <h1>{topbarTitle || title}</h1>

          <div className="salesrep-topbar-right">
            {showSearch && (
              <div className="salesrep-search">
                <span>⌕</span>
                <input placeholder="Search orders, SKU..." />
              </div>
            )}

            <button type="button" className="salesrep-icon-btn">
              <Bell size={16} />
            </button>
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}

export default SalesRepLayout;
