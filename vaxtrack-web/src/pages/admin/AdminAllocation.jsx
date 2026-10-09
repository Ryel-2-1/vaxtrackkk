import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AdminLayout from "../../components/admin/AdminLayout";
import KpiCard from "../../components/ui/KpiCard";
import { subscribeBackorderQueue, subscribePendingReturns } from "../../services/allocationService";
import { confirmReturnDisposition } from "../../services/inventoryCallables";
import { describeAllocation } from "../../services/backorder";
import "./AdminAllocation.css";

/**
 * Admin › Stock allocation.
 *
 * 1. The backorder queue: future orders waiting for stock, in the exact order
 *    the server will serve them (Urgent, then earliest requested date/time,
 *    then creation time). Read-only — allocation happens on the server when
 *    stock is added, returned as usable, or released by a cancellation.
 * 2. Returns awaiting a decision: stock brought back by a failed delivery.
 *    It is neither reserved nor available until an Admin confirms its
 *    condition here. Only "Returned and usable" puts it back into stock (and
 *    immediately reallocates it); the others quarantine or write it off.
 */

const DISPOSITIONS = [
  { value: "usable", label: "Returned and usable", tone: "primary" },
  { value: "damaged", label: "Damaged", tone: "danger" },
  { value: "temperature_excursion", label: "Temperature excursion", tone: "danger" },
  { value: "missing", label: "Missing", tone: "danger" },
];

const DISPOSITION_EFFECT = {
  usable: "restored to available stock and reallocated to waiting orders",
  damaged: "quarantined — never allocated",
  temperature_excursion: "quarantined — never allocated",
  missing: "written off the batch's on-hand stock",
};

function formatWhen(ts) {
  const d = ts?.toDate?.();
  if (!d) return "—";
  return d.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

function requestedLabel(order) {
  if (!order.requestedDeliveryDate) return "No date (served last)";
  return order.scheduledDeliveryTime
    ? `${order.requestedDeliveryDate} ${order.scheduledDeliveryTime}`
    : order.requestedDeliveryDate;
}

function AdminAllocation() {
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState("");
  const [returns, setReturns] = useState([]);
  const [returnsLoading, setReturnsLoading] = useState(true);
  const [returnsError, setReturnsError] = useState("");
  // Per-return draft notes and the one return currently being decided.
  const [notes, setNotes] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const unsubQueue = subscribeBackorderQueue(
      (rows) => {
        setQueue(rows);
        setQueueLoading(false);
        setQueueError("");
      },
      (err) => {
        setQueueLoading(false);
        setQueueError(
          err?.code === "permission-denied"
            ? "You do not have permission to view the backorder queue."
            : "The backorder queue could not be loaded."
        );
      }
    );
    const unsubReturns = subscribePendingReturns(
      (rows) => {
        setReturns(rows);
        setReturnsLoading(false);
        setReturnsError("");
      },
      (err) => {
        setReturnsLoading(false);
        setReturnsError(
          err?.code === "permission-denied"
            ? "You do not have permission to view returns."
            : "Pending returns could not be loaded."
        );
      }
    );
    return () => {
      unsubQueue();
      unsubReturns();
    };
  }, []);

  const decide = async (ret, disposition) => {
    if (busyId) return;
    const choice = DISPOSITIONS.find((d) => d.value === disposition);
    const ok = window.confirm(
      `Confirm "${choice.label}" for ${ret.totalQuantity ?? "these"} returned vial(s) from ${
        ret.orderNumber || ret.orderId
      }?\n\nThey will be ${DISPOSITION_EFFECT[disposition]}. This cannot be changed afterwards.`
    );
    if (!ok) return;
    setBusyId(ret.id);
    setActionError("");
    setOutcome(null);
    try {
      const result = await confirmReturnDisposition(ret.id, disposition, notes[ret.id] || "");
      setOutcome({
        orderNumber: ret.orderNumber || ret.orderId,
        disposition,
        reallocated: Array.isArray(result?.reallocated) ? result.reallocated : [],
        replayed: result?.replayed === true,
      });
    } catch (error) {
      setActionError(error?.message || "The return could not be confirmed. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const awaiting = queue.filter((o) => o.allocationState === "awaiting_stock").length;
  const partial = queue.filter((o) => o.allocationState === "partially_reserved").length;
  const shortUnits = queue.reduce((sum, o) => sum + describeAllocation(o).backordered, 0);
  const returnUnits = returns.reduce((sum, r) => sum + (Number(r.totalQuantity) || 0), 0);

  return (
    <AdminLayout
      description="Current backlog: future orders waiting for stock now, and returned stock that needs a decision. Resolved orders leave this queue; their receipts and allocation history stay in Order History."
      actions={
        <Link className="alloc-btn alloc-history-link" to="/admin/order-history">
          Order &amp; allocation history
        </Link>
      }
    >
      <section className="alloc-kpis" aria-label="Allocation summary">
        <KpiCard label="Awaiting stock" value={awaiting} context="nothing reserved yet" tone="warning" />
        <KpiCard label="Partially reserved" value={partial} context="some items held" tone="info" />
        <KpiCard label="Vials short" value={shortUnits.toLocaleString()} context="across waiting orders" tone="warning" />
        <KpiCard
          label="Returns to confirm"
          value={returns.length}
          context={`${returnUnits.toLocaleString()} vials held aside`}
          tone={returns.length ? "danger" : "neutral"}
          attention={returns.length > 0}
        />
      </section>

      {outcome && (
        <div className="alloc-outcome" role="status">
          <strong>
            {outcome.orderNumber}: {DISPOSITIONS.find((d) => d.value === outcome.disposition)?.label}
            {outcome.replayed ? " (already recorded)" : ""}
          </strong>
          {outcome.disposition === "usable" &&
            (outcome.reallocated.length > 0 ? (
              <ul>
                {outcome.reallocated.map((a) => (
                  <li key={`${a.orderId}-${a.units}`}>
                    Reallocated {a.units.toLocaleString()} to {a.orderNumber || a.orderId} —{" "}
                    {a.allocationState === "fully_reserved" ? "now fully reserved" : "still waiting for more"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Restored to available stock. No waiting order needed it.</p>
            ))}
        </div>
      )}
      {actionError && (
        <p className="alloc-error" role="alert">
          {actionError}
        </p>
      )}

      <section className="alloc-card" aria-labelledby="alloc-returns-heading">
        <header>
          <h2 id="alloc-returns-heading">Returns awaiting confirmation</h2>
          <p>
            Reported by riders after a failed delivery. Check the physical stock, then record its condition.
            Until then these vials are neither reserved nor available.
          </p>
        </header>
        {returnsLoading ? (
          <p className="alloc-muted">Loading returns…</p>
        ) : returnsError ? (
          <p className="alloc-error" role="alert">{returnsError}</p>
        ) : returns.length === 0 ? (
          <p className="alloc-muted">No returned stock is waiting for a decision.</p>
        ) : (
          <ul className="alloc-return-list">
            {returns.map((ret) => (
              <li key={ret.id} className="alloc-return">
                <div className="alloc-return-head">
                  <strong>{ret.orderNumber || ret.orderId}</strong>
                  <span className="tnum">{(Number(ret.totalQuantity) || 0).toLocaleString()} vials</span>
                </div>
                <p className="alloc-muted">
                  Failed {formatWhen(ret.reportedAt)} · Reason: {ret.failureReason || "not given"}
                </p>
                <table className="alloc-table">
                  <thead>
                    <tr>
                      <th scope="col">Batch</th>
                      <th scope="col">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(ret.items || []).map((item, i) => (
                      <tr key={`${item.inventoryId}-${i}`}>
                        <td>{item.batchId || item.inventoryId}</td>
                        <td className="tnum">{Number(item.quantity || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <label className="alloc-notes">
                  <span>Notes (optional)</span>
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={notes[ret.id] || ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [ret.id]: e.target.value }))}
                  />
                </label>
                <div className="alloc-actions">
                  {DISPOSITIONS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      className={`alloc-btn alloc-btn-${d.tone}`}
                      disabled={busyId !== null}
                      onClick={() => decide(ret, d.value)}
                    >
                      {busyId === ret.id ? "Saving…" : d.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="alloc-card" aria-labelledby="alloc-queue-heading">
        <header>
          <h2 id="alloc-queue-heading">Backorder queue (current)</h2>
          <p>
            In the order stock will be given out: Urgent first, then the earliest requested date and time,
            then the order placed first. Orders are dispatched only once fully reserved.
          </p>
        </header>
        {queueLoading ? (
          <p className="alloc-muted">Loading queue…</p>
        ) : queueError ? (
          <p className="alloc-error" role="alert">{queueError}</p>
        ) : queue.length === 0 ? (
          <p className="alloc-muted">No orders are waiting for stock.</p>
        ) : (
          <div className="alloc-table-wrap">
            <table className="alloc-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Order</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Items short</th>
                  <th scope="col">Reserved</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((order, index) => {
                  const info = describeAllocation(order);
                  return (
                    <tr key={order.id}>
                      <td className="tnum">{index + 1}</td>
                      <td>
                        <strong>{order.orderNumber || order.id}</strong>
                        <small>{order.clinicName || order.destinationName || ""}</small>
                      </td>
                      <td>{String(order.priority || "").toLowerCase() === "urgent" ? "Urgent" : "Standard"}</td>
                      <td className="tnum">{requestedLabel(order)}</td>
                      <td>
                        {info.lines
                          .filter((l) => l.backordered > 0)
                          .map((l) => (
                            <small key={l.index}>
                              {l.name}: {l.backordered.toLocaleString()} short
                            </small>
                          ))}
                      </td>
                      <td className="tnum">
                        {info.reserved.toLocaleString()} / {info.requested.toLocaleString()}
                      </td>
                      <td>
                        <span className={`alloc-state alloc-state-${info.state}`}>{info.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminLayout>
  );
}

export default AdminAllocation;
