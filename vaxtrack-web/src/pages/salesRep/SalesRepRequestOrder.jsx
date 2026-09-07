import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Loader2,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { subscribeInventory } from "../../services/inventoryService";
import { availableStock } from "../../services/inventoryCallables";
import { formatCentavos, readPriceCentavos } from "../../services/money";
import { subscribeClinics } from "../../services/clinicService";
import SalesRepLayout from "./SalesRepLayout";

// STRICT Clinic ID matcher. The field is specifically Clinic ID, so ONLY the
// clinic's canonical `clinicId` field is compared — never the display name and
// never the Firestore doc id. The typed value is trimmed and case-folded before
// comparison. A clinic record whose `clinicId` is missing/empty cannot validate
// (guarantees we don't fall back to a doc-id or free-text match). Existence in
// the live Firestore `clinics` collection is required because the array we
// search over comes from `subscribeClinics`.
function findRegisteredClinic(clinics, value) {
  const term = (value || "").trim().toLowerCase();
  if (!term) return null;
  return (
    clinics.find((c) => {
      const cid = c && c.clinicId;
      if (cid == null) return false;
      const canonical = String(cid).trim().toLowerCase();
      if (!canonical) return false; // reject records without a real Clinic ID
      return canonical === term;
    }) || null
  );
}

const CLINIC_INVALID_MSG = "Enter a valid Clinic ID registered in VaxTrack.";

/**
 * One catalog card per inventory DOCUMENT — one line is one exact batch.
 *
 * `inventoryId` is the Firestore document id and is the only identity carried
 * onward. `sku` stays as a display label; it used to double as the identifier
 * and was ambiguous (batchId when present, the document id otherwise), which is
 * why no order before this checkpoint could be traced to a batch with certainty.
 *
 * Availability is derived (`quantity - reservedQuantity`), never stored. A
 * batch that cannot be ordered is still SHOWN — disabled, with the reason — so
 * stock that exists but is unusable is visible rather than silently missing.
 */
function normalizeProduct(raw, todayIso) {
  const available = availableStock(raw);
  const onHand = typeof raw.quantity === "number" ? raw.quantity : null;
  const expiryIso = typeof raw.expiryDate === "string" ? raw.expiryDate.trim() : "";
  const expired = /^\d{4}-\d{2}-\d{2}$/.test(expiryIso) && expiryIso < todayIso;
  const unitPriceCentavos = readPriceCentavos(raw.sellingPriceCentavos);

  // `available === null` means the batch's own figures are unusable — the three
  // hand-seeded staging batches store `quantity` as text. Saying "0 in stock"
  // would be wrong; it needs a migration, and the label says so.
  //
  // An unpriced batch gets its own reason for the same purpose. It is not out
  // of stock and it is not expired — it is waiting on an admin, which is a
  // different problem with a different owner. Blocking it here means a rep can
  // never build a cart the server will refuse, and can never be quoted ₱0.00.
  let blockedReason = null;
  if (available === null) blockedReason = "Needs inventory migration";
  else if (expired) blockedReason = "Expired — unavailable";
  else if (unitPriceCentavos === null) blockedReason = "Not priced — unavailable";
  else if (available <= 0) blockedReason = "Out of stock";

  return {
    inventoryId: raw.id,
    // The price shown on this card, and the exact figure the checkout will ask
    // the server to confirm. Carried into the cart so a price that moves while
    // the rep is deciding is caught rather than silently applied.
    unitPriceCentavos,
    priceLabel: formatCentavos(unitPriceCentavos),
    name: raw.vaccineName || "Unknown Vaccine",
    sku: raw.batchId || "—",
    category: raw.vaccineType || "Other",
    onHand,
    reserved: typeof raw.reservedQuantity === "number" ? raw.reservedQuantity : 0,
    stock: available ?? 0,
    available,
    expiryDate: expiryIso || null,
    expired,
    blockedReason,
    orderable: blockedReason === null,
    temp: raw.storageTemp != null
      ? String(raw.storageTemp).includes("°") ? String(raw.storageTemp) : `${raw.storageTemp}°C`
      : "—",
    status: blockedReason ?? "In Stock",
  };
}

/** Today in Asia/Manila — the same date-only cutoff the server applies. */
function manilaToday() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function SalesRepRequestOrder() {
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [stockFilter, setStockFilter] = useState("all");
  const [quantities, setQuantities] = useState({});
  const [cart, setCart] = useState([]);
  const [destination, setDestination] = useState("");
  const [notice, setNotice] = useState("");

  const [clinics, setClinics] = useState([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  const [clinicError, setClinicError] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeClinics(
      (docs) => {
        setClinics(Array.isArray(docs) ? docs : []);
        setClinicsLoading(false);
      },
      () => setClinicsLoading(false)
    );
    return unsubscribe;
  }, []);

  /**
   * Merge anything the Inventory page handed over, once the catalog is known.
   *
   * Only orderable batches are added: an expired or unmigrated batch selected
   * on the previous screen must not slip into the cart and fail at checkout.
   */
  const applyPreselection = (products) => {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem("salesRepSelectedInventory") || "null");
    } catch {
      return; // unreadable draft; nothing to merge
    }
    if (!Array.isArray(saved) || saved.length === 0) return;
    localStorage.removeItem("salesRepSelectedInventory");

    const preselected = [];
    for (const item of saved) {
      const match = products.find((p) => p.inventoryId === item.id);
      if (match && match.orderable && !preselected.some((c) => c.inventoryId === match.inventoryId)) {
        preselected.push({ ...match, quantity: 1 });
      }
    }
    if (preselected.length === 0) return;

    setCart((prev) => {
      const merged = [...prev];
      for (const item of preselected) {
        if (!merged.find((c) => c.inventoryId === item.inventoryId)) merged.push(item);
      }
      return merged;
    });
    setNotice(`${preselected.length} item(s) added from inventory selection.`);
  };

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        const todayIso = manilaToday();
        const products = raw.map((item) => normalizeProduct(item, todayIso));
        setCatalog(products);

        setQuantities((prev) => {
          const next = { ...prev };
          for (const p of products) {
            if (!(p.inventoryId in next)) next[p.inventoryId] = 1;
          }
          return next;
        });

        // Items pre-selected on the Inventory page, merged here rather than in
        // a second effect that watched `catalog`. That effect called setState
        // synchronously in its body, which cascades renders; this callback is
        // an external-system (Firestore snapshot) callback, where updating
        // state is exactly what it is for. Matching is by inventory DOCUMENT
        // id, never by batch label.
        applyPreselection(products);

        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view inventory. Please contact your administrator.");
        } else {
          setError("Unable to load inventory. Please try again later.");
        }
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return catalog.filter((product) => {
      const matchesSearch =
        product.name.toLowerCase().includes(query) ||
        product.sku.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.status.toLowerCase().includes(query);
      // "In stock only" now means orderable — an expired or unmigrated batch
      // has stock on paper but cannot be ordered.
      const matchesStock = stockFilter === "all" || product.orderable;
      return matchesSearch && matchesStock;
    });
  }, [catalog, searchTerm, stockFilter]);

  const cartTotal = cart.reduce((total, item) => total + item.quantity, 0);
  const storageSlots = cart.length;

  // Keyed by the inventory DOCUMENT id, not the batch label: two batches could
  // share a batchId (nothing enforces uniqueness), and keying by it would let
  // one card's quantity control another's.
  const changeQuantity = (key, direction) => {
    const product = catalog.find((item) => item.inventoryId === key);
    const maxQty = Math.max(product?.stock || 1, 1);

    setQuantities((current) => {
      const currentQty = current[key] || 1;
      const nextQty = direction === "minus" ? currentQty - 1 : currentQty + 1;
      return { ...current, [key]: Math.min(Math.max(nextQty, 1), maxQty) };
    });
  };

  const addToCart = (product) => {
    if (!product.orderable) {
      // The real reason, not a blanket "out of stock" — an unpriced or
      // unmigrated batch is an admin task, not an empty shelf, and telling a
      // rep the wrong one sends them to the wrong person.
      setNotice(`${product.name}: ${product.blockedReason}.`);
      return;
    }

    const quantity = quantities[product.inventoryId] || 1;

    setCart((current) => {
      const existing = current.find((item) => item.inventoryId === product.inventoryId);
      if (existing) {
        return current.map((item) =>
          item.inventoryId === product.inventoryId
            ? { ...item, quantity: Math.min(item.quantity + quantity, product.stock) }
            : item
        );
      }
      return [...current, { ...product, quantity }];
    });

    setNotice(`${product.name} added to quick cart.`);
  };

  const removeFromCart = (key) => {
    setCart((current) => current.filter((item) => item.inventoryId !== key));
  };

  const placeOrder = () => {
    if (cart.length === 0) {
      setNotice("Add at least one vaccine before placing an order.");
      return;
    }

    // Clinic must be a REAL registered clinic — re-checked here, at submit,
    // not only while typing. Arbitrary text (e.g. "rewe") and empty values are
    // rejected; the canonical clinic record is what flows into the draft.
    if (clinicsLoading) return; // validation still pending
    const clinic = findRegisteredClinic(clinics, destination);
    if (!clinic) {
      setClinicError(CLINIC_INVALID_MSG);
      return;
    }
    setClinicError("");

    const orderDraft = {
      destination: clinic.name, // canonical clinic name (PlaceOrder pre-selects by name)
      clinicId: clinic.clinicId, // canonical Clinic ID (guaranteed present by matcher)
      clinicDocId: clinic.id,
      totalVials: cartTotal,
      storageSlots,
      items: cart,
      createdAt: new Date().toISOString(),
    };

    localStorage.setItem("salesRepQuickCart", JSON.stringify(orderDraft));
    navigate("/sales-rep/place-order");
  };

  if (loading) {
    return (
      <SalesRepLayout active="request" title="Request Order" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading vaccine catalog...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="request" title="Request Order" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="request" title="Request Order" showSearch={false}>
      <section className="request-order-layout request-v2-layout">
        <div className="request-catalog">
          <div className="request-header-row request-v2-header">
            <div>
              <h2>Available vaccines</h2>
              <p>Live hub availability from Firestore inventory.</p>
            </div>

            <div className="request-search request-v2-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by name, batch ID, or vaccine type..."
              />
            </div>
          </div>

          <div className="request-v2-tabs">
            <button
              type="button"
              className={stockFilter === "all" ? "active" : ""}
              onClick={() => setStockFilter("all")}
            >
              All Products
            </button>

            <button
              type="button"
              className={stockFilter === "stock" ? "active" : ""}
              onClick={() => setStockFilter("stock")}
            >
              In Stock Only
            </button>
          </div>

          {notice && (
            <div className="request-v2-notice">
              <CheckCircle2 size={16} />
              <span>{notice}</span>
            </div>
          )}

          <div className="product-grid request-v2-product-grid">
            {filteredProducts.length > 0 ? (
              filteredProducts.map((product) => (
                <div className="product-card request-v2-product-card" key={product.inventoryId}>
                  <div className="product-card-top">
                    <span className="product-type">{product.category}</span>
                    <span className={getStockClass(product.status)}>{product.status}</span>
                  </div>

                  <h2>{product.name}</h2>
                  <p>Batch: {product.sku}</p>

                  <div className="product-meta">
                    <div>
                      {/* Available is derived on-hand minus reserved. Both are
                          shown so a rep can tell "someone else has claimed it"
                          from "there is none". */}
                      <span>Available Stock</span>
                      <strong>
                        {product.available === null ? "--" : product.available.toLocaleString()}
                      </strong>
                      <small>
                        {product.available === null
                          ? "needs migration"
                          : `of ${product.onHand ?? 0} on hand · ${product.reserved} reserved`}
                      </small>
                    </div>

                    <div>
                      {/* VAT-exclusive, and labelled as such. An unlabelled
                          price invites the reader to assume whichever
                          convention they are used to, and the invoice adds 12%
                          on top of this figure. */}
                      <span>Unit Price</span>
                      <strong>{product.priceLabel}</strong>
                      <small>
                        {product.unitPriceCentavos === null
                          ? "not priced yet"
                          : "per vial, excl. VAT"}
                      </small>
                    </div>

                    <div>
                      <span>Storage Temp</span>
                      <strong>{product.temp}</strong>
                    </div>
                  </div>

                  <div className="product-actions request-v2-actions">
                    <div className="qty-control">
                      <button
                        type="button"
                        onClick={() => changeQuantity(product.inventoryId, "minus")}
                        disabled={!product.orderable}
                      >
                        <Minus size={14} />
                      </button>

                      <span>{quantities[product.inventoryId] || 1}</span>

                      <button
                        type="button"
                        onClick={() => changeQuantity(product.inventoryId, "plus")}
                        disabled={!product.orderable}
                      >
                        <Plus size={14} />
                      </button>
                    </div>

                    <button
                      type="button"
                      className={!product.orderable ? "disabled" : ""}
                      onClick={() => addToCart(product)}
                      disabled={!product.orderable}
                    >
                      {!product.orderable ? (
                        <>
                          <Bell size={15} />
                          {/* The real reason, not a blanket "out of stock":
                              expired, unmigrated and unpriced batches are
                              different problems with different owners. */}
                          {product.blockedReason}
                        </>
                      ) : (
                        <>
                          <ShoppingCart size={15} />
                          Add to Order
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="request-v2-empty">
                <PackageCheck size={34} />
                <strong>No products found</strong>
                <p>Try changing your search or stock filter.</p>
              </div>
            )}
          </div>
        </div>

        <aside className="quick-cart request-v2-cart">
          <div className="quick-cart-title">
            <h2>Quick Cart</h2>
            <span>{cart.length}</span>
          </div>

          {cart.length === 0 ? (
            <div className="empty-cart">
              <ShoppingCart size={38} />
              <p>
                No items added yet.
                <br />
                Select vaccines from the catalog.
              </p>
            </div>
          ) : (
            <div className="request-v2-cart-items">
              {cart.map((item) => (
                <div className="request-v2-cart-item" key={item.inventoryId}>
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.sku}</p>
                    <span>{item.quantity.toLocaleString()} {item.quantity === 1 ? "vial" : "vials"}</span>
                  </div>

                  <button type="button" onClick={() => removeFromCart(item.inventoryId)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="cart-footer">
            <p>Total Vials: <strong>{cartTotal.toLocaleString()}</strong></p>
            <p>Storage Slots: <strong>{storageSlots}</strong></p>

            <label htmlFor="request-clinic-id">Clinic ID / Destination</label>
            <input
              id="request-clinic-id"
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                if (clinicError) setClinicError("");
              }}
              placeholder="e.g. MNL-HUB-A102"
              aria-invalid={clinicError ? "true" : undefined}
              aria-describedby={clinicError ? "request-clinic-error" : undefined}
            />
            {clinicError && (
              <small id="request-clinic-error" className="request-clinic-error" role="alert">
                {clinicError}
              </small>
            )}

            <button
              type="button"
              onClick={placeOrder}
              disabled={cart.length === 0 || clinicsLoading}
            >
              Place Order
            </button>
          </div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

function getStockClass(status) {
  if (status === "Out of Stock") return "stock out";
  if (status === "Low Stock") return "stock low";
  return "stock";
}

export default SalesRepRequestOrder;
