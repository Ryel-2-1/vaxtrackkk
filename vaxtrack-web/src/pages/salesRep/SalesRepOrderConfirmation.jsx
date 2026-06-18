import { CheckCircle2, Copy, PackageCheck, Truck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepOrderConfirmation() {
  const navigate = useNavigate();

  return (
    <SalesRepLayout active="request" title="Order Confirmation" showSearch={false}>
      <section className="confirmation-card">
        <div className="confirmation-hero">
          <CheckCircle2 size={54} />
          <h1>Order Placed</h1>
          <p>Your medical supply request has been successfully queued for fulfillment.</p>
        </div>

        <div className="order-reference">
          <div><span>Order Reference</span><strong>VT-ORD-2023-9821 <Copy size={14} /></strong></div>
          <span className="processing">• Processing</span>
        </div>

        <h3>Order Summary</h3>
        <ConfirmItem icon={<PackageCheck size={18} />} name="Vaxin-B Plus (Lot #882)" sku="SKU: VAX-001-B" qty="500 Units" note="Cold-Chain Prep" />
        <ConfirmItem icon={<Truck size={18} />} name="Sterile Disposal Kit Z-1" sku="SKU: ACC-SYR-Q" qty="1,000 Units" note="Standard Transit" />

        <div className="confirmation-details">
          <div><span>Estimated Delivery</span><strong>Oct 24, 2023 • 09:00 AM</strong></div>
          <div><span>Shipping Destination</span><strong>Makati Medical Center, Tower 2</strong></div>
        </div>

        <div className="confirmation-actions">
          <button onClick={() => navigate("/sales-rep/order-tracking")}>Track Order Status</button>
          <button className="outline" onClick={() => navigate("/sales-rep/request-order")}>← Return to Catalog</button>
        </div>

        <a className="pdf-link">Download PDF Invoice</a>
        <small>This confirmation is a record of order submission. Official CVP compliance and billing documentation will be sent to the registered clinic administrator within 2 hours.</small>
      </section>
    </SalesRepLayout>
  );
}

function ConfirmItem({ icon, name, sku, qty, note }) {
  return (
    <div className="confirm-item">
      <span>{icon}</span>
      <div><strong>{name}</strong><p>{sku}</p></div>
      <div><strong>{qty}</strong><p>{note}</p></div>
    </div>
  );
}

export default SalesRepOrderConfirmation;
