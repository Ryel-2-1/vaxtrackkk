// Synthetic UI scenarios ONLY, in the fixed local demo emulator. Run the
// existing qa:motorcycle:seed first to create the local sign-in accounts.
// Usage: node scripts/seedStopProgressQa.mjs pending|proof|delivered|no-location
// Only the two stop-progress-qa-* orders and their own QA rider are replaced.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { MOTORCYCLE_QA_PROJECT } from "../src/services/motorcycleQaConfig.js";
import { ROUTE_PROVIDER, ROUTE_PROFILE } from "../src/services/routeMetadata.js";
const scenario = process.argv[2] ?? "pending";
if (!["pending", "proof", "delivered", "no-location"].includes(scenario)) throw new Error("Unknown local QA scenario.");
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8289";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const app = initializeApp({ projectId: MOTORCYCLE_QA_PROJECT });
const db = getFirestore(app);
try {
  const rider = "stop-progress-qa-rider";
  const now = Timestamp.now();
  const shape = JSON.parse(readFileSync(new URL("../../vaxtrack_mobile/test/fixtures/motorcycle_routes.json", import.meta.url), "utf8"))
    .routes.find((r) => r.name === "trip").polyline;
  const batch = db.batch();
  for (const [index, lat, lng] of [[1, 14.338, 121.087], [2, 14.313, 121.111]]) {
    const id = `stop-progress-qa-${index}`;
    const recorded = index === 1 && scenario !== "pending";
    batch.set(db.doc(`orders/${id}`), {
      orderNumber: `QA-PROGRESS-00${index}`, clinicName: `Progress sample clinic ${index}`,
      clinicAddress: "Synthetic QA destination", clinicLat: lat, clinicLng: lng,
      vaccineName: "QA vaccine", quantity: 1, unit: "vial", priority: "Standard",
      createdByUid: "motorcycle-qa-salesrep", assignedRiderId: rider, assignedRiderName: "QA progress rider",
      status: index === 1 && ["delivered", "no-location"].includes(scenario) ? "delivered" : "in_transit",
      tripId: "stop-progress-qa-trip", stopSequence: index, tripStopCount: 2,
      tripPolyline: shape, tripRouteProvider: ROUTE_PROVIDER, tripRouteProfile: ROUTE_PROFILE,
      tripDistanceMeters: 6664, tripDurationSeconds: 1547,
      stopEtaText: index === 1 ? "9:10 AM" : "9:26 AM",
      createdAt: now, assignedAt: now, updatedAt: now,
      ...(recorded ? {
        proofSubmittedAt: now, proofSubmittedByUid: rider,
        proofOfDeliveryPath: `proof_of_delivery/${id}/proof.jpg`,
        proofOfDeliveryUrl: "https://example.invalid/synthetic-proof.jpg",
        proofRecipientName: "QA recipient",
      } : {}),
    });
  }
  batch.set(db.doc(`riderLocations/${rider}`), scenario === "no-location"
    ? { trackingState: "ended", updatedAt: now }
    : { latitude: 14.338, longitude: 121.087, capturedAt: now, updatedAt: now, trackingState: "active", accuracyMeters: 10 });
  batch.set(db.doc(`riderDeviationStates/${rider}`), {
    sessionState: scenario === "no-location" ? "ended" : "navigating",
    orderId: scenario === "delivered" ? "stop-progress-qa-2" : "stop-progress-qa-1",
    routeStatus: "available", phase: "on_route", updatedAt: now,
  });
  await batch.commit();
  console.log(`Local stop-progress scenario ready: ${scenario}. No cloud writes or lifecycle callables were run.`);
} finally {
  await db.terminate();
  await deleteApp(app);
}
