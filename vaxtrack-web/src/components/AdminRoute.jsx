import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { LOGIN_PATH, ROLES, resolveAccess } from "../services/authorization";

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
  const [state, setState] = useState("loading");
  const [redirectTo, setRedirectTo] = useState(LOGIN_PATH);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRedirectTo(LOGIN_PATH);
        setState("redirect");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const decision = resolveAccess({
          profile: snap.exists() ? snap.data() : null,
          requiredRole: ROLES.ADMIN,
        });

        if (decision.allowed) {
          setState("allowed");
          return;
        }
        setRedirectTo(decision.redirectTo);
        setState("redirect");
      } catch {
        // A failed profile read is not permission to continue.
        setRedirectTo(LOGIN_PATH);
        setState("redirect");
      }
    });

    return () => unsubscribe();
  }, []);

  // `null` while resolving: protected content must never paint before the
  // decision is known, not even for one frame.
  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}

export default AdminRoute;
