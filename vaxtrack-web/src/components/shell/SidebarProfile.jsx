import useOwnProfile from "../profile/useOwnProfile";
import { initialsOf, readProfile } from "../../services/profileModel";

/**
 * The signed-in user's card in every role's sidebar — one component, so the
 * Admin, Sales Rep and Dispatcher rails show the same thing the same way.
 * Live: a name saved in "My profile" appears here at once.
 */
export default function SidebarProfile({ fallbackRole }) {
  const { profile } = useOwnProfile();
  const me = readProfile(profile);
  return (
    <div className="m-profile">
      <div className="m-profile-avatar" aria-hidden="true">
        {initialsOf(me.name)}
      </div>
      <div className="m-profile-text">
        <strong>{me.name || fallbackRole}</strong>
        <span>{me.roleLabel === "—" ? fallbackRole : me.roleLabel}</span>
      </div>
    </div>
  );
}
