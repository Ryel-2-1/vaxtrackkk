import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  ChevronDown,
  Filter,
  PhoneCall,
  Search,
  Truck,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "../../components/admin/AdminSidebar";
import {
  subscribeDeliveries,
  UNKNOWN_STATUS_KEY,
  UNKNOWN_STATUS_LABEL,
} from "../../services/deliveryService";
import { ORDER_STATUSES, STATUS_LABELS } from "../../services/orderWorkflow";
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
    // `vehicle`, `plate`, `temp` and `region` were read here. NOTHING has ever
    // written vehicle or plate — not the live callable, not the superseded
    // client path — and `storageTemp`/`region` only ever came from the
    // superseded one, so no order created today carries either. They rendered a
    // permanent dash under headings promising vehicle, cold-chain and regional
    // detail the order does not hold, so the fields are gone rather than
    // dashed forever.
    //
    // `eta` was not an estimate: it restated the status ("In Transit" /
    // "Needs Review" / "Preparing") under a heading that read as an arrival
    // time. No order carries an arrival estimate, so there is nothing to show.
    destination: raw.clinicName || "—",
    address: raw.clinicAddress || "—",
    rawStatus: raw.rawStatus,
    statusKey: raw.statusKey,
    status: raw.statusLabel,
    statusType: raw.statusType,
    priority: raw.priority || "Normal",
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
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);

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

  /* The toast and its `showToast` helper went with the five actions that used
     them. Each raised a message and did nothing else, so the page now has no
     control that could report a result it did not produce. */

  const filteredDeliveries = useMemo(() => {
    return deliveryList.filter((delivery) => {
      const searchValue =
        `${delivery.id} ${delivery.rider} ${delivery.destination} ${delivery.status}`.toLowerCase();
      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      // One filter value per canonical status, so what the operator picks is
      // what the list shows. The old four buckets meant "In transit" also
      // returned delivered orders and "Delayed" also returned cancelled ones.
      const matchesStatus =
        statusFilter === "all" || delivery.statusType === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [deliveryList, searchTerm, statusFilter]);

  // Counted per canonical status. `delivered` and `cancelled` are no longer
  // folded into "in transit" and "delayed", and `delivery_failed` — which had
  // no count at all — now has its own.
  const countOf = (key) => deliveryList.filter((d) => d.statusType === key).length;
  const inTransitCount = countOf("in_transit");
  const delayedCount = countOf("delayed");
  const failedCount = countOf("delivery_failed");
  const preparingCount =
    countOf("pending_dispatch") + countOf("assigned") + countOf("loading");
  const unknownCount = countOf(UNKNOWN_STATUS_KEY);

  // The banner covers orders that have stopped and need a person: delayed and
  // failed. A cancelled order is closed, not stalled, and used to be counted here.
  const needsReview = useMemo(
    () =>
      deliveryList.filter(
        (d) => d.statusType === "delayed" || d.statusType === "delivery_failed"
      ),
    [deliveryList]
  );

  return (
    <div className="inventory-page">
      <AdminSidebar active="deliveries" onLogout={handleLogout} />

      <main className="deliveries-v4-page">

        <header className="mdl-header">
          <div>
            <h1>Deliveries</h1>
            {/* Was "Monitor and route active cold-chain shipments." Admin does
                not route anything and this page performs no cold-chain
                measurement; it reads the orders collection. */}
            <p>Read-only view of every order and its current status.</p>
          </div>

          {/* A "New delivery" button stood here and raised a toast explaining
              that deliveries are created elsewhere. A control that cannot do
              the thing it is labelled with is not a control — the same fact is
              stated as text, where it belongs. */}
          <p className="mdl-header-note">
            Orders are created by Sales Reps and dispatched by a Dispatcher.
          </p>
        </header>

        {needsReview.length > 0 && (
          <section className="mdl-banner mdl-banner-danger">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>
                {needsReview.length} deliver{needsReview.length === 1 ? "y" : "ies"}{" "}
                stopped and need{needsReview.length === 1 ? "s" : ""} review
              </strong>
              {/* Names the two statuses it covers, so the figure can be checked
                  against the cards below it. It used to say "delayed" while
                  counting cancelled orders too. */}
              <p>
                {delayedCount} delayed, {failedCount} failed. Oldest:{" "}
                {needsReview[0].id}.
              </p>
            </div>
            {/* The order number stays in the sentence above rather than in the
                label: at 375px a button carrying a full VT-ORD- number is wider
                than the banner can give it. */}
            <button
              type="button"
              className="mdl-btn mdl-btn-danger-ghost"
              onClick={() => setSelectedDelivery(needsReview[0])}
              aria-label={`Review ${needsReview[0].id}`}
            >
              Review
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
            {/* Straight from the canonical list, so every status an order can
                hold is selectable and none can be forgotten here. `unknown` is
                offered too — a document carrying a value the system does not
                define is findable rather than buried in another bucket. */}
            <option value="all">All statuses</option>
            {ORDER_STATUSES.map((key) => (
              <option key={key} value={key}>
                {STATUS_LABELS[key]}
              </option>
            ))}
            <option value={UNKNOWN_STATUS_KEY}>{UNKNOWN_STATUS_LABEL}</option>
          </select>

          {/* The region select was removed with the field behind it. `region` is
              written only by the superseded client order path, so no order
              created today has one and the list was permanently empty. */}

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

          {/* "In transit" counted delivered and completed orders too, so
              finished deliveries were reported as on route. It now counts the
              one status it names. */}
          <KpiCard
            label="In transit"
            value={inTransitCount}
            context="On route"
            tone="info"
            onClick={() => setStatusFilter("in_transit")}
          />

          {/* "Delayed" counted cancelled orders as well, which both overstated
              the figure and put closed orders behind a "Needs review" label. */}
          <KpiCard
            label="Delayed"
            value={delayedCount}
            context="Still open"
            tone="danger"
            attention={delayedCount > 0}
            onClick={() => setStatusFilter("delayed")}
          />

          {/* A canonical status with no count anywhere before this pass: a
              failed delivery was in the total and in the filter, and in no card. */}
          <KpiCard
            label="Delivery failed"
            value={failedCount}
            context="Rider stopped"
            tone="danger"
            attention={failedCount > 0}
            onClick={() => setStatusFilter("delivery_failed")}
          />

          <KpiCard
            label="Preparing"
            value={preparingCount}
            context="Pending, assigned or loading"
            tone="warning"
            onClick={() => setStatusFilter("pending_dispatch")}
          />
        </section>

        {/* Only rendered when such a document exists, so it is a real finding
            rather than a permanent empty slot. */}
        {unknownCount > 0 && (
          <section className="mdl-banner">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>
                {unknownCount} order{unknownCount === 1 ? "" : "s"} with an
                unrecognised status
              </strong>
              <p>
                Their stored status is not one this system defines. They are
                shown as Unknown rather than assumed to be pending.
              </p>
            </div>
            <button
              type="button"
              className="mdl-btn mdl-btn-secondary"
              onClick={() => setStatusFilter(UNKNOWN_STATUS_KEY)}
            >
              Show them
            </button>
          </section>
        )}

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
                  <th>Rider</th>
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

                        {/* Was a button that raised "Contacting {rider}…" and
                            placed no call. The order does carry the assigned
                            rider's number, so this is now a real tel: link —
                            and it only appears when there is a number to dial. */}
                        {delivery.riderPhone ? (
                          <a
                            className="mdl-btn mdl-btn-ghost mdl-btn-sm"
                            href={`tel:${delivery.riderPhone}`}
                            aria-label={`Call ${delivery.rider} on ${delivery.riderPhone}`}
                          >
                            Call
                          </a>
                        ) : null}
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

      {/* `onResolve`, `onContact` and `onRoute` are gone with the buttons they
          drove. "Mark Reviewed" announced a state change nothing wrote — there
          is no reviewed field, and Admin is a read-only view of the orders
          collection. "View Route" promised a live route Admin has no source
          for. "Contact Rider" is now a tel: link inside the drawer. */}
      {selectedDelivery && (
        <DeliveryModal
          delivery={selectedDelivery}
          onClose={() => setSelectedDelivery(null)}
        />
      )}
    </div>
  );
}

function DeliveryModal({ delivery, onClose }) {
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
                {delivery.riderPhone ? (
                  <small>{delivery.riderPhone}</small>
                ) : (
                  <small>No phone number on this order</small>
                )}
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
          {delivery.riderPhone ? (
            <a
              className="mdl-btn mdl-btn-secondary"
              href={`tel:${delivery.riderPhone}`}
            >
              <PhoneCall size={14} aria-hidden="true" />
              Call {delivery.rider} on {delivery.riderPhone}
            </a>
          ) : (
            <p className="mdl-drawer-note">
              No rider phone number on this order.
            </p>
          )}

          <button type="button" className="mdl-btn mdl-btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </aside>
    </div>
  );
}

export default Deliveries;
