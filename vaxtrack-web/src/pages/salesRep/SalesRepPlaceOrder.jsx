import { Bell, FileText, MapPin, Plus, Search, SlidersHorizontal, Zap } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createSalesRepOrder } from "../../services/orderService";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepPlaceOrder() {
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);

const handleFinalizeOrder = async () => {
  try {
    setSaving(true);

    const orderRef = await createSalesRepOrder({
      clinicName: "St. Luke's Medical Center - QC",
      clinicAddress:
        "279 E Rodriguez Sr. Ave, Quezon City, Metro Manila",
      vaccineName: "Vaxipro Ultra-V Adult",
      vaccineType: "Cold Chain Vaccine",
      quantity: 660,
      unit: "vials",
      storageTemp: "2°C - 8°C",
      priority: "Urgent",
    });

    localStorage.setItem("latestSalesOrderId", orderRef.id);
    navigate("/sales-rep/order-confirmation");
  } catch (error) {
    console.error("Create order error:", error);
    alert("Unable to create order. Please try again.");
  } finally {
    setSaving(false);
  }
};

  return (
    <SalesRepLayout active="request" title="Place New Order" topbarTitle="Place New Order" showSearch={false}>
      <div className="place-order-session">Current Session <strong>#ORD-2024-8842</strong> <Bell size={15} /></div>

      <section className="place-order-layout">
        <div className="place-order-left">
          <div className="place-filter-row">
            <div className="request-search"><Search size={16} /><input placeholder="Search medical inventory by name, SKU, or category..." /></div>
            <button><SlidersHorizontal size={15} /> Filters</button>
          </div>

          <div className="order-items-card">
            <div className="order-items-header"><h2>Order Items</h2><span>3 Items Selected</span></div>
            <table>
              <thead><tr><th>Product</th><th>SKU & Chain</th><th>Quantity</th><th>Unit Price</th></tr></thead>
              <tbody>
                <OrderRow name="Vaxipro Ultra-V (Adult)" sku="SKU-VX-9921" qty="150" price="₱24.50" />
                <OrderRow name="Vaxipro Ultra-V (Adult)" sku="SKU-IM-4410" qty="500" price="₱12.00" chain="Room Temp" />
                <OrderRow name="Vaxipro Ultra-V (Adult)" sku="SKU-SY-1205" qty="10" price="₱85.00" chain="Dry Goods" />
              </tbody>
            </table>
            <div className="order-items-footer"><button><Plus size={16} /> Add More Items</button><p>Items Subtotal <strong>₱10,525.00</strong></p></div>
          </div>
        </div>

        <aside className="place-order-side">
          <div className="destination-card">
            <h2><MapPin size={18} /> Destination Details</h2>
            <label>Select Clinic/Hospital</label>
            <select><option>St. Luke's Medical Center - QC</option></select>
            <div className="address-box"><strong>Shipping Address</strong><p>279 E Rodriguez Sr. Ave, Quezon City,<br />1112 Metro Manila, Philippines</p></div>
          </div>

          <div className="destination-card">
            <h2><FileText size={18} /> Delivery Instructions</h2>
            <textarea placeholder="Add special handling notes, gate codes, or delivery window preferences..." />
            <label className="urgent-row"><input type="checkbox" /> <Zap size={13} /> Mark as Urgent Delivery</label>
          </div>

          <div className="pricing-card">
            <h2>Pricing Summary</h2>
            <p>Subtotal <strong>₱10,525.00</strong></p>
            <h3>Estimated Total <span>₱10,690.00</span></h3>
            <button onClick={handleFinalizeOrder} disabled={saving}>
              {saving ? "Saving Order..." : "Finalize Order →"}
            </button>
            <small>By clicking finalize, you confirm this order complies with medical distribution regulations.</small>
          </div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

function OrderRow({ name, sku, qty, price, chain }) {
  return (
    <tr>
      <td><strong>{name}</strong><small>⊙ In Stock (4,200 units)</small></td>
      <td>{sku}{chain && <span className="chain-chip">{chain}</span>}</td>
      <td><div className="qty-mini"><button>−</button><span>{qty}</span><button>+</button></div></td>
      <td><strong>{price}</strong></td>
    </tr>
  );
}

export default SalesRepPlaceOrder;
