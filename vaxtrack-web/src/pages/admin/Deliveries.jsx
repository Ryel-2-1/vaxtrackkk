import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  RotateCcw,
  Search,
  Truck,
  X,
} from "lucide-react";
import {
  subscribeDeliveries,
  UNKNOWN_STATUS_KEY,
  UNKNOWN_STATUS_LABEL,
} from "../../services/deliveryService";
import { ORDER_STATUSES, STATUS_LABELS } from "../../services/orderWorkflow";
import StatusBadge from "../../components/ui/StatusBadge";
import TimingIndicator from "../../components/ui/TimingIndicator";
import RequestedArrivalNote from "../../components/schedule/RequestedArrivalNote";
import KpiCard from "../../components/ui/KpiCard";
import PageNav, { PAGE_SIZE } from "../../components/ui/PageNav";
import OrderCancellationAction from "../../components/orders/OrderCancellationAction";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import LiveDeliveryMap from "../../components/LiveDeliveryMap";
import { subscribeOrderStatusEvents } from "../../services/statusEventService";
import { kpiValue, liveErrorMessage } from "../../services/liveDataErrors";
import "./Deliveries.css";

// The "Preparing" card counts — and its filter shows — orders not yet on the
// road: pending dispatch, assigned or loading.
const PREPARING_FILTER = "preparing";
const PREPARING_STATUSES = new Set(["pending_dispatch", "assigned", "loading"]);

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
    cancellationOrder: raw,
    // The order number people use. A shortened document id looked like a real
    // reference; an order without a number says so instead.
    id: raw.orderNumber || "No order number",
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
    requestedDeliveryDate: raw.requestedDeliveryDate ?? null,
    originalRequestedDeliveryDate: raw.originalRequestedDeliveryDate ?? null,
    requestedArrival: raw.requestedArrival ?? null,
    assignedAt: raw.assignedAt || null,
    statusUpdatedAt: raw.statusUpdatedAt || null,
    statusUpdatedByEmail: raw.statusUpdatedByEmail || "",
    // Rider-uploaded photos. Both are full Firebase Storage download URLs
    // written by the Flutter Rider app, so the web renders them directly and
    // needs no Storage SDK. `invoiceUrl` is the rider's photo of the paper
    // invoice — unrelated to the `invoices` collection / Admin Invoices module.
    // Server-evaluated delivery timing (functions/src/deliveryTiming.js) —
    // shown next to the lifecycle status, never instead of it.
    timingStatus: raw.timingStatus ?? null,
    expectedArrivalAt: raw.expectedArrivalAt ?? null,
    automaticDelayedAt: raw.automaticDelayedAt ?? null,
    proofOfDeliveryUrl: raw.proofOfDeliveryUrl || "",
    invoiceUrl: raw.invoiceUrl || "",
    // The rider whose live location the map reads (riderLocations/{uid} — the
    // order itself no longer carries a location copy), then the saved-route
    // fields. The map tolerates missing values and shows an honest fallback.
    assignedRiderId: raw.assignedRiderId || "",
    clinicLat: raw.clinicLat,
    clinicLng: raw.clinicLng,
    routePolyline: raw.routePolyline || "",
    routeProvider: raw.routeProvider ?? null,
    routeProfile: raw.routeProfile ?? null,
    tripRouteProvider: raw.tripRouteProvider ?? null,
    tripRouteProfile: raw.tripRouteProfile ?? null,
    routeDistanceMeters: raw.routeDistanceMeters,
    routeDurationSeconds: raw.routeDurationSeconds,
    routeEtaText: raw.routeEtaText || "",
    routeGeneratedAt: raw.routeGeneratedAt || null,
    // Multi-stop trip fields for the read-only delivery map (whole-trip route +
    // this order's place in the tour). tripId + clinicLat/Lng + stopSequence
    // also let the page plot every stop's marker for the admin overview.
    tripId: raw.tripId || "",
    tripPolyline: raw.tripPolyline || "",
    tripStopCount: raw.tripStopCount,
    tripDistanceMeters: raw.tripDistanceMeters,
    tripDurationSeconds: raw.tripDurationSeconds,
    stopSequence: raw.stopSequence,
    stopEtaText: raw.stopEtaText || "",
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

  const [deliveryList, setDeliveryList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  // An alert’s "Open delivery" link (/admin/deliveries?order=<order id>)
  // opens that order’s drawer as soon as the live list has it. Derived, not
  // copied into state, so it always shows the stored order; closing the
  // drawer drops the parameter so it does not reopen.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedOrderId = searchParams.get("order") || "";
  const linkedDelivery = linkedOrderId
    ? deliveryList.find((d) => d.uid === linkedOrderId) ?? null
    : null;
  const openDelivery = selectedDelivery
    ? deliveryList.find((delivery) => delivery.uid === selectedDelivery.uid) ?? null
    : linkedDelivery;
  const closeDelivery = () => {
    setSelectedDelivery(null);
    if (linkedOrderId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("order");
          return next;
        },
        { replace: true }
      );
    }
  };

  useEffect(() => {
    const unsubscribe = subscribeDeliveries(
      (raw) => {
        setDeliveryList(raw.map(normalizeDelivery));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(liveErrorMessage(error, "deliveries"));
      }
    );
    return () => unsubscribe();
  }, []);

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
        statusFilter === "all" ||
        (statusFilter === PREPARING_FILTER && PREPARING_STATUSES.has(delivery.statusType)) ||
        delivery.statusType === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [deliveryList, searchTerm, statusFilter]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredDeliveries.length / PAGE_SIZE)));
  const pageDeliveries = filteredDeliveries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Counted per canonical status. `delivered` and `cancelled` are no longer
  // folded into "in transit" and "delayed", and `delivery_failed` — which had
  // no count at all — now has its own.
  const countOf = (key) => deliveryList.filter((d) => d.statusType === key).length;
  const inTransitCount = countOf("in_transit");
  // A dash while loading or after a failed read — never a false zero.
  const kpiState = { loading, error: loadError };
  const delayedCount = countOf("delayed");
  const failedCount = countOf("delivery_failed");
  const preparingCount = deliveryList.filter((d) => PREPARING_STATUSES.has(d.statusType)).length;
  const unknownCount = countOf(UNKNOWN_STATUS_KEY);
  // Delayed and failed deliveries are listed on the Alerts page (Delivery
  // exceptions) and counted on the top bar's bell — no banner here.
  const filtersActive = statusFilter !== "all" || searchTerm !== "";
  const resetFilters = () => {
    setStatusFilter("all");
    setSearchTerm("");
  };

  // Every stop in the selected order's trip, numbered by visiting order. Admin
  // can read all orders, so it plots the whole tour; the map falls back to the
  // single numbered stop when this is empty.
  const selectedTripStops = useMemo(() => {
    const tripId = openDelivery?.tripId;
    if (!tripId) return [];
    return deliveryList
      .filter(
        (d) =>
          d.tripId === tripId &&
          Number.isFinite(d.clinicLat) &&
          Number.isFinite(d.clinicLng) &&
          Number.isFinite(d.stopSequence)
      )
      .sort((a, b) => a.stopSequence - b.stopSequence)
      .map((d) => ({ lat: d.clinicLat, lng: d.clinicLng, label: d.stopSequence }));
  }, [deliveryList, openDelivery]);

  return (
    <>
    <main className="deliveries-v4-page">

        <header className="mdl-header">
          {/* A "New delivery" button stood here and raised a toast explaining
              that deliveries are created elsewhere. A control that cannot do
              the thing it is labelled with is not a control — the same fact is
              stated as text, where it belongs. */}
          <p className="mdl-header-note">
            Orders are created by Med Reps and dispatched by a Dispatcher.
          </p>
        </header>

        <section className="deliveries-summary-grid">
          <KpiCard
            label="Total deliveries"
            value={kpiValue(deliveryList.length, kpiState)}
            context="All orders"
            tone="neutral"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />

          {/* "In transit" counted delivered and completed orders too, so
              finished deliveries were reported as on route. It now counts the
              one status it names. */}
          <KpiCard
            label="In transit"
            value={kpiValue(inTransitCount, kpiState)}
            context="On route"
            tone="info"
            active={statusFilter === "in_transit"}
            onClick={() => setStatusFilter("in_transit")}
          />

          {/* "Delayed" counted cancelled orders as well, which both overstated
              the figure and put closed orders behind a "Needs review" label. */}
          <KpiCard
            label="Delayed"
            value={kpiValue(delayedCount, kpiState)}
            context="Still open"
            tone="danger"
            attention={delayedCount > 0}
            active={statusFilter === "delayed"}
            onClick={() => setStatusFilter("delayed")}
          />

          {/* A canonical status with no count anywhere before this pass: a
              failed delivery was in the total and in the filter, and in no card. */}
          <KpiCard
            label="Delivery failed"
            value={kpiValue(failedCount, kpiState)}
            context="Rider stopped"
            tone="danger"
            attention={failedCount > 0}
            active={statusFilter === "delivery_failed"}
            onClick={() => setStatusFilter("delivery_failed")}
          />

          <KpiCard
            label="Preparing"
            value={kpiValue(preparingCount, kpiState)}
            context="Pending, assigned or loading"
            tone="warning"
            active={statusFilter === PREPARING_FILTER}
            onClick={() => setStatusFilter(PREPARING_FILTER)}
          />
        </section>

        {/* The cards above are the status tabs; this row refines them: search,
            any single status (including those no card covers) and Reset. */}
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
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {/* Straight from the canonical list, so every status an order can
                hold is selectable and none can be forgotten here. `unknown` is
                offered too — a document carrying a value the system does not
                define is findable rather than buried in another bucket. */}
            <option value="all">All statuses</option>
            <option value={PREPARING_FILTER}>Preparing (pending, assigned or loading)</option>
            {ORDER_STATUSES.map((key) => (
              <option key={key} value={key}>
                {STATUS_LABELS[key]}
              </option>
            ))}
            <option value={UNKNOWN_STATUS_KEY}>{UNKNOWN_STATUS_LABEL}</option>
          </select>

          <button
            type="button"
            className="mdl-btn mdl-btn-secondary"
            onClick={resetFilters}
            disabled={!filtersActive}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Reset filters
          </button>
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
                {pageDeliveries.map((delivery) => (
                  <tr
                    key={delivery.uid}
                    className={
                      delivery.statusType === "delayed" ? "mdl-row-delayed" : ""
                    }
                    onClick={() => setSelectedDelivery(delivery)}
                  >
                    <td>
                      <span className="mdl-td-order">{delivery.id}</span>
                      <RequestedArrivalNote order={delivery} />
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
                      <div>
                        <TimingIndicator order={delivery} detail={false} />
                      </div>
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
                    ? "Deliveries appear here when orders are created by Medical Representatives."
                    : "Try adjusting your search or selected filters."}
                </p>
              </div>
            )}
          </div>
          {filteredDeliveries.length > 0 && (
            <PageNav page={currentPage} total={filteredDeliveries.length} onPageChange={setPage} label="Delivery pages" />
          )}
        </section>
      </main>

      {/* Admin delivery details remain a read-only view of the order. */}
      {openDelivery && (
        <DeliveryModal
          delivery={openDelivery}
          tripStops={selectedTripStops}
          onClose={closeDelivery}
        />
      )}
    </>
  );
}

function DeliveryModal({ delivery, tripStops = [], onClose }) {
  const created = formatDateTime(delivery.createdAt);
  const assigned = formatDateTime(delivery.assignedAt);
  const statusUpdated = formatDateTime(delivery.statusUpdatedAt);

  // Server-recorded status history. Tagged with the order it was loaded for,
  // so switching orders shows "loading" rather than the previous order's list.
  const [history, setHistory] = useState({ orderId: null, events: [], error: false });
  useEffect(
    () =>
      subscribeOrderStatusEvents(
        delivery.uid,
        (events) => setHistory({ orderId: delivery.uid, events, error: false }),
        () => setHistory({ orderId: delivery.uid, events: [], error: true })
      ),
    [delivery.uid]
  );
  const historyLoaded = history.orderId === delivery.uid;
  // A modal drawer: focus moves in, Tab stays inside, Escape closes, and
  // focus returns to the row that opened it.
  const drawerRef = useRef(null);
  useDialogFocus({ dialogRef: drawerRef, onDismiss: onClose });

  return (
    <div className="mdl-drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="mdl-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mdl-drawer-title"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mdl-drawer-head">
          <div>
            <div className="mdl-drawer-title-row">
              <h2 id="mdl-drawer-title">{delivery.id}</h2>
              <StatusBadge statusKey={delivery.statusKey} />
            </div>
            <TimingIndicator order={delivery} />
            <RequestedArrivalNote order={delivery} />
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
          <OrderCancellationAction key={delivery.uid} order={delivery.cancellationOrder} scope="inventory-page" />
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
            <h3>Live location</h3>
            <LiveDeliveryMap order={delivery} tripStops={tripStops} showDeviation />
          </section>

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

          <section className="mdl-drawer-section">
            <h3>Status history</h3>
            {!historyLoaded && <p className="mdl-drawer-note">Loading status history…</p>}
            {historyLoaded && history.error && (
              <p className="mdl-drawer-note">Status history could not be loaded.</p>
            )}
            {historyLoaded && !history.error && history.events.length === 0 && (
              <p className="mdl-drawer-note">
                No status changes recorded for this order. History is kept for
                changes made since it was introduced; earlier ones were not
                recorded and are not reconstructed.
              </p>
            )}
            {historyLoaded && history.events.length > 0 && (
              <ol className="mdl-history">
                {history.events.map((event) => (
                  <li key={event.id}>
                    <div className="mdl-drawer-row">
                      <span>{STATUS_LABELS[event.to] ?? event.to}</span>
                      <strong className="tnum">{formatDateTime(event.at) ?? "—"}</strong>
                    </div>
                    {event.reason && <p className="mdl-history-reason">{event.reason}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <footer className="mdl-drawer-actions">
          <button type="button" className="mdl-btn mdl-btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </aside>
    </div>
  );
}

export default Deliveries;
