import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  CheckCircle2,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

const productCatalog = [
  {
    category: "MRNA TECHNOLOGY",
    name: "VaxCovar-9 Prime",
    sku: "VC9-P-2024-X",
    stock: 4280,
    temp: "-80°C to -60°C",
    status: "In Stock",
  },
  {
    category: "VIRAL VECTOR",
    name: "ImmunoShield G3",
    sku: "IGS3-500-MED",
    stock: 840,
    temp: "2°C to 8°C",
    status: "Low Stock",
  },
  {
    category: "PROTEIN SUBUNIT",
    name: "NovusVax Pro",
    sku: "NVP-99-PRO",
    stock: 12150,
    temp: "2°C to 8°C",
    status: "In Stock",
  },
  {
    category: "MRNA TECHNOLOGY",
    name: "Pediatri-Vax 12",
    sku: "PV12-KID-24",
    stock: 0,
    temp: "-20°C",
    status: "Out of Stock",
  },
  {
    category: "INACTIVATED",
    name: "CoronaVac Plus",
    sku: "SNO-2023-C44",
    stock: 120000,
    temp: "2°C to 8°C",
    status: "In Stock",
  },
  {
    category: "MRNA TECHNOLOGY",
    name: "Spikevax Batch",
    sku: "MOD-2023-B12",
    stock: 45000,
    temp: "-20°C",
    status: "In Stock",
  },
];

function SalesRepRequestOrder() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [stockFilter, setStockFilter] = useState("all");
  const [quantities, setQuantities] = useState(() =>
    productCatalog.reduce((acc, product) => ({ ...acc, [product.sku]: 1 }), {})
  );
  const [cart, setCart] = useState([]);
  const [destination, setDestination] = useState("");
  const [notice, setNotice] = useState("");

  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return productCatalog.filter((product) => {
      const matchesSearch =
        product.name.toLowerCase().includes(query) ||
        product.sku.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.status.toLowerCase().includes(query);

      const matchesStock = stockFilter === "all" || product.stock > 0;

      return matchesSearch && matchesStock;
    });
  }, [searchTerm, stockFilter]);

  const cartTotal = cart.reduce((total, item) => total + item.quantity, 0);
  const storageSlots = cart.length;

  const changeQuantity = (sku, direction) => {
    const product = productCatalog.find((item) => item.sku === sku);
    const maxQty = Math.max(product?.stock || 1, 1);

    setQuantities((current) => {
      const currentQty = current[sku] || 1;
      const nextQty = direction === "minus" ? currentQty - 1 : currentQty + 1;

      return {
        ...current,
        [sku]: Math.min(Math.max(nextQty, 1), maxQty),
      };
    });
  };

  const addToCart = (product) => {
    if (product.stock <= 0) {
      notifyRestock(product);
      return;
    }

    const quantity = quantities[product.sku] || 1;

    setCart((current) => {
      const existing = current.find((item) => item.sku === product.sku);

      if (existing) {
        return current.map((item) =>
          item.sku === product.sku
            ? {
                ...item,
                quantity: Math.min(item.quantity + quantity, product.stock),
              }
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

  const notifyRestock = (product) => {
    const savedNotifications = JSON.parse(localStorage.getItem("salesRepRestockNotifications") || "[]");
    const alreadySaved = savedNotifications.some((item) => item.sku === product.sku);

    if (!alreadySaved) {
      localStorage.setItem(
        "salesRepRestockNotifications",
        JSON.stringify([...savedNotifications, product])
      );
    }

    setNotice(`Restock notification saved for ${product.name}.`);
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

  return (
    <SalesRepLayout active="request" title="Vaccine Inventory" showSearch={false}>
      <section className="request-order-layout request-v2-layout">
        <div className="request-catalog">
          <div className="request-header-row request-v2-header">
            <div>
              <h1>Vaccine Inventory</h1>
              <p>Global medical catalog and live hub availability.</p>
            </div>

            <div className="request-search request-v2-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by name, SKU, or vaccine type..."
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
                  <p>SKU: {product.sku}</p>

                  <div className="product-meta">
                    <div>
                      <span>Hub Stock Level</span>
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

                      <span>{quantities[product.sku]}</span>

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
                          Notify When Restocked
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
