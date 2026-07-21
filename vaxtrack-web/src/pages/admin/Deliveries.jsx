import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  ChevronDown,
  Filter,
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
    // Read-only pass-throughs displayed in the detail drawer.
    riderPhone: raw.assignedRiderPhone || "",
    instructions: raw.deliveryInstructions || "",
    createdAt: raw.createdAt || null,
    assignedAt: raw.assignedAt || null,
    statusUpdatedAt: raw.statusUpdatedAt || null,
    statusUpdatedByEmail: raw.statusUpdatedByEmail || "",
    // Rider-uploaded photos. Both are full Firebase Storage download URLs
    // written by the Flutter Rider app, so the web renders them directly and
    // needs no Storage SDK. `invoiceUrl` is the rider's photo of the paper
    // invoice — unrelated to the `invoices` collection / Admin Invoices module.
    proofOfDeliveryUrl: raw.proofOfDeliveryUrl || "",
    invoiceUrl: raw.invoiceUrl || "",
  };
}

function formatDateTime(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

        <header className="mdl-header">
          <div>
            <h1>Delivery management</h1>
            <p>Monitor and route active cold-chain shipments.</p>
          </div>

          <button
            type="button"
            className="mdl-btn mdl-btn-secondary"
            onClick={() =>
              showToast(
                "Deliveries are created through Sales Rep orders and dispatched by a Dispatcher."
              )
            }
          >
            <Plus size={14} />
            New delivery
          </button>
        </header>

        {delayedCount > 0 && delayedDelivery && (
          <section className="mdl-banner mdl-banner-danger">
            <AlertTriangle size={16} />
            <div>
              <strong>
                {delayedCount} delayed deliver{delayedCount === 1 ? "y" : "ies"}{" "}
                require{delayedCount === 1 ? "s" : ""} review
              </strong>
              <p>{delayedDelivery.id} needs attention.</p>
            </div>
            <button
              type="button"
              className="mdl-btn mdl-btn-danger-ghost"
              onClick={() => setSelectedDelivery(delayedDelivery)}
            >
              Review Now
            </button>
          </section>
        )}

        <section className="mdl-filterbar">
          <label className="mdl-search">
            <Search size={15} />
            <input
              placeholder="Search by order, rider, or destination..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </label>

          <select
            className="mdl-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="transit">In transit</option>
            <option value="delayed">Delayed</option>
            <option value="loading">Loading / assigned</option>
          </select>

          <select
            className="mdl-select"
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
          >
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="mdl-btn mdl-btn-secondary"
            onClick={() => setShowMoreFilters((prev) => !prev)}
          >
            <Filter size={14} />
            More filters
            <ChevronDown size={14} />
          </button>
        </section>

        {showMoreFilters && (
          <section className="mdl-quickfilters">
            <button
              type="button"
              className="mdl-chip"
              onClick={() => setStatusFilter("delayed")}
            >
              Show delayed only
            </button>

            <button
              type="button"
              className="mdl-chip"
              onClick={() => setStatusFilter("transit")}
            >
              Show in-transit only
            </button>

            <button
              type="button"
              className="mdl-chip"
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

        <section className="mdl-card">
          <div className="mdl-card-head">
            <div>
              <h2>Deliveries</h2>
              <p>
                Showing {filteredDeliveries.length} of {deliveryList.length}{" "}
                deliveries
              </p>
            </div>
          </div>

          <div className="mdl-table-wrap">
            <table className="mdl-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Rider &amp; vehicle</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredDeliveries.map((delivery) => (
                  <tr
                    key={delivery.uid}
                    className={
                      delivery.statusType === "delayed" ? "mdl-row-delayed" : ""
                    }
                    onClick={() => setSelectedDelivery(delivery)}
                  >
                    <td>
                      <span className="mdl-td-order">{delivery.id}</span>
                    </td>

                    <td>
                      <div className="mdl-rider-cell">
                        <span className="mdl-avatar">{delivery.initials}</span>
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
                      <div className="mdl-dest-cell">
                        <strong>{delivery.destination}</strong>
                        <small>{delivery.address}</small>
                      </div>
                    </td>

                    <td>
                      <StatusBadge statusKey={delivery.statusKey} />
                    </td>

                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="mdl-row-actions">
                        <button
                          type="button"
                          className="mdl-btn mdl-btn-ghost mdl-btn-sm"
                          onClick={() => setSelectedDelivery(delivery)}
                        >
                          View
                        </button>

                        <button
                          type="button"
                          className="mdl-btn mdl-btn-ghost mdl-btn-sm"
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
              <div className="mdl-empty">
                <span className="mdl-empty-icon">
                  <Truck size={18} />
                </span>
                <strong>Loading deliveries...</strong>
              </div>
            )}

            {!loading && loadError && (
              <div className="mdl-empty">
                <span className="mdl-empty-icon">
                  <AlertTriangle size={18} />
                </span>
                <strong>Could not load deliveries</strong>
                <p>{loadError}</p>
              </div>
            )}

            {!loading && !loadError && filteredDeliveries.length === 0 && (
              <div className="mdl-empty">
                <span className="mdl-empty-icon">
                  <Truck size={18} />
                </span>
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
            showToast(
              "Live route view activates once rider GPS updates are available."
            );
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

function DeliveryModal({ delivery, onClose, onContact, onRoute, onResolve }) {
  const created = formatDateTime(delivery.createdAt);
  const assigned = formatDateTime(delivery.assignedAt);
  const statusUpdated = formatDateTime(delivery.statusUpdatedAt);

  return (
    <div className="mdl-drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="mdl-drawer"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mdl-drawer-head">
          <div>
            <div className="mdl-drawer-title-row">
              <h2>{delivery.id}</h2>
              <StatusBadge statusKey={delivery.statusKey} />
            </div>
            <p>{delivery.destination}</p>
          </div>

          <button
            type="button"
            className="mdl-drawer-close"
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={16} />
          </button>
        </header>

        <div className="mdl-drawer-body">
          <section className="mdl-drawer-section">
            <h3>Destination</h3>
            <div className="mdl-drawer-row">
              <span>Clinic</span>
              <strong>{delivery.destination}</strong>
            </div>
            <div className="mdl-drawer-row">
              <span>Address</span>
              <strong>{delivery.address}</strong>
            </div>
            {delivery.region !== "—" && (
              <div className="mdl-drawer-row">
                <span>Region</span>
                <strong>{delivery.region}</strong>
              </div>
            )}
          </section>

          <section className="mdl-drawer-section">
            <h3>Shipment</h3>
            <div className="mdl-drawer-row">
              <span>Vaccine</span>
              <strong>{delivery.vaccineName}</strong>
            </div>
            <div className="mdl-drawer-row">
              <span>Quantity</span>
              <strong className="tnum">
                {delivery.quantity} {delivery.unit}
              </strong>
            </div>
            <div className="mdl-drawer-row">
              <span>Temperature</span>
              <strong>{delivery.temp}</strong>
            </div>
            <div className="mdl-drawer-row">
              <span>Priority</span>
              <strong>{delivery.priority}</strong>
            </div>
          </section>

          <section className="mdl-drawer-section">
            <h3>Rider</h3>
            <div className="mdl-drawer-rider">
              <span className="mdl-avatar">{delivery.initials}</span>
              <div>
                <strong>{delivery.rider}</strong>
                <small>
                  {delivery.vehicle !== "—"
                    ? `${delivery.vehicle} • Plate: ${delivery.plate}`
                    : "Vehicle not assigned"}
                </small>
                {delivery.riderPhone && <small>{delivery.riderPhone}</small>}
              </div>
            </div>
          </section>

          {delivery.instructions && (
            <section className="mdl-drawer-section">
              <h3>Delivery instructions</h3>
              <p className="mdl-drawer-note">{delivery.instructions}</p>
            </section>
          )}

          <section className="mdl-drawer-section">
            <h3>Proof of delivery</h3>
            {delivery.proofOfDeliveryUrl ? (
              <div className="mdl-proof">
                <a
                  className="mdl-proof-thumb"
                  href={delivery.proofOfDeliveryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src={delivery.proofOfDeliveryUrl}
                    alt={`Proof of delivery for order ${delivery.id}`}
                    loading="lazy"
                  />
                </a>
                <div className="mdl-proof-actions">
                  <a
                    className="mdl-proof-link"
                    href={delivery.proofOfDeliveryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open image
                  </a>
                  {delivery.invoiceUrl && (
                    <a
                      className="mdl-proof-link secondary"
                      href={delivery.invoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open invoice photo
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <p className="mdl-drawer-note">No proof uploaded yet.</p>
            )}
          </section>

          <section className="mdl-drawer-section">
            <h3>Activity</h3>
            {created && (
              <div className="mdl-drawer-row">
                <span>Order created</span>
                <strong className="tnum">{created}</strong>
              </div>
            )}
            {assigned && (
              <div className="mdl-drawer-row">
                <span>Rider assigned</span>
                <strong className="tnum">{assigned}</strong>
              </div>
            )}
            {statusUpdated && (
              <div className="mdl-drawer-row">
                <span>Last status update</span>
                <strong className="tnum">{statusUpdated}</strong>
              </div>
            )}
            {delivery.statusUpdatedByEmail && (
              <div className="mdl-drawer-row">
                <span>Updated by</span>
                <strong>{delivery.statusUpdatedByEmail}</strong>
              </div>
            )}
            {!created && !assigned && !statusUpdated && (
              <p className="mdl-drawer-note">No activity recorded yet.</p>
            )}
          </section>
        </div>

        <footer className="mdl-drawer-actions">
          <button
            type="button"
            className="mdl-btn mdl-btn-primary"
            onClick={onResolve}
          >
            Mark Reviewed
          </button>

          <button
            type="button"
            className="mdl-btn mdl-btn-secondary"
            onClick={onContact}
          >
            <PhoneCall size={14} />
            Contact Rider
          </button>

          <button
            type="button"
            className="mdl-btn mdl-btn-ghost"
            onClick={onRoute}
          >
            View Route
          </button>
        </footer>
      </aside>
    </div>
  );
}

export default Deliveries;
