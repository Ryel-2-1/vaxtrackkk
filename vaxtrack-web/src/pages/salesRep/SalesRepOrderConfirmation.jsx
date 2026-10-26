import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  FileText,
  MapPin,
  PackageCheck,
  Printer,
  Truck,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatCentavos } from "../../services/money";
import { priceConventionNote, readPriceConvention } from "../../services/pricingConfig";
import AllocationSummary from "../../components/ui/AllocationSummary";
import { withLiveLifecycle } from "../../services/orderConfirmation";
import { STATUTORY_DISCOUNT_LABELS } from "../../services/negotiatedPricing";
import { subscribeOrder } from "../../services/orderHistoryService";
import { logSafeError } from "../../services/liveDataErrors.js";

/**
 * The confirmation shows ONLY what checkout stored after re-reading the order
 * the server named (services/orderConfirmation.js).
 *
 * It used to fill anything missing from a hardcoded sample order — a clinic,
 * two products, a ₱150 "handling fee" and a ₱16,850 "estimated total" — so a
 * real confirmation always carried a fee and a total nothing had charged, and a
 * missing record showed an entirely fictional order as placed. Those are gone:
 * a record that is missing, unreadable or unverified renders the "details
 * unavailable" state and points the rep to Order Tracking. The only money
 * shown is the server's subtotal; prices are VAT-inclusive for VATable
 * products, so no VAT is added to it.
 */
/** The confirmation record checkout stored; undefined when it cannot be read. */
function readSavedConfirmation() {
  try {
    return JSON.parse(localStorage.getItem("latestSalesOrderDetails") || "null");
  } catch (error) {
    logSafeError("Unable to load latest sales order", error);
    return undefined;
  }
}

function getLatestOrder(saved) {
  try {
    if (saved === undefined) return { verified: false, replayed: false, orderNumber: null };
    if (!saved || saved.verified !== true) {
      return {
        verified: false,
        replayed: saved?.replayed === true,
        orderNumber:
          saved?.orderNumber || saved?.id || localStorage.getItem("latestSalesOrderId") || null,
      };
    }
    return toDisplay(saved);
  } catch (error) {
    logSafeError("Unable to load latest sales order", error);
    return { verified: false, replayed: false, orderNumber: null };
  }
}

/** The page's view of one verified confirmation record. */
function toDisplay(saved) {
  return {
    verified: true,
    replayed: saved.replayed === true,
    // The order's document id — what the live listener follows.
    orderId: typeof saved.id === "string" && saved.id ? saved.id : null,
    orderNumber: saved.orderNumber || saved.id,
    status: friendlyStatus(saved.status),
    doctorName: saved.doctorName || null,
    clinicName: saved.clinicName || saved.destinationName || "—",
    clinicAddress: saved.clinicAddress || "",
    requestedDeliveryDate: saved.requestedDeliveryDate || null,
    deliveryInstructions: saved.deliveryInstructions?.trim() || "No delivery instructions provided.",
    priority: saved.priority || "Standard",
    items: Array.isArray(saved.items) ? saved.items : [],
    subtotalCentavos: typeof saved.subtotalCentavos === "number" ? saved.subtotalCentavos : null,
    // The ORDER's recorded convention (a replay can return an older order).
    priceIsVatInclusive: readPriceConvention(saved.priceIsVatInclusive),
    // Server-written allocation (null on a confirmation saved before it).
    allocation: saved.allocation && typeof saved.allocation === "object" ? saved.allocation : null,
    // Negotiated pricing and the VAT breakdown, as placed (never re-derived).
    priceNegotiated: saved.priceNegotiated === true,
    standardSubtotalCentavos: typeof saved.standardSubtotalCentavos === "number" ? saved.standardSubtotalCentavos : null,
    statutoryDiscountTotalCentavos: typeof saved.statutoryDiscountTotalCentavos === "number" ? saved.statutoryDiscountTotalCentavos : 0,
    finalTotalCentavos:
      typeof saved.finalTotalCentavos === "number"
        ? saved.finalTotalCentavos
        : typeof saved.subtotalCentavos === "number"
          ? saved.subtotalCentavos
          : null,
    vatSummary: saved.vatSummary && typeof saved.vatSummary === "object" ? saved.vatSummary : null,
  };
}

function SalesRepOrderConfirmation() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  // What checkout stored after re-reading the order the server named.
  const savedRecord = useMemo(() => readSavedConfirmation(), []);
  const stored = useMemo(() => getLatestOrder(savedRecord), [savedRecord]);
  // The same order, LIVE — for its LIFECYCLE only. Status and reservation
  // progress change after placement (assigned, backorder filled) and this page
  // used to keep the placement-time values until a reload. The financial record
  // — items, quantities, agreed prices, VAT, subtotal — is never taken from the
  // live document: withLiveLifecycle copies status and allocation onto the
  // stored record and nothing else. Only the Med Rep's own order is readable,
  // as the rules require.
  const [live, setLive] = useState({ id: null, doc: undefined, failed: false });
  useEffect(() => {
    if (!stored.verified || !stored.orderId) return undefined;
    const id = stored.orderId;
    return subscribeOrder(
      id,
      (doc) => setLive({ id, doc, failed: false }),
      () => setLive({ id, doc: undefined, failed: true })
    );
  }, [stored.verified, stored.orderId]);
  const liveCurrent = live.id === stored.orderId;
  const order =
    liveCurrent && live.doc && live.doc.id === stored.orderId
      ? toDisplay(withLiveLifecycle(savedRecord, live.doc))
      : stored;
  const liveNote = !liveCurrent
    ? null
    : live.failed
      ? "Showing the order as placed — its current status could not be loaded."
      : live.doc === null
        ? "This order is no longer available. Open Order Tracking for your current orders."
        : null;

  const handleCopyReference = async () => {
    try {
      await navigator.clipboard.writeText(order.orderNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const actions = (
    <div className="confirmation-actions confirmation-v2-actions">
      <button onClick={() => navigate("/sales-rep/order-tracking")}>
        <Truck size={16} />
        Track Order Status
      </button>
    </div>
  );

  const reference = order.orderNumber && (
    <div className="order-reference confirmation-v2-reference">
      <div>
        <span>Order Reference</span>
        <button type="button" onClick={handleCopyReference}>
          <strong>{order.orderNumber}</strong>
          <Copy size={14} />
        </button>
        {copied && <small>Copied</small>}
      </div>
      {order.verified && <span className="processing">• {order.status}</span>}
      {liveNote && <small className="confirmation-live-note" role="status">{liveNote}</small>}
    </div>
  );

  // Unverified: the server confirmed an order, but its stored details could not
  // be read back. Nothing from the checkout form is presented as confirmed.
  if (!order.verified) {
    return (
      <section className="confirmation-card confirmation-v2-card">
        <div className="confirmation-hero">
          <AlertTriangle size={34} />
          <h2>Order submitted</h2>
          <p>
            The order was received, but its details could not be loaded. Open Order
            Tracking to see exactly what was stored before placing anything else.
          </p>
        </div>
        {reference}
        {actions}
      </section>
    );
  }

  return (
    <>
      <section className="confirmation-card confirmation-v2-card">
        <div className="confirmation-hero">
          <CheckCircle2 size={34} />
          <h2>{order.replayed ? "Order recovered" : "Order placed"}</h2>
          <p>
            {order.replayed
              ? "This order had already been placed by an earlier attempt. It was recovered — no second order was created."
              : "Your medical supply request has been successfully queued for fulfillment."}
          </p>
        </div>

        {reference}

        <h3>Order Summary</h3>

        {order.items.map((item, index) => (
          <ConfirmItem
            key={item.inventoryId || `ITEM-${index + 1}`}
            icon={<PackageCheck size={18} />}
            name={item.name || "Selected vaccine"}
            sku={`Batch: ${item.sku || "—"} · ${item.vatLabel || "Not recorded"}`}
            qty={`${Number(item.quantity || 0).toLocaleString()} ${
              Number(item.quantity) === 1 ? "vial" : "vials"
            }`}
            price={item}
          />
        ))}

        <AllocationSummary
          summary={order.allocation}
          lines={order.items
            .filter((item) => Number.isInteger(item.reservedQuantity))
            .map((item) => ({
              name: item.name || "Selected vaccine",
              requested: Number(item.quantity) || 0,
              reserved: item.reservedQuantity,
              backordered: item.backorderedQuantity || 0,
            }))}
        />

        <div className="confirmation-details confirmation-v2-details">
          <div>
            <CalendarClock size={17} />
            <span>Estimated Delivery</span>
            <strong>
              {order.allocation && !order.allocation.fullyReserved
                ? "Waiting for stock — not yet scheduled"
                : "Pending dispatch schedule"}
            </strong>
          </div>

          <div>
            <MapPin size={17} />
            <span>Shipping Destination</span>
            <strong>{order.clinicName}</strong>
            {order.doctorName && <p>For {order.doctorName}</p>}
            {order.clinicAddress && <p>{order.clinicAddress}</p>}
          </div>

          {order.requestedDeliveryDate && (
            <div>
              <CalendarClock size={17} />
              <span>Requested Delivery Date</span>
              <strong>{order.requestedDeliveryDate}</strong>
            </div>
          )}
        </div>

        <div className="confirmation-notes-card">
          <div>
            <FileText size={17} />
            <span>Delivery Notes</span>
          </div>
          <p>{order.deliveryInstructions}</p>
        </div>

        <div className="confirmation-v2-total">
          <div>
            <span>Priority</span>
            <strong>{order.priority}</strong>
          </div>
          {order.vatSummary && (
            <>
              <div>
                <span>Negotiated subtotal</span>
                <strong>{formatAmount(order.subtotalCentavos)}</strong>
              </div>
              {order.statutoryDiscountTotalCentavos > 0 && (
                <div>
                  <span>Less: SC/PWD discounts</span>
                  <strong>−{formatCentavos(order.statutoryDiscountTotalCentavos)}</strong>
                </div>
              )}
              <div>
                <span>VATable sales (net of VAT)</span>
                <strong>{formatAmount(order.vatSummary.vatableSalesCentavos)}</strong>
              </div>
              <div>
                <span>VAT-exempt sales</span>
                <strong>{formatAmount(order.vatSummary.vatExemptSalesCentavos)}</strong>
              </div>
              <div>
                <span>Zero-rated sales</span>
                <strong>{formatAmount(order.vatSummary.zeroRatedSalesCentavos)}</strong>
              </div>
              <div>
                <span>VAT (12%)</span>
                <strong>{formatAmount(order.vatSummary.vatAmountCentavos)}</strong>
              </div>
            </>
          )}
          <div className="grand-total">
            <span>{order.vatSummary ? "Final total (VAT-inclusive)" : "Subtotal"}</span>
            <strong>{order.vatSummary ? formatAmount(order.finalTotalCentavos) : formatCentavos(order.subtotalCentavos)}</strong>
          </div>
        </div>

        {actions}

        <button type="button" className="pdf-link confirmation-print-btn" onClick={handlePrint}>
          <Printer size={15} />
          Print / Save PDF Invoice
        </button>

        <small>
          This confirmation is a record of order submission.{" "}
          {priceConventionNote(order.priceIsVatInclusive)}
        </small>
      </section>
    </>
  );
}

function friendlyStatus(raw) {
  switch (raw) {
    case "pending_dispatch": return "Processing";
    case "assigned": return "Assigned";
    case "in_transit": return "In Transit";
    case "delivered":
    case "completed": return "Delivered";
    case "delayed": return "Delayed";
    case "cancelled":
    case "canceled": return "Cancelled";
    default: return "Processing";
  }
}

/** A breakdown figure: ₱0.00 is a real amount here, so it is shown, not dashed. */
function formatAmount(centavos) {
  return centavos === 0 ? "₱0.00" : formatCentavos(centavos);
}

/**
 * One ordered line. The agreed price is the one placed; a negotiated line also
 * shows its standard price and reason. Read-only: placed prices cannot be edited.
 */
function ConfirmItem({ icon, name, sku, qty, price }) {
  const agreed = typeof price?.unitPriceCentavos === "number" ? price.unitPriceCentavos : null;
  return (
    <div className="confirm-item">
      <span>{icon}</span>
      <div>
        <strong>{name}</strong>
        <p>{sku}</p>
        {price?.priceNegotiated && (
          <p className="confirm-negotiated">
            Negotiated price {formatCentavos(agreed)} (standard {formatCentavos(price.standardUnitPriceCentavos)})
            {price.negotiationReason ? ` — ${price.negotiationReason}` : ""}
          </p>
        )}
        {price?.statutoryDiscountCentavos > 0 && (
          <p className="confirm-negotiated">
            {STATUTORY_DISCOUNT_LABELS[price.statutoryDiscountType] ?? "Statutory"} discount −{formatCentavos(price.statutoryDiscountCentavos)}
          </p>
        )}
      </div>
      <div>
        <strong>{qty}</strong>
        {typeof price?.finalLineTotalCentavos === "number" && <p className="tnum">{formatAmount(price.finalLineTotalCentavos)}</p>}
      </div>
    </div>
  );
}

export default SalesRepOrderConfirmation;
