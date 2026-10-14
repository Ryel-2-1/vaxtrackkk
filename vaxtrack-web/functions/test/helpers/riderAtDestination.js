"use strict";

/**
 * Test helper: put the Rider at the order's stored destination with a fresh,
 * accurate, active location — what the delivery geofence requires before a
 * completion (src/deliveryGeofence.js). `now` must match the completion's
 * clock. Orders without destination coordinates get no location, so the
 * geofence refusal for them stays observable.
 */
async function placeRiderAtDestination(db, Timestamp, { uid, orderId, now = new Date(), accuracyMeters = 8 }) {
  const order = (await db.collection("orders").doc(orderId).get()).data() ?? {};
  const lat = order.destinationLat ?? order.clinicLat;
  const lng = order.destinationLng ?? order.clinicLng;
  if (typeof lat !== "number" || typeof lng !== "number") return;
  const at = Timestamp.fromDate(now);
  await db.collection("riderLocations").doc(uid).set({
    riderUid: uid,
    trackingState: "active",
    latitude: lat,
    longitude: lng,
    accuracyMeters,
    capturedAt: at,
    updatedAt: at,
  });
}

/** A verified destination snapshot for hand-built (legacy-shaped) orders. */
const VERIFIED_DESTINATION = Object.freeze({
  destinationLat: 14.5995,
  destinationLng: 120.9842,
  destinationGeofenceRadiusM: 300,
  destinationLocationVerified: true,
});

module.exports = { placeRiderAtDestination, VERIFIED_DESTINATION };
