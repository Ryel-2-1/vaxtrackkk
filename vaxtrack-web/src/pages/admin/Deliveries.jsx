import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Filter,
  Plus,
  Search,
  Truck,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Deliveries.css";

function Deliveries() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const deliveries = [
    {
      id: "#VT-823",
      eta: "ETA: 9:00 AM",
      etaType: "normal",
      initials: "JS",
      rider: "Juan Santos",
      vehicle: "Van",
      plate: "NCL-1241",
      destination: "Makati Med Center",
      address: "2 Amorsolo Street, Legazpi Village",
      status: "In Transit",
      statusType: "transit",
    },
    {
      id: "#VT-8824",
      eta: "+45m Behind",
      etaType: "late",
      initials: "MR",
      rider: "Maria Reyes",
      vehicle: "Truck",
      plate: "RTY-992",
      destination: "PGH Manila",
      address: "Taft Avenue, Ermita",
      status: "Delayed",
      statusType: "delayed",
    },
    {
      id: "#VT-8825",
      eta: "Departs at 1:00pm",
      etaType: "neutral",
      initials: "DL",
      rider: "David Lim",
      vehicle: "Van",
      plate: "ABC-445",
      destination: "St. Luke's BGC",
      address: "32nd St, Taguig",
      status: "Loading",
      statusType: "loading",
    },
    {
      id: "#VT-8826",
      eta: "-35m ahead",
      etaType: "ahead",
      initials: "AG",
      rider: "Ana Garcia",
      vehicle: "Bike",
      plate: "123-XY",
      destination: "Quezon City Gen",
      address: "Seminary Road, Project 8",
      status: "In Transit",
      statusType: "transit",
    },
  ];

  return (
    <div className="inventory-page">
      <AdminSidebar active="deliveries" onLogout={handleLogout} />

      <main className="deliveries-v4-page">
        <header className="deliveries-v4-header">
          <div>
            <h1>Delivery Management</h1>
            <p>Monitor and route active cold-chain shipments.</p>
          </div>

          <div className="deliveries-v4-header-right">
            <div className="deliveries-v4-top-icons">
              <button type="button">
                <Bell size={15} />
                <span></span>
              </button>

              <button type="button">
                <CircleHelp size={15} />
              </button>
            </div>

            <button
              type="button"
              className="deliveries-v4-new-btn"
              onClick={() => navigate("/create-delivery")}
            >
              <Plus size={14} />
              New Delivery
            </button>
          </div>
        </header>

        <section className="deliveries-v4-filters">
          <div className="deliveries-v4-search">
            <Search size={15} />
            <input placeholder="Search by Delivery ID, Rider, or Destination..." />
          </div>

          <button type="button" className="deliveries-v4-filter-btn">
            All Statuses
            <ChevronDown size={14} />
          </button>

          <button type="button" className="deliveries-v4-filter-btn">
            All Regions
            <ChevronDown size={14} />
          </button>

          <button type="button" className="deliveries-v4-more-btn">
            <Filter size={14} />
            More Filters
          </button>
        </section>

        <section className="deliveries-v4-body">
          <aside className="deliveries-v4-stats">
            <div className="deliveries-v4-stat-card">
              <div className="deliveries-v4-stat-head">
                <div className="deliveries-v4-stat-icon blue">
                  <Truck size={17} />
                </div>

                <span className="deliveries-v4-trend good">+12%</span>
              </div>

              <h2>42</h2>
              <p>Active Deliveries</p>
            </div>

            <div className="deliveries-v4-stat-card">
              <div className="deliveries-v4-stat-head">
                <div className="deliveries-v4-stat-icon amber">
                  <Clock3 size={17} />
                </div>
              </div>

              <h2 className="amber">3</h2>
              <p>Delayed (Warning)</p>
            </div>
          </aside>

          <section className="deliveries-v4-fleet-card">
            <div className="deliveries-v4-fleet-header">
              <h2>Live Fleet Tracking</h2>
              <button type="button">View Map Mode</button>
            </div>

            <table className="deliveries-v4-table">
              <thead>
                <tr>
                  <th>Delivery ID</th>
                  <th>Rider &amp; Vehicle</th>
                  <th>Destination</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      <div className="deliveries-v4-id-cell">
                        <strong>{delivery.id}</strong>
                        <small className={delivery.etaType}>{delivery.eta}</small>
                      </div>
                    </td>

                    <td>
                      <div className="deliveries-v4-rider-cell">
                        <span className="deliveries-v4-avatar">
                          {delivery.initials}
                        </span>

                        <div>
                          <strong>{delivery.rider}</strong>
                          <small>
                            {delivery.vehicle}
                            <br />
                            (Plate: {delivery.plate})
                          </small>
                        </div>
                      </div>
                    </td>

                    <td>
                      <div className="deliveries-v4-destination-cell">
                        <strong>{delivery.destination}</strong>
                        <small>{delivery.address}</small>
                      </div>
                    </td>

                    <td>
                      <span
                        className={`deliveries-v4-status ${delivery.statusType}`}
                      >
                        {delivery.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </section>
      </main>
    </div>
  );
}

export default Deliveries;
