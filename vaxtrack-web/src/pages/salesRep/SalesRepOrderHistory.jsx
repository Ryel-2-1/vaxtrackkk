import { auth } from "../../firebase";
import OrderHistoryView from "../../components/history/OrderHistoryView";

/**
 * Med Rep › Order History.
 *
 * Every order this Med Rep placed — processing, reserved, in delivery,
 * delivered, cancelled or failed — with its original Order Confirmation
 * Receipt, the current fulfillment picture and the Stock Allocation Timeline.
 * Scoped to the signed-in uid; the Firestore rules allow nothing broader.
 * Rendered inside the persistent Sales Rep shell (content only).
 */
function SalesRepOrderHistory() {
  // `auth.currentUser` is synchronous here: the SalesRepRoute guard renders
  // this page only after sign-in has resolved.
  const uid = auth.currentUser?.uid ?? null;
  return (
    <section className="salesrep-order-history" aria-label="Order history">
      <OrderHistoryView mode="salesrep" medRepUid={uid} />
    </section>
  );
}

export default SalesRepOrderHistory;
