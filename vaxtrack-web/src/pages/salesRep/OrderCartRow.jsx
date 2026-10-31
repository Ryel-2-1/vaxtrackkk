import { Trash2 } from "lucide-react";
import { formatCentavos } from "../../services/money";
import { NEGOTIATED_PRICE_LABEL } from "../../services/negotiatedPricing";
import { PRODUCT_VAT_LABELS } from "../../services/vatClassification";
import { formatAmount } from "./priceReviewFormat";
/** Available now vs. what this line would backorder, in words. */
function stockText(item) {
  const vials = (n) => `${n.toLocaleString()} ${n === 1 ? "vial" : "vials"}`;
  if (item.availableNow === 0) return "Out of stock — future order";
  if (item.quantity > item.availableNow) {
    return `Available now: ${vials(item.availableNow)} · about ${vials(item.quantity - item.availableNow)} backordered`;
  }
  return `Available: ${vials(item.availableNow)}`;
}

export default function OrderCartRow({ item, price, review, onAccept, onDecrease, onIncrease, onRemove }) {
  return (
    <tr className={review ? "place-v2-row-review" : undefined}>
      <td>
        <strong>{item.name}</strong>
        {item.batchGone ? (
          <small className="place-v2-line-alert">This batch is no longer available. Remove it to continue.</small>
        ) : item.liveBlockedReason ? (
          <small className="place-v2-line-alert">{item.liveBlockedReason} Remove it to continue.</small>
        ) : (
          item.availableNow !== null && <small>{stockText(item)}</small>
        )}
        {item.live && item.priceChanged && (
          <small className="place-v2-line-alert">
            {item.livePriceCentavos === null
              ? "This batch no longer has a price. Remove it to continue."
              : `Price changed: ${formatCentavos(item.expectedUnitPriceCentavos)} in your cart, ${formatCentavos(item.livePriceCentavos)} now.`}
          </small>
        )}
        {review === "accept-stock" && (
          <small className="place-v2-line-alert">
            Stock changed: you saw {Number(item.cartAvailable).toLocaleString()} available; part of this line would now be backordered.
          </small>
        )}
        {(review === "accept-price" || review === "accept-stock") && (
          <button type="button" className="place-v2-accept-btn" onClick={onAccept}>
            {review === "accept-price" ? `Accept ${formatCentavos(item.livePriceCentavos)}` : "Accept current stock"}
          </button>
        )}
        <small className="place-v2-vat">
          {item.vatClassification ? PRODUCT_VAT_LABELS[item.vatClassification] : "VAT status confirmed when placed"}
        </small>
      </td>

      <td>
        {item.sku}
      </td>

      <td>
        <div className="qty-mini place-v2-qty-mini">
          <button type="button" onClick={onDecrease}>−</button>
          <span>{item.quantity}</span>
          <button type="button" onClick={onIncrease}>+</button>
        </div>
      </td>

      {/* The AGREED price (the standard unless negotiated below), and the
          line's FINAL total. A figure that could not be read shows a dash
          rather than a zero. */}
      <td className="tnum">
        {price?.agreedUnitPriceCentavos != null ? formatCentavos(price.agreedUnitPriceCentavos) : "—"}
        {price?.priceNegotiated && <small className="place-v2-negotiated-tag">{NEGOTIATED_PRICE_LABEL}</small>}
      </td>

      <td className="tnum">
        {price?.finalLineTotalCentavos != null ? formatAmount(price.finalLineTotalCentavos) : "—"}
      </td>

      <td>
        <button type="button" className="place-v2-remove-btn" onClick={onRemove}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

