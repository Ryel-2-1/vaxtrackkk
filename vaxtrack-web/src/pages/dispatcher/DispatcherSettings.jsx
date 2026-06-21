import { useState } from "react";
import {
  Bell,
  CheckCircle2,
  Clock,
  MapPinned,
  Save,
  ShieldCheck,
  Truck,
  UserRound,
} from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherSettings() {
  const [profile, setProfile] = useState({
    fullName: "Dispatcher User",
    email: "dispatcher@vaxtrack.com",
    assignedHub: "Main Distribution Hub-A",
    role: "Dispatcher",
  });

  const [preferences, setPreferences] = useState({
    shipmentAlerts: true,
    geofenceAlerts: true,
    cargoReminders: true,
    routeOverride: false,
  });

  const [saved, setSaved] = useState(false);

  const handleProfileChange = (field, value) => {
    setProfile((prev) => ({
      ...prev,
      [field]: value,
    }));

    setSaved(false);
  };

  const handleToggle = (key) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSaveProfile = () => {
    localStorage.setItem("dispatcherProfile", JSON.stringify(profile));
    localStorage.setItem("dispatcherPreferences", JSON.stringify(preferences));

    setSaved(true);

    setTimeout(() => {
      setSaved(false);
    }, 2500);
  };

  return (
    <DispatcherLayout active="settings" title="VaxTrack Logistics">
      <section className="dispatcher-page-title">
        <h1>Dispatcher Settings</h1>
        <p>Manage dispatch profile, monitoring preferences, and alert rules.</p>
      </section>

      {saved && (
        <div className="dispatcher-save-message">
          <CheckCircle2 size={17} />
          Settings saved successfully.
        </div>
      )}

      <section className="dispatcher-settings-grid">
        <div className="dispatcher-settings-card">
          <div className="settings-card-heading">
            <UserRound size={18} />
            <h2>Profile Information</h2>
          </div>

          <div className="dispatcher-form-grid">
            <label>
              Full Name
              <input
                value={profile.fullName}
                onChange={(e) => handleProfileChange("fullName", e.target.value)}
              />
            </label>

            <label>
              Email
              <input
                value={profile.email}
                onChange={(e) => handleProfileChange("email", e.target.value)}
              />
            </label>

            <label>
              Assigned Hub
              <input
                value={profile.assignedHub}
                onChange={(e) =>
                  handleProfileChange("assignedHub", e.target.value)
                }
              />
            </label>

            <label>
              Role
              <input
                value={profile.role}
                onChange={(e) => handleProfileChange("role", e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="dispatcher-blue-btn save-profile"
            onClick={handleSaveProfile}
          >
            <Save size={15} />
            Save Profile
          </button>
        </div>

        <aside className="dispatcher-settings-card">
          <div className="settings-card-heading">
            <Bell size={18} />
            <h2>Dispatch Preferences</h2>
          </div>

          <SettingToggle
            icon={<Truck size={16} />}
            title="Shipment assignment alerts"
            enabled={preferences.shipmentAlerts}
            onClick={() => handleToggle("shipmentAlerts")}
          />

          <SettingToggle
            icon={<MapPinned size={16} />}
            title="Geofence deviation alerts"
            enabled={preferences.geofenceAlerts}
            onClick={() => handleToggle("geofenceAlerts")}
          />

          <SettingToggle
            icon={<Clock size={16} />}
            title="Cargo loading reminders"
            enabled={preferences.cargoReminders}
            onClick={() => handleToggle("cargoReminders")}
          />

          <SettingToggle
            icon={<ShieldCheck size={16} />}
            title="Critical route override approval"
            enabled={preferences.routeOverride}
            onClick={() => handleToggle("routeOverride")}
          />
        </aside>
      </section>
    </DispatcherLayout>
  );
}

function SettingToggle({ icon, title, enabled, onClick }) {
  return (
    <div className="dispatcher-toggle-row">
      <div className="dispatcher-toggle-label">
        {icon}
        <strong>{title}</strong>
      </div>

      <button
        type="button"
        className={`dispatcher-toggle ${enabled ? "enabled" : ""}`}
        onClick={onClick}
        aria-label={title}
      >
        <span></span>
      </button>
    </div>
  );
}

export default DispatcherSettings;