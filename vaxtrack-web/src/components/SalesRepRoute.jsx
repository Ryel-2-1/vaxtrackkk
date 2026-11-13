import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../firebase";
import { ROLES } from "../services/authorization";
import { ACCESS_LOADING, watchRouteAccess } from "../services/liveRouteAccess";
import TermsGate from "./terms/TermsGate";

/** The Sales Rep area's gate. Mirrors AdminRoute exactly — same decision. */
function SalesRepRoute() {
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
        requiredRole: ROLES.SALES_REP,
        onChange: setAccess,
      }),
    []
  );

  // Was a visible "Loading account..." string, which is a layout shift on every
  // navigation and told the user nothing. `null` matches the other two guards
  // and keeps protected content from painting before the decision resolves.
  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  // One-time Terms of Use and Data Privacy agreement (TermsGate.jsx).
  return <TermsGate><Outlet /></TermsGate>;
}

export default SalesRepRoute;
