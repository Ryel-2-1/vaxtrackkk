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
import SalesRepLayout from "./SalesRepLayout";

function normalizeProduct(raw) {
  const qty = raw.quantity != null ? Number(raw.quantity) : 0;
  let status = "In Stock";
  if (qty <= 0) status = "Out of Stock";
  else if (qty <= 100) status = "Low Stock";

  return {
    id: raw.id,
    name: raw.vaccineName || "Unknown Vaccine",
    sku: raw.batchId || raw.id,
    category: raw.vaccineType || "Other",
    stock: qty,
    temp: raw.storageTemp != null
      ? String(raw.storageTemp).includes("°") ? String(raw.storageTemp) : `${raw.storageTemp}°C`
      : "—",
    status,
  };
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

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        const products = raw.map(normalizeProduct);
        setCatalog(products);

        setQuantities((prev) => {
          const next = { ...prev };
          for (const p of products) {
            if (!(p.sku in next)) next[p.sku] = 1;
          }
          return next;
        });

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

  useEffect(() => {
    if (catalog.length === 0) return;

    try {
      const saved = JSON.parse(localStorage.getItem("salesRepSelectedInventory") || "null");
      if (!Array.isArray(saved) || saved.length === 0) return;

      localStorage.removeItem("salesRepSelectedInventory");

      const preselected = [];
      for (const item of saved) {
        const match = catalog.find((p) => p.id === item.id);
        if (match && match.stock > 0) {
          const existing = preselected.find((c) => c.sku === match.sku);
          if (!existing) {
            preselected.push({ ...match, quantity: 1 });
          }
        }
      }

      if (preselected.length > 0) {
        setCart((prev) => {
          const merged = [...prev];
          for (const item of preselected) {
            if (!merged.find((c) => c.sku === item.sku)) {
              merged.push(item);
            }
          }
          return merged;
        });
        setNotice(`${preselected.length} item(s) added from inventory selection.`);
      }
    } catch {
      // ignore parse errors
    }
  }, [catalog]);

  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return catalog.filter((product) => {
      const matchesSearch =
        product.name.toLowerCase().includes(query) ||
        product.sku.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.status.toLowerCase().includes(query);
      const matchesStock = stockFilter === "all" || product.stock > 0;
      return matchesSearch && matchesStock;
    });
  }, [catalog, searchTerm, stockFilter]);

  const cartTotal = cart.reduce((total, item) => total + item.quantity, 0);
  const storageSlots = cart.length;

  const changeQuantity = (sku, direction) => {
    const product = catalog.find((item) => item.sku === sku);
    const maxQty = Math.max(product?.stock || 1, 1);

    setQuantities((current) => {
      const currentQty = current[sku] || 1;
      const nextQty = direction === "minus" ? currentQty - 1 : currentQty + 1;
      return { ...current, [sku]: Math.min(Math.max(nextQty, 1), maxQty) };
    });
  };

  const addToCart = (product) => {
    if (product.stock <= 0) {
      setNotice(`${product.name} is out of stock.`);
      return;
    }

    const quantity = quantities[product.sku] || 1;

    setCart((current) => {
      const existing = current.find((item) => item.sku === product.sku);
      if (existing) {
        return current.map((item) =>
          item.sku === product.sku
            ? { ...item, quantity: Math.min(item.quantity + quantity, product.stock) }
            : item
        );
      }
      return [...current, { ...product, quantity }];
    });

    setNotice(`${product.name} added to quick cart.`);
  };

  const removeFromCart = (sku) => {
    setCart((current) => current.filter((item) => item.sku !== sku));
  };

  const placeOrder = () => {
    if (cart.length === 0) {
      setNotice("Add at least one vaccine before placing an order.");
      return;
    }

    if (!destination.trim()) {
      setNotice("Please enter a clinic ID or destination before placing an order.");
      return;
    }

    const orderDraft = {
      destination: destination.trim(),
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
      <SalesRepLayout active="request" title="Vaccine Inventory" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading vaccine catalog...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="request" title="Vaccine Inventory" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="request" title="Vaccine Inventory" showSearch={false}>
      <section className="request-order-layout request-v2-layout">
        <div className="request-catalog">
          <div className="request-header-row request-v2-header">
            <div>
              <h1>Vaccine Inventory</h1>
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
                <div className="product-card request-v2-product-card" key={product.sku}>
                  <div className="product-card-top">
                    <span className="product-type">{product.category}</span>
                    <span className={getStockClass(product.status)}>{product.status}</span>
                  </div>

                  <h2>{product.name}</h2>
                  <p>Batch: {product.sku}</p>

                  <div className="product-meta">
                    <div>
                      <span>Available Stock</span>
                      <strong>{product.stock > 0 ? product.stock.toLocaleString() : "--"}</strong>
                      <small>vials</small>
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
                        onClick={() => changeQuantity(product.sku, "minus")}
                        disabled={product.stock <= 0}
                      >
                        <Minus size={14} />
                      </button>

                      <span>{quantities[product.sku] || 1}</span>

                      <button
                        type="button"
                        onClick={() => changeQuantity(product.sku, "plus")}
                        disabled={product.stock <= 0}
                      >
                        <Plus size={14} />
                      </button>
                    </div>

                    <button
                      type="button"
                      className={product.stock <= 0 ? "disabled" : ""}
                      onClick={() => addToCart(product)}
                    >
                      {product.stock <= 0 ? (
                        <>
                          <Bell size={15} />
                          Out of Stock
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
                <div className="request-v2-cart-item" key={item.sku}>
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.sku}</p>
                    <span>{item.quantity.toLocaleString()} vials</span>
                  </div>

                  <button type="button" onClick={() => removeFromCart(item.sku)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="cart-footer">
            <p>Total Vials: <strong>{cartTotal.toLocaleString()}</strong></p>
            <p>Storage Slots: <strong>{storageSlots}</strong></p>

            <label>Clinic ID / Destination</label>
            <input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="e.g. MNL-HUB-A102"
            />

            <button type="button" onClick={placeOrder} disabled={cart.length === 0}>
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
