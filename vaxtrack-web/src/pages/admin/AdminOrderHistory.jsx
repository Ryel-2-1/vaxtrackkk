import AdminLayout from "../../components/admin/AdminLayout";
import OrderHistoryView from "../../components/history/OrderHistoryView";

/**
 * Admin › Order History.
 *
 * HISTORICAL records for every Med Rep's orders: original Order Confirmation
 * Receipts and the Stock Allocation History ledger, resolved orders included.
 * The live, operational backorder queue stays on Stock Allocation (sidebar) —
 * this page neither replaces nor duplicates it. Laid out like the Med Rep's
 * Order History (2026-10-31): one filter row, one fixed table, one pager.
 */
function AdminOrderHistory() {
  return (
    <AdminLayout>
      <OrderHistoryView mode="admin" />
    </AdminLayout>
  );
}

export default AdminOrderHistory;
