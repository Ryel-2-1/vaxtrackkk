import { useState } from "react";
import { createRoot } from "react-dom/client";
import OrderCancellationAction from "../../src/components/orders/OrderCancellationAction";
import "../../src/styles.css";
import "../../src/styles/tokens.css";
import "../../src/pages/admin/Inventory.css";
import "../../src/pages/admin/admin-foundation.css";
import "../../src/pages/salesRep/salesrep-polish.css";

window.cancellationQA = {
  identity: { uid: "rep", profile: { role: "salesrep", status: "approved" }, error: null },
  calls: [], refuse: false,
};
const initial = { id: "qa-document-id", orderNumber: "VT-ORD-QA-001", status: "pending_dispatch", createdByUid: "rep",
  allocationVersion: 2, allocationStatus: "reserved" };

function CancellationQA() {
  const [order, setOrder] = useState(initial);
  const [role, setRole] = useState("salesrep");
  const [, refresh] = useState(0);
  const qa = window.cancellationQA;
  qa.refresh = () => refresh((n) => n + 1);
  qa.cancelled = () => setOrder((o) => ({ ...o, status: "cancelled" }));
  return <div className={role === "admin" ? "inventory-page" : "salesrep-page"}>
    <main style={{ display: "block", width: "100%", padding: "24px", transform: "translateY(0)" }}>
      <h1>Cancellation component QA</h1>
      <p>Local fixture. Identity and server replies are simulated. No cloud connection.</p>
      <label>Identity <select aria-label="Identity" value={role} onChange={(e) => {
        setRole(e.target.value);
        qa.identity = { uid: e.target.value === "other" ? "another-rep" : "rep", profile: { role: e.target.value === "other" ? "salesrep" : e.target.value, status: "approved" }, error: null };
      }}><option value="salesrep">Owning Med Rep</option><option value="admin">Admin</option><option value="other">Other Med Rep</option><option value="rider">Rider</option></select></label>
      <label style={{ display: "block" }}><input type="checkbox" aria-label="Simulate server refusal" onChange={(e) => { qa.refuse = e.target.checked; }} /> Simulate server refusal</label>
      <button onClick={() => { qa.calls = []; setOrder(initial); refresh((n) => n + 1); }}>Reset fixture</button>
      <p data-testid="call-count">Cancellation calls: {qa.calls.length}</p>
      <p>Order status: {order.status}</p>
      <div style={{ height: "1100px" }}>Scroll down to the order action. Its ancestor is transformed.</div>
      <OrderCancellationAction key={`${role}-${order.id}`} order={order} scope={role === "admin" ? "inventory-page" : "salesrep-page"} />
      <button type="button">After order action</button>
    </main>
  </div>;
}
createRoot(document.getElementById("root")).render(<CancellationQA />);
