"use strict";

/**
 * Negotiated pricing + statutory (SC/PWD) line discounts against a REAL
 * Firestore (emulator).
 *
 * What only real transactions can prove: the order, receipt, history, outbox,
 * reservation, request key and BOTH audit records commit together or not at
 * all; a standard price that moves under an open checkout refuses the whole
 * order; a retried request replays rather than re-pricing; and agreed prices
 * and discounts survive backorder allocation and later catalog changes.
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
const vatOf = (c) => splitVatInclusiveCentavos(c).vatCentavos;

let seq = 0;
const rid = () => `neg${String(++seq).padStart(4, "0")}${"y".repeat(20)}`;

const COLLECTIONS = [
  "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
  "orderRequestKeys", "orderReceipts", "orderHistoryOutbox", "inventoryAllocationEvents",
  "orderPriceAdjustments", "orderStatutoryDiscounts", "invoices", "counters",
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

const line = (inventoryId, quantity, over = {}) => ({ inventoryId, quantity, expectedUnitPriceCentavos: STD[inventoryId], ...over });
// A discounted line, with the Med Rep's eligibility attestation ticked.
const sc = (centavos) => ({ statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: centavos, eligibilityConfirmed: true });
const pwd = (centavos) => ({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: centavos, eligibilityConfirmed: true });

const payloadOf = (items, over = {}) => ({
  requestId: rid(), doctorId: DOCTOR, doctorAddressId: CLINIC, requestedDeliveryDate: DELIVERY_DATE, items, ...over,
});
const create = (uid, items, over = {}) =>
  ops.createOrderWithReservation({ db, FieldValue, uid, now: NOW, payload: payloadOf(items, over) });

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
const docs = async (c) => (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function assertNothingWritten(label) {
  for (const c of WRITTEN_BY_ORDER) assert.equal(await size(c), 0, `${label}: no ${c}`);
  for (const id of ["vat", "exempt", "zero"]) {
    assert.equal((await db.collection("inventory").doc(id).get()).data().reservedQuantity, 0, `${label}: ${id} untouched`);
  }
}

/** The order reconciles: negotiated subtotal − discounts = final = VAT parts. */
function assertReconciles(o) {
  const sum = (k) => o.items.reduce((s, i) => s + i[k], 0);
  assert.equal(o.subtotalCentavos, sum("negotiatedGrossCentavos"));
  assert.equal(o.statutoryDiscountTotalCentavos, sum("statutoryDiscountCentavos"));
  assert.equal(o.finalTotalCentavos, sum("finalLineTotalCentavos"));
  assert.equal(o.subtotalCentavos - o.statutoryDiscountTotalCentavos, o.finalTotalCentavos);
  const v = o.vatSummary;
  assert.equal(v.vatableSalesCentavos + v.vatAmountCentavos + v.vatExemptSalesCentavos + v.zeroRatedSalesCentavos, o.finalTotalCentavos);
  assert.equal(v.vatAmountCentavos, sum("lineVatCentavos"));
  for (const i of o.items) {
    assert.equal(i.lineTotalCentavos, i.quantity * i.unitPriceCentavos, "lineTotal stays quantity × unit");
    assert.equal(i.finalLineTotalCentavos, i.negotiatedGrossCentavos - i.statutoryDiscountCentavos);
    assert.equal(i.lineVatCentavos, i.vatClassification === "vatable" ? vatOf(i.finalLineTotalCentavos) : 0);
  }
}

// ---------------------------------------------------------------- happy paths

test("standard price, no discount: no adjustment, no discount, no audits", async () => {
  await seed();
  const r = await create(SR, [line("vat", 2)]);
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.agreedUnitPriceCentavos, STD.vat);
  assert.equal(it.priceNegotiated, false);
  assert.equal(it.statutoryDiscountCentavos, 0);
  assert.equal(it.statutoryDiscountType, null);
  assert.equal(o.finalTotalCentavos, 2 * STD.vat);
  assertReconciles(o);
  assert.equal(await size("orderPriceAdjustments"), 0);
  assert.equal(await size("orderStatutoryDiscounts"), 0);
});

test("negotiated price only: recorded with its own audit", async () => {
  await seed();
  const requestId = rid();
  const r = await ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: payloadOf([line("vat", 3, { agreedUnitPriceCentavos: 110050, negotiationReason: "  Volume  order " })], { requestId }),
  });
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.unitPriceCentavos, 110050);
  assert.equal(it.negotiatedGrossCentavos, 330150);
  assert.equal(it.negotiatedAdjustmentCentavos, -44850);
  assert.equal(it.negotiationReason, "Volume order");
  assert.equal(it.statutoryDiscountCentavos, 0);
  assert.equal(o.priceNegotiated, true);
  assert.equal(o.statutoryDiscountApplied, false);
  assertReconciles(o);
  const [audit] = await docs("orderPriceAdjustments");
  assert.equal(audit.id, `${r.orderId}__0`);
  assert.equal(audit.medRepUid, SR);
  assert.equal(audit.requestId, requestId);
  assert.ok(audit.createdAt instanceof Timestamp);
  assert.equal(await size("orderStatutoryDiscounts"), 0);
  // The batch's standard price is never changed by a negotiation.
  assert.equal((await db.collection("inventory").doc("vat").get()).data().sellingPriceCentavos, STD.vat);
});

test("SC/PWD discount only: VAT extracted after the line discount, with its own audit", async () => {
  await seed();
  const r = await create(SR, [line("vat", 2, sc(50000))]);
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.priceNegotiated, false);
  assert.equal(it.negotiatedGrossCentavos, 250000);
  assert.equal(it.statutoryDiscountCentavos, 50000);
  assert.equal(it.statutoryDiscountType, "senior_citizen");
  assert.equal(it.finalLineTotalCentavos, 200000);
  assert.equal(it.lineVatCentavos, vatOf(200000));
  assert.equal(o.subtotalCentavos, 250000);
  assert.equal(o.statutoryDiscountTotalCentavos, 50000);
  assert.equal(o.finalTotalCentavos, 200000);
  assertReconciles(o);
  assert.equal(await size("orderPriceAdjustments"), 0, "no negotiation, no price audit");
  const [audit] = await docs("orderStatutoryDiscounts");
  assert.equal(audit.id, `${r.orderId}__0`);
  assert.equal(audit.discountType, "senior_citizen");
  assert.equal(audit.discountCentavos, 50000);
  assert.equal(audit.medRepUid, SR);
  assert.ok(audit.createdAt instanceof Timestamp);
  // The Med Rep's eligibility attestation: confirmed, by the verified caller,
  // at server time — recorded as an attestation, not a verification.
  assert.equal(audit.eligibilityConfirmed, true);
  assert.equal(audit.eligibilityVerificationMethod, "med_rep_attestation");
  assert.equal(audit.eligibilityAttestationText, "I confirm that I verified the customer’s eligibility for this statutory discount.");
  assert.equal(audit.eligibilityConfirmedByUid, SR);
  assert.ok(audit.eligibilityConfirmedAt instanceof Timestamp);
  // No identification of the customer is stored anywhere.
  for (const key of Object.keys(audit).filter((k) => k !== "name")) {
    assert.doesNotMatch(key, /id(Number|No)|idCard|photo|image|beneficiary|birth|address/i, key);
  }
  assert.equal(it.eligibilityConfirmed, true);
});

test("both on the same line: two separate figures, two separate audit records", async () => {
  await seed();
  const r = await create(SR, [line("vat", 3, { agreedUnitPriceCentavos: 110000, negotiationReason: "Volume", ...pwd(33000) })]);
  const o = await order(r.orderId);
  const it = o.items[0];
  assert.equal(it.negotiatedAdjustmentCentavos, -45000);
  assert.equal(it.statutoryDiscountCentavos, 33000);
  assert.equal(it.finalLineTotalCentavos, 297000);
  assertReconciles(o);
  const price = await docs("orderPriceAdjustments");
  const disc = await docs("orderStatutoryDiscounts");
  assert.equal(price.length, 1);
  assert.equal(disc.length, 1);
  assert.equal("discountCentavos" in price[0], false);
  assert.equal("negotiatedAdjustmentCentavos" in disc[0], false);
});

test("mixed classes with discounts on selected lines only — no proportional allocation", async () => {
  await seed();
  const r = await create(SR, [
    line("vat", 3, { agreedUnitPriceCentavos: 119999, negotiationReason: "Promo", ...sc(1) }),
    line("exempt", 2),
    line("zero", 5, pwd(10000)),
  ]);
  const o = await order(r.orderId);
  assertReconciles(o);
  assert.deepEqual(o.items.map((i) => i.statutoryDiscountCentavos), [1, 0, 10000]);
  assert.equal(o.items[1].finalLineTotalCentavos, 2 * STD.exempt, "an undiscounted line is untouched");
  assert.equal(o.vatSummary.vatAmountCentavos, vatOf(3 * 119999 - 1));
  assert.equal(o.vatSummary.vatExemptSalesCentavos, 2 * STD.exempt);
  assert.equal(o.vatSummary.zeroRatedSalesCentavos, 5 * STD.zero - 10000);
  assert.equal(await size("orderStatutoryDiscounts"), 2);
  assert.equal(await size("orderPriceAdjustments"), 1);
});

test("a discount equal to the line's negotiated gross is allowed; one centavo more is refused", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1, pwd(STD.vat)), line("exempt", 1)]);
  const o = await order(r.orderId);
  assert.equal(o.items[0].finalLineTotalCentavos, 0);
  assert.equal(o.items[0].lineVatCentavos, 0);
  assertReconciles(o);

  await seed();
  assert.equal(await codeOf(create(SR, [line("vat", 1, pwd(STD.vat + 1))])), "statutory-discount-exceeds-line");
  assert.equal(
    await codeOf(create(SR, [line("vat", 2, { agreedUnitPriceCentavos: 100000, negotiationReason: "x", ...pwd(200001) })])),
    "statutory-discount-exceeds-line",
    "bounded by the NEGOTIATED gross"
  );
  await assertNothingWritten("over the boundary");
});

// ---------------------------------------------------------------- refusals leave nothing

test("refusals leave no order, reservation, key, receipt, history or audit", async (t) => {
  const cases = [
    ["a client line total", [line("vat", 1, { lineTotalCentavos: 1 })], "unknown-field"],
    ["a client final line total", [line("vat", 1, { finalLineTotalCentavos: 1 })], "unknown-field"],
    ["a client line VAT", [line("vat", 1, { lineVatCentavos: 1 })], "unknown-field"],
    ["a client VAT classification", [line("vat", 1, { vatClassification: "vat_exempt" })], "unknown-field"],
    ["a beneficiary ID", [line("vat", 1, { ...sc(100), seniorCitizenId: "1234" })], "unknown-field"],
    ["a missing reason", [line("vat", 1, { agreedUnitPriceCentavos: 100000 })], "negotiation-reason-required"],
    ["a zero agreed price", [line("vat", 1, { agreedUnitPriceCentavos: 0, negotiationReason: "free" })], "invalid-agreed-price"],
    ["a discount without a category", [line("vat", 1, { statutoryDiscountCentavos: 500 })], "statutory-discount-type-required"],
    ["an unknown category", [line("vat", 1, { statutoryDiscountType: "employee", statutoryDiscountCentavos: 500 })], "invalid-statutory-discount"],
    ["an unconfirmed category (NAAC)", [line("vat", 1, { ...pwd(500), statutoryDiscountType: "naac" })], "invalid-statutory-discount"],
    ["an unconfirmed category (Solo Parent)", [line("vat", 1, { ...pwd(500), statutoryDiscountType: "solo_parent" })], "invalid-statutory-discount"],
    ["an unconfirmed category (Medal of Valor)", [line("vat", 1, { ...pwd(500), statutoryDiscountType: "medal_of_valor" })], "invalid-statutory-discount"],
    ["a discount without the attestation", [line("vat", 1, { statutoryDiscountType: "pwd", statutoryDiscountCentavos: 500 })], "eligibility-not-confirmed"],
    ["an attestation of false", [line("vat", 1, { ...pwd(500), eligibilityConfirmed: false })], "eligibility-not-confirmed"],
    ["an attestation of \"true\"", [line("vat", 1, { ...pwd(500), eligibilityConfirmed: "true" })], "eligibility-not-confirmed"],
    ["an attestation of 1", [line("vat", 1, { ...pwd(500), eligibilityConfirmed: 1 })], "eligibility-not-confirmed"],
    ["one unconfirmed line among confirmed ones", [line("vat", 1, pwd(500)), line("exempt", 1, { ...sc(500), eligibilityConfirmed: null })], "eligibility-not-confirmed"],
    ["a fractional discount", [line("vat", 1, pwd(10.5))], "invalid-statutory-discount"],
    ["a negative discount", [line("vat", 1, pwd(-100))], "invalid-statutory-discount"],
  ];
  for (const [label, items, code] of cases) {
    await t.test(label, async () => {
      await seed();
      assert.equal(await codeOf(create(SR, items)), code);
      await assertNothingWritten(label);
    });
  }
  await t.test("client order totals", async () => {
    await seed();
    for (const field of ["subtotalCentavos", "finalTotalCentavos", "statutoryDiscountTotalCentavos", "vatSummary"]) {
      assert.equal(await codeOf(create(SR, [line("vat", 1)], { [field]: 1 })), "unknown-field", field);
    }
    await assertNothingWritten("order totals");
  });
});

test("a standard price changed after review refuses the whole order atomically", async () => {
  await seed();
  await db.collection("inventory").doc("vat").update({ sellingPriceCentavos: 135000 });
  let error;
  try {
    await create(SR, [line("exempt", 1), line("vat", 2, { agreedUnitPriceCentavos: 110000, negotiationReason: "Volume", ...sc(1000) })]);
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "price-changed");
  assert.deepEqual(Object.keys(error.details).sort(), ["batchId", "currentUnitPriceCentavos", "expectedUnitPriceCentavos", "inventoryId"]);
  await assertNothingWritten("stale standard price");

  const r = await create(SR, [line("vat", 2, { expectedUnitPriceCentavos: 135000, agreedUnitPriceCentavos: 110000, negotiationReason: "Volume", ...sc(1000) })]);
  const o = await order(r.orderId);
  assert.equal(o.items[0].standardUnitPriceCentavos, 135000);
  assert.equal(o.items[0].agreedUnitPriceCentavos, 110000);
  assert.equal(o.items[0].statutoryDiscountCentavos, 1000);
});

test("only an approved Med Rep can place an order", async () => {
  await seed();
  const items = [line("vat", 1, { agreedUnitPriceCentavos: 100000, negotiationReason: "Deal", ...sc(500) })];
  for (const uid of [DISPATCHER, RIDER, ADMIN, SR_PENDING, "nobody"]) {
    assert.ok(["wrong-role", "not-approved", "profile-missing"].includes(await codeOf(create(uid, items))), uid);
  }
  await assertNothingWritten("unauthorized");
});

// ---------------------------------------------------------------- idempotency + immutability

test("a repeated request replays the original prices and discounts; a changed discount under the same id is refused", async () => {
  await seed();
  const payload = payloadOf([line("vat", 2, { agreedUnitPriceCentavos: 115000, negotiationReason: "Contract", ...sc(23000) })]);
  const first = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload });
  const [a, b] = await Promise.all([
    ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload }),
    ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload }),
  ]);
  for (const replay of [a, b]) {
    assert.equal(replay.orderId, first.orderId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.pricing.items[0].agreedUnitPriceCentavos, 115000);
    assert.equal(replay.pricing.items[0].statutoryDiscountCentavos, 23000);
    assert.equal(replay.pricing.finalTotalCentavos, 230000 - 23000);
  }
  assert.equal(await size("orders"), 1);
  assert.equal(await size("orderPriceAdjustments"), 1);
  assert.equal(await size("orderStatutoryDiscounts"), 1);

  const changed = { ...payload, items: [line("vat", 2, { agreedUnitPriceCentavos: 115000, negotiationReason: "Contract", ...sc(23001) })] };
  assert.equal(await codeOf(ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload: changed })), "idempotency-conflict");
  assert.equal((await order(first.orderId)).items[0].statutoryDiscountCentavos, 23000);
});

test("another Med Rep's request never touches a placed order", async () => {
  await seed();
  const requestId = rid();
  const mk = (uid, agreed) => ops.createOrderWithReservation({
    db, FieldValue, uid, now: NOW,
    payload: payloadOf([line("vat", 1, { agreedUnitPriceCentavos: agreed, negotiationReason: "Deal" })], { requestId }),
  });
  const mine = await mk(SR, 120000);
  const theirs = await mk(SR2, 90000);
  assert.notEqual(theirs.orderId, mine.orderId);
  assert.equal((await order(mine.orderId)).items[0].agreedUnitPriceCentavos, 120000);
});

test("backordered stock is allocated later at the agreed price and discount", async () => {
  await seed();
  await db.collection("inventory").doc("vat").update({ quantity: 2 });
  const r = await create(SR, [line("vat", 5, { agreedUnitPriceCentavos: 100000, negotiationReason: "Long-term contract", ...sc(50000) })]);
  let o = await order(r.orderId);
  assert.equal(o.items[0].reservedQuantity, 2);
  assert.equal(o.items[0].backorderedQuantity, 3);

  await db.collection("inventory").doc("vat").update({ quantity: 50, sellingPriceCentavos: 150000 });
  await allocateProducts({ db, FieldValue, productKeys: ["vVat"], now: NOW });
  o = await order(r.orderId);
  assert.equal(o.items[0].reservedQuantity, 5);
  assert.equal(o.items[0].agreedUnitPriceCentavos, 100000);
  assert.equal(o.items[0].statutoryDiscountCentavos, 50000);
  assert.equal(o.items[0].finalLineTotalCentavos, 450000);
  assert.equal(o.finalTotalCentavos, 450000);
  assertReconciles(o);
});

test("a re-classified vaccine never changes a placed order's VAT", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1, pwd(5000))]);
  await db.collection("vaccines").doc("vVat").update({ vatClassification: "zero_rated" });
  const o = await order(r.orderId);
  assert.equal(o.items[0].vatClassification, "vatable");
  assert.equal(o.vatSummary.vatAmountCentavos, vatOf(STD.vat - 5000));
});

test("the receipt states what was charged", async () => {
  await seed();
  const r = await create(SR, [line("vat", 2, { agreedUnitPriceCentavos: 110000, negotiationReason: "Volume", ...pwd(22000) }), line("zero", 1)]);
  const o = await order(r.orderId);
  const receipt = (await db.collection("orderReceipts").doc(r.orderId).get()).data();
  assert.equal(receipt.subtotalCentavos, o.subtotalCentavos);
  assert.equal(receipt.discountCentavos, 22000);
  assert.equal(receipt.finalTotalCentavos, o.finalTotalCentavos);
  assert.equal(receipt.vatAmountCentavos, o.vatSummary.vatAmountCentavos);
  assert.equal(receipt.lines[0].unitPriceCentavos, 110000);
  assert.equal(receipt.lines[0].statutoryDiscountCentavos, 22000);
  assert.equal(receipt.lines[0].finalLineTotalCentavos, 198000);
});

// ---------------------------------------------------------------- invoices

const save = (uid, payload) => invoices.saveInvoiceDraftForPricedOrder({ db, FieldValue, uid, payload, now: NOW });
const issue = (uid, payload) => invoices.issueInvoiceForPricedOrder({ db, FieldValue, uid, payload, now: NOW });

test("the invoice bills final charged amounts with no discount line, and adds up exactly", async () => {
  await seed();
  const r = await create(SR, [
    // 2 × ₱1,100.00 − ₱220.01 = ₱1,979.99 — does not divide by 2.
    line("vat", 2, { agreedUnitPriceCentavos: 110000, negotiationReason: "Volume", ...sc(22001) }),
    line("exempt", 1),
    line("zero", 1, pwd(3000)),
  ]);
  const o = await order(r.orderId);
  await db.collection("inventory").doc("vat").update({ sellingPriceCentavos: 999900 });

  // The invoice carries no discount of its own: the SC/PWD discounts are
  // already inside the line amounts. Any invoice discount is refused —
  // including one equal to the recorded per-line total.
  for (const discountCentavos of [100, o.statutoryDiscountTotalCentavos]) {
    assert.equal(
      await codeOf(save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: { discountCentavos } })),
      "discount-recorded-per-line",
      String(discountCentavos)
    );
  }
  await save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: {} });
  const inv = (await db.collection("invoices").doc(r.orderId).get()).data();

  // Line amounts are the order's FINAL charged line totals.
  inv.items.forEach((it, i) => {
    assert.equal(it.lineTotalCentavos, o.items[i].finalLineTotalCentavos, `line ${i}`);
    assert.equal(it.amountIsFinalCharged, true);
    assert.equal("statutoryDiscountCentavos" in it, false, "no discount on the invoice line");
  });
  assert.equal(inv.items[0].lineTotalCentavos, 197999);
  assert.equal(inv.items[0].unitPriceCentavos, null, "no fabricated rounded unit price");
  assert.equal(inv.items[1].unitPriceCentavos, STD.exempt);
  assert.equal(inv.items[2].unitPriceCentavos, STD.zero - 3000);
  assert.equal(inv.lineAmountBasis, "final_charged");
  assert.equal("discountSource" in inv, false);
  assert.equal(inv.discountCentavos, 0);

  // The visible invoice adds up: Σ line amounts = subtotal = VAT breakdown = total.
  const sum = inv.items.reduce((s, it) => s + it.lineTotalCentavos, 0);
  assert.equal(inv.subtotalCentavos, sum);
  assert.equal(inv.totalSalesVatInclusiveCentavos, sum);
  assert.equal(inv.vatableSalesCentavos + inv.vatAmountCentavos + inv.vatExemptSalesCentavos + inv.zeroRatedSalesCentavos, sum);
  assert.equal(inv.grandTotalCentavos, sum);
  assert.equal(inv.grandTotalCentavos, o.finalTotalCentavos);
  assert.equal(inv.finalTotalCentavos, o.finalTotalCentavos);
  // VAT on the final charged amounts, as the order recorded.
  assert.equal(inv.vatAmountCentavos, o.vatSummary.vatAmountCentavos);
  assert.equal(inv.vatableSalesCentavos, o.vatSummary.vatableSalesCentavos);
  assert.equal(inv.vatExemptSalesCentavos, STD.exempt);
  assert.equal(inv.zeroRatedSalesCentavos, STD.zero - 3000);

  // The discount stays internal: on the order and its audit.
  assert.equal(o.items[0].statutoryDiscountCentavos, 22001);
  assert.equal((await docs("orderStatutoryDiscounts")).length, 2);

  await issue(ADMIN, { orderId: r.orderId });
  assert.equal((await db.collection("invoices").doc(r.orderId).get()).data().invoiceStatus, "issued");
});

test("a negotiated order without line discounts saves its invoice; legacy priced orders keep the admin discount", async () => {
  await seed();
  const r = await create(SR, [line("vat", 1, { agreedUnitPriceCentavos: 100000, negotiationReason: "Deal" })]);
  // Negotiation alone does not block the invoice: it saves with no discount.
  await save(ADMIN, { orderId: r.orderId, presentation: {}, adjustments: { discountCentavos: 0 } });
  const inv = (await db.collection("invoices").doc(r.orderId).get()).data();
  assert.equal(inv.discountCentavos, 0);
  assert.equal(inv.grandTotalCentavos, 100000);

  await db.collection("orders").doc("legacyPriced").set({
    orderNumber: "VT-OLD", status: "delivered", pricingVersion: 1, priceCurrency: "PHP", priceIsVatInclusive: true,
    subtotalCentavos: 2 * STD.vat, createdByUid: SR, unit: "vials",
    items: [{ inventoryId: "vat", name: "Hep B", quantity: 2, unitPriceCentavos: STD.vat, lineTotalCentavos: 2 * STD.vat, vatClassification: "vatable" }],
  });
  await save(ADMIN, { orderId: "legacyPriced", presentation: {}, adjustments: { discountCentavos: 1000 } });
  const legacy = (await db.collection("invoices").doc("legacyPriced").get()).data();
  assert.equal(legacy.discountCentavos, 1000);
  assert.equal(legacy.items[0].unitPriceCentavos, STD.vat);
  assert.equal(legacy.items[0].lineTotalCentavos, 2 * STD.vat);
  assert.equal("amountIsFinalCharged" in legacy.items[0], false);
  assert.equal("lineAmountBasis" in legacy, false);
  assert.equal(legacy.grandTotalCentavos, 2 * STD.vat - 1000);
});
