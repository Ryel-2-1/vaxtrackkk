import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  ChevronDown,
  Clock,
  Globe,
  MoreVertical,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Settings.css";

function Settings() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("general");

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="settings" onLogout={handleLogout} />

      <main className="settings-v2-main">
        <header className="settings-v2-topbar">
          <div className="settings-search">
            <Search size={14} />
            <input placeholder="Search settings or ID..." />
          </div>

          <div className="settings-top-icons">
            <button>
              <Bell size={15} />
            </button>
            <button>
              <Clock size={15} />
            </button>
            <button>
              <ShieldCheck size={15} />
            </button>
          </div>
        </header>

        <section className="settings-v2-header settings-title-left">
  <div>
    <h1>
      {activeTab === "general"
        ? "Admin Settings - Alert Configuration"
        : "User Management"}
    </h1>

    <p>
      {activeTab === "general"
        ? "Manage organization details and system-wide logistics rules."
        : "Manage your organization's personnel, permissions, and registration requests."}
    </p>
  </div>
</section>

        <div className="settings-tabs">
          <button
            className={activeTab === "general" ? "active" : ""}
            onClick={() => setActiveTab("general")}
          >
            General
          </button>

          <button
            className={activeTab === "users" ? "active" : ""}
            onClick={() => setActiveTab("users")}
          >
            User Management
          </button>
        </div>

        {activeTab === "general" ? <GeneralSettings /> : <UserManagement />}
      </main>
    </div>
  );
}

function GeneralSettings() {
  return (
    <section className="settings-v2-grid">
      <div className="settings-v2-left">
        <div className="settings-v2-card">
          <div className="settings-card-title">
            <Building2 size={17} />
            <h2>Organization Profile</h2>
          </div>

          <div className="settings-form-grid">
            <div>
              <label>Organization Name</label>
              <input defaultValue="VaxTrack Philippines" />
            </div>

            <div>
              <label>Registration ID</label>
              <input defaultValue="ORG-PH-2023-8842" />
            </div>

            <div>
              <label>Primary Contact</label>
              <input defaultValue="admin@vaxtrack.ph" />
            </div>
          </div>
        </div>

        <div className="settings-v2-card">
          <div className="settings-card-title">
            <Globe size={17} />
            <h2>Regional Settings</h2>
          </div>

          <div className="settings-form-grid three">
            <div>
              <label>Time Zone</label>
              <select defaultValue="asia">
                <option value="asia">Asia/Manila GMT+8</option>
              </select>
            </div>

            <div>
              <label>Language</label>
              <select defaultValue="en">
                <option value="en">English (US)</option>
              </select>
            </div>

            <div>
              <label>Date Format</label>
              <select defaultValue="dmy">
                <option value="dmy">DD/MM/YYYY</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-action-row">
          <button className="discard-btn">Discard Changes</button>

          <button className="save-settings-btn">
            <Save size={14} />
            Save Settings
          </button>
        </div>
      </div>

      <aside className="settings-v2-card system-card">
        <div className="settings-card-title">
          <SettingsIcon size={17} />
          <h2>System Features</h2>
        </div>

        <div className="feature-list">
          <FeatureToggle
            title="Enable inventory alerts"
            desc="Receive notifications for warehouse movements"
            enabled
          />

          <FeatureToggle
            title="Enable low stock alerts"
            desc="Notify when levels drop below threshold"
            enabled
          />

          <FeatureToggle
            title="Enable expired/near-expiry vaccine alerts"
            desc="Warnings for stock reaching end-of-life"
            enabled
          />

          <FeatureToggle
            title="Enable route deviation alerts"
            desc="Track real-time courier pathing anomalies"
          />

          <FeatureToggle
            title="Enable delivery status notifications"
            desc="Automatic updates on shipment progress"
            enabled
          />
        </div>
      </aside>
    </section>
  );
}

function UserManagement() {
  const staff = [
    {
      name: "Albert Pangilinan",
      email: "albert.p@vaxtrack.ph",
      role: "Senior Dispatcher",
      status: "Active",
      type: "active",
    },
    {
      name: "Clarisse Ramos",
      email: "clarisse.r@vaxtrack.ph",
      role: "Inventory Manager",
      status: "Pending",
      type: "pending",
    },
    {
      name: "Mateo Garcia",
      email: "m.garcia@vaxtrack.ph",
      role: "Manager",
      status: "Active",
      type: "active",
    },
  ];

  return (
    <section className="user-management-card">
      <div className="staff-card-header">
        <div className="settings-card-title">
          <Users size={17} />
          <h2>Staff Directory</h2>
        </div>

        <div className="staff-actions">
          <button>
            Fast Cash
            <ChevronDown size={13} />
          </button>

          <button>
            All Roles
            <ChevronDown size={13} />
          </button>

          <button>
            All Branches
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      <table className="staff-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {staff.map((person) => (
            <tr key={person.email}>
              <td>
                <div className="staff-profile">
                  <div className="staff-avatar">
                    <UserRound size={16} />
                  </div>

                  <div>
                    <strong>{person.name}</strong>
                    <small>{person.email}</small>
                  </div>
                </div>
              </td>

              <td>{person.role}</td>

              <td>
                <span className={`staff-status ${person.type}`}>
                  {person.status}
                </span>
              </td>

              <td>
                <button className="table-action-btn">
                  <MoreVertical size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="staff-pagination">
        <p>Showing 1-10 of 42 employees</p>

        <div>
          <button>Previous</button>
          <button className="active">Next</button>
        </div>
      </div>
    </section>
  );
}

function FeatureToggle({ title, desc, enabled = false }) {
  return (
    <div className="feature-toggle-row">
      <div>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>

      <button className={`settings-toggle ${enabled ? "enabled" : ""}`}>
        <span></span>
      </button>
    </div>
  );
}

export default Settings;