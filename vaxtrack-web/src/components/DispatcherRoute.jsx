import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { LOGIN_PATH, ROLES, resolveAccess } from "../services/authorization";

/** The Dispatcher area's gate. Mirrors AdminRoute exactly — same decision. */
function DispatcherRoute() {
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
          requiredRole: ROLES.DISPATCHER,
        });

        if (decision.allowed) {
          setState("allowed");
          return;
        }
        setRedirectTo(decision.redirectTo);
        setState("redirect");
      } catch {
        setRedirectTo(LOGIN_PATH);
        setState("redirect");
      }
    });

    return () => unsubscribe();
  }, []);

  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}

export default DispatcherRoute;
