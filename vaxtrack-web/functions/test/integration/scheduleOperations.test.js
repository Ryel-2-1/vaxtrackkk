"use strict";

/**
 * rescheduleOrderDelivery against a REAL Firestore (emulator): the order write
 * and its scheduleEvents entry commit together, nothing but the schedule
 * fields changes, and every refusal leaves the order exactly as it was.
 *
 * Run:  npm run test:emulator   (in functions/)
 * Own project id: test files run in parallel and others wipe `orders`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-schedule" }, "schedule-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const schedule = require("../../src/scheduleOperations");

// 2026-10-05 10:00 in Manila.
const NOW = new Date("2026-10-05T02:00:00.000Z");
const ADMIN = "admin_ok";
const ADMIN_PENDING = "admin_pending";
const DISPATCHER = "disp_ok";
const MEDREP = "rep_ok";
const RIDER = "rider_ok";

// A server-priced, reserved, destination-snapshotted order — every field the
// reschedule must leave alone.
const baseOrder = (over = {}) => ({
  orderNumber: "VT-ORD-1",
  status: "pending_dispatch",
  priority: "Urgent",
  requestedDeliveryDate: "2026-10-08",
  createdByUid: MEDREP,
  assignedRiderId: null,
  doctorId: "doc1",
  doctorName: "Dr. Ana Reyes",
  destinationType: "clinic",
  destinationName: "Laguna Clinic",
  deliveryAddress: "1 National Highway",
  clinicDocId: "clinic1",
  clinicLat: 14.3,
  clinicLng: 121.1,
  pricingVersion: 1,
  subtotalCentavos: 250000,
  priceIsVatInclusive: false,
  allocationVersion: 1,
  allocationStatus: "reserved",
  items: [{ inventoryId: "inv1", quantity: 2, unitPriceCentavos: 125000, lineTotalCentavos: 250000 }],
  ...over,
});

// No collection-wide wipes: other integration files run in parallel against
// the same emulator, and scanning collections here slowed their concurrency
// tests. Each test seeds its OWN uniquely-named orders instead.
let run = 0;
const usersSeeded = (async () => {
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
  await db.collection("users").doc(ADMIN_PENDING).set({ role: "admin", status: "pending" });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(MEDREP).set({ role: "salesrep", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
})();

/** Seed fresh orders under unique ids; returns { name: id }. */
async function seed(orders) {
  await usersSeeded;
  run += 1;
  const ids = {};
  for (const [name, data] of Object.entries(orders)) {
    ids[name] = `sch${Date.now()}_${run}_${name}`;
    await db.collection("orders").doc(ids[name]).set(data);
  }
  await db.collection("inventory").doc(`inv_${run}`).set({ quantity: 100, reservedQuantity: 2, sellingPriceCentavos: 125000 });
  ids.inventory = `inv_${run}`;
  return ids;
}

const reschedule = (uid, payload) =>
  schedule.rescheduleOrderDelivery({ db, FieldValue, uid, payload, now: NOW });
const codeOf = async (p) => {
  try { await p; return null; } catch (e) { return e.code; }
};
const order = async (id) => (await db.collection("orders").doc(id).get()).data();
const events = async (id) =>
  (await db.collection("orders").doc(id).collection("scheduleEvents").orderBy("revision").get()).docs.map((d) => d.data());

const SCHEDULE_KEYS = [
  "requestedDeliveryDate", "scheduledDeliveryTime", "originalRequestedDeliveryDate",
  "scheduleRevision", "scheduleUpdatedAt", "scheduleUpdatedByUid", "scheduleChangeReason", "updatedAt",
];
const withoutSchedule = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !SCHEDULE_KEYS.includes(k)));

test("Admin reschedules before assignment: date, time, audit, original and history", async () => {
  const { o1, inventory } = await seed({ o1: baseOrder() });
  const before = await order(o1);

  const r = await reschedule(ADMIN, { orderId: o1, requestedDeliveryDate: "2026-10-12", scheduledDeliveryTime: "09:30", reason: "Clinic asked for Monday" });
  assert.deepEqual(r, { orderId: o1, requestedDeliveryDate: "2026-10-12", scheduledDeliveryTime: "09:30", revision: 1 });

  const after = await order(o1);
  assert.equal(after.requestedDeliveryDate, "2026-10-12");
  assert.equal(after.scheduledDeliveryTime, "09:30");
  assert.equal(after.originalRequestedDeliveryDate, "2026-10-08", "the Med Rep's request is preserved");
  assert.equal(after.scheduleRevision, 1);
  assert.equal(after.scheduleUpdatedByUid, ADMIN);
  assert.ok(after.scheduleUpdatedAt, "server time recorded");
  assert.equal(after.scheduleChangeReason, "Clinic asked for Monday");
  // Price, VAT convention, destination, reservation, status, rider: untouched.
  assert.deepEqual(withoutSchedule(after), withoutSchedule(before));
  assert.equal((await db.collection("inventory").doc(inventory).get()).data().reservedQuantity, 2);

  const [e] = await events(o1);
  assert.equal(e.revision, 1);
  assert.equal(e.fromDate, "2026-10-08");
  assert.equal(e.fromTime, null);
  assert.equal(e.toDate, "2026-10-12");
  assert.equal(e.toTime, "09:30");
  assert.equal(e.changedByUid, ADMIN);
  assert.equal(e.orderStatus, "pending_dispatch");
  assert.ok(e.changedAt);
});

test("a second reschedule keeps the ORIGINAL request and appends history", async () => {
  const { o1 } = await seed({ o1: baseOrder() });
  await reschedule(ADMIN, { orderId: o1, requestedDeliveryDate: "2026-10-12" });
  await reschedule(ADMIN, { orderId: o1, requestedDeliveryDate: "2026-10-12", scheduledDeliveryTime: "14:00" });
  const after = await order(o1);
  assert.equal(after.originalRequestedDeliveryDate, "2026-10-08");
  assert.equal(after.scheduleRevision, 2);
  const list = await events(o1);
  assert.deepEqual(list.map((e) => [e.fromDate, e.fromTime, e.toDate, e.toTime]), [
    ["2026-10-08", null, "2026-10-12", null],
    ["2026-10-12", null, "2026-10-12", "14:00"],
  ]);
});

test("rescheduling works after rider assignment and after dispatch, and changes nothing else", async () => {
  const ids = await seed({
    assigned: baseOrder({ status: "assigned", assignedRiderId: RIDER, assignedRiderName: "QA Rider" }),
    transit: baseOrder({ status: "in_transit", assignedRiderId: RIDER, startedAt: new Date("2026-10-05T01:00:00Z") }),
    failed: baseOrder({ status: "delivery_failed", assignedRiderId: RIDER }),
  });
  for (const name of ["assigned", "transit", "failed"]) {
    const id = ids[name];
    const before = await order(id);
    await reschedule(ADMIN, { orderId: id, requestedDeliveryDate: "2026-10-09", scheduledDeliveryTime: "08:00" });
    const after = await order(id);
    assert.equal(after.requestedDeliveryDate, "2026-10-09", name);
    assert.deepEqual(withoutSchedule(after), withoutSchedule(before), `${name}: only schedule fields change`);
  }
});

test("a legacy undated order can be given its first date; its original stays null", async () => {
  const legacyOrder = baseOrder();
  delete legacyOrder.requestedDeliveryDate;
  const { legacy } = await seed({ legacy: legacyOrder });
  await reschedule(ADMIN, { orderId: legacy, requestedDeliveryDate: "2026-10-06" });
  const after = await order(legacy);
  assert.equal(after.requestedDeliveryDate, "2026-10-06");
  assert.equal(after.originalRequestedDeliveryDate, null);
  assert.equal((await events(legacy))[0].fromDate, null);
});

test("refusals leave the order and its history untouched", async (t) => {
  const ids = await seed({
    o1: baseOrder(),
    done: baseOrder({ status: "delivered" }),
    gone: baseOrder({ status: "cancelled" }),
  });
  const before = await order(ids.o1);
  const cases = [
    ["dispatcher", DISPATCHER, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12" }, "wrong-role"],
    ["Med Rep", MEDREP, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12" }, "wrong-role"],
    ["rider", RIDER, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12" }, "wrong-role"],
    ["pending admin", ADMIN_PENDING, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12" }, "not-approved"],
    ["impossible date", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-02-31" }, "invalid-schedule-date"],
    ["malformed date", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "10/12/2026" }, "invalid-schedule-date"],
    ["past date", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-10-04" }, "schedule-date-in-past"],
    ["bad time", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12", scheduledDeliveryTime: "25:00" }, "invalid-schedule-time"],
    ["unchanged", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-10-08" }, "schedule-unchanged"],
    ["smuggled field", ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-10-12", subtotalCentavos: 1 }, "unknown-field"],
    ["delivered order", ADMIN, { orderId: ids.done, requestedDeliveryDate: "2026-10-12" }, "order-closed"],
    ["cancelled order", ADMIN, { orderId: ids.gone, requestedDeliveryDate: "2026-10-12" }, "order-closed"],
    ["missing order", ADMIN, { orderId: "sch_missing_order", requestedDeliveryDate: "2026-10-12" }, "order-not-found"],
  ];
  for (const [name, uid, payload, code] of cases) {
    await t.test(`refuses: ${name}`, async () => {
      assert.equal(await codeOf(reschedule(uid, payload)), code);
    });
  }
  await t.test("nothing changed", async () => {
    assert.deepEqual(await order(ids.o1), before);
    assert.equal((await events(ids.o1)).length, 0);
    assert.equal((await events(ids.done)).length, 0);
  });
  await t.test("today in Manila is allowed (it is not 'past')", async () => {
    assert.equal((await reschedule(ADMIN, { orderId: ids.o1, requestedDeliveryDate: "2026-10-05" })).requestedDeliveryDate, "2026-10-05");
  });
});
