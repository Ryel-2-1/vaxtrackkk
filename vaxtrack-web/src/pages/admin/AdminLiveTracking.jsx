import AdminLayout from "../../components/admin/AdminLayout";
import LiveTrackingPanel from "../../components/tracking/LiveTrackingPanel";

/** Admin › Live Tracking — every rider with an active delivery (read-only). */
function AdminLiveTracking() {
  return (
    <AdminLayout description="Where riders with an active delivery are now, and whether any has left the assigned route.">
      <LiveTrackingPanel />
    </AdminLayout>
  );
}

export default AdminLiveTracking;
