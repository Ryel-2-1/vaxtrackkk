import MyProfile from "../../components/profile/MyProfile";

/**
 * Dispatcher Settings — the shared "My profile" page (same as Admin and Sales
 * Rep).
 *
 * This page used to be entirely local: a hardcoded "Dispatcher User" profile
 * that every dispatcher saw, an editable Role field, an invented "Assigned
 * Hub", and four preference toggles — all "saved" only to localStorage, which
 * nothing ever read back. None of it reached the user's account, and the
 * toggles controlled nothing (alerts are always on; see Admin → Settings →
 * General). It now reads and writes the dispatcher's own users/{uid} record,
 * and role is read-only like everywhere else.
 */
function DispatcherSettings() {
  return <MyProfile />;
}

export default DispatcherSettings;
