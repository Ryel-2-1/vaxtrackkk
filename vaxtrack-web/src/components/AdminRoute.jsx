import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../firebase";
import { ROLES } from "../services/authorization";
import { ACCESS_LOADING, watchRouteAccess } from "../services/liveRouteAccess";

/**
 * The Admin area's gate.
 *
 * The decision itself lives in services/authorization.js, shared with the other
 * two guards and with login, so the three areas cannot drift apart in what they
 * consider an acceptable account.
 *
 * Identity is the AUTH uid: the profile is read at `users/{user.uid}` and no
 * field inside the document is allowed to redirect that lookup.
 */
function AdminRoute() {
  const [access, setAccess] = useState(ACCESS_LOADING);
  const { state, redirectTo } = access;

  // The profile is WATCHED, not read once: a role or status change made while
  // this session is open re-runs the same decision immediately, and a redirect
  // unmounts the area (and every page listener under it). See
  // services/liveRouteAccess.js.
  useEffect(
    () =>
      watchRouteAccess({
        subscribeAuth: (callback) => onAuthStateChanged(auth, callback),
        subscribeProfile: (uid, onProfile, onError) =>
          onSnapshot(
            doc(db, "users", uid),
            (snap) => onProfile(snap.exists() ? snap.data() : null),
            onError
          ),
        requiredRole: ROLES.ADMIN,
        onChange: setAccess,
      }),
    []
  );

  // `null` while resolving: protected content must never paint before the
  // decision is known, not even for one frame.
  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}

export default AdminRoute;
