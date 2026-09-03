import {
  AlertTriangle,
  Bell,
  FileText,
  Loader2,
  MapPin,
  Minus,
  PackagePlus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createSalesRepOrder } from "../../services/orderService";
import { subscribeClinics } from "../../services/clinicService";
import { auth } from "../../firebase";
import SalesRepLayout from "./SalesRepLayout";

function getInitialItems() {
  try {
    const savedDraft = JSON.parse(localStorage.getItem("salesRepQuickCart") || "null");

    if (savedDraft?.items?.length) {
      return savedDraft.items.map((item) => ({
        name: item.name || "Unknown Vaccine",
        sku: item.sku || item.id || "—",
        chain: item.temp || item.category || "Cold Chain",
        quantity: Number(item.quantity) || 1,
        stockText: item.stock
          ? `Available: ${Number(item.stock).toLocaleString()} ${Number(item.stock) === 1 ? "vial" : "vials"}`
          : "",
      }));
    }
  } catch (error) {
    console.warn("Unable to load sales rep cart:", error);
  }

  return [];
}

function SalesRepPlaceOrder() {
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState(getInitialItems);
  const [searchTerm, setSearchTerm] = useState("");

  const [clinics, setClinics] = useState([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  const [selectedClinic, setSelectedClinic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeClinics(
      (docs) => {
        setClinics(docs);
        setClinicsLoading(false);

        if (!selectedClinic && docs.length > 0) {
          try {
            const savedDraft = JSON.parse(localStorage.getItem("salesRepQuickCart") || "null");
            const dest = savedDraft?.destination || "";
            const match = docs.find((c) => c.name === dest);
            setSelectedClinic(match ? match.name : docs[0].name);
          } catch {
            setSelectedClinic(docs[0].name);
          }
        }
      },
      () => {
        setClinicsLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const selectedClinicInfo = clinics.find((c) => c.name === selectedClinic) || clinics[0] || null;

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.sku.toLowerCase().includes(query) ||
        item.chain.toLowerCase().includes(query)
    );
  }, [items, searchTerm]);

  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);

  const handleQuantityChange = (sku, action) => {
    setItems((current) =>
      current.map((item) => {
        if (item.sku !== sku) return item;
        const nextQuantity =
          action === "increase" ? item.quantity + 1 : Math.max(item.quantity - 1, 1);
        return { ...item, quantity: nextQuantity };
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

    // Re-validate the clinic at submit time (not only while selecting): it must
    // still be a REAL registered clinic in the live Firestore `clinics` array
    // AND carry a non-empty canonical `clinicId`. Records without a `clinicId`
    // are rejected — we never fall back to the Firestore doc id.
    if (clinicsLoading) {
      setMessage("Verifying clinic — please wait.");
      return;
    }
    const liveClinic =
      selectedClinicInfo && clinics.find((c) => c.id === selectedClinicInfo.id);
    const canonicalClinicId =
      liveClinic && liveClinic.clinicId != null
        ? String(liveClinic.clinicId).trim()
        : "";
    const verifiedClinic = liveClinic && canonicalClinicId ? liveClinic : null;
    if (!verifiedClinic) {
      setMessage("Enter a valid Clinic ID registered in VaxTrack.");
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
        clinicId: canonicalClinicId, // canonical Clinic ID (verified non-empty)
        clinicName: verifiedClinic.name,
        clinicAddress: verifiedClinic.location || verifiedClinic.address || "",
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

      // Carry the clinic's manual coordinates onto the order when present, so
      // Dispatcher Geofence can show the destination + geofence circle.
      // Clinics without coordinates simply omit these (rider-only map).
      if (
        Number.isFinite(Number(selectedClinicInfo.latitude)) &&
        Number.isFinite(Number(selectedClinicInfo.longitude)) &&
        selectedClinicInfo.latitude !== "" &&
        selectedClinicInfo.longitude !== "" &&
        selectedClinicInfo.latitude != null &&
        selectedClinicInfo.longitude != null
      ) {
        orderPayload.clinicLat = Number(selectedClinicInfo.latitude);
        orderPayload.clinicLng = Number(selectedClinicInfo.longitude);
      }

      // Pre-compute the canonical public order reference the same way
      // `createSalesRepOrder` would default it (`VT-ORD-<epoch ms>`), and pass
      // it in the payload. The service uses `orderData.orderNumber || …`, so
      // this is behavior-neutral — the same value is written to Firestore
      // regardless. Passing it explicitly lets us carry it to the confirmation
      // screen (previously we only had the Firestore doc id, which is why
      // confirmation showed `TVJXOqvC66uXVSswezIr` instead of `VT-ORD-…`).
      // Date.now() here is inside an async click handler (`handleFinalizeOrder`),
      // not render — the react-hooks/purity check reports this as a false
      // positive when analysing event handlers, so disable it narrowly.
      // eslint-disable-next-line react-hooks/purity
      const orderNumber = `VT-ORD-${Date.now()}`;
      orderPayload.orderNumber = orderNumber;

      const orderRef = await createSalesRepOrder(orderPayload);
      const orderId = orderRef.id;

      localStorage.setItem("latestSalesOrderId", orderId);
      localStorage.setItem(
        "latestSalesOrderDetails",
        JSON.stringify({
          id: orderId,
          orderNumber,
          ...orderPayload,
          status: "pending_dispatch",
        })
      );

      localStorage.removeItem("salesRepQuickCart");

      navigate("/sales-rep/order-confirmation");
    } catch (error) {
      console.error("Create order error:", error);
      setMessage(error.message || "Unable to create order. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (items.length === 0 && !message) {
    return (
      <SalesRepLayout active="request" title="Checkout" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <strong>No items in cart</strong>
          <p>Go back to the catalog to add vaccines to your order.</p>
          <button
            type="button"
            className="inventory-request-btn"
            style={{ marginTop: 16 }}
            onClick={() => navigate("/sales-rep/request-order")}
          >
            <PackagePlus size={16} />
            Browse Catalog
          </button>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout
      active="request"
      title="Checkout"
      topbarTitle="Checkout"
      showSearch={false}
    >
      <div className="place-order-session place-v2-session">
        <span>Current Session</span>
        <strong>{items.length} {items.length === 1 ? "item" : "items"} in order</strong>
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
                placeholder="Search selected items by name, batch, or type..."
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
              <span>{items.length} {items.length === 1 ? "Item" : "Items"} Selected</span>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch ID</th>
                  <th>Quantity</th>
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
                    <td colSpan="4">
                      <div className="place-v2-empty">
                        No matching order item found.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="order-items-footer">
              <p>
                Total Vials
                <strong>{totalQuantity.toLocaleString()}</strong>
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
            {clinicsLoading ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                <Loader2 size={14} className="spin" style={{ verticalAlign: "middle", marginRight: 6 }} />
                Loading clinics...
              </p>
            ) : clinics.length === 0 ? (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>No clinics found. Add clinics in Admin.</p>
            ) : (
              <select
                value={selectedClinic}
                onChange={(event) => setSelectedClinic(event.target.value)}
              >
                {clinics.map((clinic) => (
                  <option key={clinic.id} value={clinic.name}>
                    {clinic.name}
                  </option>
                ))}
              </select>
            )}

            {selectedClinicInfo && (
              <div className="address-box">
                <strong>Shipping Address</strong>
                <p>{selectedClinicInfo.location || selectedClinicInfo.address || "No address on file"}</p>
              </div>
            )}
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
            <h2>Order Summary</h2>

            <p>
              Total Vials
              <strong>{totalQuantity.toLocaleString()}</strong>
            </p>

            <p>
              Items
              <strong>{items.length}</strong>
            </p>

            <p>
              Priority
              <strong>{urgent ? "Urgent" : "Standard"}</strong>
            </p>

            <button
              type="button"
              onClick={handleFinalizeOrder}
              disabled={saving || items.length === 0 || clinicsLoading || !selectedClinicInfo}
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
        {item.stockText && <small>{item.stockText}</small>}
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

      <td>
        <button type="button" className="place-v2-remove-btn" onClick={onRemove}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

export default SalesRepPlaceOrder;
