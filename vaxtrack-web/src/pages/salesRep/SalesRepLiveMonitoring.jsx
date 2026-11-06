import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { auth } from "../../firebase";
import FleetMap from "../../components/tracking/FleetMap";
import TrackingStateBadge from "../../components/tracking/TrackingStateBadge";
import { useNow } from "../../components/useRiderLiveLocation";
import StatusBadge from "../../components/ui/StatusBadge";
import RequestedArrivalNote from "../../components/schedule/RequestedArrivalNote";
import { subscribeSalesRepOrders } from "../../services/orderService";
import { subscribeRiderLocation } from "../../services/riderTrackingService";
import { normalizeStatusKey, getOrderStatusValue } from "../../services/deliveryService";
import {
  buildFleet,
  formatAge,
  MARKER_LABELS,
  riderUidsOnDelivery,
} from "../../services/riderTracking";
import "../../components/tracking/LiveTracking.css";

/**
 * Med Rep › Live Monitoring — the same map + sidebar layout as Admin and
 * Dispatcher Live Tracking, scoped to the rep's OWN shipments.
 *
 * Only riders carrying one of this rep's orders appear. Firestore rules allow
 * a Med Rep to read a rider's location only while the server lists them as a
 * viewer of that rider (riderLocationViewers — set while the rider carries
 * their order); a Med Rep cannot list the fleet or read route-deviation
 * states, so this page opens one listener per such rider and shows freshness
 * only. A location that cannot be read shows as "Location unavailable".
 */
function SalesRepLiveMonitoring() {
  const uid = auth.currentUser?.uid ?? null;
  const nowMs = useNow();
  const [orders, setOrders] = useState(null);
  const [ordersError, setOrdersError] = useState(false);
  const [locations, setLocations] = useState({});
  const [selectedUid, setSelectedUid] = useState(null);

  useEffect(() => {
    if (!uid) return undefined;
    return subscribeSalesRepOrders(
      uid,
      (rows) => { setOrders(rows); setOrdersError(false); },
      () => setOrdersError(true)
    );
  }, [uid]);

  // One location listener per rider currently carrying this rep's orders,
  // replaced when that set changes.
  const riderKey = useMemo(() => [...riderUidsOnDelivery(orders || [])].sort().join("|"), [orders]);
  useEffect(() => {
    if (!riderKey) return undefined;
    const unsubs = riderKey.split("|").map((riderUid) =>
      subscribeRiderLocation(
        riderUid,
        (location) => setLocations((current) => ({ ...current, [riderUid]: location })),
        () => setLocations((current) => ({ ...current, [riderUid]: null }))
      )
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [riderKey]);

  const fleet = useMemo(
    () => (orders ? buildFleet({ orders, locations, deviations: null, riders: null, nowMs }) : []),
    [orders, locations, nowMs]
  );
  const ordersById = useMemo(() => new Map((orders || []).map((o) => [o.id, o])), [orders]);
  const selected = fleet.find((r) => r.uid === selectedUid) || fleet[0] || null;

  if (ordersError) {
    return (
      <div className="ltp-state ltp-state-error" role="alert">
        <strong>Your shipments could not be loaded.</strong>
        <p>Check your connection — this page reconnects on its own.</p>
      </div>
    );
  }
  if (!orders) {
    return (
      <div className="ltp-state" role="status" aria-live="polite">
        <span className="rv-spinner" aria-hidden="true" />
        <span>Loading your shipments…</span>
      </div>
    );
  }

  return (
    <div className="ltp srl-monitor">
      {fleet.length === 0 ? (
        <div className="ltp-state">
          <strong>None of your shipments has a rider right now.</strong>
          <p>
            A shipment appears here once a rider is assigned to it, until it is delivered. Every order is
            also in <Link to="/sales-rep/order-tracking">Order Tracking</Link>.
          </p>
        </div>
      ) : (
        <div className="ltp-grid">
          <section className="ltp-card ltp-map-card">
            <FleetMap riders={fleet} selectedUid={selected?.uid ?? null} onSelect={setSelectedUid} />
            {fleet.every((r) => !r.latLng) && (
              <p className="ltp-muted ltp-map-empty">No rider carrying your shipments has reported a position yet.</p>
            )}
          </section>

          {/* Shipments with a rider: assigned and loading at the hub, then on the
              road — the same set the server grants this rep location access for. */}
          <aside className="ltp-side">
            <section className="ltp-card">
              <h2 className="ltp-h">Shipment</h2>
              {selected ? (
                <div className="ltp-details">
                  <div className="ltp-details-head">
                    <strong>{selected.name}</strong>
                    <TrackingStateBadge state={selected.state} />
                  </div>
                  <p className="ltp-row">
                    <span>Last update</span>
                    <strong className="tnum">{formatAge(selected.locationAtMs, nowMs) || "—"}</strong>
                  </p>
                  <div className="ltp-orders">
                    <span>Your orders with this rider</span>
                    <ul>
                      {selected.orders.map((o) => {
                        const order = ordersById.get(o.id);
                        return (
                          <li key={o.id}>
                            <strong className="tnum">{o.orderNumber}</strong>{" "}
                            <StatusBadge statusKey={normalizeStatusKey(getOrderStatusValue(order || {}))} />
                            {o.clinicName && <span className="ltp-muted"> · {o.clinicName}</span>}
                            {order && <RequestedArrivalNote order={order} />}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              ) : (
                <p className="ltp-muted">Select a shipment on the map or in the list.</p>
              )}
            </section>
            <section className="ltp-card">
              <h2 className="ltp-h">
                Your shipments with a rider <span className="ltp-muted tnum">({fleet.length})</span>
              </h2>
              <ul className="ltp-list">
                {fleet.map((r) => (
                  <li key={r.uid}>
                    <button
                      type="button"
                      className={`ltp-list-item${r.uid === selected?.uid ? " active" : ""}`}
                      onClick={() => setSelectedUid(r.uid)}
                      aria-pressed={r.uid === selected?.uid}
                    >
                      <span className={`ltp-dot ltp-dot-${r.state}`} aria-hidden="true" />
                      <span className="ltp-list-name">
                        {r.name} · {r.orders.map((o) => o.orderNumber).join(", ")}
                      </span>
                      <span className="ltp-muted tnum">{formatAge(r.locationAtMs, nowMs) || MARKER_LABELS[r.state]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

export default SalesRepLiveMonitoring;
