import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
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
function getLatestOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem("latestSalesOrderDetails") || "null");
    if (!saved || saved.verified !== true) {
      return {
        verified: false,
        replayed: saved?.replayed === true,
        orderNumber:
          saved?.orderNumber || saved?.id || localStorage.getItem("latestSalesOrderId") || null,
      };
    }
    return {
      verified: true,
      replayed: saved.replayed === true,
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
    };
  } catch (error) {
    console.warn("Unable to load latest sales order:", error);
    return { verified: false, replayed: false, orderNumber: null };
  }
}

function SalesRepOrderConfirmation() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const order = useMemo(() => getLatestOrder(), []);

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

      <button className="outline" onClick={() => navigate("/sales-rep/request-order")}>
        <ClipboardList size={16} />
        Return to Catalog
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
          <div className="grand-total">
            <span>Subtotal</span>
            <strong>{formatCentavos(order.subtotalCentavos)}</strong>
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

function ConfirmItem({ icon, name, sku, qty }) {
  return (
    <div className="confirm-item">
      <span>{icon}</span>
      <div>
        <strong>{name}</strong>
        <p>{sku}</p>
      </div>
      <div>
        <strong>{qty}</strong>
      </div>
    </div>
  );
}

export default SalesRepOrderConfirmation;
