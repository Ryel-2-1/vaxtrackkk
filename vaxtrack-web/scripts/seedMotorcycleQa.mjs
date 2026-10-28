// Local, synthetic route fixtures only. Explicit emulator hosts and demo ID
// mean an inherited GCLOUD_PROJECT or credentials file can never select cloud.
import { createRequire } from "node:module";
import { MOTORCYCLE_QA_PROJECT } from "../src/services/motorcycleQaConfig.js";
import { ROUTING_DEFAULTS, SUGGESTED_HUB } from "../src/services/routingSettings.js";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8289";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9097";
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, GeoPoint, Timestamp } = require("firebase-admin/firestore");
const app = initializeApp({ projectId: MOTORCYCLE_QA_PROJECT });
const db = getFirestore(app);
const auth = getAuth(app);
const password = "MotorcycleQA2026!";
try {
  for (const role of ["dispatcher", "admin", "salesrep", "rider"]) {
    const uid = `motorcycle-qa-${role}`;
    const email = `${role}@motorcycle.test`;
    try { await auth.createUser({ uid, email, password, emailVerified: true }); }
    catch (error) { if (error.code !== "auth/uid-already-exists") throw error; }
    await db.doc(`users/${uid}`).set({
      uid, email, role, status: "approved", name: `QA ${role}`,
      fullName: `QA ${role}`, firstName: "QA", lastName: role,
    }, { merge: true });
  }
  const now = Timestamp.now();
  const rider = "motorcycle-qa-rider";
  await db.doc(`riderLocations/${rider}`).set({
    riderUid: rider, latitude: 14.329, longitude: 121.081,
    accuracyM: 10, capturedAt: now, updatedAt: now, trackingState: "active",
  });
  await db.doc(`riderLocationViewers/${rider}`).set({
    viewerUids: ["motorcycle-qa-salesrep"], updatedAt: now,
  });
  for (const [index, lat, lng] of [[1, 14.338, 121.087], [2, 14.313, 121.111]]) {
    const ref = db.doc(`orders/motorcycle-qa-${index}`);
    if (!(await ref.get()).exists) await ref.set({
      orderNumber: `QA-MOTO-00${index}`, clinicName: `Sample clinic ${index}`,
      clinicAddress: "Synthetic test destination, Laguna", clinicLat: lat, clinicLng: lng,
      doctorName: "Sample doctor", destinationName: `Sample clinic ${index}`,
      vaccineName: "Sample vaccine", quantity: 1, unit: "vial", priority: "Standard",
      items: [{ vaccineId: "qa-vaccine", vaccineName: "Sample vaccine", quantity: 1, unit: "vial" }],
      status: "assigned", assignedRiderId: rider, assignedRiderName: "QA rider",
      createdByUid: "motorcycle-qa-salesrep", createdByEmail: "salesrep@motorcycle.test",
      destinationRevision: 0, createdAt: now, assignedAt: now, updatedAt: now,
      lastLocation: new GeoPoint(14.329, 121.081),
    });
  }

  // Departure planning (Cargo Loading): the hub, and requested arrivals set
  // relative to NOW so the scenario is always live. Stop 2 must be reached
  // first — before now + 45 min — even though stop 1 is the shorter ride
  // from the hub; stop 1 asks for a window an hour and a half out.
  await db.doc("operationsSettings/routing").set({
    hubName: SUGGESTED_HUB.name, hubLatitude: SUGGESTED_HUB.latitude, hubLongitude: SUGGESTED_HUB.longitude,
    serviceMinutes: ROUTING_DEFAULTS.serviceMinutes, trafficBufferPercent: ROUTING_DEFAULTS.trafficBufferPercent,
    longWaitMinutes: ROUTING_DEFAULTS.longWaitMinutes, updatedAt: now, updatedByUid: "motorcycle-qa-admin",
  });
  const manila = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type) => manila.find((p) => p.type === type).value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const nowMinute = Number(part("hour")) * 60 + Number(part("minute"));
  const clockAt = (minute) => {
    const m = Math.min(minute, 23 * 60 + 59);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  await db.doc("orders/motorcycle-qa-1").update({
    requestedDeliveryDate: today,
    requestedArrival: { version: 1, mode: "window", start: clockAt(nowMinute + 90), end: clockAt(nowMinute + 120) },
  });
  await db.doc("orders/motorcycle-qa-2").update({
    requestedDeliveryDate: today,
    requestedArrival: { version: 1, mode: "before", time: clockAt(nowMinute + 45) },
  });
  console.log("Local motorcycle QA fixtures ready (demo-vaxtrack-motorcycle).");
  console.log("Portal accounts: dispatcher@motorcycle.test, admin@motorcycle.test, salesrep@motorcycle.test");
  console.log(`Local test password: ${password}`);
} finally {
  await db.terminate();
  await deleteApp(app);
}
