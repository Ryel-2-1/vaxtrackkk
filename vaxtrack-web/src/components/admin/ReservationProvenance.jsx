import { useState } from "react";
import { getReservationProvenance } from "../../services/inventoryCallables";
import "./ReservationProvenance.css";

/**
 * "Where are this batch's held units?" for the Admin inventory drawer.
 *
 * Asks the server (getReservationProvenance) which open orders hold the
 * batch's reserved units and which failed-delivery returns hold its
 * return-pending units, and whether those add up to the batch's own counters.
 * A figure like "2 reserved" is therefore always inspectable down to the order
 * — and a mismatch is reported, never hidden. Loaded on demand (one callable),
 * and the parent remounts this per batch via `key`.
 */
function ReservationProvenance({ inventoryId }) {
  const [state, setState] = useState({ status: "idle", data: null, error: "" });

  const load = async () => {
    setState({ status: "loading", data: null, error: "" });
    try {
      const data = await getReservationProvenance(inventoryId);
      setState({ status: "ready", data, error: "" });
    } catch (error) {
      setState({
        status: "error",
        data: null,
        error: error?.message || "Reservation details could not be loaded.",
      });
    }
  };

  if (state.status === "idle") {
    return (
      <div className="inv-prov">
        <button type="button" className="inv-prov-load" onClick={load}>
          Show which orders hold this stock
        </button>
      </div>
    );
  }
  if (state.status === "loading") {
    return <p className="inv-prov inv-prov-muted">Loading reservations…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="inv-prov">
        <p className="inv-prov-error" role="alert">{state.error}</p>
        <button type="button" className="inv-prov-load" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  const d = state.data;
  const reservations = Array.isArray(d?.reservations) ? d.reservations : [];
  const returns = Array.isArray(d?.returns) ? d.returns : [];

  return (
    <section className="inv-prov" aria-label="Reservation provenance">
      <dl className="inv-prov-counts">
        <div><dt>On hand (not yet delivered)</dt><dd className="tnum">{d.onHand ?? "—"}</dd></div>
        <div><dt>Reserved</dt><dd className="tnum">{d.reservedQuantity ?? 0}</dd></div>
        <div><dt>Returned, awaiting decision</dt><dd className="tnum">{d.returnPendingQuantity ?? 0}</dd></div>
        <div><dt>Quarantined</dt><dd className="tnum">{d.quarantinedQuantity ?? 0}</dd></div>
        <div><dt>Available to allocate</dt><dd className="tnum">{d.available ?? "—"}</dd></div>
      </dl>

      {d.reconciled === false && (
        <p className="inv-prov-error" role="alert">
          These orders and returns do not add up to the batch's counters. The batch needs review before
          any manual change.
        </p>
      )}

      <h3>Reserved for</h3>
      {reservations.length === 0 ? (
        <p className="inv-prov-muted">No open order holds units of this batch.</p>
      ) : (
        <table className="inv-prov-table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Status</th>
              <th scope="col">Requested</th>
              <th scope="col">Units</th>
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => (
              <tr key={r.orderId}>
                <td>
                  {r.orderNumber || r.orderId}
                  {r.priority && String(r.priority).toLowerCase() === "urgent" && <small> · Urgent</small>}
                </td>
                <td>{r.status || "—"}</td>
                <td className="tnum">{r.requestedDeliveryDate || "—"}</td>
                <td className="tnum">{r.reservedQuantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {returns.length > 0 && (
        <>
          <h3>Returned by failed deliveries</h3>
          <table className="inv-prov-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Reason</th>
                <th scope="col">Units</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.returnId || r.orderId}>
                  <td>{r.orderNumber || r.orderId}</td>
                  <td>{r.failureReason || "—"}</td>
                  <td className="tnum">{r.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="inv-prov-muted">Confirm their condition under Stock Allocation.</p>
        </>
      )}
    </section>
  );
}

export default ReservationProvenance;
