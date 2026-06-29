import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

function AdminRoute() {
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
        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists()) {
          setRedirectTo("/login");
          setState("redirect");
          return;
        }

        const data = snap.data();
        const role = (data.role || "").toLowerCase().trim();
        const status = (data.status || "approved").toLowerCase().trim();

        if (status === "pending" || status === "pending_approval") {
          setRedirectTo("/pending");
          setState("redirect");
          return;
        }

        if (status === "rejected" || status === "disabled") {
          setRedirectTo("/login");
          setState("redirect");
          return;
        }

        if (role !== "admin") {
          if (role === "dispatcher") setRedirectTo("/dispatcher");
          else if (
            role === "salesrep" ||
            role === "sales_rep" ||
            role === "sales-rep" ||
            role === "sales representative"
          )
            setRedirectTo("/sales-rep");
          else setRedirectTo("/login");
          setState("redirect");
          return;
        }

        setState("allowed");
      } catch {
        setRedirectTo("/login");
        setState("redirect");
      }
    });

    return () => unsubscribe();
  }, []);

  if (state === "loading") return null;
  if (state === "redirect") return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}

export default AdminRoute;
