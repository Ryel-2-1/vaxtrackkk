import {
  AlertTriangle,
  Bell,
  FileText,
  Loader2,
  MapPin,
  PackagePlus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createOrderWithReservation,
  newRequestId,
} from "../../services/inventoryCallables";
import { subscribeClinics } from "../../services/clinicService";
import {
  centavosToPesos,
  formatCentavos,
  readPriceCentavos,
} from "../../services/money";
import SalesRepLayout from "./SalesRepLayout";

/**
 * A server error code turned into something a rep can act on.
 *
 * The server already writes a user-facing sentence; this only adds the extra
 * step where the right next action is not obvious from the message alone.
 */
function messageForCallableError(error) {
  switch (error?.code) {
    case "insufficient-stock": {
      const info = error.info;
      return info
        ? `Only ${info.available} left in batch ${info.batchId ?? info.inventoryId}. Adjust the quantity and try again.`
        : error.message;
    }
    case "batch-expired":
      return "One of these batches has expired and can no longer be ordered. Remove it and pick another.";
    case "price-changed": {
      // The whole point of the check is that a rep sees the real numbers and
      // decides, so both figures are named rather than summarised as "changed".
      const info = error.info;
      if (!info) return error.message;
      const batch = info.batchId ?? info.inventoryId;
      return `The price of batch ${batch} changed from ${formatCentavos(
        info.expectedUnitPriceCentavos
      )} to ${formatCentavos(
        info.currentUnitPriceCentavos
      )} while you were ordering. Nothing was placed. Rebuild the cart from the catalog to order at the new price.`;
    }
    case "batch-unpriced":
      return "One of these batches has no selling price yet. An admin needs to price it before it can be ordered.";
    case "price-not-confirmed":
      return "This cart was built before batch pricing. Please rebuild it from the catalog so the prices can be confirmed.";
    case "inventory-migration-required":
      return "One of these batches still records its stock as text and needs an admin migration before it can be ordered.";
    case "idempotency-conflict":
      return "This checkout was already submitted with different contents. Review your cart and start a new order.";
    case "duplicate-inventory-line":
      return "The same batch appears on two lines. Combine them into one.";
    default:
      return error?.message || "Unable to create order. Please try again.";
  }
}

/**
 * The confirmation screen's line data, built from the callable's own reply.
 *
 * `pricing` is what the server recorded on the order. The cart lines are used
 * only for the display fields the server does not return (batch label, chain).
 * If the server sends no pricing block — an old deployment, or an order it
 * could not read back on a replay — the lines carry NO price at all rather than
 * falling back to the client's expectation: an unproven number shown as a bill
 * is worse than a dash.
 */
function confirmationPricing(pricing, cartItems) {
  const byId = new Map(cartItems.map((item) => [item.inventoryId, item]));
  const serverItems = Array.isArray(pricing?.items) ? pricing.items : null;

  if (!serverItems) {
    return {
      items: cartItems.map((item) => ({ ...item, unitPrice: null, unitPriceCentavos: null })),
      subtotalCentavos: null,
      subtotal: null,
      pricingSource: "unavailable",
    };
  }

  return {
    items: serverItems.map((line) => {
      const cartLine = byId.get(line.inventoryId);
      return {
        inventoryId: line.inventoryId,
        name: line.name ?? cartLine?.name ?? "Selected Vaccine",
        sku: line.batchId ?? cartLine?.sku ?? "—",
        chain: cartLine?.chain ?? "Cold Chain",
        quantity: line.quantity,
        unitPriceCentavos: line.unitPriceCentavos,
        lineTotalCentavos: line.lineTotalCentavos,
        unitPrice: centavosToPesos(line.unitPriceCentavos),
      };
    }),
    subtotalCentavos: pricing.subtotalCentavos,
    subtotal: centavosToPesos(pricing.subtotalCentavos),
    priceCurrency: pricing.priceCurrency,
    priceIsVatInclusive: pricing.priceIsVatInclusive,
    pricingSource: "server",
  };
}

function getInitialItems() {
  try {
    const savedDraft = JSON.parse(localStorage.getItem("salesRepQuickCart") || "null");

    if (savedDraft?.items?.length) {
      return savedDraft.items.map((item) => ({
        // The authoritative Firestore inventory DOCUMENT id, carried through
        // from the catalog. It used to be dropped here and again in the order
        // service, which is why no order could be traced back to a batch. It is
        // the only field the server treats as identity.
        inventoryId: item.inventoryId || null,
        name: item.name || "Unknown Vaccine",
        sku: item.sku || "—",
        chain: item.temp || item.category || "Cold Chain",
        quantity: Number(item.quantity) || 1,
        // The price the catalog showed when this line entered the cart, read
        // back through the same validator the catalog used — so a hand-edited
        // localStorage value does not become a price, it becomes null, and the
        // submit guard below refuses the cart rather than quoting it.
        expectedUnitPriceCentavos: readPriceCentavos(item.unitPriceCentavos),
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

  /** Synchronous re-entry guard — see handleFinalizeOrder. */
  const submittingRef = useRef(false);

  /**
   * One stable id per checkout ATTEMPT.
   *
   * Generated once when the page mounts and kept across a recoverable failure,
   * so a retry reaches the server as the SAME attempt and replays the original
   * order instead of creating a second one. Retired only after a confirmed
   * success (a new attempt is a genuinely new order).
   */
  const requestIdRef = useRef(newRequestId());
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

  /**
   * The cart's VAT-exclusive subtotal, in centavos — an ESTIMATE, and labelled
   * as one on screen.
   *
   * The authoritative subtotal is the one the server computes from the batches
   * inside the reservation transaction and writes onto the order. This figure
   * exists so the rep can see what they are about to commit to; if it disagrees
   * with the server the checkout is refused with `price-changed` rather than
   * quietly reconciled. Null when any line has no readable price, because a
   * partial total is a wrong total.
   */
  const subtotalCentavos = items.some((item) => item.expectedUnitPriceCentavos === null)
    ? null
    : items.reduce(
        (total, item) => total + item.expectedUnitPriceCentavos * item.quantity,
        0
      );

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
    // Synchronous re-entry guard, BEFORE any state update or await.
    //
    // `disabled={saving}` is feedback, not concurrency control: setSaving is a
    // React state update, so several clicks delivered in one event turn all
    // reach this handler before any rebuild. The server's idempotency key makes
    // duplicates harmless; this stops them being sent at all.
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (items.length === 0) {
      submittingRef.current = false;
      setMessage("Add at least one order item before finalizing.");
      return;
    }

    // Re-validate the clinic at submit time (not only while selecting): it must
    // still be a REAL registered clinic in the live Firestore `clinics` array
    // AND carry a non-empty canonical `clinicId`. Records without a `clinicId`
    // are rejected — we never fall back to the Firestore doc id.
    if (clinicsLoading) {
      submittingRef.current = false;
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
      submittingRef.current = false;
      setMessage("Enter a valid Clinic ID registered in VaxTrack.");
      return;
    }

    // Every line must carry an authoritative batch. A cart built before this
    // checkpoint has none, and guessing one from its name or SKU is exactly
    // what the reservation design forbids.
    const unallocated = items.filter((item) => !item.inventoryId);
    if (unallocated.length > 0) {
      submittingRef.current = false;
      setMessage(
        "This cart was built before batch tracking. Please rebuild it from the catalog."
      );
      return;
    }

    // And every line must carry the price it was quoted at. The server refuses
    // an unconfirmed price anyway; catching it here means the rep is told to
    // rebuild the cart instead of watching a submit fail.
    const unpriced = items.filter((item) => item.expectedUnitPriceCentavos === null);
    if (unpriced.length > 0) {
      submittingRef.current = false;
      setMessage(
        "This cart was built before batch pricing. Please rebuild it from the catalog."
      );
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      // The order is created SERVER-SIDE so it commits together with the stock
      // reservation. `clinicDocId` is the Firestore document id; the clinic's
      // name, address and location snapshot are all re-derived from that
      // document on the server, so nothing typed here can describe a different
      // destination. Only the batch id and an integer quantity travel per line.
      const result = await createOrderWithReservation({
        requestId: requestIdRef.current,
        clinicDocId: verifiedClinic.id,
        priority: urgent ? "Urgent" : "Standard",
        deliveryInstructions: instructions.trim(),
        items: items.map((item) => ({
          inventoryId: item.inventoryId,
          quantity: Number(item.quantity),
          expectedUnitPriceCentavos: item.expectedUnitPriceCentavos,
        })),
      });

      // Only now — after the callable confirms the commit — is the cart cleared
      // and the confirmation shown. Nothing above this line may claim success.
      localStorage.setItem("latestSalesOrderId", result.orderId);
      localStorage.setItem(
        "latestSalesOrderDetails",
        JSON.stringify({
          id: result.orderId,
          orderNumber: result.orderNumber,
          clinicName: verifiedClinic.name,
          clinicAddress: verifiedClinic.location || verifiedClinic.address || "",
          // Prices come from `result.pricing` — what the SERVER wrote onto the
          // order — never from `expectedUnitPriceCentavos`, which is only ever
          // the client's claim about what it was shown. The two agree by
          // construction here, since a difference would have been refused with
          // `price-changed`; showing the server's copy means the confirmation
          // still cannot drift from the document if that ever stops holding.
          ...confirmationPricing(result.pricing, items),
          quantity: totalQuantity,
          status: "pending_dispatch",
        })
      );
      localStorage.removeItem("salesRepQuickCart");
      // A new attempt after this point is a NEW order, so the id is retired.
      requestIdRef.current = newRequestId();

      navigate("/sales-rep/order-confirmation");
    } catch (error) {
      // The cart and the request id both survive: a retry of a recoverable
      // failure must reach the server as the SAME attempt, or a submission
      // that actually committed would be duplicated.
      setMessage(messageForCallableError(error));
    } finally {
      setSaving(false);
      submittingRef.current = false;
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
                  <th>Unit price</th>
                  <th>Line total</th>
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
                    <td colSpan="6">
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

            {/* Named "estimated" and "excl. VAT" on purpose. The server writes
                the binding figure, and the invoice adds 12% on top of it —
                a number labelled just "Total" would be read as neither. */}
            <p>
              Estimated subtotal
              <strong className="tnum">
                {subtotalCentavos === null ? "—" : formatCentavos(subtotalCentavos)}
              </strong>
            </p>
            <p className="place-v2-price-note">
              Excludes 12% VAT, added at invoicing. Prices are confirmed against
              the batch when the order is placed.
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

      {/* Both figures come from the catalog snapshot, and the server will
          confirm the unit price against the live batch before anything is
          placed. A line whose price could not be read shows a dash rather than
          a zero — zero is a price, and this is the absence of one. */}
      <td className="tnum">{formatCentavos(item.expectedUnitPriceCentavos)}</td>

      <td className="tnum">
        {item.expectedUnitPriceCentavos === null
          ? "—"
          : formatCentavos(item.expectedUnitPriceCentavos * item.quantity)}
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
