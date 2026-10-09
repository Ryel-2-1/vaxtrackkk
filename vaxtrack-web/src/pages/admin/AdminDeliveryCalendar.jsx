import AdminLayout from "../../components/admin/AdminLayout";
import DeliveryCalendar from "../../components/schedule/DeliveryCalendar";

/**
 * Admin view of the shared Delivery Calendar. Same month view and filters as
 * the Dispatcher, plus Med Rep names (from the user directory only an Admin
 * may read) and the "Change date & time" control, which calls the
 * rescheduleOrderDelivery callable — the only path that may move a schedule.
 */
function AdminDeliveryCalendar() {
  return (
    <AdminLayout>
      <DeliveryCalendar role="admin" />
    </AdminLayout>
  );
}

export default AdminDeliveryCalendar;
