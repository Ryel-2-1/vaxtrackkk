import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Filter,
  Navigation,
  PhoneCall,
  Plus,
  Search,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Deliveries.css";

const initialDeliveries = [
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
    region: "Makati",
    status: "In Transit",
    statusType: "transit",
    temp: "3.4°C",
    priority: "Normal",
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
    region: "Manila",
    status: "Delayed",
    statusType: "delayed",
    temp: "3.8°C",
    priority: "High",
  },
  {
    id: "#VT-8825",
    eta: "Departs at 1:00 PM",
    etaType: "neutral",
    initials: "DL",
    rider: "David Lim",
    vehicle: "Van",
    plate: "ABC-445",
    destination: "St. Luke's BGC",
    address: "32nd St, Taguig",
    region: "Taguig",
    status: "Loading",
    statusType: "loading",
    temp: "2.9°C",
    priority: "Normal",
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
    region: "Quezon City",
    status: "In Transit",
    statusType: "transit",
    temp: "3.1°C",
    priority: "Normal",
  },
];

function Deliveries() {
  const navigate = useNavigate();

  const [deliveryList, setDeliveryList] = useState(initialDeliveries);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [showNewDeliveryModal, setShowNewDeliveryModal] = useState(false);
  const [mapMode, setMapMode] = useState(false);
  const [toast, setToast] = useState("");

 const [newDelivery, setNewDelivery] = useState({
  id: "",
  rider: "",
  destination: "",
  address: "",
  region: "Manila",
  statusType: "loading",
  temp: "2-8°C",
  priority: "Normal",
});

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const handleCreateDelivery = (e) => {
    e.preventDefault();

   if (
  !newDelivery.id.trim() ||
  !newDelivery.rider.trim() ||
  !newDelivery.destination.trim() ||
  !newDelivery.address.trim()
) {
      showToast("Please complete all delivery fields.");
      return;
    }

    const statusLabel =
      newDelivery.statusType === "transit"
        ? "In Transit"
        : newDelivery.statusType === "delayed"
        ? "Delayed"
        : "Loading";

    const createdDelivery = {
      id: newDelivery.id.startsWith("#") ? newDelivery.id : `#${newDelivery.id}`,
      eta:
        newDelivery.statusType === "loading"
          ? "Preparing shipment"
          : newDelivery.statusType === "delayed"
          ? "Needs review"
          : "ETA: Pending",
      etaType:
        newDelivery.statusType === "delayed"
          ? "late"
          : newDelivery.statusType === "transit"
          ? "normal"
          : "neutral",
      initials: newDelivery.rider
        .split(" ")
        .filter(Boolean)
        .map((name) => name[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      rider: newDelivery.rider,
      vehicle: newDelivery.vehicle,
      plate: newDelivery.plate,
      destination: newDelivery.destination,
      address: newDelivery.address,
      region: newDelivery.region,
      status: statusLabel,
      statusType: newDelivery.statusType,
      temp: newDelivery.temp,
      priority: newDelivery.priority,
    };

    setDeliveryList((prev) => [createdDelivery, ...prev]);

    setNewDelivery({
      id: "",
      rider: "",
      vehicle: "Van",
      plate: "",
      destination: "",
      address: "",
      region: "Manila",
      statusType: "loading",
      temp: "2-8°C",
      priority: "Normal",
    });

    setShowNewDeliveryModal(false);
    showToast(`${createdDelivery.id} has been added to deliveries.`);
  };

  const filteredDeliveries = useMemo(() => {
    return deliveryList.filter((delivery) => {
      const searchValue =
        `${delivery.id} ${delivery.rider} ${delivery.destination} ${delivery.region} ${delivery.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" || delivery.statusType === statusFilter;

      const matchesRegion =
        regionFilter === "all" ||
        delivery.region.toLowerCase() === regionFilter.toLowerCase();

      return matchesSearch && matchesStatus && matchesRegion;
    });
  }, [deliveryList, searchTerm, statusFilter, regionFilter]);

  const delayedDelivery =
    deliveryList.find((item) => item.statusType === "delayed") ||
    deliveryList[0];

  return (
    <div className="inventory-page">
      <AdminSidebar active="deliveries" onLogout={handleLogout} />

      <main className="deliveries-v4-page">
        {toast && <div className="deliveries-toast">{toast}</div>}

        <header className="deliveries-v4-header">
          <div>
            <h1>Delivery Management</h1>
            <p>Monitor and route active cold-chain shipments.</p>
          </div>

          <div className="deliveries-v4-header-right">
            <div className="deliveries-v4-top-icons">
              <button
                type="button"
                onClick={() => showToast("No new notifications.")}
              >
                <Bell size={15} />
                <span></span>
              </button>

              <button
                type="button"
                onClick={() =>
                  showToast("Tip: Click any delivery row to review details.")
                }
              >
                <CircleHelp size={15} />
              </button>
            </div>

            <button
              type="button"
              className="deliveries-v4-new-btn"
              onClick={() => setShowNewDeliveryModal(true)}
            >
              <Plus size={14} />
              New Delivery
            </button>
          </div>
        </header>

        <section className="deliveries-alert-strip">
          <AlertTriangle size={18} />

          <div>
            <strong>1 delayed delivery requires review</strong>
            <p>#VT-8824 is currently +45 minutes behind schedule.</p>
          </div>

          <button
            type="button"
            onClick={() => setSelectedDelivery(delayedDelivery)}
          >
            Review Now
          </button>
        </section>

        <section className="deliveries-v4-filters">
          <div className="deliveries-v4-search">
            <Search size={15} />
            <input
              placeholder="Search by Delivery ID, Rider, or Destination..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <select
            className="deliveries-v4-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="transit">In Transit</option>
            <option value="delayed">Delayed</option>
            <option value="loading">Loading</option>
          </select>

          <select
            className="deliveries-v4-select"
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
          >
            <option value="all">All Regions</option>
            <option value="Makati">Makati</option>
            <option value="Manila">Manila</option>
            <option value="Taguig">Taguig</option>
            <option value="Quezon City">Quezon City</option>
          </select>

          <button
            type="button"
            className="deliveries-v4-more-btn"
            onClick={() => setShowMoreFilters((prev) => !prev)}
          >
            <Filter size={14} />
            More Filters
            <ChevronDown size={14} />
          </button>
        </section>

        {showMoreFilters && (
          <section className="deliveries-more-filters">
            <button type="button" onClick={() => setStatusFilter("delayed")}>
              Show delayed only
            </button>

            <button type="button" onClick={() => setStatusFilter("transit")}>
              Show in-transit only
            </button>

            <button
              type="button"
              onClick={() => {
                setStatusFilter("all");
                setRegionFilter("all");
                setSearchTerm("");
              }}
            >
              Reset filters
            </button>
          </section>
        )}

        <section className="deliveries-summary-grid">
          <DeliverySummaryCard
            icon={<Truck size={18} />}
            value="42"
            label="Active Deliveries"
            type="blue"
            note="+12%"
            onClick={() => setStatusFilter("all")}
          />

          <DeliverySummaryCard
            icon={<Navigation size={18} />}
            value="18"
            label="In Transit"
            type="green"
            note="On route"
            onClick={() => setStatusFilter("transit")}
          />

          <DeliverySummaryCard
            icon={<Clock3 size={18} />}
            value="3"
            label="Delayed"
            type="amber"
            note="Needs review"
            onClick={() => setStatusFilter("delayed")}
          />

          <DeliverySummaryCard
            icon={<AlertTriangle size={18} />}
            value="2"
            label="Route Alerts"
            type="red"
            note="Critical"
            onClick={() => showToast("Route alert filter applied.")}
          />
        </section>

        <section className="deliveries-v4-fleet-card">
          <div className="deliveries-v4-fleet-header">
            <div>
              <h2>{mapMode ? "Fleet Map Mode" : "Live Fleet Tracking"}</h2>
              <p>
                Showing {filteredDeliveries.length} of {deliveryList.length} demo
                deliveries
              </p>
            </div>

            <button type="button" onClick={() => setMapMode((prev) => !prev)}>
              {mapMode ? "View Table Mode" : "View Map Mode"}
            </button>
          </div>

          {mapMode ? (
            <FleetMap
              deliveries={filteredDeliveries}
              onSelect={setSelectedDelivery}
            />
          ) : (
            <div className="deliveries-table-wrap">
              <table className="deliveries-v4-table">
                <thead>
                  <tr>
                    <th>Delivery ID</th>
                    <th>Rider &amp; Vehicle</th>
                    <th>Destination</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredDeliveries.map((delivery) => (
                    <tr
                      key={delivery.id}
                      className={`delivery-row-${delivery.statusType}`}
                      onClick={() => setSelectedDelivery(delivery)}
                    >
                      <td>
                        <div className="deliveries-v4-id-cell">
                          <strong>{delivery.id}</strong>
                          <small className={delivery.etaType}>
                            {delivery.eta}
                          </small>
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
                              Plate: {delivery.plate}
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

                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="delivery-row-actions">
                          <button
                            type="button"
                            onClick={() => setSelectedDelivery(delivery)}
                          >
                            View
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setMapMode(true);
                              showToast(`Showing route for ${delivery.id}.`);
                            }}
                          >
                            Route
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              showToast(`Contacting ${delivery.rider}...`)
                            }
                          >
                            Call
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredDeliveries.length === 0 && (
                <div className="deliveries-empty-state">
                  <Truck size={30} />
                  <strong>No deliveries found</strong>
                  <p>Try adjusting your search or selected filters.</p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {selectedDelivery && (
        <DeliveryModal
          delivery={selectedDelivery}
          onClose={() => setSelectedDelivery(null)}
          onContact={() => showToast(`Contacting ${selectedDelivery.rider}...`)}
          onRoute={() => {
            setSelectedDelivery(null);
            setMapMode(true);
            showToast(`Route view opened for ${selectedDelivery.id}.`);
          }}
          onResolve={() => {
            setSelectedDelivery(null);
            showToast(`${selectedDelivery.id} marked as reviewed.`);
          }}
        />
      )}

      {showNewDeliveryModal && (
        <div className="deliveries-modal-backdrop">
          <form
            className="deliveries-modal deliveries-form-modal"
            onSubmit={handleCreateDelivery}
          >
            <button
              type="button"
              className="deliveries-modal-close"
              onClick={() => setShowNewDeliveryModal(false)}
            >
              <X size={18} />
            </button>
            
            <h2>New Delivery</h2>
            <p>Create a new cold-chain delivery record for dispatch monitoring.</p>

            <div className="deliveries-form-grid">
              <label>
                Delivery ID
                <input
                  type="text"
                  placeholder="VT-9001"
                  value={newDelivery.id}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      id: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Rider Name
                <input
                  type="text"
                  placeholder="Juan Dela Cruz"
                  value={newDelivery.rider}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      rider: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Vehicle
                <select
                  value={newDelivery.vehicle}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      vehicle: e.target.value,
                    }))
                  }
                >
                  <option>Van</option>
                  <option>Truck</option>
                  <option>Bike</option>
                </select>
              </label>

              <label>
                Plate Number
                <input
                  type="text"
                  placeholder="ABC-1234"
                  value={newDelivery.plate}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      plate: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Destination
                <input
                  type="text"
                  placeholder="Clinic or hospital name"
                  value={newDelivery.destination}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      destination: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Region
                <select
                  value={newDelivery.region}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      region: e.target.value,
                    }))
                  }
                >
                  <option>Manila</option>
                  <option>Makati</option>
                  <option>Taguig</option>
                  <option>Quezon City</option>
                </select>
              </label>

              <label className="wide">
                Address
                <input
                  type="text"
                  placeholder="Complete delivery address"
                  value={newDelivery.address}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      address: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Status
                <select
                  value={newDelivery.statusType}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      statusType: e.target.value,
                    }))
                  }
                >
                  <option value="loading">Loading</option>
                  <option value="transit">In Transit</option>
                  <option value="delayed">Delayed</option>
                </select>
              </label>

              <label>
                Priority
                <select
                  value={newDelivery.priority}
                  onChange={(e) =>
                    setNewDelivery((prev) => ({
                      ...prev,
                      priority: e.target.value,
                    }))
                  }
                >
                  <option>Normal</option>
                  <option>High</option>
                  <option>Urgent</option>
                </select>
              </label>
            </div>

            <div className="deliveries-modal-actions">
              <button type="submit" className="deliveries-primary-action">
                Create Delivery
              </button>

              <button
                type="button"
                className="deliveries-light-action"
                onClick={() => setShowNewDeliveryModal(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function DeliverySummaryCard({ icon, value, label, type, note, onClick }) {
  return (
    <button
      type="button"
      className={`deliveries-summary-card ${type}`}
      onClick={onClick}
    >
      <div className="deliveries-summary-icon">{icon}</div>

      <div>
        <h2>{value}</h2>
        <p>{label}</p>
        <small>{note}</small>
      </div>
    </button>
  );
}

function FleetMap({ deliveries, onSelect }) {
  return (
    <div className="deliveries-map-mode">
      <div className="deliveries-map-line one"></div>
      <div className="deliveries-map-line two"></div>
      <div className="deliveries-map-line three"></div>

      {deliveries.map((delivery, index) => (
        <button
          type="button"
          key={delivery.id}
          className={`deliveries-map-pin pin-${index + 1} ${
            delivery.statusType
          }`}
          onClick={() => onSelect(delivery)}
        >
          <Truck size={16} />
          <span>{delivery.id}</span>
        </button>
      ))}

      <div className="deliveries-map-legend">
        <span>
          <i className="transit"></i>
          In Transit
        </span>

        <span>
          <i className="delayed"></i>
          Delayed
        </span>

        <span>
          <i className="loading"></i>
          Loading
        </span>
      </div>
    </div>
  );
}

function DeliveryModal({ delivery, onClose, onContact, onRoute, onResolve }) {
  return (
    <div className="deliveries-modal-backdrop">
      <div className="deliveries-modal">
        <button
          type="button"
          className="deliveries-modal-close"
          onClick={onClose}
        >
          <X size={18} />
        </button>

        <div className={`deliveries-modal-icon ${delivery.statusType}`}>
          <Truck size={24} />
        </div>

        <h2>{delivery.id}</h2>
        <p>
          {delivery.destination} delivery handled by {delivery.rider}.
        </p>

        <div className="deliveries-modal-grid">
          <div>
            <span>Rider</span>
            <strong>{delivery.rider}</strong>
          </div>

          <div>
            <span>Status</span>
            <strong>{delivery.status}</strong>
          </div>

          <div>
            <span>Vehicle</span>
            <strong>{delivery.vehicle}</strong>
          </div>

          <div>
            <span>Plate No.</span>
            <strong>{delivery.plate}</strong>
          </div>

          <div>
            <span>Temperature</span>
            <strong>{delivery.temp}</strong>
          </div>

          <div>
            <span>Priority</span>
            <strong>{delivery.priority}</strong>
          </div>

          <div className="wide">
            <span>Destination</span>
            <strong>{delivery.address}</strong>
          </div>
        </div>

        <div className="deliveries-modal-actions">
          <button
            type="button"
            className="deliveries-primary-action"
            onClick={onRoute}
          >
            View Route
          </button>

          <button
            type="button"
            className="deliveries-light-action"
            onClick={onContact}
          >
            <PhoneCall size={15} />
            Contact Rider
          </button>

          <button
            type="button"
            className="deliveries-danger-action"
            onClick={onResolve}
          >
            Mark Reviewed
          </button>
        </div>
      </div>
    </div>
  );
}

export default Deliveries;