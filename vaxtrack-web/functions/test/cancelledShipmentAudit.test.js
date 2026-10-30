"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getCancelledShipmentAudit } = require("../src/cancelledShipmentAudit");

function fakeDb(records) {
  const reads = [];
  return {
    reads,
    collection(collection) {
      return { doc(id) { return { async get() {
        reads.push(`${collection}/${id}`);
        const data = records[`${collection}/${id}`];
        return { exists: data !== undefined, data: () => data };
      } }; } };
    },
  };
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error.code; }
}

test("cancelled audit returns actor name and settled batch slices without exposing staff records", async () => {
  const db = fakeDb({
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/rep": { role: "salesrep", name: "Current Rep Name" },
    "orders/o1": { status: "cancelled", cancelledByUid: "rep", cancelledByName: "Rep at cancellation" },
    "inventoryReservations/o1": { status: "released", settlementType: "cancelled", items: [
      { lineIndex: 0, batchId: "LOT-7", quantity: 3, inventoryId: "private-batch" },
      { lineIndex: 1, batchId: "LOT-8", quantity: 2, inventoryId: "other-private-batch" },
    ] },
  });
  const result = await getCancelledShipmentAudit({ db, uid: "dispatcher", payload: { orderId: "o1" } });
  assert.equal(result.cancelledByName, "Rep at cancellation");
  assert.equal(result.reservationStatus, "released");
  assert.equal(result.settlementType, "cancelled");
  assert.deepEqual(result.slices, [
    { lineIndex: 0, batchId: "LOT-7", quantity: 3 },
    { lineIndex: 1, batchId: "LOT-8", quantity: 2 },
  ]);
  assert.equal(JSON.stringify(result).includes("private-batch"), false);
});

test("legacy cancellation resolves current actor name and reports missing reservation honestly", async () => {
  const db = fakeDb({
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/admin": { role: "admin", name: "Current Admin Name" },
    "orders/legacy": { status: "cancelled", cancelledByUid: "admin" },
  });
  const result = await getCancelledShipmentAudit({ db, uid: "dispatcher", payload: { orderId: "legacy" } });
  assert.equal(result.cancelledByName, "Current Admin Name");
  assert.equal(result.reservationStatus, null);
  assert.deepEqual(result.slices, []);
});

test("cancellation audit rejects other roles, non-cancelled orders and invalid IDs", async () => {
  const db = fakeDb({
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/pending": { role: "dispatcher", status: "pending" },
    "users/rep": { role: "salesrep", status: "approved" },
    "orders/open": { status: "pending_dispatch" },
  });
  assert.equal(await codeOf(getCancelledShipmentAudit({ db, uid: "rep", payload: { orderId: "open" } })), "wrong-role");
  assert.equal(await codeOf(getCancelledShipmentAudit({ db, uid: "pending", payload: { orderId: "open" } })), "wrong-role");
  assert.equal(await codeOf(getCancelledShipmentAudit({ db, uid: "dispatcher", payload: { orderId: "open" } })), "invalid-status");
  assert.equal(await codeOf(getCancelledShipmentAudit({ db, uid: "dispatcher", payload: { orderId: "bad/id" } })), "invalid-payload");
  assert.equal(await codeOf(getCancelledShipmentAudit({ db, uid: "dispatcher", payload: { orderId: "open", extra: true } })), "invalid-payload");
  assert.equal(db.reads.some((path) => path.startsWith("inventoryReservations/")), false);
});
