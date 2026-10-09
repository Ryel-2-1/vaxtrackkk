"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestOrderDestinationChange, reviewOrderDestinationChange } =
  require("../src/destinationOperations");
const { buildOrderDestinationSnapshot } = require("../src/policy");

const doctor = { name: "Dr. Ana Reyes", active: true };
const area = { name: "Manila", active: true };
const home = {
  kind: "home", active: true, addressLine: "25 Rizal Avenue, Manila",
  areaId: "area1", area: "Manila", latitude: 14.6, longitude: 120.98,
  geofenceRadiusM: 250,
};
const clinic = {
  clinicId: "C-1", name: "Staging Clinic", location: "10 Mabini Street, Manila",
  areaId: "area1", area: "Manila", latitude: 14.5, longitude: 120.9,
  locationVerified: true, geofenceRadiusM: 300,
};
const original = buildOrderDestinationSnapshot({
  doctorId: "doctor1", doctorAddressId: "clinic1", doctor,
  relationship: { active: true }, clinic, area,
}).orderFields;

function fixture(orderChanges = {}, documentChanges = {}) {
  const docs = new Map(Object.entries({
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/rep_owner": { role: "salesrep", status: "approved" },
    "users/rep_other": { role: "salesrep", status: "approved" },
    "doctors/doctor1": doctor,
    "doctors/doctor1/deliveryAddresses/home": home,
    "doctors/doctor1/deliveryAddresses/clinic1": { active: true },
    "clinics/clinic1": clinic,
    "areas/area1": area,
    "orders/order1": {
      ...original, status: "assigned", createdByUid: "rep_owner",
      clinicLocationSnapshotAt: "old-time", destinationSnapshotAt: "old-time",
      routePolyline: "old-route", routeGeneratedAt: "old-time",
      routeEtaText: "old eta", routeDistanceMeters: 100,
      routeDurationSeconds: 10, routeProvider: "openrouteservice",
      routeDestinationRevision: 0, ...orderChanges,
    },
    ...documentChanges,
  }));
  const deleted = Symbol("delete");
  const stamp = Symbol("server-time");
  let nextId = 1;
  class Ref {
    constructor(path) { this.path = path; this.id = path.split("/").at(-1); }
    collection(name) { return new Collection(`${this.path}/${name}`); }
    async get() {
      const data = docs.get(this.path);
      return { exists: !!data, data: () => data };
    }
  }
  class Collection {
    constructor(path) { this.path = path; }
    doc(id) { return new Ref(`${this.path}/${id || `generated-${nextId++}`}`); }
  }
  const db = {
    collection: (name) => new Collection(name),
    async runTransaction(work) {
      const writes = [];
      const tx = {
        async get(ref) { return ref.get(); },
        create(ref, data) { writes.push({ type: "create", ref, data }); },
        update(ref, data) { writes.push({ type: "update", ref, data }); },
      };
      const result = await work(tx);
      for (const { type, ref, data } of writes) {
        if (type === "create" && docs.has(ref.path)) throw Error("duplicate event");
        const updated = type === "update" ? { ...docs.get(ref.path) } : {};
        for (const [key, value] of Object.entries(data)) {
          if (value === deleted) delete updated[key];
          else updated[key] = value;
        }
        docs.set(ref.path, updated);
      }
      return result;
    },
  };
  const FieldValue = { serverTimestamp: () => stamp, delete: () => deleted };
  const request = (over = {}, uid = "dispatcher") => requestOrderDestinationChange({
    db, FieldValue, uid,
    payload: {
      orderId: "order1", doctorAddressId: "home",
      reason: "Doctor requested home delivery", expectedRevision: 0,
      ...over,
    },
  });
  const review = (decision, requestId, uid = "rep_owner") => reviewOrderDestinationChange({
    db, FieldValue, uid,
    payload: { orderId: "order1", requestId, decision },
  });
  return { docs, request, review, stamp };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

test("Dispatcher request keeps the real address and route until the owning Med Rep approves", async () => {
  const { docs, request, review, stamp } = fixture();
  const proposed = await request();
  const pending = docs.get("orders/order1");
  const requestDoc = docs.get(`orders/order1/destinationChangeRequests/${proposed.requestId}`);
  assert.equal(proposed.status, "pending");
  assert.equal(pending.doctorAddressId, "clinic1");
  assert.equal(pending.destinationRevision, undefined);
  assert.equal(pending.routePolyline, "old-route");
  assert.equal(pending.destinationChangeRequest.proposed.doctorAddressId, "home");
  assert.equal(requestDoc.status, "pending");
  assert.equal(docs.has("orders/order1/destinationCorrections/revision-1"), false);

  const decision = await review("approve", proposed.requestId);
  const approved = docs.get("orders/order1");
  const audit = docs.get("orders/order1/destinationCorrections/revision-1");
  assert.equal(decision.status, "approved");
  assert.equal(approved.doctorId, "doctor1");
  assert.equal(approved.doctorAddressId, "home");
  assert.equal(approved.clinicDocId, null);
  assert.equal(Object.hasOwn(approved, "clinicId"), false);
  assert.equal(approved.clinicLat, home.latitude);
  assert.equal(approved.destinationRevision, 1);
  assert.equal(approved.destinationSnapshotAt, stamp);
  assert.equal(Object.hasOwn(approved, "destinationChangeRequest"), false);
  for (const field of ["routePolyline", "routeGeneratedAt", "routeEtaText", "routeProvider", "routeDestinationRevision"]) {
    assert.equal(Object.hasOwn(approved, field), false, field);
  }
  assert.equal(docs.get(`orders/order1/destinationChangeRequests/${proposed.requestId}`).status, "approved");
  assert.equal(audit.previous.clinicId, clinic.clinicId);
  assert.equal(audit.current.doctorAddressId, "home");
  assert.equal(audit.requestedByUid, "dispatcher");
  assert.equal(audit.approvedByUid, "rep_owner");
  assert.equal(audit.reason, "Doctor requested home delivery");
  assert.equal((await review("approve", proposed.requestId)).replayed, true);
});

test("rejection retains the original address, route and revision; it clears the pending request", async () => {
  const { docs, request, review } = fixture();
  const proposed = await request();
  const decision = await review("reject", proposed.requestId);
  const order = docs.get("orders/order1");
  assert.equal(decision.status, "rejected");
  assert.equal(order.doctorAddressId, "clinic1");
  assert.equal(order.routePolyline, "old-route");
  assert.equal(order.destinationRevision, undefined);
  assert.equal(Object.hasOwn(order, "destinationChangeRequest"), false);
  assert.equal(docs.has("orders/order1/destinationCorrections/revision-1"), false);
  assert.equal(docs.get(`orders/order1/destinationChangeRequests/${proposed.requestId}`).status, "rejected");
  assert.equal((await review("reject", proposed.requestId)).replayed, true);
  assert.equal((await request()).status, "pending", "Dispatcher may request again after rejection");
});

test("only an approved Dispatcher can request and only the order's Med Rep can decide", async () => {
  await rejects(fixture().request({}, "rep_owner"), "wrong-role");
  await rejects(fixture({}, { "users/dispatcher": { role: "dispatcher", status: "pending" } }).request(), "not-approved");
  await rejects(fixture({ createdByUid: null }).request(), "order-owner-missing");
  await rejects(fixture({}, { "users/rep_owner": { role: "salesrep", status: "disabled" } }).request(), "order-owner-missing");
  const { docs, request, review } = fixture();
  const proposed = await request();
  await rejects(review("approve", proposed.requestId, "dispatcher"), "wrong-role");
  await rejects(review("approve", proposed.requestId, "rep_other"), "not-order-owner");
  assert.equal(docs.get("orders/order1").doctorAddressId, "clinic1");
  assert.equal(docs.get(`orders/order1/destinationChangeRequests/${proposed.requestId}`).status, "pending");
});

test("a second request and invalid decisions cannot silently change the order", async () => {
  const { docs, request, review } = fixture();
  const proposed = await request();
  await rejects(request(), "destination-request-pending");
  await rejects(review("maybe", proposed.requestId), "invalid-decision");
  await rejects(request({ doctorId: "doctor2" }), "unknown-field");
  assert.equal(docs.get("orders/order1").doctorAddressId, "clinic1");
  assert.equal(docs.get("orders/order1").destinationChangeRequest.id, proposed.requestId);
});

test("approval fails if status, invoice, or proposed address changed; rejection still works", async () => {
  const scenarios = [
    [(docs) => docs.set("orders/order1", { ...docs.get("orders/order1"), status: "in_transit" }), "invalid-status-transition"],
    [(docs) => docs.set("invoices/order1", { invoiceStatus: "issued" }), "invoice-already-issued"],
    [(docs) => docs.set("doctors/doctor1/deliveryAddresses/home", { ...home, addressLine: "40 Changed Avenue" }), "destination-request-stale"],
  ];
  for (const [change, code] of scenarios) {
    const { docs, request, review } = fixture();
    const proposed = await request();
    change(docs);
    await rejects(review("approve", proposed.requestId), code);
    assert.equal(docs.get("orders/order1").doctorAddressId, "clinic1");
    assert.equal(docs.get("orders/order1").routePolyline, "old-route");
    assert.equal(docs.get(`orders/order1/destinationChangeRequests/${proposed.requestId}`).status, "pending");
    await review("reject", proposed.requestId);
    assert.equal(Object.hasOwn(docs.get("orders/order1"), "destinationChangeRequest"), false);
  }
});

test("request validation rejects stale revisions and inactive links without writing", async () => {
  const cases = [
    [fixture({ destinationRevision: 2 }), "destination-changed"],
    [fixture({}, { "doctors/doctor1/deliveryAddresses/home": { ...home, active: false } }), "destination-inactive"],
    [fixture({}, { "doctors/doctor1/deliveryAddresses/home": undefined }), "destination-not-found"],
    [fixture({}, { "invoices/order1": { invoiceStatus: "issued" } }), "invoice-already-issued"],
  ];
  for (const [{ docs, request }, code] of cases) {
    await rejects(request(), code);
    assert.equal(docs.get("orders/order1").destinationChangeRequest, undefined);
  }
  for (const status of ["in_transit", "delayed", "delivered", "cancelled", "unknown"]) {
    await rejects(fixture({ status }).request(), "invalid-status-transition");
  }
  await rejects(fixture().request({ doctorAddressId: "clinic1" }), "destination-unchanged");
  await rejects(fixture().request({ reason: " " }), "reason-required");
});
