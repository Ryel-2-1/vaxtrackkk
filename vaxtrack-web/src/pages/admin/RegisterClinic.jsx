import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  CircleHelp,
  ContactRound,
  Snowflake,
  Search,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Clinics.css";

function RegisterClinic() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    navigate("/clinic-success");
  };

  return (
    <div className="inventory-page clinics-shell register-clinic-shell">
      <AdminSidebar active="clinics" onLogout={handleLogout} />

      <main className="clinics-main register-clinic-main">
        <RegisterTopBar />

        <section className="register-clinic-header">
          <h1>Register New Clinic</h1>
          <p>
            Enter facility details, contact information, and logistics
            specifications to onboard a new clinic into the VaxTrack network.
          </p>
        </section>

        <form className="clinic-form" onSubmit={handleSubmit}>
          <FormCard
            icon={<Building2 size={17} />}
            title="Facility Information"
            tone="blue"
          >
            <div className="clinic-field full">
              <label>Clinic Name</label>
              <input placeholder="e.g. Metro Manila General Hospital" />
            </div>

            <div className="clinic-field">
              <label>Facility Type</label>
              <select defaultValue="">
                <option value="" disabled>Select facility type</option>
                <option>Hospital</option>
                <option>Clinic</option>
                <option>Health Center</option>
                <option>Rural Health Unit</option>
              </select>
            </div>

            <div className="clinic-field full">
              <label>Street Address</label>
              <input placeholder="Building, Street Name" />
            </div>

            <div className="clinic-field">
              <label>City/Municipality</label>
              <input placeholder="City" />
            </div>

            <div className="clinic-field">
              <label>Region</label>
              <select defaultValue="">
                <option value="" disabled>Select region</option>
                <option>Metro Manila</option>
                <option>CALABARZON</option>
                <option>Central Luzon</option>
              </select>
            </div>

            <div className="clinic-field">
              <label>Zip Code</label>
              <input placeholder="1000" />
            </div>
          </FormCard>

          <FormCard
            icon={<ContactRound size={17} />}
            title="Contact Details"
            tone="green"
          >
            <div className="clinic-field full">
              <label>Primary Contact Person</label>
              <input placeholder="Full Name" />
            </div>

            <div className="clinic-field">
              <label>Email Address</label>
              <input type="email" placeholder="contact@clinic.com" />
            </div>

            <div className="clinic-field">
              <label>Phone Number</label>
              <input placeholder="+63 XXX XXX XXXX" />
            </div>
          </FormCard>

          <FormCard
            icon={<Snowflake size={17} />}
            title="Logistics Specifications"
            tone="amber"
          >
            <div className="clinic-field">
              <label>Refrigeration Capacity</label>
              <select defaultValue="">
                <option value="" disabled>Select capacity level</option>
                <option>Small Capacity</option>
                <option>Medium Capacity</option>
                <option>Large Capacity</option>
              </select>
            </div>

            <div className="clinic-field">
              <label>Power Backup Type</label>
              <select defaultValue="">
                <option value="" disabled>Select backup type</option>
                <option>Generator</option>
                <option>Solar Backup</option>
                <option>UPS</option>
              </select>
            </div>
          </FormCard>

          <div className="clinic-form-actions">
            <button
              type="button"
              className="clinic-cancel-btn"
              onClick={() => navigate("/clinics")}
            >
              Cancel
            </button>

            <button type="submit" className="clinic-submit-btn">
              Register Clinic
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function RegisterTopBar() {
  return (
    <header className="clinics-topbar">
      <h1>Clinic Management</h1>

      <div className="clinics-search">
        <Search size={15} />
        <input placeholder="Search clinics..." />
      </div>

      <div className="clinics-top-icons">
        <button type="button"><Bell size={15} /></button>
        <button type="button"><CircleHelp size={15} /></button>
      </div>
    </header>
  );
}

function FormCard({ icon, title, tone, children }) {
  return (
    <section className="clinic-form-card">
      <div className="clinic-form-card-title">
        <span className={tone}>{icon}</span>
        <h2>{title}</h2>
      </div>

      <div className="clinic-form-grid">{children}</div>
    </section>
  );
}

export default RegisterClinic;
