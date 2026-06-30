import {
  Bell,
  FileText,
  MapPin,
  Minus,
  PackagePlus,
  Plus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createSalesRepOrder } from "../../services/orderService";
import { auth } from "../../firebase";
import SalesRepLayout from "./SalesRepLayout";

const fallbackItems = [
  {
    name: "Vaxipro Ultra-V (Adult)",
    sku: "SKU-VX-9921",
    chain: "Cold Chain",
    quantity: 150,
    unitPrice: 24.5,
    stockText: "In Stock (4,200 units)",
  },
  {
    name: "Vaxipro Ultra-V (Adult)",
    sku: "SKU-IM-4410",
    chain: "Room Temp",
    quantity: 500,
    unitPrice: 12,
    stockText: "In Stock (4,200 units)",
  },
  {
    name: "Vaxipro Ultra-V (Adult)",
    sku: "SKU-SY-1205",
    chain: "Dry Goods",
    quantity: 10,
    unitPrice: 85,
    stockText: "In Stock (4,200 units)",
  },
];

const unitPriceMap = {
  "VC9-P-2024-X": 24.5,
  "IGS3-500-MED": 12,
  "NVP-99-PRO": 18.75,
  "PV12-KID-24": 20,
  "SNO-2023-C44": 11.5,
  "MOD-2023-B12": 22.25,
};

const clinics = [
  {
    name: "St. Luke's Medical Center - QC",
    address: "279 E Rodriguez Sr. Ave, Quezon City, 1112 Metro Manila, Philippines",
  },
  {
    name: "Manila Doctors Hospital",
    address: "667 United Nations Ave, Ermita, Manila, 1000 Metro Manila, Philippines",
  },
  {
    name: "Makati Medical Center",
    address: "2 Amorsolo Street, Legazpi Village, Makati, 1229 Metro Manila, Philippines",
  },
];

function getInitialItems() {
  try {
    const savedDraft = JSON.parse(localStorage.getItem("salesRepQuickCart") || "null");

    if (savedDraft?.items?.length) {
      return savedDraft.items.map((item) => ({
        name: item.name,
        sku: item.sku,
        chain: item.temp || item.category || "Cold Chain",
        quantity: Number(item.quantity) || 1,
        unitPrice: Number(item.unitPrice) || unitPriceMap[item.sku] || 15,
        stockText: item.stock ? `In Stock (${Number(item.stock).toLocaleString()} units)` : "In Stock",
      }));
    }
  } catch (error) {
    console.warn("Unable to load sales rep cart:", error);
  }

  return fallbackItems;
}

function SalesRepPlaceOrder() {
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState(getInitialItems);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedClinic, setSelectedClinic] = useState(() => {
    try {
      const savedDraft = JSON.parse(localStorage.getItem("salesRepQuickCart") || "null");
      return savedDraft?.destination || clinics[0].name;
    } catch {
      return clinics[0].name;
    }
  });
  const [instructions, setInstructions] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [message, setMessage] = useState("");

  const selectedClinicInfo =
    clinics.find((clinic) => clinic.name === selectedClinic) || clinics[0];

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return items.filter((item) => {
      return (
        item.name.toLowerCase().includes(query) ||
        item.sku.toLowerCase().includes(query) ||
        item.chain.toLowerCase().includes(query)
      );
    });
  }, [items, searchTerm]);

  const subtotal = useMemo(() => {
    return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
  }, [items]);

  const handlingFee = 165;
  const urgentFee = urgent ? 250 : 0;
  const estimatedTotal = subtotal + handlingFee + urgentFee;
  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);

  const handleQuantityChange = (sku, action) => {
    setItems((current) =>
      current.map((item) => {
        if (item.sku !== sku) return item;

        const nextQuantity =
          action === "increase"
            ? item.quantity + 1
            : Math.max(item.quantity - 1, 1);

        return {
          ...item,
          quantity: nextQuantity,
        };
      })
    );
  };

  const handleRemoveItem = (sku) => {
    setItems((current) => current.filter((item) => item.sku !== sku));
  };

  const handleFinalizeOrder = async () => {
    if (items.length === 0) {
      setMessage("Add at least one order item before finalizing.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const user = auth.currentUser;
      const vaccineSummary =
        items.length === 1
          ? items[0].name
          : `${items[0].name} +${items.length - 1} more`;

      const orderPayload = {
        clinicName: selectedClinicInfo.name,
        clinicAddress: selectedClinicInfo.address,
        vaccineName: vaccineSummary,
        vaccineType: items[0]?.chain || "",
        quantity: totalQuantity,
        unit: "vials",
        storageTemp: items[0]?.chain || "",
        priority: urgent ? "Urgent" : "Standard",
        deliveryInstructions: instructions.trim(),
        items,
        createdByUid: user?.uid || null,
        createdByEmail: user?.email || null,
      };

      const orderRef = await createSalesRepOrder(orderPayload);
      const orderId = orderRef.id;

      localStorage.setItem("latestSalesOrderId", orderId);
      localStorage.setItem(
        "latestSalesOrderDetails",
        JSON.stringify({
          id: orderId,
          ...orderPayload,
          subtotal,
          handlingFee,
          urgentFee,
          estimatedTotal,
          status: "pending_dispatch",
        })
      );

      navigate("/sales-rep/order-confirmation");
    } catch (error) {
      console.error("Create order error:", error);
      setMessage(error.message || "Unable to create order. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SalesRepLayout
      active="request"
      title="Place New Order"
      topbarTitle="Place New Order"
      showSearch={false}
    >
      <div className="place-order-session place-v2-session">
        <span>Current Session</span>
        <strong>#ORD-2024-8842</strong>
        <Bell size={15} />
      </div>

      <section className="place-order-layout place-v2-layout">
        <div className="place-order-left">
          <div className="place-filter-row place-v2-filter-row">
            <div className="request-search place-v2-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search selected items by name, SKU, or cold-chain type..."
              />
            </div>

            <button
              type="button"
              className="place-v2-add-more"
              onClick={() => navigate("/sales-rep/request-order")}
            >
              <PackagePlus size={15} />
              Add More Items
            </button>
          </div>

          {message && <div className="place-v2-message">{message}</div>}

          <div className="order-items-card place-v2-items-card">
            <div className="order-items-header">
              <div>
                <h2>Order Items</h2>
                <p>Review selected vaccines before finalizing the order.</p>
              </div>
              <span>{items.length} Items Selected</span>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU & Chain</th>
                  <th>Quantity</th>
                  <th>Unit Price</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => (
                    <OrderRow
                      key={item.sku}
                      item={item}
                      onDecrease={() => handleQuantityChange(item.sku, "decrease")}
                      onIncrease={() => handleQuantityChange(item.sku, "increase")}
                      onRemove={() => handleRemoveItem(item.sku)}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan="5">
                      <div className="place-v2-empty">
                        No matching order item found.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="order-items-footer">
              <button type="button" onClick={() => navigate("/sales-rep/request-order")}>
                <Plus size={16} />
                Add More Items
              </button>

              <p>
                Items Subtotal
                <strong>{formatCurrency(subtotal)}</strong>
              </p>
            </div>
          </div>
        </div>

        <aside className="place-order-side place-v2-side">
          <div className="destination-card">
            <h2>
              <MapPin size={18} />
              Destination Details
            </h2>

            <label>Select Clinic/Hospital</label>
            <select
              value={selectedClinic}
              onChange={(event) => setSelectedClinic(event.target.value)}
            >
              {clinics.map((clinic) => (
                <option key={clinic.name} value={clinic.name}>
                  {clinic.name}
                </option>
              ))}
            </select>

            <div className="address-box">
              <strong>Shipping Address</strong>
              <p>{selectedClinicInfo.address}</p>
            </div>
          </div>

          <div className="destination-card">
            <h2>
              <FileText size={18} />
              Delivery Instructions
            </h2>

            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Add special handling notes, gate codes, or delivery window preferences..."
            />

            <label className="urgent-row place-v2-urgent-row">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(event) => setUrgent(event.target.checked)}
              />
              <Zap size={13} />
              Mark as Urgent Delivery
            </label>
          </div>

          <div className="pricing-card place-v2-pricing-card">
            <h2>Pricing Summary</h2>

            <p>
              Total Vials
              <strong>{totalQuantity.toLocaleString()}</strong>
            </p>

            <p>
              Subtotal
              <strong>{formatCurrency(subtotal)}</strong>
            </p>

            <p>
              Handling Fee
              <strong>{formatCurrency(handlingFee)}</strong>
            </p>

            {urgent && (
              <p>
                Urgent Fee
                <strong>{formatCurrency(urgentFee)}</strong>
              </p>
            )}

            <h3>
              Estimated Total
              <span>{formatCurrency(estimatedTotal)}</span>
            </h3>

            <button
              type="button"
              onClick={handleFinalizeOrder}
              disabled={saving || items.length === 0}
            >
              {saving ? "Saving Order..." : "Finalize Order →"}
            </button>

            <small>
              By clicking finalize, you confirm this order complies with medical distribution regulations.
            </small>
          </div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

function OrderRow({ item, onDecrease, onIncrease, onRemove }) {
  return (
    <tr>
      <td>
        <strong>{item.name}</strong>
        <small>⊙ {item.stockText}</small>
      </td>

      <td>
        {item.sku}
        <span className="chain-chip">{item.chain}</span>
      </td>

      <td>
        <div className="qty-mini place-v2-qty-mini">
          <button type="button" onClick={onDecrease}>−</button>
          <span>{item.quantity}</span>
          <button type="button" onClick={onIncrease}>+</button>
        </div>
      </td>

      <td>
        <strong>{formatCurrency(item.unitPrice)}</strong>
      </td>

      <td>
        <button type="button" className="place-v2-remove-btn" onClick={onRemove}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default SalesRepPlaceOrder;
