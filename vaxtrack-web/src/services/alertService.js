import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const ALERTS_COLLECTION = "alerts";

export async function createRouteDeviationAlert(alertData = {}) {
  return addDoc(collection(db, ALERTS_COLLECTION), {
    type: "route_deviation",
    title: "Route Deviation Detected",
    message:
      alertData.message ||
      "Rider moved outside the assigned delivery route/geofence.",
    orderId: alertData.orderId || null,
    deliveryId: alertData.deliveryId || "TRK-9824",
    riderId: alertData.riderId || "rider_001",
    riderName: alertData.riderName || "Juan Dela Cruz",
    location: alertData.location || "Quezon City",
    severity: "critical",
    status: "active",
    createdAt: serverTimestamp(),
  });
}

export function subscribeActiveAlerts(callback) {
  const q = query(
    collection(db, ALERTS_COLLECTION),
    where("status", "==", "active")
  );

  return onSnapshot(q, (snapshot) => {
    const alerts = snapshot.docs.map((docItem) => ({
      id: docItem.id,
      ...docItem.data(),
    }));

    callback(alerts);
  });
}