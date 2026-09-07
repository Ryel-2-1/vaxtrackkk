import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { LOGIN_PATH, ROLES, resolveAccess } from "../services/authorization";

/** The Sales Rep area's gate. Mirrors AdminRoute exactly — same decision. */
function SalesRepRoute() {
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
        const userSnap = await getDoc(doc(db, "users", user.uid));
        const decision = resolveAccess({
          profile: userSnap.exists() ? userSnap.data() : null,
          requiredRole: ROLES.SALES_REP,
        });

        if (decision.allowed) {
          setState("allowed");
          return;
        }
        setRedirectTo(decision.redirectTo);
        setState("redirect");
      } catch (error) {
        console.error("Sales Representative route error:", error);
        setRedirectTo(LOGIN_PATH);
        setState("redirect");
      }
    });

    return () => unsubscribe();
  }, []);

  // Was a visible "Loading account..." string, which is a layout shift on every
  // navigation and told the user nothing. `null` matches the other two guards
  // and keeps protected content from painting before the decision resolves.
  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}

export default SalesRepRoute;
