import {
  Bike,
  ChevronRight,
  ClipboardList,
  FileText,
  Settings,
  Truck,
  UserRound,
} from "lucide-react";
import RiderLayout from "./RiderLayout";

function RiderProfile() {
  return (
    <RiderLayout active="profile">
      <section className="rider-profile-v2">
        <div className="rider-profile-title">
          <span>RIDER PROFILE</span>
          <h2>Juan Dela Cruz</h2>
        </div>

        <section className="rider-profile-main-card">
          <div className="rider-profile-top">
            <div className="rider-profile-avatar"></div>

            <div className="rider-profile-info">
              <div className="rider-profile-badges">
                <span>ACTIVE</span>
                <span>COLD CHAIN CERTIFIED</span>
              </div>

              <h3>ID: VT-8824</h3>
              <p>Quezon City Hub</p>
            </div>
          </div>

          <div className="rider-profile-stats">
            <div>
              <strong>1,248</strong>
              <span>Deliveries</span>
            </div>

            <div>
              <strong>99.8%</strong>
              <span>On-Time</span>
            </div>
          </div>
        </section>

        <section className="rider-profile-card">
          <h3>CURRENT STATUS</h3>

          <div className="rider-current-status">
            <div className="rider-current-icon">
              <Truck size={18} />
            </div>

            <div className="rider-current-text">
              <strong>En Route: Manila Med</strong>
              <span>ETA 14 mins</span>
            </div>

            <div className="rider-current-temp">
              <strong>2.4°C</strong>
              <span>Box Temp Stable</span>
            </div>
          </div>

          <div className="rider-profile-progress">
            <span></span>
          </div>

          <div className="rider-profile-progress-labels">
            <span>HUB</span>
            <span>DESTINATION</span>
          </div>
        </section>

        <section className="rider-profile-card">
          <h3 className="rider-card-title-icon">
            <Bike size={15} />
            Vehicle Info
          </h3>

          <ProfileRow label="Type" value="Honda ADV 150" />
          <ProfileRow label="Plate Number" value="NCP 1234" />
          <ProfileRow label="Box Capacity" value="45L (Cooled)" />
        </section>

        <section className="rider-profile-card">
          <h3 className="rider-card-title-icon">
            <Settings size={15} />
            Account Settings
          </h3>

          <SettingsRow icon={<UserRound size={14} />} label="Personal Information" />
          <SettingsRow icon={<ClipboardList size={14} />} label="Delivery History" />
          <SettingsRow icon={<FileText size={14} />} label="Documents & Contracts" />
        </section>
      </section>
    </RiderLayout>
  );
}

function ProfileRow({ label, value }) {
  return (
    <div className="rider-profile-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsRow({ icon, label }) {
  return (
    <div className="rider-profile-settings-row">
      <span>
        {icon}
        {label}
      </span>

      <ChevronRight size={15} />
    </div>
  );
}

export default RiderProfile;