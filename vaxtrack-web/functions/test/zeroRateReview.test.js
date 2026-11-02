"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { requestZeroRateApproval, reviewZeroRateApproval } = require("../src/zeroRateRequests");

function harness(role, status = "pending") {
  const writes = [];
  const records = new Map([
    ["users/admin1", { role, status: "approved" }],
    ["zeroRateRequests/request1", { requesterUid: "rep1", status }],
  ]);
  const db = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (fn) => fn({
      get: async (ref) => ({ exists: records.has(ref.path), data: () => records.get(ref.path) }),
      update: (ref, fields) => writes.push({ path: ref.path, fields }),
    }),
  };
  return { db, writes };
}

test("only an approved Admin can accept or deny a pending request", async () => {
  const payload = { requestId: "request1", decision: "approved" };
  const FieldValue = { serverTimestamp: () => "server-time" };
  const admin = harness("admin");
  assert.deepEqual(await reviewZeroRateApproval({ db: admin.db, FieldValue, uid: "admin1", payload }),
    { requestId: "request1", status: "approved" });
  assert.deepEqual(admin.writes, [{ path: "zeroRateRequests/request1", fields: {
    status: "approved", reviewedByUid: "admin1", reviewedAt: "server-time",
  } }]);
  const deniedRequest = harness("admin");
  assert.deepEqual(await reviewZeroRateApproval({ db: deniedRequest.db, FieldValue, uid: "admin1",
    payload: { requestId: "request1", decision: "rejected" } }), { requestId: "request1", status: "rejected" });
  assert.equal(deniedRequest.writes[0].fields.status, "rejected");
  for (const [role, status] of [["salesrep", "pending"], ["admin", "approved"], ["admin", "used"]]) {
    const denied = harness(role, status);
    await assert.rejects(reviewZeroRateApproval({ db: denied.db, FieldValue, uid: "admin1", payload }));
    assert.equal(denied.writes.length, 0);
  }
});

test("a Med Rep can request review only for a linked destination in their territory", async () => {
  const records = new Map([
    ["users/rep1", { role: "salesrep", status: "approved", name: "Rep One", assignedAreaIds: ["area1"], assignedClinicIds: ["clinic1"] }],
    ["doctors/doctor1", { name: "Dr Ana", active: true }],
    ["doctors/doctor1/deliveryAddresses/clinic1", { active: true }],
    ["clinics/clinic1", { name: "Health Clinic", location: "10 Mabini Street", areaId: "area1", area: "Manila",
      locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300 }],
    ["areas/area1", { name: "Manila", active: true }],
    ["inventory/batch1", { vaccineId: "vaccine1", vaccineName: "Vaccine A", batchId: "LOT-1" }],
    ["vaccines/vaccine1", { vatClassification: "vatable" }],
  ]);
  const created = [];
  const ref = (path) => ({ path, id: path.split("/").at(-1), collection: (name) => ({
    path: `${path}/${name}`, doc: (id) => ref(`${path}/${name}/${id}`),
  }) });
  const db = {
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => fn({
      get: async (target) => target.path.endsWith("/deliveryAddresses")
        ? { docs: [{ id: "clinic1", data: () => records.get("doctors/doctor1/deliveryAddresses/clinic1") }] }
        : { exists: records.has(target.path), data: () => records.get(target.path) },
      create: (target, data) => created.push({ target, data }),
    }),
  };
  let next = 0;
  const originalCollection = db.collection;
  db.collection = (name) => name === "zeroRateRequests"
    ? { doc: (id) => ref(`${name}/${id ?? `request${++next}`}`) }
    : originalCollection(name);
  const FieldValue = { serverTimestamp: () => "server-time" };
  const payload = { doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: "2026-11-10",
    items: [{ inventoryId: "batch1", quantity: 2 }], reason: "Destination may qualify" };
  const now = new Date("2026-11-02T02:00:00Z");
  assert.deepEqual(await requestZeroRateApproval({ db, FieldValue, uid: "rep1", payload, now }),
    { requestId: "request1", status: "pending" });
  assert.equal(created[0].data.requesterUid, "rep1");
  assert.equal(created[0].data.status, "pending");
  assert.equal(created[0].data.reason, payload.reason);
  assert.equal(Object.hasOwn(created[0].data, "evidenceReference"), false);
  assert.deepEqual(created[0].data.items, [{ inventoryId: "batch1", quantity: 2, vaccineName: "Vaccine A", batchId: "LOT-1", vatClassification: "vatable" }]);
  records.set("vaccines/vaccine1", { vatClassification: "vat_exempt" });
  await assert.rejects(requestZeroRateApproval({ db, FieldValue, uid: "rep1", payload, now }), { code: "zero-rate-no-vatable-lines" });
  records.set("vaccines/vaccine1", { vatClassification: "vatable" });
  records.set("users/rep1", { ...records.get("users/rep1"), assignedAreaIds: [], assignedClinicIds: [] });
  await assert.rejects(requestZeroRateApproval({ db, FieldValue, uid: "rep1", payload, now }));
  assert.equal(created.length, 1);
});
