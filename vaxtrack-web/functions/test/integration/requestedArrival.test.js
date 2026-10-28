"use strict";

/**
 * Requested arrival at the destination, against a REAL Firestore (emulator).
 *
 * What only real transactions can prove: the spec is stored exactly as
 * accepted on the order AND its receipt; a refused spec leaves no order,
 * reservation, request key, receipt or audit; a retry with the same request id
 * and the same preference replays (no second order or reservation) while a
 * changed preference is refused; and a request key written before version 2
 * still replays. Pricing, VAT and reservations are unaffected.
 *
 * Run:  npm run test:emulator   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const app = admin.initializeApp({ projectId: "demo-vaxtrack-arrival" }, "requested-arrival-tests");
const db = app.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");
const { canonicalRequestFingerprint } = require("../../src/policy");

const SR = "sr1";
const DOCTOR = "doctor1";
const CLINIC = "clinic1";
const AREA = "area1";
// 2026-10-11 10:00 in Manila.
const NOW = new Date("2026-10-11T02:00:00.000Z");
const TODAY = "2026-10-11";
const LATER = "2026-10-15";

let seq = 0;
const rid = () => `arr${String(++seq).padStart(4, "0")}${"z".repeat(20)}`;

const COLLECTIONS = [
  "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
  "orderRequestKeys", "orderReceipts", "orderHistoryOutbox", "inventoryAllocationEvents",
  "orderPriceAdjustments", "orderStatutoryDiscounts",
];
const WRITTEN_BY_ORDER = [
  "orders", "inventoryReservations", "orderRequestKeys", "orderReceipts", "orderHistoryOutbox",
  "inventoryAllocationEvents", "orderPriceAdjustments", "orderStatutoryDiscounts",
];

async function wipe() {
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed() {
  await wipe();
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", name: "Rep One", assignedAreaIds: [AREA], assignedClinicIds: [CLINIC] });
  await db.collection("areas").doc(AREA).set({ name: "Manila", active: true });
  await db.collection("clinics").doc(CLINIC).set({
    clinicId: "CLN-001", name: "Health Clinic", location: "10 Mabini Street, Manila", areaId: AREA, area: "Manila",
    status: "active", locationVerified: true, latitude: 14.5995, longitude: 120.9842, geofenceRadiusM: 300,
  });
  const doctorRef = db.collection("doctors").doc(DOCTOR);
  await doctorRef.set({ name: "Dr. Ana Reyes", areaId: AREA, area: "Manila", active: true });
  await doctorRef.collection("deliveryAddresses").doc(CLINIC).set({ active: true });
  await db.collection("vaccines").doc("vVat").set({ vaccineName: "Hep B", internalSku: "VXT-001-HEPBB", vatClassification: "vatable" });
  await db.collection("vaccines").doc("vExempt").set({ vaccineName: "Rabies", internalSku: "VXT-002-RABIE", vatClassification: "vat_exempt" });
  const batch = (vaccineId, price, batchId) => ({
    vaccineId, quantity: 100, reservedQuantity: 0, sellingPriceCentavos: price, priceIsVatInclusive: true,
    status: "OK", expiryDate: "2027-12-31", batchId, vaccineName: batchId,
  });
  await db.collection("inventory").doc("vat").set(batch("vVat", 112000, "HEP-001"));
  await db.collection("inventory").doc("exempt").set(batch("vExempt", 45000, "RAB-001"));
}

const ITEMS = [
  { inventoryId: "vat", quantity: 2, expectedUnitPriceCentavos: 112000, agreedUnitPriceCentavos: 100000, negotiationReason: "Volume deal" },
  { inventoryId: "exempt", quantity: 3, expectedUnitPriceCentavos: 45000 },
];
const payloadOf = (over = {}) => ({ requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: LATER, items: ITEMS, ...over });
const create = (payload) => ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload });
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const order = async (id) => (await db.collection("orders").doc(id).get()).data();
const receipt = async (id) => (await db.collection("orderReceipts").doc(id).get()).data();
const size = async (c) => (await db.collection(c).get()).size;

test("each mode is stored canonically on the order and its receipt", async () => {
  await seed();
  const cases = [
    [undefined, { version: 1, mode: "any_time" }],
    [null, { version: 1, mode: "any_time" }],
    [{ mode: "window", start: "10:00", end: "12:00" }, { version: 1, mode: "window", start: "10:00", end: "12:00" }],
    [{ mode: "before", time: "10:00" }, { version: 1, mode: "before", time: "10:00" }],
    [{ mode: "exact", time: "12:00" }, { version: 1, mode: "exact", time: "12:00" }],
    [{ mode: "exact", time: "00:00" }, { version: 1, mode: "exact", time: "00:00" }],
  ];
  for (const [sent, stored] of cases) {
    const r = await create(payloadOf(sent === undefined ? {} : { requestedArrival: sent }));
    const o = await order(r.orderId);
    assert.deepEqual(o.requestedArrival, stored, JSON.stringify(sent));
    assert.equal(o.requestedDeliveryDate, LATER, "the date is never moved");
    assert.equal(o.scheduledDeliveryTime, undefined, "the Admin schedule field is not written");
    assert.deepEqual((await receipt(r.orderId)).requestedArrival, stored, "receipt snapshot");
    const key = (await db.collection("orderRequestKeys").get()).docs.find((d) => d.data().orderId === r.orderId).data();
    assert.equal(key.fingerprintVersion, 3);
    assert.deepEqual(r.requestedArrival, stored, "response confirms the stored preference");
    assert.equal(r.requestedDeliveryDate, LATER);
  }
});

test("refused requests leave nothing written at all", async () => {
  await seed();
  const refusals = [
    [{ mode: "evening" }, "invalid-requested-arrival"],
    [{ mode: "window", start: "10:00" }, "invalid-requested-arrival"],
    [{ mode: "window", start: "12:00", end: "10:00" }, "invalid-requested-arrival"],
    [{ mode: "window", start: "10:00", end: "10:00" }, "invalid-requested-arrival"],
    [{ mode: "before", time: "10:00", start: "09:00" }, "invalid-requested-arrival"],
    [{ mode: "exact", time: "9:30" }, "invalid-requested-arrival"],
  ];
  for (const [requestedArrival, code] of refusals) {
    assert.equal(await codeOf(create(payloadOf({ requestedArrival }))), code, JSON.stringify(requestedArrival));
  }
  // Today in Manila is Oct 11, now 10:00: a time already gone is refused...
  assert.equal(await codeOf(create(payloadOf({ requestedDeliveryDate: TODAY, requestedArrival: { mode: "before", time: "10:00" } }))), "requested-arrival-passed");
  assert.equal(await codeOf(create(payloadOf({ requestedDeliveryDate: TODAY, requestedArrival: { mode: "exact", time: "09:59" } }))), "requested-arrival-passed");
  for (const c of WRITTEN_BY_ORDER) assert.equal(await size(c), 0, `no ${c}`);
  for (const id of ["vat", "exempt"]) assert.equal((await db.collection("inventory").doc(id).get()).data().reservedQuantity, 0);
  // ...but a later time today is accepted.
  const ok = await create(payloadOf({ requestedDeliveryDate: TODAY, requestedArrival: { mode: "exact", time: "10:00" } }));
  assert.equal((await order(ok.orderId)).requestedArrival.time, "10:00");
});

test("a retry with the same preference replays; a changed preference under the same id is refused", async () => {
  await seed();
  const payload = payloadOf({ requestedArrival: { mode: "before", time: "11:00" } });
  const first = await create(payload);
  const [a, b] = await Promise.all([create(payload), create(payload)]);
  for (const replay of [a, b]) {
    assert.equal(replay.orderId, first.orderId);
    assert.equal(replay.replayed, true);
  }
  assert.equal(await size("orders"), 1, "one order");
  assert.equal(await size("inventoryReservations"), 1, "one reservation document");
  const reserved = (await db.collection("inventory").doc("vat").get()).data().reservedQuantity;
  assert.equal(reserved, 2, "stock reserved once");

  for (const changed of [
    { ...payload, requestedArrival: { mode: "exact", time: "11:00" } },
    { ...payload, requestedArrival: { mode: "before", time: "11:30" } },
    { ...payload, requestedArrival: undefined },
  ]) {
    assert.equal(await codeOf(create(changed)), "idempotency-conflict", JSON.stringify(changed.requestedArrival ?? null));
  }
  assert.equal(await size("orders"), 1);
  assert.deepEqual((await order(first.orderId)).requestedArrival, { version: 1, mode: "before", time: "11:00" });
  assert.equal(await codeOf(create({ ...payload, requestedDeliveryDate: "2026-10-16" })), "idempotency-conflict");
  assert.equal((await order(first.orderId)).requestedDeliveryDate, LATER);
});

test("a request key written before version 2 still replays an unchanged retry", async () => {
  await seed();
  const payload = payloadOf({ requestedArrival: { mode: "exact", time: "11:00" } });
  const first = await create(payload);
  // Rewrite the key as an older deployment wrote it: version-1 hash, no version.
  const keyRef = db.collection("orderRequestKeys").doc(`${SR}__${payload.requestId}`);
  const v1 = canonicalRequestFingerprint({ uid: SR, doctorId: DOCTOR, doctorAddressId: CLINIC, items: ITEMS });
  await keyRef.update({ fingerprint: v1, fingerprintVersion: FieldValue.delete() });
  const replay = await create(payload);
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.replayed, true);
  // Its older hash still protects the items; schedule fields are compared
  // against the original stored order rather than silently ignored.
  const otherItems = { ...payload, items: [ITEMS[1]] };
  assert.equal(await codeOf(create(otherItems)), "idempotency-conflict");
  assert.equal(await size("orders"), 1);
});

test("pricing, VAT, negotiation and reservations are unchanged by the preference", async () => {
  await seed();
  const plain = await create(payloadOf());
  const timed = await create(payloadOf({ requestedArrival: { mode: "window", start: "08:00", end: "09:00" } }));
  const [p, t] = [await order(plain.orderId), await order(timed.orderId)];
  for (const k of ["subtotalCentavos", "standardSubtotalCentavos", "negotiatedAdjustmentTotalCentavos", "finalTotalCentavos", "priceNegotiated"]) {
    assert.deepEqual(t[k], p[k], k);
  }
  assert.deepEqual(t.vatSummary, p.vatSummary);
  assert.deepEqual(t.items.map((i) => [i.vatClassification, i.agreedUnitPriceCentavos, i.reservedQuantity]), p.items.map((i) => [i.vatClassification, i.agreedUnitPriceCentavos, i.reservedQuantity]));
  assert.equal(await size("orderPriceAdjustments"), 2, "one negotiation audit per order");
  // A negotiated line without its reason is still refused, preference or not.
  const noReason = [{ ...ITEMS[0], negotiationReason: "" }, ITEMS[1]];
  assert.notEqual(await codeOf(create(payloadOf({ items: noReason, requestedArrival: { mode: "exact", time: "11:00" } }))), null);
});

test("a committed timed request replays after cutoff and the next day; a NEW stale request writes nothing", async () => {
  await seed();
  const payload = payloadOf({ requestedDeliveryDate: TODAY, requestedArrival: { mode: "exact", time: "10:01" } });
  const first = await create(payload);
  const reserved = (await db.collection("inventory").doc("vat").get()).data().reservedQuantity;
  for (const now of [new Date("2026-10-11T03:00:00Z"), new Date("2026-10-11T16:01:00Z")]) {
    const replay = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, now, payload });
    assert.equal(replay.orderId, first.orderId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.requestedArrival, first.requestedArrival);
    assert.equal(replay.requestedDeliveryDate, TODAY);
    assert.equal(await codeOf(ops.createOrderWithReservation({ db, FieldValue, uid: SR, now, payload: { ...payload, requestId: rid() } })), now.getTime() < new Date("2026-10-11T16:00:00Z").getTime() ? "requested-arrival-passed" : "invalid-requested-date");
  }
  assert.equal(await size("orders"), 1);
  assert.equal(await size("orderRequestKeys"), 1);
  assert.equal(await size("inventoryReservations"), 1);
  assert.equal((await db.collection("inventory").doc("vat").get()).data().reservedQuantity, reserved);
});

test("v1 and v2 recovery compares unbound schedule fields with the original order", async () => {
  await seed();
  for (const version of [1, 2]) {
    const payload = payloadOf({ requestedArrival: { mode: "exact", time: "11:00" } });
    const first = await create(payload);
    const args = { uid: SR, doctorId: DOCTOR, doctorAddressId: CLINIC, items: ITEMS };
    if (version === 2) args.schedule = { requestedArrival: { version: 1, mode: "exact", time: "11:00" } };
    await db.collection("orderRequestKeys").doc(`${SR}__${payload.requestId}`).update({ fingerprintVersion: version, fingerprint: canonicalRequestFingerprint(args) });
    assert.equal((await create(payload)).orderId, first.orderId);
    assert.equal(await codeOf(create({ ...payload, requestedDeliveryDate: "2026-10-16" })), "idempotency-conflict");
    assert.equal(await codeOf(create({ ...payload, requestedArrival: { mode: "any_time" } })), "idempotency-conflict");
  }
  assert.equal(await size("orders"), 2);
});

test("simultaneous first submissions reserve once and preserve one schedule", async () => {
  await seed();
  const payload = payloadOf({ requestedArrival: { mode: "window", start: "10:00", end: "12:00" } });
  const results = await Promise.all([create(payload), create(payload), create(payload)]);
  assert.equal(new Set(results.map((r) => r.orderId)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(await size("orders"), 1);
  assert.equal((await db.collection("inventory").doc("vat").get()).data().reservedQuantity, 2);
  for (const r of results) assert.deepEqual(r.requestedArrival, { version: 1, mode: "window", start: "10:00", end: "12:00" });
});
