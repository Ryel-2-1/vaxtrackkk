import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Box,
  Truck,
  Users,
  Building2,
  FileText,
  BarChart3,
  AlertTriangle,
  Settings,
  LogOut,
} from "lucide-react";
import "./AdminSidebar.css";

/// Shared Admin navigation sidebar. The single source of the sidebar markup —
/// used by AdminLayout (and directly by admin pages not yet on AdminLayout).
/// Keeps the `.inventory-sidebar` class so the existing green shell styling +
/// AdminSidebar.css layout apply; `active` drives the highlight + aria-current.
export function AdminSidebar({ active, onLogout }) {
  return (
    <aside className="inventory-sidebar" id="admin-nav" aria-label="Admin navigation">
      <h2>VaxTrack</h2>

      <span className="m-role-chip">
        <span className="m-role-dot" />
        Admin Console
      </span>

      <div className="profile-mini">
        <div className="avatar">LA</div>
        <div className="profile-mini-text">
          <h3>Logistics Admin</h3>
          <p>Manila Central Hub</p>
          <small>VaxTrack Web</small>
        </div>
      </div>

      <nav>
        <Link
          className={active === "dashboard" ? "active" : ""}
          aria-current={active === "dashboard" ? "page" : undefined}
          to="/admin"
        >
          <LayoutDashboard size={16} aria-hidden="true" />
          <span>Dashboard</span>
        </Link>

        <p className="admin-nav-group">Operations</p>

        <Link
          className={active === "inventory" ? "active" : ""}
          aria-current={active === "inventory" ? "page" : undefined}
          to="/admin/inventory"
        >
          <Box size={16} aria-hidden="true" />
          <span>Inventory</span>
        </Link>

        <Link
          className={active === "deliveries" ? "active" : ""}
          aria-current={active === "deliveries" ? "page" : undefined}
          to="/admin/deliveries"
        >
          <Truck size={16} aria-hidden="true" />
          <span>Deliveries</span>
        </Link>

        <Link
          className={active === "riders" ? "active" : ""}
          aria-current={active === "riders" ? "page" : undefined}
          to="/admin/riders"
        >
          <Users size={16} aria-hidden="true" />
          <span>Riders</span>
        </Link>

        <Link
          className={active === "clinics" ? "active" : ""}
          aria-current={active === "clinics" ? "page" : undefined}
          to="/admin/clinics"
        >
          <Building2 size={16} aria-hidden="true" />
          <span>Clinics</span>
        </Link>

        <p className="admin-nav-group">Records</p>

        <Link
          className={active === "invoices" ? "active" : ""}
          aria-current={active === "invoices" ? "page" : undefined}
          to="/admin/invoices"
        >
          <FileText size={16} aria-hidden="true" />
          <span>Invoices</span>
        </Link>

        <Link
          className={active === "analytics" ? "active" : ""}
          aria-current={active === "analytics" ? "page" : undefined}
          to="/admin/analytics"
        >
          <BarChart3 size={16} aria-hidden="true" />
          <span>Analytics</span>
        </Link>

        <p className="admin-nav-group">System</p>

        <Link
          className={active === "alerts" ? "active" : ""}
          aria-current={active === "alerts" ? "page" : undefined}
          to="/admin/alerts"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Alerts</span>
        </Link>

        <Link
          className={active === "settings" ? "active" : ""}
          aria-current={active === "settings" ? "page" : undefined}
          to="/admin/settings"
        >
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </Link>
      </nav>

      <button type="button" className="sidebar-logout" onClick={onLogout}>
        <LogOut size={16} aria-hidden="true" />
        <span>Logout</span>
      </button>
    </aside>
  );
}

export default AdminSidebar;
