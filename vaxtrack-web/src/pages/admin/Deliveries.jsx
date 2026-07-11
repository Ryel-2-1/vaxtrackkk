import { useEffect, useMemo, useState } from "react";
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
import { subscribeDeliveries } from "../../services/deliveryService";
import StatusBadge from "../../components/ui/StatusBadge";
import KpiCard from "../../components/ui/KpiCard";
import "./Deliveries.css";

function normalizeDelivery(raw) {
  const riderName = raw.assignedRiderName || "Unassigned";
  const initials = riderName
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

  return {
    uid: raw.id,
    id: raw.orderNumber || raw.id.slice(0, 10).toUpperCase(),
    rider: riderName,
    initials,
    vehicle: raw.vehicle || "—",
    plate: raw.plate || "—",
    destination: raw.clinicName || "—",
    address: raw.clinicAddress || "—",
    region: raw.region || "—",
    rawStatus: raw.rawStatus,
    statusKey: raw.statusKey,
    status: raw.statusLabel,
    statusType: raw.statusType,
    temp: raw.storageTemp || "—",
    priority: raw.priority || "Normal",
    eta: raw.statusType === "transit" ? "In Transit" : raw.statusType === "delayed" ? "Needs Review" : "Preparing",
    etaType: raw.statusType === "delayed" ? "late" : raw.statusType === "transit" ? "normal" : "neutral",
    vaccineName: raw.vaccineName || "—",
    quantity: raw.quantity || 0,
    unit: raw.unit || "doses",
  };
}

function Deliveries() {
  const navigate = useNavigate();

  const [deliveryList, setDeliveryList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [mapMode, setMapMode] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeDeliveries(
      (raw) => {
        setDeliveryList(raw.map(normalizeDelivery));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(error.message || "Failed to load deliveries.");
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
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

  const transitCount = deliveryList.filter((d) => d.statusType === "transit").length;
  const delayedCount = deliveryList.filter((d) => d.statusType === "delayed").length;
  const loadingCount = deliveryList.filter((d) => d.statusType === "loading").length;

  const delayedDelivery = deliveryList.find((d) => d.statusType === "delayed");

  const regions = useMemo(() => {
    const set = new Set(deliveryList.map((d) => d.region).filter((r) => r !== "—"));
    return Array.from(set).sort();
  }, [deliveryList]);

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
              onClick={() =>
                showToast(
                  "Deliveries are created through Sales Rep orders and dispatched by a Dispatcher."
                )
              }
            >
              <Plus size={14} />
              New Delivery
            </button>
          </div>
        </header>

        {delayedCount > 0 && delayedDelivery && (
          <section className="deliveries-alert-strip">
            <AlertTriangle size={18} />
            <div>
              <strong>
                {delayedCount} delayed deliver{delayedCount === 1 ? "y" : "ies"}{" "}
                require{delayedCount === 1 ? "s" : ""} review
              </strong>
              <p>{delayedDelivery.id} needs attention.</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedDelivery(delayedDelivery)}
            >
              Review Now
            </button>
          </section>
        )}

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
            <option value="loading">Loading / Assigned</option>
          </select>

          <select
            className="deliveries-v4-select"
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
          >
            <option value="all">All Regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
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
          <KpiCard
            label="Total deliveries"
            value={deliveryList.length}
            context="All orders"
            tone="neutral"
            onClick={() => setStatusFilter("all")}
          />

          <KpiCard
            label="In transit"
            value={transitCount}
            context="On route"
            tone="info"
            onClick={() => setStatusFilter("transit")}
          />

          <KpiCard
            label="Delayed"
            value={delayedCount}
            context="Needs review"
            tone="danger"
            attention={delayedCount > 0}
            onClick={() => setStatusFilter("delayed")}
          />

          <KpiCard
            label="Loading / assigned"
            value={loadingCount}
            context="Preparing"
            tone="warning"
            onClick={() => setStatusFilter("loading")}
          />
        </section>

        <section className="deliveries-v4-fleet-card">
          <div className="deliveries-v4-fleet-header">
            <div>
              <h2>{mapMode ? "Fleet Map Mode" : "Live Fleet Tracking"}</h2>
              <p>
                Showing {filteredDeliveries.length} of {deliveryList.length}{" "}
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
                      key={delivery.uid}
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
                              {delivery.vehicle !== "—"
                                ? `${delivery.vehicle} • Plate: ${delivery.plate}`
                                : "Vehicle not assigned"}
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
                        <StatusBadge statusKey={delivery.statusKey} />
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

              {loading && (
                <div className="deliveries-empty-state">
                  <Truck size={30} />
                  <strong>Loading deliveries...</strong>
                </div>
              )}

              {!loading && loadError && (
                <div className="deliveries-empty-state">
                  <Truck size={30} />
                  <strong>Could not load deliveries</strong>
                  <p>{loadError}</p>
                </div>
              )}

              {!loading && !loadError && filteredDeliveries.length === 0 && (
                <div className="deliveries-empty-state">
                  <Truck size={30} />
                  <strong>
                    {deliveryList.length === 0
                      ? "No deliveries yet"
                      : "No deliveries match your filters"}
                  </strong>
                  <p>
                    {deliveryList.length === 0
                      ? "Deliveries appear here when orders are created by Sales Representatives."
                      : "Try adjusting your search or selected filters."}
                  </p>
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
          onContact={() =>
            showToast(`Contacting ${selectedDelivery.rider}...`)
          }
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
    </div>
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
          key={delivery.uid}
          className={`deliveries-map-pin pin-${index + 1} ${delivery.statusType}`}
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

          <div>
            <span>Vaccine</span>
            <strong>{delivery.vaccineName}</strong>
          </div>

          <div>
            <span>Quantity</span>
            <strong>
              {delivery.quantity} {delivery.unit}
            </strong>
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
