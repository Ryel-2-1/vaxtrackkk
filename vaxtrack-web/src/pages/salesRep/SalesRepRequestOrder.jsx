import { Search, ShoppingCart } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepRequestOrder() {
  const navigate = useNavigate();
  const products = [
    ["MRNA TECHNOLOGY", "VaxCovar-9 Prime", "VC9-P-2024-X", "4,280", "-80°C to -60°C", "In Stock"],
    ["VIRAL VECTOR", "ImmunoShield G3", "IGS3-500-MED", "840", "2°C to 8°C", "Low Stock"],
    ["PROTEIN SUBUNIT", "NovusVax Pro", "NVP-99-PRO", "12,150", "2°C to 8°C", "In Stock"],
    ["MRNA TECHNOLOGY", "Pediatri-Vax 12", "PV12-KID-24", "--", "-20°C", "Out of Stock"],
  ];

  return (
    <SalesRepLayout active="request" title="Vaccine Inventory" showSearch={false}>
      <section className="request-order-layout">
        <div className="request-catalog">
          <div className="request-header-row">
            <div>
              <h1>Vaccine Inventory</h1>
              <p>Global medical catalog & live hub availability</p>
            </div>
            <div className="request-search"><Search size={16} /><input placeholder="Search by name, SKU, or vaccine type..." /></div>
          </div>

          <div className="catalog-tabs">
            <button className="active">All Products</button>
            <button>In Stock Only</button>
          </div>

          <div className="product-grid">
            {products.map((product) => (
              <div className="product-card" key={product[1]}>
                <div className="product-card-top">
                  <span className="product-type">{product[0]}</span>
                  <span className={product[5] === "Out of Stock" ? "stock out" : product[5] === "Low Stock" ? "stock low" : "stock"}>{product[5]}</span>
                </div>
                <h2>{product[1]}</h2>
                <p>SKU: {product[2]}</p>

                <div className="product-meta">
                  <div><span>Hub Stock Level</span><strong>{product[3]}</strong><small>vials</small></div>
                  <div><span>Storage Temp</span><strong>{product[4]}</strong></div>
                </div>

                <div className="product-actions">
                  <div className="qty-control"><button>-</button><span>1</span><button>+</button></div>
                  <button className={product[5] === "Out of Stock" ? "disabled" : ""} onClick={() => navigate("/sales-rep/place-order")}>{product[5] === "Out of Stock" ? "Notify When Restocked" : "Add to Order"}</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="quick-cart">
          <div className="quick-cart-title"><h2>Quick Cart</h2><span>0</span></div>
          <div className="empty-cart"><ShoppingCart size={38} /><p>No items added yet.<br />Select vaccines from the catalog.</p></div>
          <div className="cart-footer">
            <p>Total Vials: <strong>0</strong></p>
            <p>Storage Slots: <strong>0</strong></p>
            <label>Clinic ID / Destination</label>
            <input placeholder="e.g. MNL-HUB-A102" />
            <button onClick={() => navigate("/sales-rep/place-order")}>Place Order</button>
          </div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

export default SalesRepRequestOrder;
