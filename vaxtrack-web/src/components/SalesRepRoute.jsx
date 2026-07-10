import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

const SALES_REP_ROLES = [
  "salesrep",
  "sales_rep",
  "sales-rep",
  "sales representative",
];

function SalesRepRoute() {
  const [state, setState] = useState("loading");
  const [redirectTo, setRedirectTo] = useState("/login");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setRedirectTo("/login");
        setState("redirect");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));

        if (!userSnap.exists()) {
          setRedirectTo("/login");
          setState("redirect");
          return;
        }

        const userData = userSnap.data();
        const role = String(userData.role || "").toLowerCase().trim();
        const status = String(
          userData.status || "approved"
        ).toLowerCase().trim();

        if (status === "pending" || status === "pending_approval") {
          setRedirectTo("/pending");
          setState("redirect");
          return;
        }

        if (status === "disabled" || status === "rejected") {
          setRedirectTo("/login");
          setState("redirect");
          return;
        }

        if (!SALES_REP_ROLES.includes(role)) {
          if (role === "admin") {
            setRedirectTo("/admin");
          } else if (role === "dispatcher") {
            setRedirectTo("/dispatcher");
          } else {
            setRedirectTo("/login");
          }

          setState("redirect");
          return;
        }

        setState("allowed");
      } catch (error) {
        console.error("Sales Representative route error:", error);
        setRedirectTo("/login");
        setState("redirect");
      }
    });

    return unsubscribe;
  }, []);

  if (state === "loading") {
    return <div>Loading account...</div>;
  }

  if (state === "redirect") {
    return <Navigate to={redirectTo} replace />;
  }

  return <Outlet />;
}

export default SalesRepRoute;