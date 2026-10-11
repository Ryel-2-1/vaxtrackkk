"use strict";

// Negotiated (agreed) order pricing — pure server rules.

const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("../src/policy");
const N = require("../src/negotiatedPricing");
const {
  allocateDiscountCentavos,
  computeInvoiceTotalsCentavos,
  validateAdjustments,
  buildInvoiceBaseFromOrder,
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
    adjustmentReason: null,
    vatClassification: "vatable",
    ...over,
  });

// ---------------------------------------------------------------- one line

test("a line at its standard price carries no adjustment and no reason", () => {
  const l = line({ adjustmentReason: "ignored" });
  assert.equal(l.priceAdjusted, false);
  assert.equal(l.adjustmentReason, null);
  assert.equal(l.adjustmentCentavos, 0);
  assert.equal(l.standardLineTotalCentavos, 37500);
  assert.equal(l.agreedLineTotalCentavos, 37500);
  assert.equal(l.unitPriceCentavos, 12500, "the charged price is the agreed one");
  assert.equal(l.lineTotalCentavos, 37500);
  assert.equal(l.vatRatePercent, 12);
});

test("a lower negotiated price: integer totals, signed adjustment, normalized reason", () => {
  const l = line({ agreedUnitPriceCentavos: 11999, adjustmentReason: "  bulk   order\n" });
  assert.equal(l.agreedLineTotalCentavos, 35997);
  assert.equal(l.standardLineTotalCentavos, 37500);
  assert.equal(l.adjustmentCentavos, -1503);
  assert.equal(l.priceAdjusted, true);
  assert.equal(l.adjustmentReason, "bulk order");
  assert.equal(l.unitPriceCentavos, 11999);
  assert.equal(l.lineTotalCentavos, 35997);
});

test("a higher negotiated price is allowed (no business maximum) and still needs a reason", () => {
  const l = line({ agreedUnitPriceCentavos: 13000, adjustmentReason: "rush delivery" });
  assert.equal(l.adjustmentCentavos, 1500);
  assert.equal(codeOf(() => line({ agreedUnitPriceCentavos: 13000 })), "adjustment-reason-required");
});

test("a changed price without a reason is refused; blank and whitespace count as missing", () => {
  for (const reason of [undefined, null, "", "   ", "\n\t"]) {
    assert.equal(codeOf(() => line({ agreedUnitPriceCentavos: 10000, adjustmentReason: reason })), "adjustment-reason-required");
  }
  assert.equal(codeOf(() => line({ agreedUnitPriceCentavos: 10000, adjustmentReason: "x".repeat(501) })), "reason-too-long");
});

test("₱0.00, negative, fractional and unsafe agreed prices are refused", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "12500"]) {
    assert.equal(codeOf(() => line({ agreedUnitPriceCentavos: bad, adjustmentReason: "r" })), "invalid-agreed-price", String(bad));
  }
  // A line total past exact-integer range is refused, not silently wrong.
  assert.equal(
    codeOf(() => line({ quantity: 1000, agreedUnitPriceCentavos: Number.MAX_SAFE_INTEGER, adjustmentReason: "r" })),
    "line-total-out-of-range"
  );
});

test("each classification is snapshotted with its rate", () => {
  assert.equal(line({ vatClassification: "vat_exempt" }).vatRatePercent, 0);
  assert.equal(line({ vatClassification: "zero_rated" }).vatRatePercent, 0);
  assert.equal(codeOf(() => line({ vatClassification: "VAT" })), "vat-classification-required");
});

// ---------------------------------------------------------------- VAT breakdown

test("VATable: VAT = round½↑(gross × 12 / 112), sales = gross − VAT", () => {
  const s = N.summarizeOrderVat([{ vatClassification: "vatable", agreedLineTotalCentavos: 112000 }]);
  assert.deepEqual(s, {
    vatRatePercent: 12,
    vatableGrossCentavos: 112000,
    vatableSalesCentavos: 100000,
    vatAmountCentavos: 12000,
    vatExemptSalesCentavos: 0,
    zeroRatedSalesCentavos: 0,
    totalCentavos: 112000,
  });
});

test("VAT Exempt and Zero-Rated carry no VAT and keep their own buckets", () => {
  const exempt = N.summarizeOrderVat([{ vatClassification: "vat_exempt", agreedLineTotalCentavos: 50000 }]);
  assert.equal(exempt.vatAmountCentavos, 0);
  assert.equal(exempt.vatExemptSalesCentavos, 50000);
  assert.equal(exempt.zeroRatedSalesCentavos, 0);
  const zero = N.summarizeOrderVat([{ vatClassification: "zero_rated", agreedLineTotalCentavos: 50000 }]);
  assert.equal(zero.vatAmountCentavos, 0);
  assert.equal(zero.zeroRatedSalesCentavos, 50000);
  assert.equal(zero.vatExemptSalesCentavos, 0);
});

test("rounding is half-up at the centavo boundary, in integers", () => {
  // 14 × 12 / 112 = 1.5 exactly → 2;  13 → 1.39 → 1;  42 → 4.5 → 5;  5 → 0.536 → 1;  1 → 0.107 → 0.
  for (const [gross, vat] of [[14, 2], [13, 1], [42, 5], [41, 4], [5, 1], [4, 0], [1, 0], [0, 0], [112, 12], [28, 3]]) {
    assert.equal(splitVatInclusiveCentavos(gross).vatCentavos, vat, `gross ${gross}`);
    const s = N.summarizeOrderVat([{ vatClassification: "vatable", agreedLineTotalCentavos: gross }]);
    assert.equal(s.vatAmountCentavos, vat);
    assert.equal(s.vatableSalesCentavos + s.vatAmountCentavos, gross, "parts sum to the gross");
  }
});

test("a mixed order reconciles to the exact total, rounding once on the VATable aggregate", () => {
  const lines = [
    line({ quantity: 7, standardUnitPriceCentavos: 33333, agreedUnitPriceCentavos: 33333 }),
    line({ quantity: 3, standardUnitPriceCentavos: 1999, agreedUnitPriceCentavos: 1899, adjustmentReason: "promo", vatClassification: "vatable" }),
    line({ quantity: 2, standardUnitPriceCentavos: 45050, agreedUnitPriceCentavos: 45050, vatClassification: "vat_exempt" }),
    line({ quantity: 11, standardUnitPriceCentavos: 1001, agreedUnitPriceCentavos: 999, adjustmentReason: "loyalty", vatClassification: "zero_rated" }),
  ];
  const a = N.summarizeAgreement(lines);
  const v = a.vatSummary;
  assert.equal(v.vatableGrossCentavos, 7 * 33333 + 3 * 1899);
  assert.equal(v.vatAmountCentavos, splitVatInclusiveCentavos(v.vatableGrossCentavos).vatCentavos, "one rounding, on the aggregate");
  assert.equal(v.vatExemptSalesCentavos, 90100);
  assert.equal(v.zeroRatedSalesCentavos, 10989);
  assert.equal(v.vatableSalesCentavos + v.vatAmountCentavos + v.vatExemptSalesCentavos + v.zeroRatedSalesCentavos, a.subtotalCentavos);
  assert.equal(v.totalCentavos, a.subtotalCentavos);
  assert.equal(a.standardSubtotalCentavos, 7 * 33333 + 3 * 1999 + 2 * 45050 + 11 * 1001);
  assert.equal(a.priceAdjustmentCentavos, a.subtotalCentavos - a.standardSubtotalCentavos);
  assert.equal(a.priceAdjusted, true);
  assert.equal(a.priceAgreementVersion, N.PRICE_AGREEMENT_VERSION);
});

test("no floating-point drift: 0.10-peso steps sum exactly", () => {
  const lines = Array.from({ length: 10 }, () => line({ quantity: 1, standardUnitPriceCentavos: 10, agreedUnitPriceCentavos: 10 }));
  assert.equal(N.summarizeAgreement(lines).subtotalCentavos, 100);
  assert.notEqual(0.1 + 0.2, 0.3, "the float drift this avoids");
});

// ---------------------------------------------------------------- request shape

const DEST = { doctorId: "doc1", doctorAddressId: "home" };

test("the payload accepts an agreed unit price and reason — never a total or VAT", () => {
  const v = P.validateCreatePayload({
    ...DEST,
    items: [{ inventoryId: "a", quantity: 2, expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12000, adjustmentReason: " volume " }],
  });
  assert.deepEqual(v.items[0], { inventoryId: "a", quantity: 2, expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12000, adjustmentReason: "volume" });
  for (const field of ["lineTotalCentavos", "agreedLineTotalCentavos", "vatAmountCentavos", "vatClassification", "unitPriceCentavos", "subtotalCentavos"]) {
    assert.equal(
      codeOf(() => P.validateCreatePayload({ ...DEST, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 1, [field]: 1 }] })),
      "unknown-field",
      field
    );
  }
  for (const field of ["subtotalCentavos", "totalCentavos", "vatSummary", "createdByUid", "createdAt", "role"]) {
    assert.equal(
      codeOf(() => P.validateCreatePayload({ ...DEST, [field]: 1, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 1 }] })),
      "unknown-field",
      field
    );
  }
});

test("the payload refuses a malformed agreed price and a changed price without a reason", () => {
  const item = (over) => ({ ...DEST, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 12500, ...over }] });
  for (const bad of [0, -100, 12.5, "12000", Infinity]) {
    assert.equal(codeOf(() => P.validateCreatePayload(item({ agreedUnitPriceCentavos: bad, adjustmentReason: "r" }))), "invalid-agreed-price", String(bad));
  }
  assert.equal(codeOf(() => P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12000 }))), "adjustment-reason-required");
  assert.equal(codeOf(() => P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12000, adjustmentReason: 5 }))), "invalid-payload");
  // Reset to standard: no reason needed, and none kept.
  assert.equal(P.validateCreatePayload(item({ agreedUnitPriceCentavos: 12500, adjustmentReason: "old note" })).items[0].adjustmentReason, null);
});

test("the idempotency fingerprint covers the agreed price and reason", () => {
  const base = { uid: "u", doctorId: "d", doctorAddressId: "home" };
  const fp = (over) => P.canonicalRequestFingerprint({ ...base, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100, ...over }] });
  assert.notEqual(fp({ agreedUnitPriceCentavos: 90, adjustmentReason: "r" }), fp({ agreedUnitPriceCentavos: 80, adjustmentReason: "r" }));
  assert.notEqual(fp({ agreedUnitPriceCentavos: 90, adjustmentReason: "r" }), fp({ agreedUnitPriceCentavos: 90, adjustmentReason: "s" }));
  // An older client (no agreed price) equals an explicit standard-price request.
  assert.equal(fp({}), fp({ agreedUnitPriceCentavos: 100, adjustmentReason: null }));
});

// ---------------------------------------------------------------- audit + compatibility

test("the audit record names the actor and request, with server time", () => {
  const l = { ...line({ agreedUnitPriceCentavos: 11000, adjustmentReason: "deal" }), inventoryId: "inv", batchId: "B1", productKey: "v1", sku: "VXT-001-AAAAA", name: "Hep B", quantity: 3 };
  const rec = N.priceAdjustmentAuditRecord({
    orderId: "o1", orderNumber: "VT-1", lineIndex: 2, line: l, uid: "rep1", requestId: "req-123",
    FieldValue: { serverTimestamp: () => "__SERVER_TIME__" },
  });
  assert.equal(rec.medRepUid, "rep1");
  assert.equal(rec.createdAt, "__SERVER_TIME__");
  assert.equal(rec.requestId, "req-123");
  assert.equal(rec.adjustmentCentavos, -4500);
  assert.equal(rec.adjustmentReason, "deal");
  assert.equal(N.priceAdjustmentAuditId("o1", 2), "o1__2");
});

test("legacy orders read as standard-priced; only a negotiated order is flagged", () => {
  assert.equal(N.orderHasNegotiatedPrice({ pricingVersion: 1, items: [{ unitPriceCentavos: 1 }] }), false);
  assert.equal(N.orderHasNegotiatedPrice({ priceAgreementVersion: 1, priceAdjusted: false, items: [] }), false);
  assert.equal(N.orderHasNegotiatedPrice({ priceAgreementVersion: 1, priceAdjusted: true, items: [] }), true);
});

// ---------------------------------------------------------------- invoice: no double discount

const pricedOrder = (over = {}) => ({
  pricingVersion: 1,
  priceIsVatInclusive: true,
  priceCurrency: "PHP",
  subtotalCentavos: 33000,
  items: [{ inventoryId: "a", name: "Hep B", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, vatClassification: "vatable" }],
  ...over,
});

test("a negotiated order cannot also take an invoice discount", () => {
  const negotiated = buildInvoiceBaseFromOrder(pricedOrder({ priceAgreementVersion: 1, priceAdjusted: true }));
  assert.equal(negotiated.priceNegotiated, true);
  assert.equal(
    codeOf(() => validateAdjustments({ discountCentavos: 100 }, negotiated.subtotalCentavos, { itemizedVat: true, priceNegotiated: true })),
    "discount-not-allowed-negotiated"
  );
  // Zero discount, other charges and withholding stay available.
  assert.doesNotThrow(() => validateAdjustments({ discountCentavos: 0, otherChargesCentavos: 500 }, negotiated.subtotalCentavos, { itemizedVat: true, priceNegotiated: true }));
  // A standard-priced order (old or new) keeps the existing invoice discount.
  const standard = buildInvoiceBaseFromOrder(pricedOrder({ priceAgreementVersion: 1, priceAdjusted: false }));
  assert.equal(standard.priceNegotiated, false);
  assert.doesNotThrow(() => validateAdjustments({ discountCentavos: 100 }, standard.subtotalCentavos, { itemizedVat: true }));
  assert.equal(buildInvoiceBaseFromOrder(pricedOrder()).priceNegotiated, false, "legacy order");
});

test("the invoice is built from the agreed snapshot and itemizes zero-rated sales", () => {
  const order = pricedOrder({
    priceAgreementVersion: 1,
    priceAdjusted: true,
    subtotalCentavos: 33000 + 20000 + 15000,
    items: [
      { inventoryId: "a", name: "A", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, standardUnitPriceCentavos: 12500, vatClassification: "vatable" },
      { inventoryId: "b", name: "B", quantity: 2, unitPriceCentavos: 10000, lineTotalCentavos: 20000, vatClassification: "vat_exempt" },
      { inventoryId: "c", name: "C", quantity: 1, unitPriceCentavos: 15000, lineTotalCentavos: 15000, vatClassification: "zero_rated" },
    ],
  });
  const base = buildInvoiceBaseFromOrder(order);
  assert.equal(base.items[0].unitPriceCentavos, 11000, "agreed, never the standard");
  assert.equal(base.itemizedVat, true);
  const totals = computeInvoiceTotalsCentavos({
    subtotalCentavos: base.subtotalCentavos,
    items: base.items,
    adjustments: { discountCentavos: 0, otherChargesCentavos: 0, withholdingTaxCentavos: 0, vatClassification: ITEMIZED_VAT },
    priceIsVatInclusive: true,
  });
  assert.equal(totals.vatAmountCentavos, splitVatInclusiveCentavos(33000).vatCentavos);
  assert.equal(totals.vatExemptSalesCentavos, 20000);
  assert.equal(totals.zeroRatedSalesCentavos, 15000);
  assert.equal(totals.grandTotalCentavos, 68000, "the agreed total, no discount line");
  assert.equal(totals.vatableSalesCentavos + totals.vatAmountCentavos + totals.vatExemptSalesCentavos + totals.zeroRatedSalesCentavos, 68000);
});

test("the three-bucket discount split sums exactly and matches the two-bucket rule without zero-rated", () => {
  for (let d = 0; d <= 3000; d += 13) {
    const s = allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 700, zeroRatedGrossCentavos: 1300, discountCentavos: d });
    assert.equal(s.vatableCentavos + s.vatExemptCentavos + s.zeroRatedCentavos, d, `d=${d}`);
    assert.ok(s.vatableCentavos <= 1000 && s.vatExemptCentavos <= 700 && s.zeroRatedCentavos <= 1300);
  }
  assert.deepEqual(
    allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 500, discountCentavos: 100 }),
    { vatableCentavos: 67, vatExemptCentavos: 33, zeroRatedCentavos: 0 }
  );
});
