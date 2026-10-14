import {
  collection,
  doc,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { logSafeError } from "./liveDataErrors.js";
import { listenLive } from "./liveSnapshot.js";

// Route-deviation incidents are created by the RIDER app, not here. The Flutter
// `route_deviation_alert_service.dart` owns that write: it uses a deterministic
// document id per (order, rider) and a Firestore transaction so retries and app
// restarts cannot produce duplicate incidents, and `firestore.rules` constrains
// exactly which fields a rider may set on one.
//
// A `createRouteDeviationAlert()` helper used to live here with hardcoded
// fallback identities ("TRK-9824", "rider_001", "Juan Dela Cruz", "Quezon
// City") left over from the mock-data era. It had zero callers, and wiring it up
// would have written fabricated rider identities into live alerts alongside the
// real incidents. It was removed rather than re-pointed at real values.

const ALERTS_COLLECTION = "alerts";

// Both listeners take an optional `onError`. They used to have none, so a
// refused or failed listener was silent: Admin Alerts read it as "No alerts
// found", and the Dispatcher Dashboard — which waits for every source before
// leaving its loading state — stayed on the spinner for good.
function reportAlertsError(onError) {
  return (error) => {
    logSafeError("Alerts subscription", error);
    if (onError) onError(error);
  };
}

export function subscribeActiveAlerts(callback, onError) {
  const q = query(
    collection(db, ALERTS_COLLECTION),
    where("status", "==", "active")
  );

  return listenLive(q, (snapshot) => {
    // Document id LAST so it always wins — see subscribeAllAlerts below.
    const alerts = snapshot.docs.map((docItem) => ({
      ...docItem.data(),
      id: docItem.id,
    }));

    callback(alerts);
  }, reportAlertsError(onError));
}

export function subscribeAllAlerts(callback, onError) {
  const q = query(
    collection(db, ALERTS_COLLECTION),
    orderBy("createdAt", "desc")
  );

  return listenLive(q, (snapshot) => {
    // Document id LAST so it always wins.
    //
    // This was `{ id: d.id, ...d.data() }`, which let a stored `id` field
    // shadow the real document id. Admin Alerts writes with that value —
    // `resolveAlert(selectedAlert.id)` and `markAlertRead(alert.id)` — and
    // keys its rows by it. A rider CAN reach this: the alerts rule lets a
    // rider create its own route_deviation incident and constrains type,
    // riderId, severity, status and the timestamps, but not extra fields, so
    // an `id` could travel in and re-aim an admin's Resolve at someone else's
    // critical alert.
    callback(snapshot.docs.map((d) => ({ ...d.data(), id: d.id })));
  }, reportAlertsError(onError));
}

export async function resolveAlert(alertId) {
  return updateDoc(doc(db, ALERTS_COLLECTION, alertId), {
    status: "resolved",
  });
}

export async function markAlertRead(alertId) {
  return updateDoc(doc(db, ALERTS_COLLECTION, alertId), {
    read: true,
  });
}