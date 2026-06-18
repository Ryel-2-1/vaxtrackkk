import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Grid3X3,
  Plus,
  Search,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Clinics.css";

function Clinics() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const clinics = [
    {
      name: "Quezon City General Hospital",
      id: "CLN-4829",
      location: "North Ave, Quezon City",
      area: "Metro Manila",
      contact: "Dr. Maria Santos",
      phone: "0917-555-0192",
      initials: "MS",
      lastDelivery: "Today, 09:30 AM",
      note: "Via Cold-Chain Truck #4",
      status: "normal",
      contactTone: "blue",
    },
    {
      name: "Makati Medical Center",
      id: "CLN-4830",
      location: "Amorsolo St, Makati",
      area: "Metro Manila",
      contact: "Juan Cruz",
      phone: "0920-123-4567",
      initials: "JC",
      lastDelivery: "2 Days Ago",
      note: "Pending Resupply",
      status: "normal",
      contactTone: "amber",
    },
    {
      name: "Pasig City Children’s Hospital",
      id: "CLN-4835",
      location: "Pasig Blvd, Pasig",
      area: "Metro Manila",
      contact: "Liza Torres",
      phone: "0918-987-6543",
      initials: "LT",
      lastDelivery: "1 Week Ago",
      note: "Delivery Overdue",
      status: "warning",
      contactTone: "purple",
    },
  ];

  return (
    <div className="inventory-page clinics-shell">
      <AdminSidebar active="clinics" onLogout={handleLogout} />

      <main className="clinics-main">
        <ClinicsTopBar />

        <section className="clinics-page-header">
          <p>Manage and monitor affiliated healthcare facilities.</p>

          <button
            type="button"
            className="clinics-primary-btn"
            onClick={() => navigate("/register-clinic")}
          >
            <Plus size={15} />
            Register New Clinic
          </button>
        </section>

        <section className="clinics-toolbar">
          <button type="button" className="clinics-status-chip">
            <CircleHelp size={13} />
            Status: All
          </button>

          <button type="button" className="clinics-view-btn">
            <Grid3X3 size={15} />
          </button>
        </section>

        <section className="clinics-table-card">
          <table className="clinics-table">
            <thead>
              <tr>
                <th>Clinic Name</th>
                <th>Location</th>
                <th>Contact Person</th>
                <th>Last Delivery</th>
              </tr>
            </thead>

            <tbody>
              {clinics.map((clinic) => (
                <tr
                  key={clinic.id}
                  className={clinic.status === "warning" ? "clinic-warning-row" : ""}
                >
                  <td>
                    <div className="clinic-name-cell">
                      <div className="clinic-icon">
                        <Building2 size={17} />
                      </div>

                      <div>
                        <strong>{clinic.name}</strong>
                        <small>ID: {clinic.id}</small>
                      </div>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-location-cell">
                      <strong>{clinic.location}</strong>
                      <small>{clinic.area}</small>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-contact-cell">
                      <div className={`clinic-contact-avatar ${clinic.contactTone}`}>
                        {clinic.initials}
                      </div>

                      <div>
                        <strong>{clinic.contact}</strong>
                        <small>{clinic.phone}</small>
                      </div>
                    </div>
                  </td>

                  <td>
                    <div className="clinic-delivery-cell">
                      <strong>{clinic.lastDelivery}</strong>
                      <small className={clinic.status === "warning" ? "danger" : ""}>
                        {clinic.note}
                      </small>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="clinics-pagination">
            <p>Showing 1 to 3 of 45 clinics</p>

            <div>
              <button type="button" disabled>
                <ChevronLeft size={14} />
              </button>
              <button type="button" className="active">1</button>
              <button type="button">2</button>
              <button type="button">3</button>
              <button type="button">...</button>
              <button type="button">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function ClinicsTopBar() {
  return (
    <header className="clinics-topbar">
      <h1>Clinic Management</h1>

      <div className="clinics-search">
        <Search size={15} />
        <input placeholder="Search clinics..." />
      </div>

      <div className="clinics-top-icons">
        <button type="button">
          <Bell size={15} />
        </button>

        <button type="button">
          <CircleHelp size={15} />
        </button>
      </div>
    </header>
  );
}

export default Clinics;
