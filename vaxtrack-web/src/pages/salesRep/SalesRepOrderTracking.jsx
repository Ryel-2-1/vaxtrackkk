import { AlertTriangle, Bell, Box, Menu, PackageCheck, Search, Share2, Truck } from "lucide-react";
import SalesRepLayout from "./SalesRepLayout";

function SalesRepOrderTracking() {
  return (
    <SalesRepLayout active="request" title="Order Tracking Dashboard" showSearch={false}>
      <header className="tracking-header">
        <div><Menu size={18} /><h1>Order Tracking Dashboard</h1></div>
        <div className="salesrep-search small"><Search size={15} /><input placeholder="Search orders, clinics..." /></div>
        <Bell size={18} />
        <span>?</span>
      </header>

      <section className="tracking-layout">
        <div className="tracking-left">
          <div className="tracking-toolbar"><button className="primary">+ New Delivery</button><div><button className="active">Active</button><button>History</button></div><span>Filter by Status</span></div>

          <table className="tracking-table">
            <thead><tr><th>Order ID</th><th>Destination</th><th>Date</th><th>Logistics Status</th><th>Progress</th></tr></thead>
            <tbody>
              <TrackingRow selected id="VT - 8803" destination="St. Luke's Medical Center" city="Quezon City, Metro Manila" date="Oct 24, 2026" status="Out for Delivery" progress="75% • 1.2km" />
              <TrackingRow id="VT - 8801" destination="Makati Medical Center" city="Makati City, Metro Manila" date="Oct 24, 2026" status="Processing" progress="25% • Sorting" />
              <TrackingRow id="VT - 8867" destination="Asian Hospital" city="Alabang, Muntinlupa" date="Oct 23, 2026" status="Delivered" progress="100% • 09:45" />
              <TrackingRow danger id="VT - 8869" destination="Cardinal Santos" city="San Juan City" date="Oct 23, 2026" status="Delayed" progress="60% • Traffic" />
            </tbody>
          </table>

          <div className="draft-footer"><Truck size={28} /><div><strong>Draft Order</strong><p>12 Products Added</p></div><div><strong>Est. Delivery</strong><p>Oct 26, 2026</p></div><button>Review Order</button></div>
        </div>

        <aside className="tracking-side">
          <div className="tracking-side-title"><h2>OrderVT-8802</h2><button>×</button></div>
          <p>Scheduled for Oct 24, 02:00 PM</p>
          <button className="contact-driver">Contact Driver</button><button className="share-btn"><Share2 size={16} /></button>
          <h3>Live Tracking</h3>
          <div className="mini-map"><span>LIVE • DRIVER ID: RX-44</span></div>
          <h3>Order Content</h3>
          <OrderContent name="VaxGrip Tetra 2024" qty="500 Units" price="₱12,500" />
          <OrderContent name="Prevenar 13" qty="120 Units" price="₱4,200" />
          <div className="tracking-total"><p>Subtotal <strong>₱16,700.00</strong></p><p>Logistics Fee <strong>₱150.00</strong></p><h2>Total <span>₱16,850.00</span></h2></div>
        </aside>
      </section>
    </SalesRepLayout>
  );
}

function TrackingRow({ selected, danger, id, destination, city, date, status, progress }) {
  return (
    <tr className={selected ? "selected" : ""}>
      <td>{danger ? <AlertTriangle size={17} /> : <Box size={17} />} <strong>{id}</strong></td>
      <td><strong>{destination}</strong><small>{city}</small></td>
      <td>{date}</td>
      <td><span className={`track-status ${status.toLowerCase().replaceAll(" ", "-")}`}>{status}</span></td>
      <td><div className="track-progress"><span style={{ width: progress.split("%")[0] + "%" }}></span></div><small>{progress}</small></td>
    </tr>
  );
}

function OrderContent({ name, qty, price }) {
  return (
    <div className="order-content"><PackageCheck size={18} /><div><strong>{name}</strong><p>Batch: #990-2A • {qty}</p></div><b>{price}</b></div>
  );
}

export default SalesRepOrderTracking;
