import { useCallback } from "react";
import { formatCentavos } from "../../services/money";
import { NEGOTIATED_PRICE_LABEL } from "../../services/negotiatedPricing";
import { PRODUCT_VAT_LABELS } from "../../services/vatClassification";
import { formatAmount } from "./priceReviewFormat";
/** Signed peso amount for an adjustment ("−₱450.00" / "+₱50.00" / "₱0.00"). */
function formatAdjustment(centavos) {
  if (centavos === null || centavos === undefined) return "—";
  if (centavos === 0) return "₱0.00";
  const sign = centavos < 0 ? "−" : "+";
  return `${sign}${formatCentavos(Math.abs(centavos))}`;
}

function vatLabelFor(cls) {
  return cls ? PRODUCT_VAT_LABELS[cls] : "VAT status confirmed when placed";
}

/**
 * The final price review, per line: the standard unit price, an editable AGREED
 * unit price (VAT-inclusive) with its reason, and the negotiated and final line
 * totals. Totals are derived in integers; there is no total input. Checkout
 * offers no SC/PWD discount entry, so every line is placed without one.
 */
export function PriceReview({
  lines,
  disabled,
  onAgreedChange,
  onReasonChange,
  onReset,
}) {
  if (lines.length === 0) return null;
  return (
    <section className="place-v2-price-review" aria-labelledby="price-review-title">
      <div className="place-v2-price-review-head">
        <h2 id="price-review-title">Final price review</h2>
        <p>
          Confirm each line&apos;s agreed unit price. Prices are VAT-inclusive for VATable products; change
          a price only when it has been agreed with the client, and give the reason.
        </p>
      </div>
      <ul className="place-v2-price-lines">
        {lines.map(({ item, catalogSku, vatClassification, agreedText, reasonText, price }) => {
          const inputId = `agreed-${item.inventoryId}`;
          const reasonId = `reason-${item.inventoryId}`;
          const errorId = `agreed-error-${item.inventoryId}`;
          const flagged = price.priceNegotiated;
          return (
            <li key={item.inventoryId} className={`place-v2-price-line${flagged ? " negotiated" : ""}`}>
              <div className="place-v2-price-product">
                <strong>{item.name}</strong>
                <span className="place-v2-price-meta">
                  {catalogSku ? <>SKU {catalogSku} · </> : null}Batch {item.sku} · Qty {item.quantity.toLocaleString()}
                </span>
                <span className="place-v2-price-meta">
                  {vatLabelFor(vatClassification)}
                  {vatClassification === "vatable" && " · VAT included"}
                </span>
                {price.priceNegotiated && <span className="place-v2-negotiated-tag">{NEGOTIATED_PRICE_LABEL}</span>}
              </div>

              <dl className="place-v2-price-figures">
                <div>
                  <dt>Standard unit price</dt>
                  <dd className="tnum">{formatCentavos(price.standardUnitPriceCentavos)}</dd>
                </div>
                <div>
                  <dt>Negotiated line total</dt>
                  <dd className="tnum">{price.negotiatedGrossCentavos != null ? formatCentavos(price.negotiatedGrossCentavos) : "—"}</dd>
                </div>
                <div>
                  <dt>Price adjustment</dt>
                  <dd className="tnum">{formatAdjustment(price.negotiatedAdjustmentCentavos)}</dd>
                </div>
                <div>
                  <dt>Final line total</dt>
                  <dd className="tnum">{price.finalLineTotalCentavos != null ? formatAmount(price.finalLineTotalCentavos) : "—"}</dd>
                </div>
              </dl>

              <div className="place-v2-price-edit">
                <label htmlFor={inputId}>
                  Agreed unit price (VAT-inclusive) for {item.name}
                </label>
                <div className="place-v2-price-input">
                  <span aria-hidden="true">₱</span>
                  <input
                    id={inputId}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={agreedText}
                    disabled={disabled}
                    aria-invalid={price.priceError ? "true" : "false"}
                    aria-describedby={price.priceError ? errorId : undefined}
                    onChange={(event) => onAgreedChange(item.inventoryId, event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="place-v2-reset-btn"
                  onClick={() => onReset(item.inventoryId)}
                  disabled={disabled || (!price.priceNegotiated && !price.priceError)}
                  aria-label={`Reset ${item.name} to the standard price`}
                >
                  Reset to standard price
                </button>
                {price.priceError && (
                  <p id={errorId} className="place-v2-price-error" role="alert">
                    {price.priceError}
                  </p>
                )}
              </div>

              {price.priceNegotiated && (
                <div className="place-v2-price-reason">
                  <label htmlFor={reasonId}>Reason for the negotiated price (required)</label>
                  <textarea
                    id={reasonId}
                    rows={2}
                    maxLength={500}
                    value={reasonText}
                    disabled={disabled}
                    aria-invalid={price.reasonError ? "true" : "false"}
                    onChange={(event) => onReasonChange(item.inventoryId, event.target.value)}
                    placeholder="e.g. Volume agreement with the clinic"
                  />
                  {price.reasonError && (
                    <p className="place-v2-price-error" role="alert">
                      {price.reasonError}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The order's figures: negotiated subtotal, the VAT breakdown and the final
 * total. They reconcile: negotiated subtotal = final total = the VAT parts.
 */
export function VatBreakdown({ summary }) {
  if (!summary) {
    return (
      <p className="place-v2-price-note" role="status">
        The totals appear once every line has a valid agreed price and VAT classification.
      </p>
    );
  }
  return (
    <dl className="place-v2-vat-breakdown">
      {summary.negotiatedAdjustmentCentavos !== 0 && (
        <div>
          <dt>Standard total</dt>
          <dd className="tnum">{formatAmount(summary.standardTotalCentavos)}</dd>
        </div>
      )}
      <div>
        <dt>Negotiated subtotal</dt>
        <dd className="tnum">{formatAmount(summary.negotiatedSubtotalCentavos)}</dd>
      </div>
      <div>
        <dt>VATable sales (net of VAT)</dt>
        <dd className="tnum">{formatAmount(summary.vatableSalesCentavos)}</dd>
      </div>
      <div>
        <dt>VAT-exempt sales</dt>
        <dd className="tnum">{formatAmount(summary.vatExemptSalesCentavos)}</dd>
      </div>
      <div>
        <dt>Zero-rated sales</dt>
        <dd className="tnum">{formatAmount(summary.zeroRatedSalesCentavos)}</dd>
      </div>
      <div>
        <dt>VAT (12%)</dt>
        <dd className="tnum">{formatAmount(summary.vatAmountCentavos)}</dd>
      </div>
      <div className="place-v2-final-total">
        <dt>Final total (VAT-inclusive)</dt>
        <dd className="tnum">{formatAmount(summary.totalCentavos)}</dd>
      </div>
    </dl>
  );
}

/**
 * Explicit reconfirmation before the order is created: who and where, every
 * line with its classification, standard vs agreed price and reason where
 * negotiated, the totals and the final total.
 */
export function ReconfirmDialog({ doctorName, destination, lines, summary, schedule, saving, onCancel, onConfirm }) {
  const focusFirst = useCallback((node) => node?.focus(), []);
  return (
    <div className="place-v2-confirm-backdrop">
      <div
        className="place-v2-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconfirm-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onCancel();
        }}
      >
        <h2 id="reconfirm-title" tabIndex={-1} ref={focusFirst}>
          Confirm order and prices
        </h2>
        <p className="place-v2-confirm-dest">
          <strong>{doctorName}</strong>
          <span>{destination}</span>
        </p>
        {schedule && (
          <p className="place-v2-confirm-schedule">
            <span>Requested delivery (arrival at the destination)</span>
            <strong>{schedule}</strong>
          </p>
        )}
        <ul className="place-v2-confirm-lines">
          {lines.map(({ item, vatClassification, price }) => (
            <li key={item.inventoryId}>
              <div>
                <strong>{item.name}</strong>
                <span>
                  Qty {item.quantity.toLocaleString()} · {vatLabelFor(vatClassification)}
                </span>
              </div>
              <div className="tnum">
                {price.priceNegotiated ? (
                  <>
                    <span>
                      {NEGOTIATED_PRICE_LABEL}: {formatCentavos(price.agreedUnitPriceCentavos)}
                      <small> (standard {formatCentavos(price.standardUnitPriceCentavos)})</small>
                    </span>
                    <span className="place-v2-confirm-reason">Reason: {price.negotiationReason}</span>
                  </>
                ) : (
                  <span>{formatCentavos(price.agreedUnitPriceCentavos)} each</span>
                )}
                <strong>{formatAmount(price.finalLineTotalCentavos)}</strong>
              </div>
            </li>
          ))}
        </ul>
        <VatBreakdown summary={summary} />
        <div className="place-v2-confirm-actions">
          <button type="button" className="place-v2-add-more" onClick={onCancel} disabled={saving}>
            Back to review
          </button>
          <button type="button" className="place-v2-confirm-btn" onClick={onConfirm} disabled={saving} aria-busy={saving}>
            {saving ? "Placing order…" : "Confirm and place order"}
          </button>
        </div>
      </div>
    </div>
  );
}

