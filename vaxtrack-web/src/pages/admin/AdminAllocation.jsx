import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AdminLayout from "../../components/admin/AdminLayout";
import KpiCard from "../../components/ui/KpiCard";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { kpiValue, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { subscribeBackorderQueue, subscribePendingReturns } from "../../services/allocationService";
import { confirmReturnDisposition } from "../../services/inventoryCallables";
import { describeAllocation } from "../../services/backorder";
import {
  SPLIT_OUTCOMES,
  evaluateSplit,
  returnReason,
  returnSourceLabel,
  splitTotals,
} from "../../services/returnSplit";
import "./AdminAllocation.css";

/**
 * Admin › Stock allocation.
 *
 * 1. The backorder queue: future orders waiting for stock, in the exact order
 *    the server will serve them (Urgent, then earliest requested date/time,
 *    then creation time). Read-only — allocation happens on the server when
 *    stock is added, returned as usable, or released by a cancellation.
 * 2. Returns awaiting a decision: stock brought back by a failed delivery or
 *    by an order cancelled after dispatch (the vials were with the rider).
 *    It is neither reserved nor available until an Admin confirms its
 *    condition here — for the whole return, or by quantity per batch. Only
 *    usable vials go back into stock (and are immediately reallocated); the
 *    rest are quarantined or written off.
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

/** "3 usable, 2 damaged" — the outcomes a split actually uses. */
function splitSentence(lines) {
  const totals = splitTotals(lines);
  return SPLIT_OUTCOMES.filter(({ key }) => totals[key] > 0)
    .map(({ key, label }) => `${totals[key].toLocaleString()} ${label.toLowerCase()}`)
    .join(", ");
}

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
  // The decision awaiting confirmation: { ret, disposition } for the whole
  // return, or { ret, lines } when recorded by quantity | null.
  const [pending, setPending] = useState(null);
  // Per-return "record by quantity" form: which are open, and their figures.
  const [splitOpen, setSplitOpen] = useState({});
  const [splitDraft, setSplitDraft] = useState({});

  useEffect(() => {
    const unsubQueue = subscribeBackorderQueue(
      (rows) => {
        setQueue(rows);
        setQueueLoading(false);
        setQueueError("");
      },
      (err) => {
        setQueueLoading(false);
        setQueueError(liveErrorMessage(err, "the backorder queue"));
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
        setReturnsError(liveErrorMessage(err, "pending returns"));
      }
    );
    return () => {
      unsubQueue();
      unsubReturns();
    };
  }, []);

  // Choosing a disposition only opens the confirmation; nothing is written
  // until the Admin confirms it there.
  const decide = (ret, disposition) => {
    if (busyId) return;
    setActionError("");
    setPending({ ret, disposition });
  };

  // Runs from the confirmation dialog. On failure it rethrows, so the dialog
  // stays open with the error inside it and the typed notes are untouched.
  const runDisposition = async () => {
    const { ret, disposition, lines } = pending;
    setBusyId(ret.id);
    setOutcome(null);
    try {
      const result = lines
        ? await confirmReturnDisposition(ret.id, null, notes[ret.id] || "", lines)
        : await confirmReturnDisposition(ret.id, disposition, notes[ret.id] || "");
      setOutcome({
        orderNumber: ret.orderNumber || ret.orderId,
        disposition: lines ? "split" : disposition,
        splitSummary: lines ? splitSentence(lines) : null,
        anyUsable: lines ? splitTotals(lines).usable > 0 : disposition === "usable",
        reallocated: Array.isArray(result?.reallocated) ? result.reallocated : [],
        replayed: result?.replayed === true,
      });
      setPending(null);
    } catch (error) {
      logSafeError("Confirm return disposition", error);
      throw error;
    } finally {
      setBusyId(null);
    }
  };
  const pendingChoice = pending
    ? pending.lines
      ? { label: "Quantities by batch", tone: splitTotals(pending.lines).usable > 0 ? "primary" : "danger" }
      : DISPOSITIONS.find((d) => d.value === pending.disposition)
    : null;
  const setSplitFigure = (retId, inventoryId, key, value) =>
    setSplitDraft((all) => ({
      ...all,
      [retId]: { ...(all[retId] || {}), [inventoryId]: { ...(all[retId]?.[inventoryId] || {}), [key]: value } },
    }));
  const kpiState = { loading: queueLoading, error: queueError };

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
        <KpiCard label="Awaiting stock" value={kpiValue(awaiting, kpiState)} context="nothing reserved yet" tone="warning" />
        <KpiCard label="Partially reserved" value={kpiValue(partial, kpiState)} context="some items held" tone="info" />
        <KpiCard
          label="Vials short"
          value={kpiValue(shortUnits.toLocaleString(), kpiState)}
          context="across waiting orders"
          tone="warning"
        />
        <KpiCard
          label="Returns to confirm"
          value={kpiValue(returns.length, { loading: returnsLoading, error: returnsError })}
          context={`${returnUnits.toLocaleString()} vials held aside`}
          tone={returns.length ? "danger" : "neutral"}
          attention={returns.length > 0}
        />
      </section>

      {outcome && (
        <div className="alloc-outcome" role="status">
          <strong>
            {outcome.orderNumber}:{" "}
            {outcome.disposition === "split"
              ? `recorded by quantity — ${outcome.splitSummary}`
              : DISPOSITIONS.find((d) => d.value === outcome.disposition)?.label}
            {outcome.replayed ? " (already recorded)" : ""}
          </strong>
          {outcome.anyUsable &&
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

      {pending && pendingChoice && (
        <ConfirmDialog
          title={`Record "${pendingChoice.label}"?`}
          target={`${(Number(pending.ret.totalQuantity) || 0).toLocaleString()} returned vials from ${
            pending.ret.orderNumber || pending.ret.orderId
          }`}
          consequence={
            pending.lines
              ? `${splitSentence(pending.lines)}. Only usable vials return to available stock and can be reallocated; damaged and temperature-excursion vials are quarantined, missing ones written off. This cannot be changed afterwards.`
              : `They will be ${DISPOSITION_EFFECT[pending.disposition]}. This cannot be changed afterwards.`
          }
          confirmLabel={`Record ${pendingChoice.label.toLowerCase()}`}
          busyLabel="Recording…"
          cancelLabel="Go back"
          tone={pendingChoice.tone === "danger" ? "danger" : "primary"}
          failureMessage="The return could not be recorded. Nothing was changed — please try again."
          onConfirm={runDisposition}
          onCancel={() => setPending(null)}
        />
      )}

      <section className="alloc-card" aria-labelledby="alloc-returns-heading">
        <header>
          <h2 id="alloc-returns-heading">Returns awaiting confirmation</h2>
          <p>
            Vials brought back after a failed delivery, or from an order cancelled after dispatch. Check the
            physical stock, then record its condition — for the whole return, or by quantity for each batch.
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
                  {returnSourceLabel(ret)} {formatWhen(ret.reportedAt)} · Reason: {returnReason(ret) || "not given"}
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
                  <button
                    type="button"
                    className="alloc-btn alloc-btn-secondary"
                    aria-expanded={splitOpen[ret.id] === true}
                    aria-controls={`split-${ret.id}`}
                    disabled={busyId !== null}
                    onClick={() => setSplitOpen((o) => ({ ...o, [ret.id]: !o[ret.id] }))}
                  >
                    {splitOpen[ret.id] ? "Close quantities" : "Record by quantity"}
                  </button>
                </div>
                {splitOpen[ret.id] && (() => {
                  const split = evaluateSplit(ret, splitDraft[ret.id]);
                  return (
                    <div className="alloc-split" id={`split-${ret.id}`}>
                      <p className="alloc-muted">
                        Enter how many vials of each batch are usable, damaged, a temperature excursion or missing.
                        Each batch must add up to what came back. Only usable vials go back into stock.
                      </p>
                      <div className="alloc-table-wrap">
                        <table className="alloc-table alloc-split-table">
                          <thead>
                            <tr>
                              <th scope="col">Batch</th>
                              <th scope="col">Returned</th>
                              {SPLIT_OUTCOMES.map((o) => (
                                <th scope="col" key={o.key}>{o.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {split.rows.map((row) => (
                              <tr key={row.inventoryId}>
                                <td>
                                  {row.batchLabel}
                                  {row.problem && (
                                    <span className="alloc-split-problem" role="status">{row.problem}</span>
                                  )}
                                </td>
                                <td className="tnum">{row.quantity.toLocaleString()}</td>
                                {SPLIT_OUTCOMES.map((o) => (
                                  <td key={o.key}>
                                    <input
                                      id={`split-${ret.id}-${row.inventoryId}-${o.key}`}
                                      type="number"
                                      inputMode="numeric"
                                      min="0"
                                      step="1"
                                      aria-label={`${o.label} vials of batch ${row.batchLabel}`}
                                      value={splitDraft[ret.id]?.[row.inventoryId]?.[o.key] ?? ""}
                                      onChange={(e) => setSplitFigure(ret.id, row.inventoryId, o.key, e.target.value)}
                                    />
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        type="button"
                        className="alloc-btn alloc-btn-primary"
                        disabled={busyId !== null || !split.valid}
                        onClick={() => {
                          if (busyId) return;
                          setActionError("");
                          setPending({ ret, lines: split.lines });
                        }}
                      >
                        Review quantities
                      </button>
                    </div>
                  );
                })()}
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
