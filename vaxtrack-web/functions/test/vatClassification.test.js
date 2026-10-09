"use strict";

// Per-item VAT: product classification resolved at order time, and invoice
// totals derived from the item snapshots (12% on VATable sales only, discount
// split pro-rata). The emulator suite proves the order-time refusal leaves
// nothing behind; these cases pin the arithmetic and the decisions.

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveLineVatClassification, PRICING_VERSION, PRICE_CURRENCY } = require("../src/policy");
const {
  ITEMIZED_VAT,
  allocateDiscountCentavos,
  baseMatchesOrder,
  buildInvoiceBaseFromOrder,
  computeInvoiceTotalsCentavos,
  validateAdjustments,
} = require("../src/invoicePricing");

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return e.code; }
};

// ---------------------------------------------------------------- order time

test("an order line takes its vaccine's classification, never a guess", () => {
  const batch = { vaccineId: "v1" };
  assert.equal(resolveLineVatClassification({ inventoryId: "b", batch, vaccine: { vatClassification: "vatable" } }), "vatable");
  assert.equal(resolveLineVatClassification({ inventoryId: "b", batch, vaccine: { vatClassification: "vat_exempt" } }), "vat_exempt");
  for (const [b, v] of [
    [{ vaccineId: "v1" }, { vaccineName: "legacy" }], // unclassified product
    [{ vaccineId: "v1" }, { vatClassification: "zero_rated" }], // not a product value
    [{ vaccineId: "v1" }, { vatClassification: "VAT" }],
    [{ vaccineId: "v1" }, null], // product missing
    [{}, { vatClassification: "vatable" }], // batch not linked to a product
    [null, null],
  ]) {
    assert.equal(codeOf(() => resolveLineVatClassification({ inventoryId: "b", batch: b, vaccine: v })), "vat-classification-required");
  }
});

// ---------------------------------------------------------------- discount split

test("a discount splits pro-rata, sums exactly, and the remainder goes to the larger share", () => {
  // 1000 / 500 gross, ₱1.00 discount → 66.67 / 33.33 → 67 (larger) / 33.
  assert.deepEqual(allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 500, discountCentavos: 100 }), { vatableCentavos: 67, vatExemptCentavos: 33 });
  // Exempt is larger → it takes the remainder.
  assert.deepEqual(allocateDiscountCentavos({ vatableGrossCentavos: 500, vatExemptGrossCentavos: 1000, discountCentavos: 100 }), { vatableCentavos: 33, vatExemptCentavos: 67 });
  // Tie → VATable takes it.
  assert.deepEqual(allocateDiscountCentavos({ vatableGrossCentavos: 500, vatExemptGrossCentavos: 500, discountCentavos: 101 }), { vatableCentavos: 51, vatExemptCentavos: 50 });
  // Nothing to split.
  assert.deepEqual(allocateDiscountCentavos({ vatableGrossCentavos: 500, vatExemptGrossCentavos: 0, discountCentavos: 0 }), { vatableCentavos: 0, vatExemptCentavos: 0 });
  // Huge figures stay exact (BigInt multiplication).
  const big = allocateDiscountCentavos({ vatableGrossCentavos: 4_000_000_000_000_000, vatExemptGrossCentavos: 1_000_000_000_000_000, discountCentavos: 3_000_000_000_000_003 });
  assert.equal(big.vatableCentavos + big.vatExemptCentavos, 3_000_000_000_000_003);
  // Never exceeds its own gross, for any discount up to the subtotal.
  for (let d = 0; d <= 1500; d += 7) {
    const s = allocateDiscountCentavos({ vatableGrossCentavos: 1000, vatExemptGrossCentavos: 500, discountCentavos: d });
    assert.equal(s.vatableCentavos + s.vatExemptCentavos, d);
    assert.ok(s.vatableCentavos <= 1000 && s.vatExemptCentavos <= 500, `d=${d}`);
  }
});

// ---------------------------------------------------------------- invoice totals

const line = (vatClassification, lineTotalCentavos) => ({ vatClassification, lineTotalCentavos });
const adj = (over = {}) => ({ discountCentavos: 0, otherChargesCentavos: 0, withholdingTaxCentavos: 0, vatClassification: ITEMIZED_VAT, ...over });

test("12% VAT applies to VATable lines only, in a mixed invoice — extracted, never added", () => {
  // Prices are VAT-inclusive (pricingConfig.js): the ₱1,000 VATable line already
  // contains its VAT; the invoice total stays ₱1,500.
  const t = computeInvoiceTotalsCentavos({ priceIsVatInclusive: true,
    subtotalCentavos: 150000,
    items: [line("vatable", 100000), line("vat_exempt", 50000)],
    adjustments: adj(),
  });
  assert.equal(t.vatAmountCentavos, 10714); // round(100000 × 12 / 112)
  assert.equal(t.vatableSalesCentavos, 89286); // net of VAT
  assert.equal(t.vatExemptSalesCentavos, 50000);
  assert.equal(t.zeroRatedSalesCentavos, 0);
  assert.equal(t.netCentavos, 139286);
  assert.equal(t.grandTotalCentavos, 150000);
  assert.equal(t.vatRate, 12);
});

test("a mixed invoice with a discount: split first, VAT on the discounted VATable sales, rounded once", () => {
  // 1,000.01 VATable + 500.00 exempt, ₱1.00 discount.
  const t = computeInvoiceTotalsCentavos({ priceIsVatInclusive: true,
    subtotalCentavos: 150001,
    items: [line("vatable", 100001), line("vat_exempt", 50000)],
    adjustments: adj({ discountCentavos: 100, otherChargesCentavos: 500, withholdingTaxCentavos: 200 }),
  });
  // discount 100 → vatable 66.67→ floor 66 (+1 remainder, larger) = 67, exempt 33.
  // VAT extracted from the VAT-inclusive 99,934: 99,934 × 12 / 112 = 10,707.2 → 10,707 (once).
  assert.equal(t.vatAmountCentavos, 10707);
  assert.equal(t.vatableSalesCentavos, 100001 - 67 - 10707);
  assert.equal(t.vatExemptSalesCentavos, 50000 - 33);
  assert.equal(t.netCentavos + t.vatAmountCentavos, 150001 - 100);
  assert.equal(t.grandTotalCentavos, 150001 - 100 + 500);
  assert.equal(t.totalAmountDueCentavos, t.grandTotalCentavos - 200);
  for (const v of Object.values(t)) assert.ok(Number.isSafeInteger(v), "every figure is an integer");
});

test("an all-exempt itemized invoice carries no VAT", () => {
  const t = computeInvoiceTotalsCentavos({ priceIsVatInclusive: true, subtotalCentavos: 2000, items: [line("vat_exempt", 2000)], adjustments: adj() });
  assert.equal(t.vatAmountCentavos, 0);
  assert.equal(t.vatRate, 0);
  assert.equal(t.vatExemptSalesCentavos, 2000);
});

test("an itemized invoice refuses a line without a valid snapshot", () => {
  assert.equal(
    codeOf(() => computeInvoiceTotalsCentavos({ priceIsVatInclusive: true, subtotalCentavos: 2000, items: [line(null, 2000)], adjustments: adj() })),
    "order-snapshot-invalid"
  );
});

test("legacy (invoice-level) totals: VAT extracted from the VAT-inclusive amount", () => {
  const t = computeInvoiceTotalsCentavos({ priceIsVatInclusive: true,
    subtotalCentavos: 80000,
    adjustments: adj({ vatClassification: "vatable" }),
  });
  // Was 80,000 + 9,600 = 89,600 (VAT on top); now ₱800 stays ₱800.
  assert.deepEqual([t.netCentavos, t.vatAmountCentavos, t.grandTotalCentavos], [71429, 8571, 80000]);
  const z = computeInvoiceTotalsCentavos({ priceIsVatInclusive: true, subtotalCentavos: 80000, adjustments: adj({ vatClassification: "zero_rated" }) });
  assert.equal(z.zeroRatedSalesCentavos, 80000);
});

// ---------------------------------------------------------------- base + adjustments

const pricedOrder = (items) => ({
  pricingVersion: PRICING_VERSION,
  priceCurrency: PRICE_CURRENCY,
  priceIsVatInclusive: true,
  unit: "vials",
  subtotalCentavos: items.reduce((s, i) => s + i.lineTotalCentavos, 0),
  items,
});
const orderLine = (inventoryId, quantity, unitPriceCentavos, vatClassification) => ({
  inventoryId, batchId: inventoryId, name: inventoryId, quantity, unitPriceCentavos,
  lineTotalCentavos: quantity * unitPriceCentavos,
  ...(vatClassification ? { vatClassification } : {}),
});

test("the invoice base carries each line's snapshot; itemized only when every line has one", () => {
  const mixed = buildInvoiceBaseFromOrder(pricedOrder([orderLine("a", 2, 1000, "vatable"), orderLine("b", 1, 500, "vat_exempt")]));
  assert.deepEqual(mixed.items.map((i) => i.vatClassification), ["vatable", "vat_exempt"]);
  assert.equal(mixed.itemizedVat, true);

  const legacy = buildInvoiceBaseFromOrder(pricedOrder([orderLine("a", 2, 1000)]));
  assert.equal(legacy.items[0].vatClassification, null);
  assert.equal(legacy.itemizedVat, false);

  const partial = buildInvoiceBaseFromOrder(pricedOrder([orderLine("a", 1, 1000, "vatable"), orderLine("b", 1, 500)]));
  assert.equal(partial.itemizedVat, false);
});

test("for an itemized order the caller cannot choose the VAT classification", () => {
  for (const sent of ["vatable", "vat_exempt", "zero_rated", "anything", undefined]) {
    assert.equal(validateAdjustments({ vatClassification: sent }, 1000, { itemizedVat: true }).vatClassification, ITEMIZED_VAT);
  }
  // A legacy order still takes (and validates) the Admin's choice.
  assert.equal(validateAdjustments({ vatClassification: "zero_rated" }, 1000).vatClassification, "zero_rated");
  assert.equal(codeOf(() => validateAdjustments({ vatClassification: ITEMIZED_VAT }, 1000)), "invalid-adjustment");
});

// ---------------------------------------------------------------- legacy VAT-exclusive records
//
// An order recorded `priceIsVatInclusive: false` keeps the calculation it was
// recorded under. These are the figures the per-item path produced before the
// VAT-inclusive rule (VAT added on top), reproduced exactly.

const legacyTotals = (a) => computeInvoiceTotalsCentavos({ priceIsVatInclusive: false, ...a });

test("LEGACY per-item: 12% on top of the VATable lines, exactly as originally invoiced", () => {
  const t = legacyTotals({
    subtotalCentavos: 150000,
    items: [line("vatable", 100000), line("vat_exempt", 50000)],
    adjustments: adj(),
  });
  assert.deepEqual(
    [t.vatableSalesCentavos, t.vatExemptSalesCentavos, t.vatAmountCentavos, t.netCentavos, t.grandTotalCentavos],
    [100000, 50000, 12000, 150000, 162000]
  );
  // Discount split first, then 12% of the discounted VATable 99,934 = 11,992.08 → 11,992.
  const d = legacyTotals({
    subtotalCentavos: 150001,
    items: [line("vatable", 100001), line("vat_exempt", 50000)],
    adjustments: adj({ discountCentavos: 100, otherChargesCentavos: 500 }),
  });
  assert.deepEqual([d.vatableSalesCentavos, d.vatAmountCentavos, d.grandTotalCentavos], [99934, 11992, 149901 + 11992 + 500]);
});

test("LEGACY invoice-level: the original 800 / 96 / 896 case is unchanged", () => {
  const t = legacyTotals({ subtotalCentavos: 80000, adjustments: adj({ vatClassification: "vatable" }) });
  assert.deepEqual([t.netCentavos, t.vatAmountCentavos, t.grandTotalCentavos], [80000, 9600, 89600]);
});

test("the same figures under the two conventions differ — the convention is never inferred", () => {
  const items = [line("vatable", 100000)];
  const a = { subtotalCentavos: 100000, items, adjustments: adj() };
  const now = computeInvoiceTotalsCentavos({ ...a, priceIsVatInclusive: true });
  const old = legacyTotals(a);
  assert.deepEqual([now.vatAmountCentavos, now.grandTotalCentavos], [10714, 100000]);
  assert.deepEqual([old.vatAmountCentavos, old.grandTotalCentavos], [12000, 112000]);
  for (const missing of [undefined, null, "true", 1, 0]) {
    assert.equal(
      codeOf(() => computeInvoiceTotalsCentavos({ ...a, priceIsVatInclusive: missing })),
      "price-convention-required",
      String(missing)
    );
  }
});

test("a legacy order's invoice base keeps its recorded convention", () => {
  const base = buildInvoiceBaseFromOrder({ ...pricedOrder([orderLine("a", 2, 1000, "vatable")]), priceIsVatInclusive: false });
  assert.equal(base.priceIsVatInclusive, false);
});

test("a stored invoice whose line snapshot was altered no longer matches its order", () => {
  const base = buildInvoiceBaseFromOrder(pricedOrder([orderLine("a", 2, 1000, "vatable")]));
  const invoice = { ...base, items: base.items.map((i) => ({ ...i })) };
  assert.equal(baseMatchesOrder(invoice, base), true);
  invoice.items[0].vatClassification = "vat_exempt";
  assert.equal(baseMatchesOrder(invoice, base), false);
});
