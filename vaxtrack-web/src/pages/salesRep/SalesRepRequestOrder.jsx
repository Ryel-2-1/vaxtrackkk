import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Loader2,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";
import { subscribeInventory } from "../../services/inventoryService";
import { useInventoryVisibility } from "../../components/useInventoryVisibility";
import InventoryVisibilityToggle from "../../components/inventory/InventoryVisibilityToggle";
import CatalogFilterDialog from "../../components/inventory/CatalogFilterDialog";
import { subscribeVaccines } from "../../services/vaccineCatalogService";
import { applyVatToCatalogProduct } from "../../services/vatClassification";
import { formatCentavos, readPriceCentavos } from "../../services/money";
import { deriveExpiryCondition, manilaToday } from "../../services/expiry";
import {
  STORAGE_UNAVAILABLE_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  mergeCartBatch,
  restoreCatalogCart,
  saveCatalogCart,
  saveCartDraft,
} from "../../services/orderDraftRequest";
import { auth } from "../../firebase";
import {
  evaluateBatchEligibility,
  reconcileCartLine,
} from "../../services/orderEligibility";
import {
  FUTURE_ORDER_LABEL,
  MAX_LINE_QUANTITY,
  estimateBackorders,
} from "../../services/backorder";
import { liveErrorMessage } from "../../services/liveDataErrors";
import DialogLayer from "../../components/ui/DialogLayer";
import { useDialogFocus } from "../../components/ui/useDialogFocus";




/**
 * One catalog row per inventory DOCUMENT — one line is one exact batch.
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
  // ONE eligibility decision, shared with the trusted callable. It mirrors
  // functions/src/policy.js `evaluateBatch` exactly — id, quantity/reserved,
  // STATUS (the check this catalog used to be missing, which let a "Critical"
  // batch into the cart and then failed the whole order at submission), expiry,
  // price and available stock — so a batch the server will refuse is never shown
  // as orderable here. `availableQuantity` is derived (quantity - reserved),
  // never stored.
  const eligibility = evaluateBatchEligibility(raw, todayIso);
  const available = eligibility.availableQuantity;
  const onHand = typeof raw.quantity === "number" ? raw.quantity : null;
  // Kept for display only: the catalog shows the live expiry condition and price.
  const expiryCondition = deriveExpiryCondition(raw, todayIso);
  const expiryIso = expiryCondition.expiryDate ?? "";
  const expired = expiryCondition.level === "expired";
  const unitPriceCentavos = readPriceCentavos(raw.sellingPriceCentavos);

  return {
    inventoryId: raw.id,
    // The vaccine product this batch belongs to — the source of its VAT
    // classification. Absent on batches created before the link existed.
    vaccineId: typeof raw.vaccineId === "string" && raw.vaccineId ? raw.vaccineId : null,
    voided: raw.voided === true,
    // The price shown in this row, and the exact figure the checkout will ask
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
    // The specific, server-aligned reason a batch cannot be ordered, plus its
    // stable code — surfaced on the disabled control, not conveyed by colour.
    blockedReason: eligibility.eligible ? null : eligibility.reason,
    blockedReasonCode: eligibility.reasonCode,
    orderable: eligibility.eligible,
    // A valid quote (priced, unexpired, usable) with nothing free right now:
    // still orderable as a FUTURE order — the server backorders it and dispatch
    // waits until every line is fully reserved.
    backorderOnly: eligibility.eligible && eligibility.backorderOnly === true,
    status: !eligibility.eligible
      ? eligibility.reason
      : eligibility.backorderOnly
        ? FUTURE_ORDER_LABEL
        : "In Stock",
  };
}

/* The local `manilaToday()` was deleted — a second copy of the same date-only
   Manila cutoff. It now comes from services/expiry.js, which takes its
   reference time explicitly instead of reading the clock itself. */

function SalesRepRequestOrder() {
  const uid = auth.currentUser?.uid ?? null;
  // Account changes remount all cart state; no previous user's lines leak.
  return <RequestOrderCart key={uid ?? "signed-out"} uid={uid} />;
}

function RequestOrderCart({ uid }) {
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  // The vaccine catalog, for each product's VAT classification.
  const [vaccines, setVaccines] = useState(null);
  const [error, setError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [stockFilter, setStockFilter] = useState("all");
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const catalogTableRef = useRef(null);
  const [fullPageHeight, setFullPageHeight] = useState(0);
  const [quantities, setQuantities] = useState({});
  const [cart, setCart] = useState(() => restoreCatalogCart(localStorage, uid));
  const cartRef = useRef(cart);
  // A message for the rep. Shown as a fixed status toast (never above the
  // list), so adding a vaccine cannot push the catalog down. Add confirmations
  // fade on their own; anything that needs action stays until dismissed.
  const [noticeState, setNoticeState] = useState({ text: "", transient: false });
  const notice = noticeState.text;
  const setNotice = (text, { transient = false } = {}) => setNoticeState({ text, transient });
  const commitCart = (next) => {
    if (!uid) {
      setNotice(UNAUTHENTICATED_MESSAGE);
      return false;
    }
    if (!saveCatalogCart(localStorage, uid, next)) {
      setNotice(STORAGE_UNAVAILABLE_MESSAGE);
      return false;
    }
    cartRef.current = next;
    setCart(next);
    return true;
  };
  useEffect(() => {
    if (!noticeState.transient || !noticeState.text) return undefined;
    const timer = window.setTimeout(() => setNoticeState({ text: "", transient: false }), 6000);
    return () => window.clearTimeout(timer);
  }, [noticeState]);
  // Below CART_SIDE_MIN_WIDTH the cart is not a side column: it opens from the
  // "View cart" button as a portaled drawer (never after all the vaccines).
  const [cartOpen, setCartOpen] = useState(false);
  useEffect(() => {
    if (!cartOpen || typeof window === "undefined" || !window.matchMedia) return undefined;
    const wide = window.matchMedia(`(min-width: ${CART_SIDE_MIN_WIDTH}px)`);
    const close = () => { if (wide.matches) setCartOpen(false); };
    close();
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, [cartOpen]);
  // The raw inventory documents and the reference date the catalog was derived
  // against, kept so a cart line can be re-checked with reconcileCartLine when
  // live inventory changes under it. The clock is read once here, in the data
  // callback — never in a render.
  const [rawInventory, setRawInventory] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [catalogTodayIso, setCatalogTodayIso] = useState(() => manilaToday(Date.now()));

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        const todayIso = manilaToday(Date.now());
        const products = raw.map((item) => normalizeProduct(item, todayIso));
        setCatalog(products);
        setRawInventory(raw);
        setCatalogTodayIso(todayIso);

        setQuantities((prev) => {
          const next = { ...prev };
          for (const p of products) {
            if (!(p.inventoryId in next)) next[p.inventoryId] = 1;
          }
          return next;
        });

        setLoading(false);
        setError("");
      },
      (err) => {
        setError(liveErrorMessage(err, "inventory"));
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);


  // One vaccine-catalog listener for the whole page (never per product).
  useEffect(() => {
    const unsubscribe = subscribeVaccines(
      (docs) => setVaccines(docs),
      (err) => {
        setVaccines([]);
        setError(liveErrorMessage(err, "vaccine VAT classifications"));
      }
    );
    return unsubscribe;
  }, []);

  const vaccinesById = useMemo(() => new Map((vaccines || []).map((v) => [v.id, v])), [vaccines]);
  const inactiveIds = useInventoryVisibility(vaccines, rawInventory);
  const products = useMemo(
    () =>
      catalog
        // Voided batches and archived vaccines are not new-order choices at
        // all — hidden, not shown disabled. They stay in Admin Inventory.
        .filter((product) => !product.voided && !vaccinesById.get(product.vaccineId)?.archived)
        .filter((product) => showInactive || !inactiveIds.has(product.vaccineId))
        .map((product) => applyVatToCatalogProduct(product, vaccinesById)),
    [catalog, vaccinesById, inactiveIds, showInactive]
  );

  const vaccineTypes = useMemo(() => [...new Set(products.map((product) => product.category))].sort(), [products]);

  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return products.filter((product) => {
      const matchesSearch =
        product.name.toLowerCase().includes(query) ||
        product.sku.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.status.toLowerCase().includes(query);
      // "In stock only" now means orderable — an expired or unmigrated batch
      // has stock on paper but cannot be ordered.
      const matchesStock = stockFilter === "all" || product.orderable;
      const matchesType = selectedTypes.length === 0 || selectedTypes.includes(product.category);
      return matchesSearch && matchesStock && matchesType;
    });
  }, [products, searchTerm, stockFilter, selectedTypes]);
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / 10));
  const currentPage = Math.min(page, totalPages);
  const visibleProducts = filteredProducts.slice((currentPage - 1) * 10, currentPage * 10);
  // Keep the pagination area steady when its last page has fewer than ten
  // rows. Measure an actual full page because row heights vary with names,
  // blocked reasons, viewport width and text zoom.
  useEffect(() => {
    const table = catalogTableRef.current;
    if (!table || totalPages < 2 || visibleProducts.length !== 10) return undefined;
    const observer = new ResizeObserver(() => setFullPageHeight(Math.ceil(table.getBoundingClientRect().height)));
    observer.observe(table);
    return () => observer.disconnect();
  }, [totalPages, visibleProducts.length, currentPage]);

  const goToPage = (nextPage) => {
    if (nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return;
    const top = catalogTableRef.current?.getBoundingClientRect().top;
    setPage(nextPage);
    if (top != null) window.scrollTo({ top: Math.max(0, window.scrollY + top - 88), behavior: "instant" });
  };

  const cartTotal = cart.reduce((total, item) => total + item.quantity, 0);
  const storageSlots = cart.length;

  // Every current inventory document by its Firestore id, for re-checking cart
  // lines against live stock.
  const rawById = useMemo(() => {
    const map = new Map();
    for (const item of rawInventory) map.set(item.id, item);
    return map;
  }, [rawInventory]);

  // Re-check each cart line against the CURRENT batch. A line whose batch has
  // vanished, become ineligible (e.g. it just turned Critical or expired), or no
  // longer has enough stock is marked — never silently removed — so the rep is
  // told exactly which batch to fix before the order can continue. The server
  // still repeats this decision inside the reservation transaction.
  const cartLines = useMemo(
    () =>
      cart.map((item) => {
        const batch = rawById.get(item.inventoryId);
        const check = reconcileCartLine(
          { inventoryId: item.inventoryId, quantity: item.quantity },
          batch,
          catalogTodayIso,
          // A line whose vaccine was archived is blocked, never silently dropped.
          { vaccine: batch ? vaccinesById.get(batch.vaccineId) ?? null : null }
        );
        return { ...item, ok: check.ok, issue: check.ok ? null : check.reason };
      }),
    [cart, rawById, catalogTodayIso, vaccinesById]
  );

  // Display-only housekeeping must never change a saved cart's stock estimate.
  const backorderEstimates = useMemo(() => estimateBackorders(cart, catalog), [cart, catalog]);
  const cartHasBackorder = cart.some((item) => (backorderEstimates.get(item.inventoryId) || 0) > 0);

  const blockedCartLines = cartLines.filter((line) => !line.ok);
  const hasBlockedCartLine = blockedCartLines.length > 0;

  // Keyed by the inventory DOCUMENT id, not the batch label: two batches could
  // share a batchId (nothing enforces uniqueness), and keying by it would let
  // one row's quantity control another's.
  const changeQuantity = (key, direction) => {
    // Not capped by available stock any more: whatever cannot be reserved now
    // is backordered. The only ceiling is the server's per-line maximum.
    const maxQty = MAX_LINE_QUANTITY;

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

    const next = mergeCartBatch(cartRef.current, product, quantity, MAX_LINE_QUANTITY);
    if (!commitCart(next)) return;

    setNotice(
      product.backorderOnly
        ? `${product.name} added as a future order — it is out of stock, so dispatch waits until stock arrives and is reserved.`
        : `${product.name} added to quick cart.`,
      { transient: true }
    );
  };

  const removeFromCart = (key) => {
    commitCart(cartRef.current.filter((item) => item.inventoryId !== key));
  };

  const placeOrder = () => {
  if (cart.length === 0) {
    setNotice("Add at least one vaccine before continuing.");
    return;
  }

  // A cart line that went invalid while the rep was deciding blocks the whole
  // checkout, and the notice names the batch so it is obvious which to fix. This
  // is the fast client guard; the callable repeats the check for stale clients.
  if (hasBlockedCartLine) {
    const first = blockedCartLines[0];
    setNotice(`${first.name} — ${first.issue}. Remove or update it to continue.`);
    return;
  }

  // Destination selection belongs to checkout. Quick Cart only carries the
  // selected Firestore inventory batches and their requested quantities.
  const orderDraft = {
    totalVials: cartTotal,
    storageSlots,
    items: cart,
    createdAt: new Date().toISOString(),
  };

  // The cart is saved under the signed-in Med Rep only, so another account on
  // this browser can never load or submit it. Checkout reads it back from the
  // same user-scoped record (services/orderDraftRequest.js).
  const uid = auth.currentUser?.uid;
  if (!uid) {
    setNotice(UNAUTHENTICATED_MESSAGE);
    return;
  }
  if (!saveCartDraft(localStorage, uid, orderDraft)) {
    setNotice(STORAGE_UNAVAILABLE_MESSAGE);
    return;
  }
  navigate("/sales-rep/place-order");
};

  if (loading || vaccines === null) {
    return (
      <>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading vaccine catalog...</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </>
    );
  }

  const cartPanel = {
    cartLines,
    backorderEstimates,
    removeFromCart,
    cartTotal,
    storageSlots,
    cartHasBackorder,
    hasBlockedCartLine,
    blockedCartLines,
    placeOrder,
  };

  return (
    <>
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
                onChange={(event) => { setSearchTerm(event.target.value); setPage(1); }}
                placeholder="Search by name, batch ID, or vaccine type..."
              />
            </div>
          </div>

          <InventoryVisibilityToggle checked={showInactive} onChange={(value) => { setShowInactive(value); setPage(1); }}
            count={[...inactiveIds].filter((id) => !vaccinesById.get(id)?.archived).length} />
          <div className="request-v2-tabs">
            <button type="button" className="catalog-filter-trigger" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">
              <Filter size={16} /> Advanced filters
              {(selectedTypes.length > 0 || stockFilter !== "all") && <span aria-label="Filters active">{selectedTypes.length + Number(stockFilter !== "all")}</span>}
            </button>

            {/* Said once for the whole list rather than under every price:
                the convention is the same for every vaccine. */}
            <p className="rq-price-convention">Unit prices are per vial · VAT-inclusive for VATable products.</p>
          </div>

          {/* Tablet / small laptop (769–1100px): "View cart" lives in a sticky
              toolbar above the list, so it never floats over a vaccine row.
              Phones use the floating control below instead. */}
          <div className="rq-cart-bar">
            <button
              type="button"
              className="rq-cart-bar-btn"
              onClick={() => setCartOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={cartOpen}
            >
              <ShoppingCart size={16} aria-hidden="true" />
              View cart ({cart.length})
            </button>
          </div>

          <div ref={catalogTableRef} className="rq-table-wrap"
            style={totalPages > 1 && visibleProducts.length < 10 && fullPageHeight > 0 ? { minHeight: fullPageHeight } : undefined}>
            {filteredProducts.length > 0 ? (
              <table className="rq-table">
                <thead>
                  <tr>
                    <th scope="col">Vaccine / batch</th>
                    <th scope="col">Type / VAT</th>
                    <th scope="col">Availability</th>
                    <th scope="col">Unit price</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => (
                    <tr key={product.inventoryId}>
                      <td>
                        <strong>{product.name}</strong>
                        <small>Batch: {product.sku}</small>
                        {!product.orderable && <small className="rq-table-reason" id={`rq-table-reason-${product.inventoryId}`}>{product.blockedReason}</small>}
                      </td>
                      <td>
                        <span>{product.category}</span>
                        <small>{product.vatLabel}</small>
                      </td>
                      <td>
                        <strong>{product.available === null ? "—" : product.available.toLocaleString()}</strong>
                        <small>{!product.orderable ? "Can't order yet" : product.backorderOnly ? "Future order" : "In stock"}</small>
                        <small>{product.available === null ? "Needs migration" : `${product.onHand ?? 0} on hand · ${Math.max((product.onHand ?? 0) - product.available, 0)} reserved or held`}</small>
                      </td>
                      <td className="rq-table-price">
                        <strong>{product.priceLabel}</strong>
                        {product.unitPriceCentavos === null && <small>Not priced yet</small>}
                      </td>
                      <td>
                        <div className="rq-table-qty" role="group" aria-label={`Quantity for ${product.name}, batch ${product.sku}`}>
                          <button type="button" className="rq-table-qty-btn" aria-label={`Decrease ${product.name} quantity`} onClick={() => changeQuantity(product.inventoryId, "minus")} disabled={!product.orderable}><Minus size={14} /></button>
                          <span>{quantities[product.inventoryId] || 1}</span>
                          <button type="button" className="rq-table-qty-btn" aria-label={`Increase ${product.name} quantity`} onClick={() => changeQuantity(product.inventoryId, "plus")} disabled={!product.orderable}><Plus size={14} /></button>
                        </div>
                      </td>
                      <td>
                        <button type="button" className="rq-table-add" onClick={() => addToCart(product)} disabled={!product.orderable}
                          aria-describedby={!product.orderable ? `rq-table-reason-${product.inventoryId}` : undefined}>
                          {!product.orderable ? "Unavailable" : product.backorderOnly ? "Add future order" : "Add to Order"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="request-v2-empty">
                <PackageCheck size={34} />
                <strong>No products found</strong>
                <p>Try changing your search or filters.</p>
              </div>
            )}
          </div>
          {filteredProducts.length > 0 && (
            <nav className="rq-pagination" aria-label="Vaccine catalog pages">
              <span>Showing {(currentPage - 1) * 10 + 1}–{Math.min(currentPage * 10, filteredProducts.length)} of {filteredProducts.length} batches</span>
              <div>
                <button type="button" aria-label="Previous page" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}><ChevronLeft size={16} /></button>
                <span>Page {currentPage} of {totalPages}</span>
                <button type="button" aria-label="Next page" disabled={currentPage === totalPages} onClick={() => goToPage(currentPage + 1)}><ChevronRight size={16} /></button>
              </div>
            </nav>
          )}
        </div>

        {/* Wide screens: the cart sits beside the catalog (sticky). It is
            hidden below CART_SIDE_MIN_WIDTH, where the drawer below takes over. */}
        <aside className="quick-cart request-v2-cart rq-cart-side" aria-labelledby="rq-cart-title">
          <QuickCartPanel headingId="rq-cart-title" {...cartPanel} />
        </aside>
      </section>

      {filtersOpen && <CatalogFilterDialog
        title="Catalog filters"
        types={vaccineTypes}
        selectedTypes={selectedTypes}
        status={stockFilter}
        statusOptions={[{ value: "all", label: "All products" }, { value: "stock", label: "Orderable products" }]}
        onApply={({ types, status }) => { setSelectedTypes(types); setStockFilter(status); setPage(1); setFiltersOpen(false); }}
        onClose={() => setFiltersOpen(false)}
      />}

      {/* Phones (≤768px): a floating control opens the same cart in a
          portaled drawer, so it is never pushed below every vaccine. The
          control is portaled too: inside the transformed route container a
          fixed element would scroll away with the page. */}
      <DialogLayer scope="salesrep-page salesrep-main">
        {/* Always mounted so screen readers announce each new message. */}
        <div className="rq-notice-region" role="status" aria-live="polite">
          {notice && (
            <div className="request-v2-notice rq-notice-toast">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{notice}</span>
              <button type="button" className="rq-notice-close" onClick={() => setNotice("")} aria-label="Dismiss message">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="rq-cart-toggle"
          onClick={() => setCartOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={cartOpen}
        >
          <ShoppingCart size={16} aria-hidden="true" />
          View cart ({cart.length})
        </button>
      </DialogLayer>
      {cartOpen && (
        <DialogLayer scope="salesrep-page salesrep-main">
          <CartDrawer onClose={() => setCartOpen(false)}>
            <QuickCartPanel headingId="rq-cart-drawer-title" {...cartPanel} />
          </CartDrawer>
        </DialogLayer>
      )}
    </>
  );
}

/** The width at which the cart becomes a side column (salesrep-polish.css). */
const CART_SIDE_MIN_WIDTH = 1101;

/**
 * The cart's contents: lines, totals and Continue to Checkout. Rendered in the
 * side column on wide screens and inside CartDrawer on narrower ones — the
 * same component, so the two can never drift apart.
 */
function QuickCartPanel({
  headingId,
  cartLines,
  backorderEstimates,
  removeFromCart,
  cartTotal,
  storageSlots,
  cartHasBackorder,
  hasBlockedCartLine,
  blockedCartLines,
  placeOrder,
}) {
  // The pressed Remove button disappears with its line, which would drop
  // keyboard focus to the page. Move it first to the neighbouring line's
  // Remove button, or to the cart heading once the cart is empty.
  const removeLine = (event, inventoryId) => {
    const panel = event.currentTarget.closest(".request-v2-cart");
    const buttons = [...(panel?.querySelectorAll(".request-v2-cart-item > button") ?? [])];
    const at = buttons.indexOf(event.currentTarget);
    const next = buttons[at + 1] || buttons[at - 1] || panel?.querySelector(`#${headingId}`);
    next?.focus({ preventScroll: true });
    removeFromCart(inventoryId);
  };

  return (
    <>
      <div className="quick-cart-title">
        <h2 id={headingId} tabIndex={-1}>Quick Cart</h2>
        <span aria-label={`${cartLines.length} ${cartLines.length === 1 ? "item" : "items"} in cart`}>{cartLines.length}</span>
      </div>

      {cartLines.length === 0 ? (
        <div className="empty-cart">
          <ShoppingCart size={28} aria-hidden="true" />
          <p>
            No items added yet.
            <br />
            Select vaccines from the catalog.
          </p>
        </div>
      ) : (
        <div className="request-v2-cart-items">
          {cartLines.map((item) => (
            <div
              className={`request-v2-cart-item${item.ok ? "" : " request-v2-cart-item-blocked"}`}
              key={item.inventoryId}
            >
              <div>
                <strong>{item.name}</strong>
                <p>{item.sku}</p>
                <span>{item.quantity.toLocaleString()} {item.quantity === 1 ? "vial" : "vials"}</span>
                {/* A specific reason in words, not conveyed by colour alone,
                    so the rep knows exactly which batch to fix. */}
                {item.ok && (backorderEstimates.get(item.inventoryId) || 0) > 0 && (
                  <span className="request-v2-cart-backorder">
                    <Clock size={12} /> About {backorderEstimates.get(item.inventoryId).toLocaleString()} may wait for stock
                  </span>
                )}
                {!item.ok && (
                  <span className="request-v2-cart-issue" role="alert">
                    <AlertTriangle size={12} /> {item.issue}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={(event) => removeLine(event, item.inventoryId)}
                aria-label={`Remove ${item.name} (batch ${item.sku}) from the cart`}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cart-footer">
        <p>
          Total Vials: <strong>{cartTotal.toLocaleString()}</strong>
        </p>

        <p>
          Storage Slots: <strong>{storageSlots}</strong>
        </p>

        {cartHasBackorder && (
          <p className="request-v2-cart-backorder-note">
            Part of this order is a future order. Whatever is in stock is reserved now;
            the rest is reserved automatically as stock arrives, in priority order.
            The order is dispatched only once every item is fully reserved — no
            delivery date is guaranteed until then.
          </p>
        )}

        {hasBlockedCartLine && (
          <p className="request-v2-cart-blocked-note" role="alert">
            Remove or update the highlighted {blockedCartLines.length === 1 ? "batch" : "batches"} to continue.
          </p>
        )}

        <button
          type="button"
          onClick={placeOrder}
          disabled={cartLines.length === 0 || hasBlockedCartLine}
        >
          Continue to Checkout
        </button>
      </div>
    </>
  );
}

/**
 * The cart below CART_SIDE_MIN_WIDTH: a portaled drawer (DialogLayer), so it
 * covers the viewport even inside the transformed route container. Focus moves
 * in, Tab stays inside, Escape and Close dismiss it, page scroll is locked, and
 * focus returns to "View cart" (useDialogFocus).
 */
function CartDrawer({ onClose, children }) {
  const drawerRef = useRef(null);
  useDialogFocus({ dialogRef: drawerRef, onDismiss: onClose });
  return (
    <div className="rq-cart-backdrop" onMouseDown={onClose}>
      <div
        ref={drawerRef}
        className="request-v2-cart rq-cart-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rq-cart-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="rq-cart-close" onClick={onClose} aria-label="Close cart">
          <X size={18} aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>
  );
}

export default SalesRepRequestOrder;
