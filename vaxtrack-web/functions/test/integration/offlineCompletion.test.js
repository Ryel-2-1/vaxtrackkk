"use strict";

/**
 * Offline delivery completion against a REAL Firestore (emulator): the
 * Rider's offline record (auto-verified or sent for review), the Dispatcher's
 * approve / reject, and the server-owned trail. Run: npm run test:emulator.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-offline-completion" }, "offline-completion-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const ops = require("../../src/offlineCompletionOps");
const O = require("../../src/offlineCompletion");
const { ALLOCATION_VERSION } = require("../../src/policy");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");

const RIDER = "offRider";
const DISPATCHER = "offDispatcher";
const ORDER = "offOrder";
const CLINIC = { lat: 14.5995, lng: 120.9842 };
const RADIUS = 50;
const MIN = 60 * 1000;
const M_PER_DEG_LAT = 6371008.8 * (Math.PI / 180);
const north = (m) => ({ lat: CLINIC.lat + m / M_PER_DEG_LAT, lng: CLINIC.lng });
const NOW = new Date("2026-11-02T08:00:00.000Z");
const HANDOFF = NOW.getTime() - 40 * MIN;

const ref = (c, id) => db.collection(c).doc(id);
const get = async (c, id) => {
  const s = await ref(c, id).get();
  return s.exists ? s.data() : null;
};

async function wipe() {
  for (const c of ["users", "orders", "inventoryReservations", "inventory", "riderLocationTrails", "alerts", "inventoryAllocationEvents"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

/** In transit, fully reserved, both photos recorded; a trail ending 5 min before the handoff, 2 km out. */
async function world({ trail = [{ ...north(2000), accuracyM: 10, atMs: HANDOFF - 5 * MIN }] } = {}) {
  await wipe();
  await ref("users", RIDER).set({ role: "rider", status: "approved" });
  await ref("users", DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await ref("inventory", "inv1").set({ quantity: 10, reservedQuantity: 2, sellingPriceCentavos: 125000, expiryDate: "2099-12-31" });
  await ref("inventoryReservations", ORDER).set({ status: "reserved", items: [{ inventoryId: "inv1", quantity: 2 }] });
  await ref("orders", ORDER).set({
    orderNumber: "VT-ORD-OFF",
    status: "in_transit",
    assignedRiderId: RIDER,
    assignedRiderName: "Rider One",
    clinicName: "Terminal",
    createdByUid: "rep1",
    allocationVersion: ALLOCATION_VERSION,
    items: [{ inventoryId: "inv1", quantity: 2 }],
    destinationLat: CLINIC.lat,
    destinationLng: CLINIC.lng,
    destinationGeofenceRadiusM: RADIUS,
    destinationLocationVerified: true,
    dispatchedAt: Timestamp.fromMillis(NOW.getTime() - 120 * MIN),
    proofOfDeliveryUrl: `https://storage/${ORDER}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(ORDER),
    proofRecipientName: "Maria Santos", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
    invoiceUrl: `https://storage/${ORDER}/invoice.jpg`, invoicePath: canonicalInvoicePath(ORDER),
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
  });
  await ref("riderLocationTrails", RIDER).set({ riderUid: RIDER, points: trail });
}

const record = (over = {}) => ({
  orderId: ORDER,
  capture: { latitude: north(12).lat, longitude: north(12).lng, accuracyMeters: 8, capturedAtMs: HANDOFF, ...over },
});
const submit = (payload = record(), now = NOW) =>
  ops.submitOfflineDeliveryCompletion({ db, FieldValue, uid: RIDER, payload, now });
const resolve = (decision, note) =>
  ops.resolveOfflineCompletionReview({ db, FieldValue, uid: DISPATCHER, payload: { orderId: ORDER, decision, ...(note ? { note } : {}) }, now: NOW });

test("a verified offline record completes the delivery once, flagged offline", async () => {
  await world();
  const r = await submit();
  assert.deepEqual([r.status, r.consumed, r.completionMode], ["delivered", true, "offline"]);
  const order = await get("orders", ORDER);
  assert.equal(order.status, "delivered");
  assert.equal(order.completionMode, "offline");
  assert.equal(order.offlineEvidence.capturedAtMs, HANDOFF);
  assert.ok(order.offlineEvidence.distanceMeters <= RADIUS);
  assert.equal(order.statusUpdatedByUid, RIDER);
  assert.equal((await get("inventory", "inv1")).quantity, 8);
  assert.equal((await get("inventoryReservations", ORDER)).status, "consumed");
  assert.equal((await db.collection("alerts").get()).size, 0, "a verified record raises no alert of its own");

  const again = await submit();
  assert.equal(again.replayed, true, "a resent record never consumes twice");
  assert.equal((await get("inventory", "inv1")).quantity, 8);
});

test("an unverifiable record never completes: it waits for review with a Needs action alert", async () => {
  await world();
  const r = await submit(record(), new Date(HANDOFF + 3 * 60 * MIN + 1));
  assert.deepEqual([r.status, r.reason], ["needs_review", "too_old"]);
  const order = await get("orders", ORDER);
  assert.equal(order.status, "in_transit");
  assert.equal(order.offlineCompletionReview.status, "pending");
  assert.equal(order.offlineCompletionReview.reason, "too_old");
  assert.equal((await get("inventory", "inv1")).quantity, 10, "no stock consumed");
  const alert = await get("alerts", O.reviewAlertId(ORDER, HANDOFF));
  assert.equal(alert.type, O.ALERT_REVIEW);
  assert.equal(alert.status, "active");

  const again = await submit(record(), new Date(HANDOFF + 3 * 60 * MIN + 1));
  assert.equal(again.replayed, true);
});

test("outside the geofence, or off the tracked trail, also goes to review", async () => {
  await world();
  const outside = await submit(record({ latitude: north(80).lat }));
  assert.equal(outside.reason, "outside_geofence");
  await world({ trail: [{ ...north(40000), accuracyM: 10, atMs: HANDOFF - MIN }] });
  assert.equal((await submit()).reason, "implausible_track");
  await world({ trail: [] });
  assert.equal((await submit()).reason, "no_track");
});

test("approve completes it with the dispatcher's attribution and resolves the review", async () => {
  await world();
  await submit(record(), new Date(HANDOFF + 4 * 60 * MIN));
  const r = await resolve("approve");
  assert.equal(r.status, "delivered");
  const order = await get("orders", ORDER);
  assert.equal(order.status, "delivered");
  assert.equal(order.completionMode, "offline_approved");
  assert.equal(order.statusUpdatedByUid, DISPATCHER);
  assert.equal(order.offlineCompletionReview.status, "approved");
  assert.equal(order.offlineCompletionReview.decidedByUid, DISPATCHER);
  assert.equal((await get("inventory", "inv1")).quantity, 8);
  assert.equal((await get("alerts", O.reviewAlertId(ORDER, HANDOFF))).status, "resolved");
  await assert.rejects(resolve("approve"), { code: "no-pending-review" });
});

test("reject needs a reason and leaves the order in transit for the rider", async () => {
  await world();
  await submit(record(), new Date(HANDOFF + 4 * 60 * MIN));
  await assert.rejects(resolve("reject"), { code: "note-required" });
  const r = await resolve("reject", "Photo does not show the clinic");
  assert.equal(r.status, "in_transit");
  const order = await get("orders", ORDER);
  assert.equal(order.status, "in_transit");
  assert.equal(order.offlineCompletionReview.status, "rejected");
  assert.equal(order.offlineCompletionReview.decisionNote, "Photo does not show the clinic");
  assert.equal((await get("inventory", "inv1")).quantity, 10);
  assert.equal((await get("alerts", O.reviewAlertId(ORDER, HANDOFF))).status, "resolved");
});

test("only a rider may submit; only a dispatcher or admin may decide; reassigned orders are refused", async () => {
  await world();
  await assert.rejects(
    ops.submitOfflineDeliveryCompletion({ db, FieldValue, uid: DISPATCHER, payload: record(), now: NOW }),
    { code: "wrong-role" },
  );
  await submit(record(), new Date(HANDOFF + 4 * 60 * MIN));
  await assert.rejects(
    ops.resolveOfflineCompletionReview({ db, FieldValue, uid: RIDER, payload: { orderId: ORDER, decision: "approve" }, now: NOW }),
    { code: "wrong-role" },
  );
  await ref("orders", ORDER).update({ assignedRiderId: "someoneElse" });
  await assert.rejects(resolve("approve"), { code: "not-assigned-rider" });
  await world();
  await ref("orders", ORDER).update({ assignedRiderId: "someoneElse" });
  await assert.rejects(submit(), { code: "not-assigned-rider" });
});

test("the trail records promptly stored fixes only", async () => {
  await world({ trail: [] });
  const at = NOW.getTime();
  const loc = (capturedMs, updatedMs) => ({
    riderUid: RIDER, trackingState: "active", latitude: CLINIC.lat, longitude: CLINIC.lng, accuracyMeters: 10,
    capturedAt: Timestamp.fromMillis(capturedMs), updatedAt: Timestamp.fromMillis(updatedMs),
  });
  assert.equal((await ops.recordTrailPoint({ db, riderUid: RIDER, location: loc(at, at + 2000), nowMs: at })).recorded, true);
  assert.equal((await ops.recordTrailPoint({ db, riderUid: RIDER, location: loc(at + 5 * MIN, at + 30 * MIN), nowMs: at + 30 * MIN })).recorded, false,
    "queued offline and uploaded late");
  assert.equal((await get("riderLocationTrails", RIDER)).points.length, 1);
});
