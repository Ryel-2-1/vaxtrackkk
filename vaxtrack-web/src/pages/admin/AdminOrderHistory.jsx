import { Link } from "react-router-dom";
import AdminLayout from "../../components/admin/AdminLayout";
import OrderHistoryView from "../../components/history/OrderHistoryView";

/**
 * Admin › Order History.
 *
 * HISTORICAL records for every Med Rep's orders: original Order Confirmation
 * Receipts and the Stock Allocation History ledger, resolved orders included.
 * The live, operational backorder queue stays on Stock Allocation — this page
 * neither replaces nor duplicates it.
 */
function AdminOrderHistory() {
  return (
    <AdminLayout
      description="Historical records: every accepted order with its original receipt and stock allocation history, including resolved orders."
      actions={
        <Link className="ohx-btn ohx-nav-link" to="/admin/allocation">
          Current backlog (Stock Allocation)
        </Link>
      }
    >
      <OrderHistoryView mode="admin" />
    </AdminLayout>
  );
}

export default AdminOrderHistory;
