"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../src/invoicePricing");

// Invoice base pricing, derived from an order snapshot.
//
// The property every case here defends: an invoice's base — identity, quantity,
// unit price, line total, subtotal, currency, VAT convention — comes from the
// ORDER, and there is no input through which a caller can influence it.

const PRICE = 125000; // ₱1,250.00
const SECOND = 45000; // ₱450.00

const pricedOrder = (over = {}) => ({
  pricingVersion: 1,
  priceCurrency: "PHP",
  priceIsVatInclusive: false,
  unit: "vials",
  clinicId: "clinic1",
  orderNumber: "VT-ORD-1",
  subtotalCentavos: 4 * PRICE,
  items: [
    {
      inventoryId: "inv1",
      batchId: "MOD-STG-001",
      name: "Moderna COVID-19 Vaccine",
      quantity: 4,
      unitPriceCentavos: PRICE,
      lineTotalCentavos: 4 * PRICE,
      unitPrice: 1250,
    },
  ],
  ...over,
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
};

test("base pricing comes from the order and nowhere else", async (t) => {
  await t.test("identity, quantity and money are copied from the snapshot", () => {
    const base = I.buildInvoiceBaseFromOrder(pricedOrder());
    assert.equal(base.items.length, 1);
    assert.equal(base.items[0].inventoryId, "inv1");
    assert.equal(base.items[0].batchId, "MOD-STG-001");
    assert.equal(base.items[0].quantity, 4);
    assert.equal(base.items[0].unitPriceCentavos, PRICE);
    assert.equal(base.items[0].lineTotalCentavos, 4 * PRICE);
    assert.equal(base.subtotalCentavos, 4 * PRICE);
    assert.equal(base.priceCurrency, "PHP");
    // Computed under the confirmed rule (prices are VAT-inclusive), even for an
    // order that recorded the earlier `false` — whose own flag is untouched.
    assert.equal(base.priceIsVatInclusive, true);
    assert.equal(base.pricingVersion, 1);
  });

  await t.test("building an invoice base never mutates the order (historical flag preserved)", () => {
    const order = pricedOrder();
    const before = JSON.stringify(order);
    I.buildInvoiceBaseFromOrder(order);
    assert.equal(JSON.stringify(order), before);
    assert.equal(order.priceIsVatInclusive, false);
  });

  await t.test("peso mirrors are derived, never authoritative", () => {
    const base = I.buildInvoiceBaseFromOrder(pricedOrder());
    assert.equal(base.items[0].unitPrice, 1250);
    assert.equal(base.items[0].amount, 5000);
    assert.equal(base.subtotal, 5000);
  });

  await t.test("a multi-line order sums each line's own price", () => {
    const base = I.buildInvoiceBaseFromOrder(
      pricedOrder({
        subtotalCentavos: 2 * PRICE + 3 * SECOND,
        items: [
          { inventoryId: "a", batchId: "A", name: "A", quantity: 2, unitPriceCentavos: PRICE, lineTotalCentavos: 2 * PRICE },
          { inventoryId: "b", batchId: "B", name: "B", quantity: 3, unitPriceCentavos: SECOND, lineTotalCentavos: 3 * SECOND },
        ],
      })
    );
    assert.equal(base.subtotalCentavos, 385000);
  });

  await t.test("a LEGACY order is refused — it keeps the manual path", () => {
    assert.equal(codeOf(() => I.buildInvoiceBaseFromOrder({ items: [] })), "order-not-priced");
    assert.equal(
      codeOf(() => I.buildInvoiceBaseFromOrder({ items: [{ quantity: 1, unitPrice: 10 }] })),
      "order-not-priced"
    );
    // Detected by the stamp only — never by item shape.
    assert.equal(I.isServerPricedOrder({ pricingVersion: 1 }), true);
    assert.equal(I.isServerPricedOrder({ pricingVersion: "1" }), false);
    assert.equal(I.isServerPricedOrder({ items: [{ unitPriceCentavos: PRICE }] }), false);
  });
});

test("a corrupted order snapshot is refused, never invoiced", async (t) => {
  await t.test("a line total that disagrees with quantity x price", () => {
    // The single most important check here: trusting a stored line total would
    // let one tampered field flow straight onto a bill.
    const bad = pricedOrder();
    bad.items[0].lineTotalCentavos = 1;
    assert.equal(codeOf(() => I.buildInvoiceBaseFromOrder(bad)), "order-snapshot-invalid");
  });

  await t.test("a subtotal that disagrees with the lines", () => {
    assert.equal(
      codeOf(() => I.buildInvoiceBaseFromOrder(pricedOrder({ subtotalCentavos: 1 }))),
      "order-snapshot-invalid"
    );
  });

  await t.test("a malformed quantity or price", () => {
    for (const q of [0, -1, 2.5, "4", null, undefined]) {
      const bad = pricedOrder();
      bad.items[0].quantity = q;
      bad.subtotalCentavos = 0;
      assert.equal(codeOf(() => I.buildInvoiceBaseFromOrder(bad)), "order-snapshot-invalid", String(q));
    }
    for (const p of [0, -1, 1250.5, "125000", null, undefined]) {
      const bad = pricedOrder();
      bad.items[0].unitPriceCentavos = p;
      assert.equal(codeOf(() => I.buildInvoiceBaseFromOrder(bad)), "order-snapshot-invalid", String(p));
    }
  });

  await t.test("an order with no items", () => {
    assert.equal(
      codeOf(() => I.buildInvoiceBaseFromOrder(pricedOrder({ items: [] }))),
      "order-has-no-items"
    );
  });
});

test("adjustments are the admin's, and are separate from the base", async (t) => {
  await t.test("all four are accepted, and the amounts default to nothing", () => {
    assert.deepEqual(I.validateAdjustments({ vatClassification: "vatable" }, 500000), {
      discountCentavos: 0,
      otherChargesCentavos: 0,
      withholdingTaxCentavos: 0,
      vatClassification: "vatable",
    });
    // An itemized order (every line snapshotted) is decided by its lines.
    assert.equal(I.validateAdjustments(undefined, 500000, { itemizedVat: true }).vatClassification, I.ITEMIZED_VAT);
    assert.deepEqual(
      I.validateAdjustments(
        {
          discountCentavos: 50000,
          otherChargesCentavos: 10000,
          withholdingTaxCentavos: 2500,
          vatClassification: "zero_rated",
        },
        500000
      ),
      {
        discountCentavos: 50000,
        otherChargesCentavos: 10000,
        withholdingTaxCentavos: 2500,
        vatClassification: "zero_rated",
      }
    );
  });

  await t.test("a discount cannot be smuggled in as a base price change", () => {
    // The whole point of keeping these as separate named fields: there is no
    // key here through which a unit price could be restated.
    for (const key of ["unitPriceCentavos", "subtotalCentavos", "items", "quantity", "unitPrice"]) {
      assert.equal(
        codeOf(() => I.validateAdjustments({ [key]: 1 }, 500000)),
        "unknown-field",
        key
      );
    }
  });

  await t.test("malformed adjustment amounts are refused, not coerced", () => {
    for (const bad of [-1, 1250.5, "50000", NaN, Infinity, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        codeOf(() => I.validateAdjustments({ discountCentavos: bad }, 500000)),
        "invalid-adjustment",
        JSON.stringify(bad) ?? String(bad)
      );
    }
    // Zero IS a valid adjustment — and the usual one.
    assert.equal(I.validateAdjustments({ discountCentavos: 0, vatClassification: "vatable" }, 500000).discountCentavos, 0);
  });

  await t.test("a discount larger than the goods is refused, not clamped", () => {
    // Clamping would charge an amount the admin did not enter.
    assert.equal(
      codeOf(() => I.validateAdjustments({ discountCentavos: 500001 }, 500000)),
      "discount-exceeds-subtotal"
    );
    assert.equal(I.validateAdjustments({ discountCentavos: 500000, vatClassification: "vatable" }, 500000).discountCentavos, 500000);
  });

  await t.test("an unclassified order gets no invented VAT: the classification must be chosen", () => {
    assert.equal(codeOf(() => I.validateAdjustments(undefined, 500000)), "vat-classification-required");
    assert.equal(codeOf(() => I.validateAdjustments({ discountCentavos: 0 }, 500000, { itemizedVat: false })), "vat-classification-required");
  });

  await t.test("the client can never supply a VAT amount or a total", () => {
    for (const key of ["vatAmountCentavos", "grandTotalCentavos", "netCentavos", "vatableSalesCentavos",
      "totalAmountDueCentavos", "totalSalesVatInclusiveCentavos", "vatRate", "priceIsVatInclusive"]) {
      assert.equal(codeOf(() => I.validateAdjustments({ vatClassification: "vatable", [key]: 1 }, 500000)), "unknown-field", key);
    }
  });

  await t.test("an unrecognised VAT classification is refused", () => {
    assert.equal(
      codeOf(() => I.validateAdjustments({ vatClassification: "made_up" }, 500000)),
      "invalid-adjustment"
    );
  });
});

test("invoice totals, in exact centavos — prices are VAT-inclusive", async (t) => {
  const totals = (adjustments, subtotalCentavos = 500000) =>
    I.computeInvoiceTotalsCentavos({
      subtotalCentavos,
      adjustments: I.validateAdjustments({ vatClassification: "vatable", ...adjustments }, subtotalCentavos),
    });

  await t.test("₱1,000 / ₱3,000: VAT extracted, the total is unchanged — never added on top", () => {
    const one = totals({}, 100000);
    assert.deepEqual([one.vatableSalesCentavos, one.vatAmountCentavos, one.grandTotalCentavos], [89286, 10714, 100000]);
    const three = totals({}, 300000);
    assert.deepEqual([three.vatableSalesCentavos, three.vatAmountCentavos, three.grandTotalCentavos], [267857, 32143, 300000]);
    assert.notEqual(one.grandTotalCentavos, 112000, "₱1,000 does not become ₱1,120");
  });

  await t.test("VAT is extracted from the discounted amount; other charges sit on top", () => {
    const t1 = totals({ discountCentavos: 50000, otherChargesCentavos: 10000 });
    assert.equal(t1.totalSalesVatInclusiveCentavos, 450000); // 500000 − 50000
    assert.equal(t1.vatAmountCentavos, 48214); // round(450000 × 12 / 112)
    assert.equal(t1.netCentavos, 401786); // net of VAT
    assert.equal(t1.netCentavos + t1.vatAmountCentavos, 450000);
    assert.equal(t1.grandTotalCentavos, 460000);
  });

  await t.test("withholding tax reduces only the amount due", () => {
    const t1 = totals({ withholdingTaxCentavos: 2500 });
    assert.equal(t1.grandTotalCentavos, 500000);
    assert.equal(t1.totalAmountDueCentavos, 497500);
  });

  await t.test("exempt and zero-rated carry no VAT but keep the net", () => {
    for (const cls of ["vat_exempt", "zero_rated"]) {
      const t1 = totals({ vatClassification: cls });
      assert.equal(t1.vatAmountCentavos, 0, cls);
      assert.equal(t1.vatRate, 0, cls);
      assert.equal(t1.netCentavos, 500000, cls);
      assert.equal(t1.grandTotalCentavos, 500000, cls);
    }
    assert.equal(totals({ vatClassification: "vat_exempt" }).vatExemptSalesCentavos, 500000);
    assert.equal(totals({ vatClassification: "zero_rated" }).zeroRatedSalesCentavos, 500000);
  });

  await t.test("the VAT line is the ONE rounding (×12÷112), and it rounds half up", () => {
    // There is no exact answer for most amounts, so the rule is stated and
    // computed in integers rather than left to a float path.
    assert.equal(totals({}, 0).vatAmountCentavos, 0);
    assert.equal(totals({}, 1).vatAmountCentavos, 0); // 0.107 -> 0
    assert.equal(totals({}, 5).vatAmountCentavos, 1); // 0.536 -> 1
    assert.equal(totals({}, 25).vatAmountCentavos, 3); // 2.679 -> 3
    assert.equal(totals({}, 125).vatAmountCentavos, 13); // 13.393 -> 13
    // Exactly .5 rounds up.
    assert.equal(totals({}, 14).vatAmountCentavos, 2); // 1.5 -> 2
    assert.equal(totals({}, 42).vatAmountCentavos, 5); // 4.5 -> 5
    assert.equal(totals({}, 1042).vatAmountCentavos, 112); // 111.643 -> 112
    for (const g of [1, 5, 14, 42, 1042, 99999, 123457]) {
      const t1 = totals({}, g);
      assert.equal(t1.netCentavos + t1.vatAmountCentavos, g, `net + VAT = gross at ${g}`);
    }
  });

  await t.test("a discount equal to the subtotal leaves nothing to tax", () => {
    const t1 = totals({ discountCentavos: 500000 });
    assert.equal(t1.netCentavos, 0);
    assert.equal(t1.vatAmountCentavos, 0);
    assert.equal(t1.grandTotalCentavos, 0);
  });

  await t.test("a total beyond exact integer range fails rather than rounds", () => {
    assert.equal(
      codeOf(() =>
        I.computeInvoiceTotalsCentavos({
          subtotalCentavos: Number.MAX_SAFE_INTEGER,
          adjustments: {
            discountCentavos: 0,
            otherChargesCentavos: Number.MAX_SAFE_INTEGER,
            withholdingTaxCentavos: 0,
            vatClassification: "vat_exempt",
          },
        })
      ),
      "invoice-total-out-of-range"
    );
  });
});

test("presentation is text, allowlisted and bounded", async (t) => {
  await t.test("known fields pass through; absent ones become empty strings", () => {
    const out = I.validatePresentation({ customerName: "Clinic One", notes: "Deliver AM" });
    assert.equal(out.customerName, "Clinic One");
    assert.equal(out.notes, "Deliver AM");
    assert.equal(out.customerTin, "", "an unsupplied field is emptied, not left undefined");
    assert.equal(Object.keys(out).length, I.PRESENTATION_FIELDS.length);
  });

  await t.test("money can NEVER arrive dressed as presentation", () => {
    // The reason this is an allowlist: a denylist would have to anticipate
    // every field someone might try.
    for (const key of [
      "subtotalCentavos", "grandTotal", "items", "unitPrice", "quantity",
      "pricingVersion", "invoiceStatus", "invoiceNumber", "orderId",
    ]) {
      assert.equal(
        codeOf(() => I.validatePresentation({ [key]: "x" })),
        "unknown-field",
        key
      );
    }
  });

  await t.test("non-text and oversized values are refused", () => {
    assert.equal(codeOf(() => I.validatePresentation({ customerName: 5 })), "invalid-presentation");
    assert.equal(
      codeOf(() => I.validatePresentation({ notes: "x".repeat(I.MAX_PRESENTATION_LENGTH + 1) })),
      "invalid-presentation"
    );
  });
});

test("a stored invoice is checked back against its order", async (t) => {
  const base = I.buildInvoiceBaseFromOrder(pricedOrder());
  const stored = () => ({
    items: JSON.parse(JSON.stringify(base.items)),
    subtotalCentavos: base.subtotalCentavos,
    priceCurrency: "PHP",
    priceIsVatInclusive: true,
    pricingVersion: 1,
  });

  await t.test("an untouched invoice matches", () => {
    assert.equal(I.baseMatchesOrder(stored(), base), true);
  });

  await t.test("a substituted unit price does not", () => {
    const s = stored();
    s.items[0].unitPriceCentavos = 1;
    assert.equal(I.baseMatchesOrder(s, base), false);
  });

  await t.test("a substituted quantity does not", () => {
    const s = stored();
    s.items[0].quantity = 400;
    assert.equal(I.baseMatchesOrder(s, base), false);
  });

  await t.test("a substituted line total, subtotal or identity does not", () => {
    for (const mutate of [
      (s) => { s.items[0].lineTotalCentavos = 1; },
      (s) => { s.subtotalCentavos = 1; },
      (s) => { s.items[0].inventoryId = "somewhere-else"; },
      (s) => { s.priceCurrency = "USD"; },
      // A draft saved under the earlier VAT-exclusive convention must be re-saved.
      (s) => { s.priceIsVatInclusive = false; },
      (s) => { s.pricingVersion = 2; },
      (s) => { s.items.push({ ...s.items[0] }); },
      (s) => { s.items = []; },
    ]) {
      const s = stored();
      mutate(s);
      assert.equal(I.baseMatchesOrder(s, base), false);
    }
  });
});
