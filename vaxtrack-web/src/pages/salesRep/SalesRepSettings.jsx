import MyProfile from "../../components/profile/MyProfile";

/**
 * Sales Rep Settings — the shared "My profile" page (same as Admin and
 * Dispatcher). Name and phone are editable; email, role, status, employee ID
 * and organization are read-only, managed by an administrator.
 */
function SalesRepSettings() {
  return <MyProfile />;
}

export default SalesRepSettings;
