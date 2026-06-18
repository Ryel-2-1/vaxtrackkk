import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  Check,
  CircleHelp,
  ClipboardCheck,
  Eye,
  FilePlus2,
  Hospital,
  Info,
  Network,
  Search,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Clinics.css";

function ClinicSuccess() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="inventory-page clinics-shell clinic-success-shell">
      <AdminSidebar active="clinics" onLogout={handleLogout} />

      <main className="clinics-main clinic-success-main">
        <SuccessTopBar />

        <section className="clinic-success-card">
          <div className="success-green-line"></div>

          <div className="success-check">
            <Check size={30} />
          </div>

          <h1>Registration Successful!</h1>
          <p>
            The facility has been successfully added to the VaxTrack network.
            Logistics operations can now be scheduled for this node.
          </p>

          <div className="success-info-grid">
            <div className="success-info-box">
              <div className="success-info-icon green">
                <Network size={18} />
              </div>

              <div>
                <span>Network Status</span>
                <strong>Active Logistics Node</strong>
              </div>
            </div>

            <div className="success-info-box">
              <div className="success-info-icon blue">
                <ClipboardCheck size={18} />
              </div>

              <div>
                <span>Provider ID</span>
                <strong>VX-PH-MM-9021</strong>
              </div>
            </div>
          </div>

          <div className="success-next-steps">
            <Info size={17} />
            <div>
              <strong>Next Steps</strong>
              <p>
                Inventory systems will synchronize automatically within the
                next 15 minutes. Cold-chain sensors are ready for pairing.
              </p>
            </div>
          </div>

          <div className="success-actions">
            <button
              type="button"
              className="success-primary-btn"
              onClick={() => navigate("/clinics")}
            >
              <Eye size={15} />
              View Clinic Profile
            </button>

            <button
              type="button"
              className="success-secondary-btn"
              onClick={() => navigate("/register-clinic")}
            >
              <FilePlus2 size={15} />
              Register Another Clinic
            </button>
          </div>

          <div className="success-muted-icons">
            <Building2 size={34} />
            <Hospital size={34} />
            <Network size={34} />
            <ClipboardCheck size={34} />
          </div>
        </section>

        <p className="success-timestamp">
          System timestamp: 2026-11-24 14:02:11 PHT • Manila Operations Hub
        </p>
      </main>
    </div>
  );
}

function SuccessTopBar() {
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

export default ClinicSuccess;
