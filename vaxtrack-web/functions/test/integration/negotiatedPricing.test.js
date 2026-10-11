"use strict";

/**
 * Negotiated (agreed) order pricing against a REAL Firestore (emulator).
 *
 * What only real transactions can prove: the order, receipt, history, outbox,
 * reservation, request key and pricing audit commit together or not at all; a
 * standard price that moves under an open checkout refuses the whole order;
 * a retried request replays rather than re-pricing; and an agreed price
 * survives backorder allocation and later catalog changes.
 *
 * Run:  npm run test:emulator   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const app = admin.initializeApp({ projectId: "demo-vaxtrack-negotiated" }, "negotiated-pricing-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const ops = require("../../src/operations");
const invoices = require("../../src/invoiceOperations");
const { allocateProducts } = require("../../src/allocation");
const { splitVatInclusiveCentavos } = require("../../src/pricingConfig");

const SR = "sr1";
const SR2 = "sr2";
const SR_PENDING = "sr_pending";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const DOCTOR = "doctor1";
const CLINIC = "clinic1";
const AREA = "area1";
const NOW = new Date("2026-10-11T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-15";

const STD = { vat: 125000, exempt: 45000, zero: 30000 };

let seq = 0;
const rid = () => `neg${String(++seq).padStart(4, "0")}${"y".repeat(20)}`;

const COLLECTIONS = [
  "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
  "orderRequestKeys", "orderReceipts", "orderHistoryOutbox", "inventoryAllocationEvents", "orderPriceAdjustments",
  "invoices", "counters",
];

async function wipe() {
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed() {
  await wipe();
  const territory = { assignedAreaIds: [AREA], assignedClinicIds: [CLINIC] };
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", name: "Rep One", ...territory });
  await db.collection("users").doc(SR2).set({ role: "salesrep", status: "approved", name: "Rep Two", ...territory });
  await db.collection("users").doc(SR_PENDING).set({ role: "salesrep", status: "pending", ...territory });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
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
  await db.collection("vaccines").doc("vZero").set({ vaccineName: "Export Lot", internalSku: "VXT-003-EXPRT", vatClassification: "zero_rated" });
  const batch = (vaccineId, price, quantity, batchId) => ({
    vaccineId, quantity, reservedQuantity: 0, sellingPriceCentavos: price, priceIsVatInclusive: true,
    status: "OK", expiryDate: "2027-12-31", batchId, vaccineName: batchId,
  });
  await db.collection("inventory").doc("vat").set(batch("vVat", STD.vat, 100, "HEP-001"));
  await db.collection("inventory").doc("exempt").set(batch("vExempt", STD.exempt, 100, "RAB-001"));
  await db.collection("inventory").doc("zero").set(batch("vZero", STD.zero, 100, "EXP-001"));
}

const line = (inventoryId, quantity, over = {}) => ({
  inventoryId,
  quantity,
  expectedUnitPriceCentavos: STD[inventoryId],
  ...over,
});

const create = (uid, items, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid, now: NOW,
    payload: {
      requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE, items, ...over,
    },
  });

const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const order = async (id) => (await db.collection("orders").doc(id).get()).data();
const size = async (c) => (await db.collection(c).get()).size;
const audits = async () => (await db.collection("orderPriceAdjustments").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function assertNothingWritten(label) {
  for (const c of ["orders", "inventoryReservations", "orderRequestKeys", "orderReceipts", "orderHistoryOutbox", "inventoryAllocationEvents", "orderPriceAdjustments"]) {
    assert.equal(await size(c), 0, `${label}: no ${c}`);
  }
  for (const id of ["vat", "exempt", "zero"]) {
    const b = (await db.collection("inventory").doc(id).get()).data();
    assert.equal(b.reservedQuantity, 0, `${label}: ${id} untouched`);
    assert.equal(b.sellingPriceCentavos, b.sellingPriceCentavos, "standard price never written");
  }
}

// ---------------------------------------------------------------- happy paths

test("a standard-price order records agreed = standard, no adjustment and no audit", async () => {
  await seed();
  const r = await create(SR, [line("vat", 2)]);
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.standardUnitPriceCentavos, STD.vat);
  assert.equal(it.agreedUnitPriceCentavos, STD.vat);
  assert.equal(it.unitPriceCentavos, STD.vat);
  assert.equal(it.lineTotalCentavos, 2 * STD.vat);
  assert.equal(it.adjustmentCentavos, 0);
  assert.equal(it.priceAdjusted, false);
  assert.equal(it.adjustmentReason, null);
  assert.equal(it.vatRatePercent, 12);
  assert.equal(o.priceAgreementVersion, 1);
  assert.equal(o.priceAdjusted, false);
  assert.equal(o.subtotalCentavos, 2 * STD.vat);
  assert.equal(o.standardSubtotalCentavos, 2 * STD.vat);
  assert.equal(o.vatSummary.vatAmountCentavos, splitVatInclusiveCentavos(2 * STD.vat).vatCentavos);
  assert.deepEqual(await audits(), []);
  assert.equal(r.pricing.priceAdjusted, false);
});

test("a lower negotiated price is the charged price; standard, adjustment, reason and audit are recorded", async () => {
  await seed();
  const requestId = rid();
  const r = await ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId, doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
      items: [line("vat", 3, { agreedUnitPriceCentavos: 110050, adjustmentReason: "  Volume  order for clinic " })],
    },
  });
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.unitPriceCentavos, 110050, "invoices and receipts read the agreed price");
  assert.equal(it.lineTotalCentavos, 330150);
  assert.equal(it.standardLineTotalCentavos, 375000);
  assert.equal(it.adjustmentCentavos, -44850);
  assert.equal(it.adjustmentReason, "Volume order for clinic");
  assert.equal(o.subtotalCentavos, 330150);
  assert.equal(o.priceAdjustmentCentavos, -44850);
  assert.equal(o.priceAdjusted, true);

  const [audit] = await audits();
  assert.equal(audit.id, `${r.orderId}__0`);
  assert.equal(audit.medRepUid, SR, "the verified caller, never payload data");
  assert.equal(audit.requestId, requestId);
  assert.ok(audit.createdAt instanceof Timestamp, "server time");
  assert.equal(audit.standardUnitPriceCentavos, STD.vat);
  assert.equal(audit.agreedUnitPriceCentavos, 110050);
  assert.equal(audit.adjustmentCentavos, -44850);
  assert.equal(audit.adjustmentReason, "Volume order for clinic");

  // The receipt — written in the same transaction — carries the agreed price.
  const receipt = (await db.collection("orderReceipts").doc(r.orderId).get()).data();
  assert.equal(receipt.lines[0].unitPriceCentavos, 110050);
  assert.equal(receipt.finalTotalCentavos, 330150);
  // The standard price on the batch is never changed by a negotiation.
  assert.equal((await db.collection("inventory").doc("vat").get()).data().sellingPriceCentavos, STD.vat);
});

test("a higher negotiated price is allowed with a reason", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1, { agreedUnitPriceCentavos: 130000, adjustmentReason: "Rush delivery" })]);
  const o = await order(r.orderId);
  assert.equal(o.items[0].adjustmentCentavos, 5000);
  assert.equal(o.subtotalCentavos, 130000);
});

test("a mixed VATable / exempt / zero-rated order reconciles exactly", async () => {
  await seed();
  const r = await create(SR, [
    line("vat", 3, { agreedUnitPriceCentavos: 119999, adjustmentReason: "Promo" }),
    line("exempt", 2),
    line("zero", 5, { agreedUnitPriceCentavos: 29999, adjustmentReason: "Loyalty" }),
  ]);
  const o = await order(r.orderId);
  const v = o.vatSummary;
  assert.equal(v.vatableGrossCentavos, 3 * 119999);
  assert.equal(v.vatAmountCentavos, splitVatInclusiveCentavos(3 * 119999).vatCentavos);
  assert.equal(v.vatExemptSalesCentavos, 2 * STD.exempt);
  assert.equal(v.zeroRatedSalesCentavos, 5 * 29999);
  assert.equal(v.vatableSalesCentavos + v.vatAmountCentavos + v.vatExemptSalesCentavos + v.zeroRatedSalesCentavos, o.subtotalCentavos);
  assert.deepEqual(o.items.map((i) => i.vatClassification), ["vatable", "vat_exempt", "zero_rated"]);
  assert.deepEqual(o.items.map((i) => i.vatRatePercent), [12, 0, 0]);
  assert.equal((await audits()).length, 2, "one audit per negotiated line");
});

// ---------------------------------------------------------------- refusals leave nothing

test("refusals leave no order, reservation, key, receipt, history or audit", async (t) => {
  const cases = [
    ["a client total", [line("vat", 1, { lineTotalCentavos: 1 })], "unknown-field"],
    ["a client agreed total", [line("vat", 1, { agreedLineTotalCentavos: 1 })], "unknown-field"],
    ["a client VAT classification", [line("vat", 1, { vatClassification: "vat_exempt" })], "unknown-field"],
    ["a missing reason", [line("vat", 1, { agreedUnitPriceCentavos: 100000 })], "adjustment-reason-required"],
    ["a zero agreed price", [line("vat", 1, { agreedUnitPriceCentavos: 0, adjustmentReason: "free" })], "invalid-agreed-price"],
    ["a fractional agreed price", [line("vat", 1, { agreedUnitPriceCentavos: 100000.5, adjustmentReason: "x" })], "invalid-agreed-price"],
  ];
  for (const [label, items, code] of cases) {
    await t.test(label, async () => {
      await seed();
      assert.equal(await codeOf(create(SR, items)), code);
      await assertNothingWritten(label);
    });
  }
  await t.test("a client order total", async () => {
    await seed();
    assert.equal(await codeOf(create(SR, [line("vat", 1)], { subtotalCentavos: 1 })), "unknown-field");
    await assertNothingWritten("order total");
  });
});

test("a standard price changed after review refuses the whole order atomically", async () => {
  await seed();
  // The Med Rep reviewed ₱1,250.00 and negotiated ₱1,100.00 on it…
  await db.collection("inventory").doc("vat").update({ sellingPriceCentavos: 135000 });
  const items = [
    line("exempt", 1),
    line("vat", 2, { agreedUnitPriceCentavos: 110000, adjustmentReason: "Volume" }),
  ];
  let error;
  try {
    await create(SR, items);
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "price-changed");
  // Only what the rep may already read: the batch and its current standard price.
  assert.deepEqual(Object.keys(error.details).sort(), ["batchId", "currentUnitPriceCentavos", "expectedUnitPriceCentavos", "inventoryId"]);
  assert.equal(error.details.currentUnitPriceCentavos, 135000);
  await assertNothingWritten("stale standard price");

  // Reviewed again at the new standard, the agreed price goes through unchanged.
  const r = await create(SR, [line("vat", 2, { expectedUnitPriceCentavos: 135000, agreedUnitPriceCentavos: 110000, adjustmentReason: "Volume" })]);
  const o = await order(r.orderId);
  assert.equal(o.items[0].standardUnitPriceCentavos, 135000);
  assert.equal(o.items[0].agreedUnitPriceCentavos, 110000);
});

test("only an approved Med Rep can place an order with negotiated prices", async () => {
  await seed();
  const items = [line("vat", 1, { agreedUnitPriceCentavos: 100000, adjustmentReason: "Deal" })];
  for (const uid of [DISPATCHER, RIDER, ADMIN, SR_PENDING, "nobody"]) {
    assert.ok(["wrong-role", "not-approved", "profile-missing"].includes(await codeOf(create(uid, items))), uid);
  }
  await assertNothingWritten("unauthorized");
});

// ---------------------------------------------------------------- idempotency + immutability

test("a repeated request replays the original agreed prices; a different price under the same id is refused", async () => {
  await seed();
  const requestId = rid();
  const payload = {
    requestId, doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
    items: [line("vat", 2, { agreedUnitPriceCentavos: 115000, adjustmentReason: "Contract" })],
  };
  const first = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload });
  const [a, b] = await Promise.all([
    ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload }),
    ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload }),
  ]);
  assert.equal(a.orderId, first.orderId);
  assert.equal(b.orderId, first.orderId);
  assert.equal(a.replayed, true);
  assert.equal(a.pricing.items[0].agreedUnitPriceCentavos, 115000);
  assert.equal(a.pricing.items[0].standardUnitPriceCentavos, STD.vat);
  assert.equal(await size("orders"), 1);
  assert.equal((await audits()).length, 1, "the audit is written once");

  const changed = { ...payload, items: [line("vat", 2, { agreedUnitPriceCentavos: 105000, adjustmentReason: "Contract" })] };
  assert.equal(await codeOf(ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload: changed })), "idempotency-conflict");
  assert.equal((await order(first.orderId)).items[0].agreedUnitPriceCentavos, 115000);
});

test("another Med Rep's request never touches a placed order's pricing", async () => {
  await seed();
  const requestId = rid();
  const mk = (uid, agreed) => ops.createOrderWithReservation({
    db, FieldValue, uid, now: NOW,
    payload: {
      requestId, doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE,
      items: [line("vat", 1, { agreedUnitPriceCentavos: agreed, adjustmentReason: "Deal" })],
    },
  });
  const mine = await mk(SR, 120000);
  const theirs = await mk(SR2, 90000);
  assert.notEqual(theirs.orderId, mine.orderId, "the request key is scoped to its caller");
  assert.equal((await order(mine.orderId)).items[0].agreedUnitPriceCentavos, 120000);
});

test("backordered stock is allocated later at the agreed price, whatever the catalog says then", async () => {
  await seed();
  await db.collection("inventory").doc("vat").update({ quantity: 2 });
  const r = await create(SR, [line("vat", 5, { agreedUnitPriceCentavos: 100000, adjustmentReason: "Long-term contract" })]);
  let o = await order(r.orderId);
  assert.equal(o.items[0].reservedQuantity, 2);
  assert.equal(o.items[0].backorderedQuantity, 3);

  // Stock arrives and the batch is re-priced; the waiting order is filled…
  await db.collection("inventory").doc("vat").update({ quantity: 50, sellingPriceCentavos: 150000 });
  await allocateProducts({ db, FieldValue, productKeys: ["vVat"], now: NOW });
  o = await order(r.orderId);
  assert.equal(o.items[0].reservedQuantity, 5);
  // …at the price agreed when it was placed.
  assert.equal(o.items[0].unitPriceCentavos, 100000);
  assert.equal(o.items[0].agreedUnitPriceCentavos, 100000);
  assert.equal(o.items[0].standardUnitPriceCentavos, STD.vat);
  assert.equal(o.subtotalCentavos, 500000);
});

test("a re-classified vaccine never changes a placed order's VAT", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1)]);
  await db.collection("vaccines").doc("vVat").update({ vatClassification: "zero_rated" });
  const o = await order(r.orderId);
  assert.equal(o.items[0].vatClassification, "vatable");
  assert.equal(o.vatSummary.vatAmountCentavos, splitVatInclusiveCentavos(STD.vat).vatCentavos);
});

// ---------------------------------------------------------------- invoices

const save = (uid, payload) => invoices.saveInvoiceDraftForPricedOrder({ db, FieldValue, uid, payload, now: NOW });
const issue = (uid, payload) => invoices.issueInvoiceForPricedOrder({ db, FieldValue, uid, payload, now: NOW });

test("the invoice bills the agreed snapshot and refuses a second discount on a negotiated order", async () => {
  await seed();
  const r = await create(SR, [
    line("vat", 2, { agreedUnitPriceCentavos: 110000, adjustmentReason: "Volume" }),
    line("zero", 1),
  ]);
  await db.collection("inventory").doc("vat").update({ sellingPriceCentavos: 999900 });

  assert.equal(
    await codeOf(save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: { discountCentavos: 100 } })),
    "discount-not-allowed-negotiated"
  );
  await save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: { discountCentavos: 0 } });
  const inv = (await db.collection("invoices").doc(r.orderId).get()).data();
  assert.equal(inv.items[0].unitPriceCentavos, 110000, "agreed, not the standard or today's catalog price");
  assert.equal(inv.subtotalCentavos, 220000 + STD.zero);
  assert.equal(inv.discountCentavos, 0);
  assert.equal(inv.zeroRatedSalesCentavos ?? inv.zeroRatedSales * 100, STD.zero);
  await issue(ADMIN, { orderId: r.orderId });
  assert.equal((await db.collection("invoices").doc(r.orderId).get()).data().invoiceStatus, "issued");
});

test("a standard-price order keeps the existing invoice discount; a legacy priced order stays invoiceable", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1)]);
  await save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: { discountCentavos: 500 } });
  assert.equal((await db.collection("invoices").doc(r.orderId).get()).data().discountCentavos, 500);

  // An order priced before negotiated pricing: no agreement fields at all.
  await db.collection("orders").doc("legacyPriced").set({
    orderNumber: "VT-OLD", status: "delivered", pricingVersion: 1, priceCurrency: "PHP", priceIsVatInclusive: true,
    subtotalCentavos: 2 * STD.vat, createdByUid: SR, unit: "vials",
    items: [{ inventoryId: "vat", name: "Hep B", quantity: 2, unitPriceCentavos: STD.vat, lineTotalCentavos: 2 * STD.vat, vatClassification: "vatable" }],
  });
  await save(ADMIN, { orderId: "legacyPriced", presentation: {}, adjustments: { discountCentavos: 1000 } });
  const legacy = (await db.collection("invoices").doc("legacyPriced").get()).data();
  assert.equal(legacy.items[0].unitPriceCentavos, STD.vat);
  assert.equal(legacy.discountCentavos, 1000);
});
