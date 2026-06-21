import { useMemo, useState } from "react";
import {
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
import SalesRepLayout from "./SalesRepLayout";

const fallbackOrder = {
  id: "VT-ORD-2023-9821",
  status: "Processing",
  clinicName: "Makati Medical Center, Tower 2",
  clinicAddress: "Makati Medical Center, Tower 2",
  estimatedDelivery: "Oct 24, 2026 • 09:00 AM",
  deliveryInstructions: "No delivery instructions provided.",
  priority: "Standard",
  subtotal: 16700,
  handlingFee: 150,
  urgentFee: 0,
  estimatedTotal: 16850,
  items: [
    {
      name: "Vaxin-B Plus",
      sku: "VAX-001-B",
      batch: "Lot #882",
      quantity: 500,
      unit: "Units",
      chain: "Cold-Chain Prep",
      unitPrice: 25,
    },
    {
      name: "Sterile Disposal Kit Z-1",
      sku: "ACC-SYR-Q",
      batch: "Standard",
      quantity: 1000,
      unit: "Units",
      chain: "Standard Transit",
      unitPrice: 4.2,
    },
  ],
};

function getLatestOrder() {
  try {
    const savedOrder = JSON.parse(localStorage.getItem("latestSalesOrderDetails") || "null");

    if (!savedOrder) return fallbackOrder;

    return {
      ...fallbackOrder,
      ...savedOrder,
      id: savedOrder.id || localStorage.getItem("latestSalesOrderId") || fallbackOrder.id,
      status: savedOrder.status || "Processing",
      clinicName: savedOrder.clinicName || fallbackOrder.clinicName,
      clinicAddress: savedOrder.clinicAddress || savedOrder.clinicName || fallbackOrder.clinicAddress,
      estimatedDelivery: savedOrder.estimatedDelivery || "Pending dispatch schedule",
      deliveryInstructions:
        savedOrder.deliveryInstructions?.trim() || "No delivery instructions provided.",
      priority: savedOrder.priority || "Standard",
      items: Array.isArray(savedOrder.items) && savedOrder.items.length
        ? savedOrder.items
        : fallbackOrder.items,
    };
  } catch (error) {
    console.warn("Unable to load latest sales order:", error);
    return fallbackOrder;
  }
}

function SalesRepOrderConfirmation() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const order = useMemo(() => getLatestOrder(), []);

  const orderItems = useMemo(() => {
    return order.items.map((item, index) => {
      const quantity = Number(item.quantity || 0);
      const unitPrice = Number(item.unitPrice || 0);
      const lineTotal = quantity * unitPrice;

      return {
        id: item.sku || item.id || `ITEM-${index + 1}`,
        name: item.name || item.vaccineName || "Selected Vaccine",
        sku: item.sku || item.id || "N/A",
        batch: item.batch || item.chain || item.temp || "Medical Supply",
        quantity,
        unit: item.unit || "vials",
        note: item.chain || item.temp || item.category || "Standard Transit",
        lineTotal,
      };
    });
  }, [order.items]);

  const subtotal = Number(order.subtotal ?? orderItems.reduce((total, item) => total + item.lineTotal, 0));
  const handlingFee = Number(order.handlingFee || 0);
  const urgentFee = Number(order.urgentFee || 0);
  const estimatedTotal = Number(order.estimatedTotal ?? subtotal + handlingFee + urgentFee);

  const handleCopyReference = async () => {
    try {
      await navigator.clipboard.writeText(order.id);
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

  return (
    <SalesRepLayout active="request" title="Order Confirmation" showSearch={false}>
      <section className="confirmation-card confirmation-v2-card">
        <div className="confirmation-hero">
          <CheckCircle2 size={54} />
          <h1>Order Placed</h1>
          <p>Your medical supply request has been successfully queued for fulfillment.</p>
        </div>

        <div className="order-reference confirmation-v2-reference">
          <div>
            <span>Order Reference</span>
            <button type="button" onClick={handleCopyReference}>
              <strong>{order.id}</strong>
              <Copy size={14} />
            </button>
            {copied && <small>Copied</small>}
          </div>

          <span className="processing">• {order.status}</span>
        </div>

        <h3>Order Summary</h3>

        {orderItems.map((item) => (
          <ConfirmItem
            key={item.id}
            icon={<PackageCheck size={18} />}
            name={item.name}
            sku={`SKU: ${item.sku}`}
            qty={`${item.quantity.toLocaleString()} ${item.unit}`}
            note={item.note}
          />
        ))}

        <div className="confirmation-details confirmation-v2-details">
          <div>
            <CalendarClock size={17} />
            <span>Estimated Delivery</span>
            <strong>{order.estimatedDelivery}</strong>
          </div>

          <div>
            <MapPin size={17} />
            <span>Shipping Destination</span>
            <strong>{order.clinicName}</strong>
            <p>{order.clinicAddress}</p>
          </div>
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
          <div>
            <span>Subtotal</span>
            <strong>{formatCurrency(subtotal)}</strong>
          </div>
          <div>
            <span>Handling Fee</span>
            <strong>{formatCurrency(handlingFee)}</strong>
          </div>
          {urgentFee > 0 && (
            <div>
              <span>Urgent Fee</span>
              <strong>{formatCurrency(urgentFee)}</strong>
            </div>
          )}
          <div className="grand-total">
            <span>Estimated Total</span>
            <strong>{formatCurrency(estimatedTotal)}</strong>
          </div>
        </div>

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

        <button type="button" className="pdf-link confirmation-print-btn" onClick={handlePrint}>
          <Printer size={15} />
          Print / Save PDF Invoice
        </button>

        <small>
          This confirmation is a record of order submission. Official CVP compliance and billing documentation will be sent to the registered clinic administrator within 2 hours.
        </small>
      </section>
    </SalesRepLayout>
  );
}

function ConfirmItem({ icon, name, sku, qty, note }) {
  return (
    <div className="confirm-item">
      <span>{icon}</span>
      <div>
        <strong>{name}</strong>
        <p>{sku}</p>
      </div>
      <div>
        <strong>{qty}</strong>
        <p>{note}</p>
      </div>
    </div>
  );
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default SalesRepOrderConfirmation;
