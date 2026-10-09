"use strict";

/** Real Firestore transaction coverage for the two-person destination change. */
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { buildOrderDestinationSnapshot } = require("../../src/policy");
const { requestOrderDestinationChange, reviewOrderDestinationChange } =
  require("../../src/destinationOperations");

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
admin.initializeApp({ projectId: "demo-vaxtrack-destination" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const DISPATCHER = "destination-dispatcher";
const OWNER = "destination-rep-owner";
const OTHER = "destination-rep-other";
const DOCTOR = "destination-doctor";
const CLINIC = "destination-clinic";
const AREA = "destination-area";

async function seed(orderId) {
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(OWNER).set({ role: "salesrep", status: "approved" });
  await db.collection("users").doc(OTHER).set({ role: "salesrep", status: "approved" });
  await db.collection("areas").doc(AREA).set({ name: "Manila", active: true });
  const clinic = {
    clinicId: "CL-DEST", name: "Destination Clinic",
    location: "10 Mabini Street, Manila", areaId: AREA, area: "Manila",
    latitude: 14.5, longitude: 120.9, geofenceRadiusM: 300,
    locationVerified: true,
  };
  const doctor = { name: "Dr. Ana Reyes", active: true };
  await db.collection("clinics").doc(CLINIC).set(clinic);
  const doctorRef = db.collection("doctors").doc(DOCTOR);
  await doctorRef.set(doctor);
  await doctorRef.collection("deliveryAddresses").doc(CLINIC).set({ active: true });
  await doctorRef.collection("deliveryAddresses").doc("home").set({
    active: true, kind: "home", addressLine: "25 Rizal Avenue, Manila",
    areaId: AREA, area: "Manila", latitude: 14.6, longitude: 120.98,
    geofenceRadiusM: 250,
  });
  const original = buildOrderDestinationSnapshot({
    doctorId: DOCTOR, doctorAddressId: CLINIC, doctor,
    relationship: { active: true }, clinic, area: { name: "Manila", active: true },
  });
  await db.collection("orders").doc(orderId).set({
    ...original.orderFields, createdByUid: OWNER, status: "assigned",
    destinationSnapshotAt: FieldValue.serverTimestamp(),
    clinicLocationSnapshotAt: FieldValue.serverTimestamp(),
    routePolyline: "old-route", routeProvider: "openrouteservice",
    routeDestinationRevision: 0,
  });
}

const request = (orderId, uid = DISPATCHER) => requestOrderDestinationChange({
  db, FieldValue, uid,
  payload: {
    orderId, doctorAddressId: "home", expectedRevision: 0,
    reason: "Doctor confirmed home delivery",
  },
});
const review = (orderId, requestId, decision, uid = OWNER) => reviewOrderDestinationChange({
  db, FieldValue, uid, payload: { orderId, requestId, decision },
});
const orderData = async (orderId) => (await db.collection("orders").doc(orderId).get()).data();

test("request leaves the destination intact; owner approval updates address, route and audit atomically", async () => {
  const id = "destination-approval";
  await seed(id);
  const created = await request(id);
  const before = await orderData(id);
  assert.equal(before.doctorAddressId, CLINIC);
  assert.equal(before.routePolyline, "old-route");
  assert.equal(before.destinationChangeRequest.id, created.requestId);
  assert.equal((await db.collection("orders").doc(id).collection("destinationCorrections").get()).size, 0);
  await assert.rejects(review(id, created.requestId, "approve", OTHER), (error) => error.code === "not-order-owner");

  const approved = await review(id, created.requestId, "approve");
  const after = await orderData(id);
  assert.equal(approved.revision, 1);
  assert.equal(after.doctorAddressId, "home");
  assert.equal(after.destinationRevision, 1);
  assert.equal(after.clinicDocId, null);
  assert.equal("clinicId" in after, false);
  assert.equal("routePolyline" in after, false);
  assert.equal("destinationChangeRequest" in after, false);
  assert.equal((await db.collection("orders").doc(id).collection("destinationChangeRequests").doc(created.requestId).get()).data().status, "approved");
  const audit = (await db.collection("orders").doc(id).collection("destinationCorrections").doc("revision-1").get()).data();
  assert.equal(audit.requestedByUid, DISPATCHER);
  assert.equal(audit.approvedByUid, OWNER);
  assert.equal(audit.previous.doctorAddressId, CLINIC);
  assert.equal(audit.current.doctorAddressId, "home");
  assert.equal((await review(id, created.requestId, "approve")).replayed, true);
});

test("rejection closes a request without changing the destination or route", async () => {
  const id = "destination-rejection";
  await seed(id);
  const created = await request(id);
  const decision = await review(id, created.requestId, "reject");
  const after = await orderData(id);
  assert.equal(decision.status, "rejected");
  assert.equal(after.doctorAddressId, CLINIC);
  assert.equal(after.routePolyline, "old-route");
  assert.equal("destinationRevision" in after, false);
  assert.equal("destinationChangeRequest" in after, false);
  assert.equal((await db.collection("orders").doc(id).collection("destinationCorrections").get()).size, 0);
});

test("moving into transit before approval refuses the write; the owner may reject", async () => {
  const id = "destination-in-transit";
  await seed(id);
  const created = await request(id);
  await db.collection("orders").doc(id).update({ status: "in_transit" });
  await assert.rejects(review(id, created.requestId, "approve"), (error) => error.code === "invalid-status-transition");
  assert.equal((await orderData(id)).doctorAddressId, CLINIC);
  assert.equal((await review(id, created.requestId, "reject")).status, "rejected");
});

test("two concurrent Dispatcher requests leave exactly one pending record", async () => {
  const id = "destination-request-race";
  await seed(id);
  const outcomes = await Promise.allSettled([request(id), request(id)]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected" && item.reason.code === "destination-request-pending").length, 1);
  const order = await orderData(id);
  assert.equal(order.doctorAddressId, CLINIC);
  assert.equal((await db.collection("orders").doc(id).collection("destinationChangeRequests").get()).size, 1);
});
