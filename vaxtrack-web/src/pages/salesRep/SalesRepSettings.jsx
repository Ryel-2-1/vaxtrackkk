import MyProfile from "../../components/profile/MyProfile";

/**
 * Sales Rep Settings — the shared "My profile" page (same as Admin and
 * Dispatcher). Name and phone are editable; email, role, status and
 * organization are read-only, managed by an administrator. The Employee ID
 * row is not shown here; the stored field and its other uses are unchanged.
 */
function SalesRepSettings() {
  return <MyProfile showEmployeeId={false} />;
}

export default SalesRepSettings;
