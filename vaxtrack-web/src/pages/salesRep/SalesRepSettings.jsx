import { Save, UserRound } from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepSettings() {
  return (
    <SalesRepLayout active="settings" title="Settings" showSearch={false}>
      <section className="salesrep-page-title">
        <h1>Sales Representative Settings</h1>
        <p>Manage profile, notification preferences, and order defaults.</p>
      </section>

      <section className="settings-simple-grid">
        <div className="salesrep-card">
          <h2><UserRound size={18} /> Profile Information</h2>
          <div className="simple-form-grid">
            <div><label>Full Name</label><input defaultValue="Sales Representative" /></div>
            <div><label>Email</label><input defaultValue="salesrep@vaxtrack.ph" /></div>
            <div><label>Assigned Hub</label><input defaultValue="Manila Central Hub" /></div>
            <div><label>Role</label><input defaultValue="Sales Representative" /></div>
          </div>
          <button className="salesrep-save-btn"><Save size={15} /> Save Profile</button>
        </div>

        <div className="salesrep-card">
          <h2>Notification Preferences</h2>
          <Toggle title="Order status updates" enabled />
          <Toggle title="Low stock alerts" enabled />
          <Toggle title="Cold-chain alerts" enabled />
          <Toggle title="Approval reminders" />
        </div>
      </section>
    </SalesRepLayout>
  );
}

function Toggle({ title, enabled }) {
  return <div className="sales-toggle-row"><span>{title}</span><button className={enabled ? "enabled" : ""}><i></i></button></div>;
}

export default SalesRepSettings;
