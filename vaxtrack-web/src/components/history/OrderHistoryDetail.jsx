import { useEffect, useState } from "react";
import { formatCentavos } from "../../services/money.js";
import { describeAllocation } from "../../services/backorder.js";
import {
  INITIAL_ALLOCATION_PENDING,
  LEGACY_RECEIPT_DETAIL,
  LEGACY_RECEIPT_MESSAGE,
  NO_HISTORY_MESSAGE,
  RECEIPT_DISCLAIMER,
  RECEIPT_TITLE,
  RECONSTRUCTED_RECEIPT_MESSAGE,
  VAT_STATUS_LABELS,
  confirmationSnapshot,
  currentLineFulfilment,
  eventBatches,
  eventLabel,
  eventTone,
  formatDateTime,
  fulfilmentStage,
  receiptLines,
  receiptPriceLabels,
  receiptStatus,
  sortEvents,
  sourceLabel,
} from "../../services/orderHistory.js";
import { subscribeAllocationEvents, subscribeOrder } from "../../services/orderHistoryService";

/**
 * One order's history, in three clearly separate parts:
 *
 *   1. Original Order Confirmation Receipt — the immutable server snapshot, or
 *      an explicit legacy notice when none exists (never current data in its
 *      place).
 *   2. Current Fulfillment Summary — the order as it stands now; batches only
 *      where an allocation event proves them.
 *   3. Stock Allocation Timeline — the append-only ledger.
 *
 * Printing: the receipt prints on its own at normal browser size. A body class
 * scopes the print stylesheet to this action, so no other page is affected.
 */

const DASH = "—";

function printReceipt() {
  const cls = "ohx-printing";
  document.body.classList.add(cls);
  const done = () => {
    document.body.classList.remove(cls);
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  // Browsers without afterprint (or a cancelled dialog) still restore the page.
  setTimeout(done, 1000);
}

function Field({ label, children }) {
  return (
    <div className="ohx-field">
      <dt>{label}</dt>
      <dd>{children ?? DASH}</dd>
    </div>
  );
}

function Receipt({ receipt, events, eventsLoading }) {
  const snapshot = confirmationSnapshot(events);
  const lines = receiptLines(receipt, snapshot);
  const reconstructed = receiptStatus(receipt) === "reconstructed";
  const priceLabels = receiptPriceLabels(receipt);
  const date = receipt.requestedDeliveryDate
    ? `${receipt.requestedDeliveryDate}${receipt.requestedDeliveryTime ? ` ${receipt.requestedDeliveryTime}` : ""}`
    : "Not specified";
  return (
    <section className="ohx-card ohx-receipt" aria-labelledby="ohx-receipt-title">
      <header className="ohx-receipt-head">
        <div>
          <h2 id="ohx-receipt-title">1. Original {RECEIPT_TITLE}</h2>
          <p className="ohx-disclaimer">{RECEIPT_DISCLAIMER}</p>
        </div>
        <button type="button" className="ohx-btn ohx-noprint" onClick={printReceipt}>Print receipt</button>
      </header>
      {reconstructed && (
        <div className="ohx-banner ohx-banner-warning" role="note">
          <strong>{RECONSTRUCTED_RECEIPT_MESSAGE}</strong>
          {(receipt.reconstructionNotes || []).map((n) => <p key={n}>{n}</p>)}
        </div>
      )}
      <dl className="ohx-fields">
        <Field label="Order reference"><span className="ohx-ref">{receipt.orderNumber || DASH}</span></Field>
        <Field label="Order document ID"><code>{receipt.orderId}</code></Field>
        <Field label="Order placed">{formatDateTime(receipt.orderCreatedAt)}</Field>
        <Field label="Med Rep">
          {receipt.medRepName || DASH}
          {receipt.medRepEmail && <small className="ohx-muted">{receipt.medRepEmail}</small>}
        </Field>
        <Field label="Doctor">{receipt.doctorName}</Field>
        <Field label="Clinic / destination">{receipt.clinicName || receipt.destinationName}</Field>
        <Field label="Delivery address">{receipt.deliveryAddress}</Field>
        <Field label="Requested delivery">{date}</Field>
        <Field label="Priority">{receipt.priority || DASH}</Field>
      </dl>
      <div className="ohx-table-wrap">
        <table className="ohx-table ohx-receipt-lines">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">SKU</th>
              <th scope="col">Product ID</th>
              <th scope="col">Qty requested</th>
              <th scope="col">Unit price</th>
              <th scope="col">Line total</th>
              {!reconstructed && <th scope="col">At confirmation</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineIndex}>
                <td>{l.name || DASH}</td>
                <td>{l.sku || DASH}</td>
                <td><code>{l.productKey || DASH}</code></td>
                <td className="tnum">{l.quantityRequested?.toLocaleString() ?? DASH}</td>
                <td className="tnum">{formatCentavos(l.unitPriceCentavos)}</td>
                <td className="tnum">{formatCentavos(l.lineTotalCentavos)}</td>
                {!reconstructed && (
                  <td className="tnum">
                    {l.reservedAtConfirmation == null
                      // Guaranteed by the server's outbox; briefly pending, never "not recorded".
                      ? <span className="ohx-muted">{eventsLoading ? "Loading…" : INITIAL_ALLOCATION_PENDING}</span>
                      : `${l.reservedAtConfirmation.toLocaleString()} reserved, ${l.backorderedAtConfirmation.toLocaleString()} backordered`}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ohx-totals">
        <Field label={priceLabels.subtotalLabel}>{formatCentavos(receipt.subtotalCentavos)}</Field>
        <Field label="VAT">
          {VAT_STATUS_LABELS[receipt.vatStatus] || receipt.vatStatus || DASH}
          {receipt.vatAmountCentavos != null && ` · ${formatCentavos(receipt.vatAmountCentavos)}${priceLabels.vatSuffix}`}
        </Field>
        <Field label="Discount">{receipt.discountCentavos != null ? formatCentavos(receipt.discountCentavos) : "None at order time"}</Field>
        <Field label="Total">
          {receipt.finalTotalCentavos != null
            ? <strong>{formatCentavos(receipt.finalTotalCentavos)}</strong>
            : "Final total set on the invoice"}
        </Field>
      </dl>
      {!snapshot && !reconstructed && !eventsLoading && (
        <p className="ohx-muted" role="status">
          {INITIAL_ALLOCATION_PENDING} This normally takes a few seconds; it appears here automatically.
        </p>
      )}
      {snapshot?.recovered && (
        <p className="ohx-muted">
          The reservation at confirmation was recorded by the history recovery process after its own allocation pass.
        </p>
      )}
      <p className="ohx-muted">{priceLabels.note}</p>
      <p className="ohx-meta">
        Receipt schema v{receipt.schemaVersion ?? "?"} · Source: {receipt.creationSource || DASH} · Recorded {formatDateTime(receipt.createdAt)}
      </p>
    </section>
  );
}

function LegacyNotice() {
  return (
    <section className="ohx-card" aria-labelledby="ohx-receipt-title">
      <h2 id="ohx-receipt-title">1. Original {RECEIPT_TITLE}</h2>
      <div className="ohx-banner ohx-banner-warning" role="note">
        <strong>{LEGACY_RECEIPT_MESSAGE}</strong>
        <p>{LEGACY_RECEIPT_DETAIL}</p>
      </div>
    </section>
  );
}

function CurrentSummary({ order, events }) {
  const stage = fulfilmentStage(order);
  const allocation = describeAllocation(order);
  const lines = currentLineFulfilment(order, events);
  return (
    <section className="ohx-card ohx-noprint" aria-labelledby="ohx-current-title">
      <h2 id="ohx-current-title">2. Current Fulfillment Summary</h2>
      <p className="ohx-muted">The order as it stands now. This changes as stock and delivery progress; the receipt above does not.</p>
      <dl className="ohx-fields">
        <Field label="Order reference"><span className="ohx-ref">{order.orderNumber || order.id}</span></Field>
        <Field label="Current status"><span className={`ohx-stage ohx-stage-${stage.value}`}>{stage.label}</span></Field>
        <Field label="Allocation">{allocation.tracked ? `${allocation.label} — ${allocation.reserved} of ${allocation.requested} reserved` : "Not tracked"}</Field>
        <Field label="Doctor">{order.doctorName}</Field>
        <Field label="Clinic / destination">{order.clinicName || order.destinationName}</Field>
        <Field label="Delivery address">{order.deliveryAddress || order.clinicAddress}</Field>
        <Field label="Priority">{order.priority}</Field>
        <Field label="Requested delivery">{order.requestedDeliveryDate || "Not specified"}</Field>
      </dl>
      <div className="ohx-table-wrap">
        <table className="ohx-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Requested</th>
              <th scope="col">Reserved</th>
              <th scope="col">Backordered</th>
              <th scope="col">Batches</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineIndex}>
                <td>{l.name}{l.sku && <small className="ohx-muted">{l.sku}</small>}</td>
                <td className="tnum">{l.requested.toLocaleString()}</td>
                <td className="tnum">{l.reserved == null ? DASH : l.reserved.toLocaleString()}</td>
                <td className="tnum">{l.backordered == null ? DASH : l.backordered.toLocaleString()}</td>
                <td>
                  {l.batches.length > 0
                    ? l.batches.map((b) => (
                        <span key={b.inventoryId || b.batchId} className="ohx-chip">
                          {b.batchId || b.inventoryId} × {b.quantity}{l.delivered ? " (delivered)" : ""}
                        </span>
                      ))
                    : <span className="ohx-muted">{l.batchNote}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Timeline({ events, loading, error }) {
  const ordered = sortEvents(events);
  return (
    <section className="ohx-card ohx-noprint" aria-labelledby="ohx-timeline-title">
      <h2 id="ohx-timeline-title">3. Stock Allocation Timeline</h2>
      {loading ? (
        <p className="ohx-muted" role="status">Loading allocation history…</p>
      ) : error ? (
        <p className="ohx-error" role="alert">{error}</p>
      ) : ordered.length === 0 ? (
        <p className="ohx-muted">{NO_HISTORY_MESSAGE}</p>
      ) : (
        <ol className="ohx-timeline">
          {ordered.map((e) => (
            <li key={e.id} className={`ohx-event ohx-tone-${eventTone(e.eventType)}`}>
              <div className="ohx-event-head">
                <strong>{eventLabel(e.eventType)}</strong>
                <time className="tnum">{formatDateTime(e.createdAt)}</time>
              </div>
              <p>{e.summary}</p>
              {eventBatches(e).length > 0 && (
                <p className="ohx-event-batches">
                  {eventBatches(e).map((b) => (
                    <span key={b.label} className="ohx-chip">{b.label} × {b.quantity}</span>
                  ))}
                </p>
              )}
              <p className="ohx-event-meta">
                After: {e.reservedQuantityAfter ?? DASH} reserved · {e.backorderedQuantityAfter ?? DASH} backordered of {e.requestedQuantity ?? DASH}
                {" · "}{sourceLabel(e.sourceOperation)}
                {" · "}{e.actorRole === "system" ? "System" : e.actorRole ? e.actorRole[0].toUpperCase() + e.actorRole.slice(1) : "System"}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function OrderHistoryDetail({ row, mode, medRepUid, onBack }) {
  const [order, setOrder] = useState(row.order);
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");

  // One instance per order (the parent keys it by order id), so the loading
  // state starts true and is only ever cleared by the subscription callbacks.
  useEffect(() => subscribeOrder(row.id, (o) => o && setOrder(o)), [row.id]);
  useEffect(() => {
    return subscribeAllocationEvents(
      row.id,
      mode === "admin" ? null : medRepUid,
      (list) => {
        setEvents(list);
        setEventsLoading(false);
        setEventsError("");
      },
      (err) => {
        setEventsLoading(false);
        setEventsError(
          err?.code === "permission-denied"
            ? "You do not have permission to view this order's allocation history."
            : "The allocation history could not be loaded."
        );
      }
    );
  }, [row.id, mode, medRepUid]);

  return (
    <div className="ohx-detail">
      <button type="button" className="ohx-link ohx-back ohx-noprint" onClick={onBack}>← Back to order history</button>
      <h1 className="ohx-detail-title ohx-noprint">
        <span className="ohx-ref">{order.orderNumber || order.id}</span>
      </h1>
      {row.receipt ? <Receipt receipt={row.receipt} events={events} eventsLoading={eventsLoading} /> : <LegacyNotice />}
      <CurrentSummary order={order} events={events} />
      <Timeline events={events} loading={eventsLoading} error={eventsError} />
    </div>
  );
}
