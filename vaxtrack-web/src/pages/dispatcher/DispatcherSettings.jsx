import {
  Bell,
  Clock,
  MapPinned,
  Save,
  ShieldCheck,
  Truck,
  UserRound,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherSettings() {
  return (
    <DispatcherLayout active="settings" title="VaxTrack Logistics">
      <section className="dispatcher-page-title">
        <h1>Dispatcher Settings</h1>
        <p>Manage dispatch profile, monitoring preferences, and alert rules.</p>
      </section>

      <section className="dispatcher-settings-grid">
        <div className="dispatcher-settings-card">
          <div className="settings-card-heading">
            <UserRound size={18} />
            <h2>Profile Information</h2>
          </div>

          <div className="dispatcher-form-grid">
            <label>
              Full Name
              <input defaultValue="Dispatcher User" />
            </label>

            <label>
              Email
              <input defaultValue="dispatcher@vaxtrack.ph" />
            </label>

            <label>
              Assigned Hub
              <input defaultValue="Main Distribution Hub-A" />
            </label>

            <label>
              Role
              <input defaultValue="Dispatcher" />
            </label>
          </div>

          <button className="dispatcher-blue-btn save-profile">
            <Save size={15} />
            Save Profile
          </button>
        </div>

        <aside className="dispatcher-settings-card">
          <div className="settings-card-heading">
            <Bell size={18} />
            <h2>Dispatch Preferences</h2>
          </div>

          <SettingToggle icon={<Truck size={16} />} title="Shipment assignment alerts" enabled />
          <SettingToggle icon={<MapPinned size={16} />} title="Geofence deviation alerts" enabled />
          <SettingToggle icon={<Clock size={16} />} title="Cargo loading reminders" enabled />
          <SettingToggle icon={<ShieldCheck size={16} />} title="Critical route override approval" />
        </aside>
      </section>
    </DispatcherLayout>
  );
}

function SettingToggle({ icon, title, enabled }) {
  return (
    <div className="dispatcher-toggle-row">
      <div>
        {icon}
        <strong>{title}</strong>
      </div>

      <button className={`dispatcher-toggle ${enabled ? "enabled" : ""}`}>
        <span></span>
      </button>
    </div>
  );
}

export default DispatcherSettings;
