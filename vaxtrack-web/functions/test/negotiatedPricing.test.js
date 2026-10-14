"use strict";

// Negotiated pricing + statutory (SC/PWD) line discounts — pure server rules.

const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("../src/policy");
const N = require("../src/negotiatedPricing");
const {
  allocateDiscountCentavos,
  computeInvoiceTotalsCentavos,
  validateAdjustments,
  buildInvoiceBaseFromOrder,
  baseMatchesOrder,
  ITEMIZED_VAT,
} = require("../src/invoicePricing");
const { splitVatInclusiveCentavos } = require("../src/pricingConfig");

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
};

const line = (over = {}) =>
  N.priceOrderLine({
    quantity: 3,
    standardUnitPriceCentavos: 12500,
    agreedUnitPriceCentavos: 12500,
    negotiationReason: null,
    statutoryDiscountType: null,
    statutoryDiscountCentavos: 0,
    // The Med Rep's attestation; ignored (false) on a line with no discount.
    eligibilityConfirmed: true,
    vatClassification: "vatable",
    ...over,
  });

// ---------------------------------------------------------------- one line

test("standard price, no discount: nothing negotiated, nothing discounted", () => {
  const l = line({ negotiationReason: "ignored" });
  assert.equal(l.priceNegotiated, false);
  assert.equal(l.negotiationReason, null);
  assert.equal(l.negotiatedAdjustmentCentavos, 0);
  assert.equal(l.statutoryDiscountCentavos, 0);
  assert.equal(l.statutoryDiscountType, null);
  assert.equal(l.standardLineTotalCentavos, 37500);
  assert.equal(l.negotiatedGrossCentavos, 37500);
  assert.equal(l.finalLineTotalCentavos, 37500);
  assert.equal(l.lineVatCentavos, splitVatInclusiveCentavos(37500).vatCentavos);
  assert.equal(l.unitPriceCentavos, 12500);
  assert.equal(l.lineTotalCentavos, 37500, "lineTotal stays quantity × unit price");
});

test("negotiated price only", () => {
  const l = line({ agreedUnitPriceCentavos: 11999, negotiationReason: "  bulk   order\n" });
  assert.equal(l.negotiatedGrossCentavos, 35997);
  assert.equal(l.negotiatedAdjustmentCentavos, -1503);
  assert.equal(l.priceNegotiated, true);
  assert.equal(l.negotiationReason, "bulk order");
  assert.equal(l.statutoryDiscountCentavos, 0);
  assert.equal(l.finalLineTotalCentavos, 35997);
  assert.equal(l.unitPriceCentavos, 11999);
  assert.equal(codeOf(() => line({ agreedUnitPriceCentavos: 13000 })), "negotiation-reason-required");
  assert.equal(line({ agreedUnitPriceCentavos: 13000, negotiationReason: "rush" }).negotiatedAdjustmentCentavos, 1500, "higher allowed");
});

test("SC/PWD discount only: subtracted from the line, VAT extracted AFTER it", () => {
  const l = line({ statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 7500 });
  assert.equal(l.priceNegotiated, false);
  assert.equal(l.negotiatedGrossCentavos, 37500);
  assert.equal(l.statutoryDiscountCentavos, 7500);
  assert.equal(l.statutoryDiscountType, "senior_citizen");
  assert.equal(l.finalLineTotalCentavos, 30000);
  assert.equal(l.lineVatCentavos, splitVatInclusiveCentavos(30000).vatCentavos, "12/112 of the discounted amount");
  assert.equal(l.lineNetOfVatCentavos + l.lineVatCentavos, 30000);
});

test("both on the same line, kept as separate figures", () => {
  const l = line({ agreedUnitPriceCentavos: 11000, negotiationReason: "volume", statutoryDiscountType: "pwd", statutoryDiscountCentavos: 6600 });
  assert.equal(l.standardLineTotalCentavos, 37500);
  assert.equal(l.negotiatedGrossCentavos, 33000);
  assert.equal(l.negotiatedAdjustmentCentavos, -4500, "the negotiation alone");
  assert.equal(l.statutoryDiscountCentavos, 6600, "the discount alone");
  assert.equal(l.finalLineTotalCentavos, 26400);
  assert.equal(l.lineVatCentavos, splitVatInclusiveCentavos(26400).vatCentavos);
});

test("exempt and zero-rated lines carry no VAT, discounted or not", () => {
  for (const cls of ["vat_exempt", "zero_rated"]) {
    const l = line({ vatClassification: cls, statutoryDiscountType: "pwd", statutoryDiscountCentavos: 500 });
    assert.equal(l.lineVatCentavos, 0);
    assert.equal(l.lineNetOfVatCentavos, l.finalLineTotalCentavos);
    assert.equal(l.vatRatePercent, 0);
  }
});

test("the discount boundary: equal to the negotiated gross is allowed (₱0.00 line), above is refused", () => {
  const atLimit = line({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 37500 });
  assert.equal(atLimit.finalLineTotalCentavos, 0);
  assert.equal(atLimit.lineVatCentavos, 0);
  assert.equal(codeOf(() => line({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 37501 })), "statutory-discount-exceeds-line");
  // Against the NEGOTIATED gross, not the standard.
  assert.equal(
    codeOf(() => line({ agreedUnitPriceCentavos: 10000, negotiationReason: "r", statutoryDiscountType: "pwd", statutoryDiscountCentavos: 30001 })),
    "statutory-discount-exceeds-line"
  );
});

test("malformed discounts and missing categories are refused", () => {
  for (const bad of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "500", true]) {
    assert.equal(codeOf(() => line({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: bad })), "invalid-statutory-discount", String(bad));
  }
  assert.equal(codeOf(() => line({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 0 })), "invalid-statutory-discount", "a category needs an amount");
  assert.equal(codeOf(() => line({ statutoryDiscountType: null, statutoryDiscountCentavos: 500 })), "statutory-discount-type-required");
  for (const type of ["SC", "senior", "discount", "employee"]) {
    assert.equal(codeOf(() => line({ statutoryDiscountType: type, statutoryDiscountCentavos: 500 })), "invalid-statutory-discount", type);
  }
});

test("only Senior Citizen and PWD are accepted for new orders", () => {
  assert.deepEqual([...P.STATUTORY_DISCOUNT_TYPES], ["senior_citizen", "pwd"]);
  assert.deepEqual([...N.STATUTORY_DISCOUNT_TYPES], ["senior_citizen", "pwd"]);
  // Categories older invoices may print are not introduced for new orders.
  for (const type of ["naac", "medal_of_valor", "solo_parent"]) {
    assert.equal(codeOf(() => line({ statutoryDiscountType: type, statutoryDiscountCentavos: 500 })), "invalid-statutory-discount", type);
    assert.equal(
      codeOf(() => P.validateCreatePayload(item({ statutoryDiscountType: type, statutoryDiscountCentavos: 500, eligibilityConfirmed: true }))),
      "invalid-statutory-discount",
      type
    );
  }
});

test("a discounted line needs the Med Rep's eligibility attestation, exactly true", () => {
  const ok = line({ statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 500 });
  assert.equal(ok.eligibilityConfirmed, true);
  for (const bad of [undefined, null, false, "true", 1, "yes", {}, []]) {
    assert.equal(
      codeOf(() => line({ statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 500, eligibilityConfirmed: bad })),
      "eligibility-not-confirmed",
      String(bad)
    );
    const payload = { statutoryDiscountType: "pwd", statutoryDiscountCentavos: 500 };
    if (bad !== undefined) payload.eligibilityConfirmed = bad;
    assert.equal(codeOf(() => P.validateCreatePayload(item(payload))), "eligibility-not-confirmed", String(bad));
  }
  // A line without a discount needs no attestation, and records none.
  assert.equal(line({ eligibilityConfirmed: undefined }).eligibilityConfirmed, false);
  assert.equal(P.validateCreatePayload(item({})).items[0].eligibilityConfirmed, false);
  // The exact statement the Med Rep confirms.
  assert.equal(P.ELIGIBILITY_ATTESTATION_TEXT, "I confirm that I verified the customer’s eligibility for this statutory discount.");
});

// ---------------------------------------------------------------- the order

const mixed = () => [
  line({ quantity: 7, standardUnitPriceCentavos: 33333, agreedUnitPriceCentavos: 33333, statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 4667 }),
  line({ quantity: 3, standardUnitPriceCentavos: 1999, agreedUnitPriceCentavos: 1899, negotiationReason: "promo" }),
  line({ quantity: 2, standardUnitPriceCentavos: 45050, agreedUnitPriceCentavos: 45050, vatClassification: "vat_exempt", statutoryDiscountType: "pwd", statutoryDiscountCentavos: 9010 }),
  line({ quantity: 11, standardUnitPriceCentavos: 1001, agreedUnitPriceCentavos: 999, negotiationReason: "loyalty", vatClassification: "zero_rated" }),
];

test("a mixed order with discounts on selected lines reconciles to the centavo", () => {
  const lines = mixed();
  const a = N.summarizeAgreement(lines);
  const v = a.vatSummary;
  assert.equal(a.negotiatedSubtotalCentavos, 7 * 33333 + 3 * 1899 + 2 * 45050 + 11 * 999);
  assert.equal(a.statutoryDiscountTotalCentavos, 4667 + 9010);
  assert.equal(a.negotiatedSubtotalCentavos - a.statutoryDiscountTotalCentavos, a.finalTotalCentavos);
  assert.equal(v.vatableSalesCentavos + v.vatAmountCentavos + v.vatExemptSalesCentavos + v.zeroRatedSalesCentavos, a.finalTotalCentavos);
  assert.equal(v.totalCentavos, a.finalTotalCentavos);
  // VAT is the sum of the per-line VAT on each line's FINAL total.
  assert.equal(v.vatAmountCentavos, lines.reduce((s, l) => s + l.lineVatCentavos, 0));
  assert.equal(v.vatAmountCentavos, splitVatInclusiveCentavos(7 * 33333 - 4667).vatCentavos + splitVatInclusiveCentavos(3 * 1899).vatCentavos);
  assert.equal(v.vatExemptSalesCentavos, 2 * 45050 - 9010);
  assert.equal(v.zeroRatedSalesCentavos, 11 * 999);
  assert.equal(a.negotiatedAdjustmentTotalCentavos, 3 * (1899 - 1999) + 11 * (999 - 1001));
  assert.equal(a.priceNegotiated, true);
  assert.equal(a.statutoryDiscountApplied, true);
});

test("no proportional allocation: a discount touches only its own line", () => {
  const plain = mixed().map((l) => ({ ...l }));
  // Lines without a discount are exactly what they would be with no discounts anywhere.
  assert.equal(plain[1].finalLineTotalCentavos, plain[1].negotiatedGrossCentavos);
  assert.equal(plain[3].finalLineTotalCentavos, plain[3].negotiatedGrossCentavos);
  assert.equal(plain[1].lineVatCentavos, line({ quantity: 3, standardUnitPriceCentavos: 1999, agreedUnitPriceCentavos: 1899, negotiationReason: "promo" }).lineVatCentavos);
});

test("rounding is half-up per line at the centavo boundary", () => {
  // 14 × 12 / 112 = 1.5 → 2;  13 → 1;  42 → 5 (4.5);  5 → 1 (0.536);  4 → 0.
  for (const [final, vat] of [[14, 2], [13, 1], [42, 5], [41, 4], [5, 1], [4, 0], [0, 0], [112, 12]]) {
    const l = line({ quantity: 1, standardUnitPriceCentavos: 200, agreedUnitPriceCentavos: 200, statutoryDiscountType: final === 200 ? null : "pwd", statutoryDiscountCentavos: 200 - final });
    assert.equal(l.finalLineTotalCentavos, final);
    assert.equal(l.lineVatCentavos, vat, `final ${final}`);
  }
});

test("no floating-point drift", () => {
  const lines = Array.from({ length: 10 }, () => line({ quantity: 1, standardUnitPriceCentavos: 10, agreedUnitPriceCentavos: 10 }));
  assert.equal(N.summarizeAgreement(lines).finalTotalCentavos, 100);
  assert.notEqual(0.1 + 0.2, 0.3, "the float drift this avoids");
});

// ---------------------------------------------------------------- request shape

const DEST = { doctorId: "doc1", doctorAddressId: "home" };
const item = (over) => ({ ...DEST, items: [{ inventoryId: "a", quantity: 2, expectedUnitPriceCentavos: 12500, ...over }] });

test("the payload accepts agreed price, reason and a line discount — never a total or VAT", () => {
  const v = P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12000, negotiationReason: " volume ", statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 4800, eligibilityConfirmed: true }));
  assert.deepEqual(v.items[0], {
    inventoryId: "a", quantity: 2, expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12000,
    negotiationReason: "volume", statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 4800,
    eligibilityConfirmed: true,
  });
  for (const field of ["lineTotalCentavos", "finalLineTotalCentavos", "negotiatedGrossCentavos", "lineVatCentavos", "vatAmountCentavos", "vatClassification", "unitPriceCentavos", "discountCentavos", "statutoryDiscountId", "seniorCitizenId", "pwdIdNumber", "idCardPhoto", "beneficiaryName"]) {
    assert.equal(codeOf(() => P.validateCreatePayload(item({ [field]: 1 }))), "unknown-field", field);
  }
  for (const field of ["subtotalCentavos", "finalTotalCentavos", "statutoryDiscountTotalCentavos", "vatSummary", "createdByUid", "createdAt", "role"]) {
    assert.equal(codeOf(() => P.validateCreatePayload({ ...item({}), [field]: 1 })), "unknown-field", field);
  }
});

test("the payload refuses bad prices, missing reasons and bad discounts before any read", () => {
  for (const bad of [0, -100, 12.5, "12000", Infinity]) {
    assert.equal(codeOf(() => P.validateCreatePayload(item({ agreedUnitPriceCentavos: bad, negotiationReason: "r" }))), "invalid-agreed-price", String(bad));
  }
  assert.equal(codeOf(() => P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12000 }))), "negotiation-reason-required");
  assert.equal(codeOf(() => P.validateCreatePayload(item({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 25001, eligibilityConfirmed: true }))), "statutory-discount-exceeds-line");
  assert.equal(codeOf(() => P.validateCreatePayload(item({ statutoryDiscountCentavos: 100, eligibilityConfirmed: true }))), "statutory-discount-type-required");
  assert.equal(codeOf(() => P.validateCreatePayload(item({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 10.5, eligibilityConfirmed: true }))), "invalid-statutory-discount");
  // Reset to standard: no reason kept.
  assert.equal(P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12500, negotiationReason: "old note" })).items[0].negotiationReason, null);
});

test("the idempotency fingerprint covers agreed price, reason and the discount", () => {
  const base = { uid: "u", doctorId: "d", doctorAddressId: "home" };
  const fp = (over) => P.canonicalRequestFingerprint({ ...base, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100, ...over }] });
  assert.notEqual(fp({ agreedUnitPriceCentavos: 90, negotiationReason: "r" }), fp({ agreedUnitPriceCentavos: 80, negotiationReason: "r" }));
  assert.notEqual(fp({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 10 }), fp({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 20 }));
  assert.notEqual(fp({ statutoryDiscountType: "pwd", statutoryDiscountCentavos: 10 }), fp({ statutoryDiscountType: "senior_citizen", statutoryDiscountCentavos: 10 }));
  assert.equal(fp({}), fp({ agreedUnitPriceCentavos: 100, negotiationReason: null, statutoryDiscountType: null, statutoryDiscountCentavos: 0 }));
});

// ---------------------------------------------------------------- audits

test("the two audit records are distinct and carry actor, type, amount, line, time and request", () => {
  const l = { ...line({ agreedUnitPriceCentavos: 11000, negotiationReason: "deal", statutoryDiscountType: "pwd", statutoryDiscountCentavos: 3300 }), inventoryId: "inv", batchId: "B1", productKey: "v1", sku: "VXT-001-AAAAA", name: "Hep B", quantity: 3 };
  const args = { orderId: "o1", orderNumber: "VT-1", lineIndex: 2, line: l, uid: "rep1", requestId: "req-123", FieldValue: { serverTimestamp: () => "__SERVER_TIME__" } };
  const price = N.priceAdjustmentAuditRecord(args);
  const disc = N.statutoryDiscountAuditRecord(args);
  for (const rec of [price, disc]) {
    assert.equal(rec.medRepUid, "rep1");
    assert.equal(rec.createdAt, "__SERVER_TIME__");
    assert.equal(rec.requestId, "req-123");
    assert.equal(rec.lineIndex, 2);
    assert.equal(rec.inventoryId, "inv");
  }
  assert.equal(price.negotiatedAdjustmentCentavos, -4500);
  assert.equal(price.negotiationReason, "deal");
  assert.equal("discountCentavos" in price, false, "the price audit holds no discount");
  assert.equal(disc.discountType, "pwd");
  assert.equal(disc.discountCentavos, 3300);
  assert.equal(disc.finalLineTotalCentavos, 29700);
  assert.equal("negotiatedAdjustmentCentavos" in disc, false, "the discount audit holds no negotiation");
  // The Med Rep's eligibility ATTESTATION: what was confirmed, by whom, when —
  // recorded as an attestation, not as a verification.
  assert.equal(disc.eligibilityConfirmed, true);
  assert.equal(disc.eligibilityVerificationMethod, "med_rep_attestation");
  assert.equal(disc.eligibilityAttestationText, P.ELIGIBILITY_ATTESTATION_TEXT);
  assert.equal(disc.eligibilityConfirmedByUid, "rep1");
  assert.equal(disc.eligibilityConfirmedAt, "__SERVER_TIME__");
  assert.equal("eligibilityConfirmed" in price, false, "the price audit holds no attestation");
  // No beneficiary identification is recorded.
  // (`name` is the vaccine product's name, not a person's.)
  for (const key of Object.keys(disc).filter((k) => k !== "name")) {
    assert.doesNotMatch(key, /id(Number|No)|idCard|photo|image|beneficiary|name|birth|address|^tin$/i, key);
  }
});

// ---------------------------------------------------------------- invoices

const agreementOrder = (lines) => {
  const a = N.summarizeAgreement(lines);
  return {
    pricingVersion: 1, priceIsVatInclusive: true, priceCurrency: "PHP",
    subtotalCentavos: a.negotiatedSubtotalCentavos,
    ...a,
    items: lines.map((l, i) => ({ inventoryId: `inv${i}`, name: `V${i}`, quantity: l.negotiatedGrossCentavos / l.agreedUnitPriceCentavos, ...l })),
  };
};

// The visible invoice: line amounts → subtotal → VAT breakdown → total, with
// no discount line. Everything a reader can add up, from the printed figures.
function assertVisibleInvoiceAddsUp(base, t) {
  const amounts = base.items.map((it) => it.lineTotalCentavos);
  const sum = amounts.reduce((s, a) => s + a, 0);
  assert.equal(sum, base.subtotalCentavos, "Σ printed line amounts = subtotal");
  assert.equal(t.totalSalesVatInclusiveCentavos, sum, "Total Sales (VAT inclusive) = Σ printed line amounts");
  assert.equal(t.vatableSalesCentavos + t.vatAmountCentavos + t.vatExemptSalesCentavos + t.zeroRatedSalesCentavos, sum, "VAT breakdown = Σ printed line amounts");
  assert.equal(t.grandTotalCentavos, sum, "total = Σ printed line amounts");
  for (const it of base.items) {
    // A shown unit price always multiplies out to the shown amount.
    if (it.unitPriceCentavos !== null) assert.equal(it.unitPriceCentavos * it.quantity, it.lineTotalCentavos);
    assert.equal(it.amount, it.lineTotalCentavos / 100);
  }
}

const invoiceFor = (order) => {
  const base = buildInvoiceBaseFromOrder(order);
  const adjustments = validateAdjustments({}, base.subtotalCentavos, { itemizedVat: true, recordedDiscountCentavos: base.recordedDiscountCentavos });
  const totals = computeInvoiceTotalsCentavos({ subtotalCentavos: base.subtotalCentavos, items: base.items, adjustments, priceIsVatInclusive: true, lineLevel: base.lineLevel });
  return { base, adjustments, totals };
};

test("the invoice shows final charged amounts, no discount line, and adds up exactly", () => {
  const order = agreementOrder(mixed());
  const { base, adjustments, totals: t } = invoiceFor(order);
  assert.equal(base.lineLevel, true);
  assert.equal(base.recordedDiscountCentavos, 0);
  assert.equal(adjustments.discountCentavos, 0, "no invoice discount");
  // Each line's amount is its FINAL charged total (finalLineTotalCentavos).
  base.items.forEach((it, i) => {
    assert.equal(it.lineTotalCentavos, order.items[i].finalLineTotalCentavos, `line ${i}`);
    assert.equal(it.amountIsFinalCharged, true);
    for (const hidden of ["statutoryDiscountCentavos", "statutoryDiscountType", "finalLineTotalCentavos"]) {
      assert.equal(hidden in it, false, `the invoice line carries no ${hidden}`);
    }
  });
  assert.equal(base.subtotalCentavos, order.finalTotalCentavos);
  assert.equal(t.grandTotalCentavos, order.finalTotalCentavos);
  // The same figures the order recorded after discounts.
  assert.equal(t.vatAmountCentavos, order.vatSummary.vatAmountCentavos);
  assert.equal(t.vatableSalesCentavos, order.vatSummary.vatableSalesCentavos);
  assert.equal(t.vatExemptSalesCentavos, order.vatSummary.vatExemptSalesCentavos);
  assert.equal(t.zeroRatedSalesCentavos, order.vatSummary.zeroRatedSalesCentavos);
  assertVisibleInvoiceAddsUp(base, t);
  assert.ok(baseMatchesOrder({ ...base, items: base.items }, base));
});

test("no fabricated unit price: shown only when the charged amount divides exactly", () => {
  // 7 × ₱333.33 − ₱46.67 = ₱2,286.64 — not divisible by 7.
  // 2 × ₱450.50 − ₱90.10 = ₱810.90 — divisible: ₱405.45.
  const order = agreementOrder(mixed());
  const { base, totals } = invoiceFor(order);
  assert.equal(base.items[0].lineTotalCentavos, 228664);
  assert.equal(base.items[0].unitPriceCentavos, null, "never a rounded ₱326.66 × 7 = ₱2,286.62");
  assert.equal(base.items[0].unitPrice, null);
  assert.equal(base.items[2].unitPriceCentavos, 40545);
  assert.equal(base.items[1].unitPriceCentavos, 1899, "undiscounted: the agreed price");
  assert.equal(base.items[3].unitPriceCentavos, 999);
  assertVisibleInvoiceAddsUp(base, totals);
});

test("a ₱0.00 line (discount = its whole amount) still adds up", () => {
  const order = agreementOrder([
    line({ quantity: 2, statutoryDiscountType: "pwd", statutoryDiscountCentavos: 25000 }),
    line({ quantity: 1 }),
  ]);
  const { base, totals } = invoiceFor(order);
  assert.equal(base.items[0].lineTotalCentavos, 0);
  assert.equal(base.items[0].unitPriceCentavos, 0);
  assertVisibleInvoiceAddsUp(base, totals);
  assert.equal(totals.grandTotalCentavos, 12500);
});

test("an agreement invoice refuses any invoice discount; legacy invoices keep theirs", () => {
  const order = agreementOrder(mixed());
  const base = buildInvoiceBaseFromOrder(order);
  for (const sent of [1, order.statutoryDiscountTotalCentavos]) {
    assert.equal(
      codeOf(() => validateAdjustments({ discountCentavos: sent }, base.subtotalCentavos, { itemizedVat: true, recordedDiscountCentavos: base.recordedDiscountCentavos })),
      "discount-recorded-per-line",
      String(sent)
    );
  }
  assert.doesNotThrow(() => validateAdjustments({ discountCentavos: 0 }, base.subtotalCentavos, { itemizedVat: true, recordedDiscountCentavos: 0 }));
  // A legacy server-priced order (no agreement): the admin's invoice discount
  // works exactly as before, its lines at quantity × unit price.
  const legacy = { pricingVersion: 1, priceIsVatInclusive: true, priceCurrency: "PHP", subtotalCentavos: 33000, priceNegotiated: true,
    items: [{ inventoryId: "a", name: "A", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, vatClassification: "vatable" }] };
  const lb = buildInvoiceBaseFromOrder(legacy);
  assert.equal(lb.lineLevel, false);
  assert.equal(lb.recordedDiscountCentavos, null);
  assert.equal(lb.items[0].unitPriceCentavos, 11000);
  assert.equal(lb.items[0].lineTotalCentavos, 33000);
  assert.equal("amountIsFinalCharged" in lb.items[0], false);
  const adj = validateAdjustments({ discountCentavos: 500 }, lb.subtotalCentavos, { itemizedVat: true, recordedDiscountCentavos: lb.recordedDiscountCentavos });
  assert.equal(adj.discountCentavos, 500);
  const lt = computeInvoiceTotalsCentavos({ subtotalCentavos: lb.subtotalCentavos, items: lb.items, adjustments: adj, priceIsVatInclusive: true });
  assert.equal(lt.grandTotalCentavos, 32500);
});

test("the order receipt path (gross lines + their discounts) reconciles to the same total", () => {
  const order = agreementOrder(mixed());
  const t = computeInvoiceTotalsCentavos({
    subtotalCentavos: order.subtotalCentavos,
    items: order.items.map((it) => ({ vatClassification: it.vatClassification, lineTotalCentavos: it.lineTotalCentavos, statutoryDiscountCentavos: it.statutoryDiscountCentavos })),
    adjustments: { discountCentavos: order.statutoryDiscountTotalCentavos, otherChargesCentavos: 0, withholdingTaxCentavos: 0, vatClassification: ITEMIZED_VAT },
    priceIsVatInclusive: true,
    lineLevel: true,
  });
  assert.equal(t.grandTotalCentavos, order.finalTotalCentavos);
  assert.equal(t.vatAmountCentavos, invoiceFor(order).totals.vatAmountCentavos);
});

test("a tampered per-line discount, final total or VAT is refused at invoicing", () => {
  const good = agreementOrder(mixed());
  for (const patch of [
    { statutoryDiscountCentavos: 1 },
    { finalLineTotalCentavos: 1 },
    { lineVatCentavos: 1 },
    { statutoryDiscountType: "employee" },
    { statutoryDiscountType: "naac" },
  ]) {
    const bad = { ...good, items: good.items.map((it, i) => (i === 0 ? { ...it, ...patch } : it)) };
    assert.equal(codeOf(() => buildInvoiceBaseFromOrder(bad)), "order-snapshot-invalid", JSON.stringify(patch));
  }
  assert.equal(codeOf(() => buildInvoiceBaseFromOrder({ ...good, finalTotalCentavos: good.finalTotalCentavos + 1 })), "order-snapshot-invalid");
  assert.equal(codeOf(() => buildInvoiceBaseFromOrder({ ...good, statutoryDiscountTotalCentavos: 0 })), "order-snapshot-invalid");
  // A stored invoice line whose amount was edited no longer matches the order.
  const base = buildInvoiceBaseFromOrder(good);
  const tampered = { ...base, items: base.items.map((it, i) => (i === 0 ? { ...it, lineTotalCentavos: it.lineTotalCentavos + 1 } : it)) };
  assert.equal(baseMatchesOrder(tampered, base), false);
});

test("the three-bucket split for legacy invoice discounts is unchanged", () => {
  for (let d = 0; d <= 3000; d += 13) {
    const s = allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 700, zeroRatedGrossCentavos: 1300, discountCentavos: d });
    assert.equal(s.vatableCentavos + s.vatExemptCentavos + s.zeroRatedCentavos, d, `d=${d}`);
  }
  assert.deepEqual(
    allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 500, discountCentavos: 100 }),
    { vatableCentavos: 67, vatExemptCentavos: 33, zeroRatedCentavos: 0 }
  );
  assert.equal(ITEMIZED_VAT, "per_item");
});
