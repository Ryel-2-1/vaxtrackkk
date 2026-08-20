// Admin invoice model — pure unit tests (Phase 5D).
//
// Run:  npm run test:invoices   (node --test, no framework/dependency installed)
//
// Covers computeVatExclusiveTotals, the Firestore serializer, the initial-form
// builder, formatOrderDate, and the read-only/legacy normalizer. No Firebase,
// no live writes — everything imported here is pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VAT_STANDARD_RATE,
  VAT_CLASSIFICATIONS,
  vatClassificationLabel,
  computeVatExclusiveTotals,
  formatOrderDate,
  itemsFromOrder,
  buildInitialForm,
  serializeInvoiceDoc,
  normalizeStoredTotals,
  isIssued,
  assertConsistentInvoiceTotals,
} from "../src/services/invoiceModel.js";

const approx = (actual, expected, eps = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected}`
  );

// ---------------------------------------------------------------------------
// computeVatExclusiveTotals
// ---------------------------------------------------------------------------

test("VATable: quantity x unit price, 12% VAT on top", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 20, unitPrice: 85 }],
    vatClassification: "vatable",
  });
  assert.equal(t.subtotal, 1700); // 20 x 85
  assert.equal(t.net, 1700);
  assert.equal(t.vatRate, 12);
  assert.equal(t.vatableSales, 1700);
  assert.equal(t.vatExemptSales, 0);
  assert.equal(t.zeroRatedSales, 0);
  approx(t.vatAmount, 204); // 1700 * 12%
  approx(t.totalSalesVatInclusive, 1904); // net + VAT
  approx(t.grandTotal, 1904);
  approx(t.totalAmountDue, 1904);
});

test("VAT-Exempt: net falls in the exempt bucket, VAT = 0", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 20, unitPrice: 85 }],
    vatClassification: "vat_exempt",
  });
  assert.equal(t.vatRate, 0);
  assert.equal(t.vatableSales, 0);
  assert.equal(t.vatExemptSales, 1700);
  assert.equal(t.zeroRatedSales, 0);
  assert.equal(t.vatAmount, 0);
  assert.equal(t.totalSalesVatInclusive, 1700);
  assert.equal(t.grandTotal, 1700);
  assert.equal(t.totalAmountDue, 1700);
});

test("Zero-Rated: net falls in the zero-rated bucket, VAT = 0", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 20, unitPrice: 85 }],
    vatClassification: "zero_rated",
  });
  assert.equal(t.vatRate, 0);
  assert.equal(t.zeroRatedSales, 1700);
  assert.equal(t.vatableSales, 0);
  assert.equal(t.vatExemptSales, 0);
  assert.equal(t.vatAmount, 0);
  assert.equal(t.grandTotal, 1700);
});

test("subtotal sums quantity x unit price across multiple line items", () => {
  const t = computeVatExclusiveTotals({
    items: [
      { quantity: 2, unitPrice: 100 },
      { quantity: 3, unitPrice: 50 },
      { quantity: 0, unitPrice: 999 }, // zero qty contributes nothing
    ],
    vatClassification: "vatable",
  });
  assert.equal(t.subtotal, 350); // 200 + 150 + 0
  approx(t.vatAmount, 42); // 350 * 12%
  approx(t.grandTotal, 392);
});

test("discount reduces the taxable net before VAT", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 10, unitPrice: 100 }],
    discount: 200,
    vatClassification: "vatable",
  });
  assert.equal(t.subtotal, 1000);
  assert.equal(t.discount, 200);
  assert.equal(t.net, 800); // 1000 - 200
  approx(t.vatAmount, 96); // 800 * 12%
  approx(t.grandTotal, 896);
});

test("withholding tax reduces ONLY totalAmountDue; grandTotal is unchanged", () => {
  const base = { items: [{ quantity: 10, unitPrice: 100 }] };
  const without = computeVatExclusiveTotals(base);
  const withWht = computeVatExclusiveTotals({ ...base, withholdingTax: 50 });
  approx(without.grandTotal, 1120); // 1000 + 120
  approx(withWht.grandTotal, 1120); // grandTotal UNCHANGED by withholding
  assert.equal(withWht.withholdingTax, 50);
  approx(withWht.totalAmountDue, 1070); // grandTotal - withholding
});

test("otherCharges add to grandTotal and totalAmountDue", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 1, unitPrice: 1000 }],
    otherCharges: 25,
  });
  approx(t.grandTotal, 1145); // 1000 + 120 + 25
  approx(t.totalAmountDue, 1145);
});

test("default/zero values: empty input yields all-zero totals, vatable", () => {
  const t = computeVatExclusiveTotals();
  assert.equal(t.subtotal, 0);
  assert.equal(t.net, 0);
  assert.equal(t.vatAmount, 0);
  assert.equal(t.grandTotal, 0);
  assert.equal(t.totalSalesVatInclusive, 0);
  assert.equal(t.totalAmountDue, 0);
  assert.equal(t.vatClassification, "vatable");
  assert.equal(t.withholdingTax, 0);
});

test("decimal precision: fractional net computes 12% VAT without pre-rounding", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 1, unitPrice: 1517.86 }],
  });
  approx(t.net, 1517.86);
  approx(t.vatAmount, 182.1432); // 1517.86 * 0.12
  approx(t.grandTotal, 1700.0032);
  approx(t.totalSalesVatInclusive, 1700.0032);
});

test("string/blank numeric inputs coerce safely (no NaN)", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: "5", unitPrice: "20" }],
    discount: "",
    withholdingTax: null,
  });
  assert.equal(t.subtotal, 100);
  approx(t.vatAmount, 12);
  assert.equal(Number.isNaN(t.grandTotal), false);
});

test("unknown classification falls back to vatable", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 1, unitPrice: 100 }],
    vatClassification: "bogus",
  });
  assert.equal(t.vatClassification, "vatable");
  assert.equal(t.vatRate, 12);
});

test("Phase 5B verified case (net 800 -> VAT 96 -> grandTotal 896) is preserved", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 8, unitPrice: 100 }],
  });
  assert.equal(t.net, 800);
  approx(t.vatAmount, 96);
  approx(t.grandTotal, 896);
  approx(t.totalAmountDue, 896); // withholding defaults to 0
});

test("VAT constants + labels", () => {
  assert.equal(VAT_STANDARD_RATE, 12);
  assert.deepEqual(VAT_CLASSIFICATIONS, ["vatable", "vat_exempt", "zero_rated"]);
  assert.equal(vatClassificationLabel("vatable"), "VATable (12%)");
  assert.equal(vatClassificationLabel("vat_exempt"), "VAT-Exempt");
  assert.equal(vatClassificationLabel("zero_rated"), "Zero-Rated");
  assert.equal(vatClassificationLabel("nope"), "");
});

// ---------------------------------------------------------------------------
// serialization / data preparation
// ---------------------------------------------------------------------------

const order = {
  id: "ORDER_DOC_123", // Firestore document id
  orderNumber: "VT-ORD-999",
  clinicName: "Our Lady Clinic",
  clinicAddress: "South City Homes",
  createdByUid: "sr-uid",
  createdByEmail: "rep@x.com",
  createdAt: { toDate: () => new Date(2026, 6, 26, 12) }, // Jul 26 2026 (local)
};

function formFor(overrides = {}) {
  return { ...buildInitialForm(order, null, ""), ...overrides };
}

test("serialize: orderId is the Firestore document id (not the order number)", () => {
  const doc = serializeInvoiceDoc({ orderId: order.id, order, form: formFor() });
  assert.equal(doc.orderId, "ORDER_DOC_123");
  assert.equal(doc.orderNumber, "VT-ORD-999"); // display metadata only
  assert.notEqual(doc.orderId, doc.orderNumber);
});

test("serialize: never emits invoiceNumber/createdAt/create-audit (number preserved)", () => {
  const doc = serializeInvoiceDoc({ orderId: order.id, order, form: formFor() });
  assert.equal("invoiceNumber" in doc, false);
  assert.equal("createdAt" in doc, false);
  assert.equal("createdByUid" in doc, false);
  assert.equal("invoiceStatus" in doc, false);
});

test("serialize: VAT classification persists through serialization", () => {
  const doc = serializeInvoiceDoc({
    orderId: order.id,
    order,
    form: formFor({ vatClassification: "vat_exempt" }),
  });
  assert.equal(doc.vatClassification, "vat_exempt");
  assert.equal(doc.vatRate, 0);
  assert.equal(doc.vatExemptSales, doc.net);
  assert.equal(doc.vatAmount, 0);
});

test("serialize: Registered Name/Business Address come from real clinic data", () => {
  const doc = serializeInvoiceDoc({ orderId: order.id, order, form: formFor() });
  assert.equal(doc.registeredName, "Our Lady Clinic");
  assert.equal(doc.customerAddress, "South City Homes");
});

test("items: batch/expiry preserved only when provided by order data", () => {
  const withData = itemsFromOrder({
    items: [{ name: "ABHAY-TOX", batchId: "25GT0X006A", expiry: "07.2028", quantity: 20, unitPrice: 85 }],
  });
  assert.equal(withData[0].batchId, "25GT0X006A");
  assert.equal(withData[0].expiry, "07.2028");

  const withoutData = itemsFromOrder({
    items: [{ name: "ABHAY-TOX", quantity: 20, unitPrice: 85 }],
  });
  assert.equal(withoutData[0].batchId, ""); // blank, not invented
  assert.equal(withoutData[0].expiry, "");
});

test("serialize: item batch/expiry pass through blank when absent", () => {
  const doc = serializeInvoiceDoc({
    orderId: order.id,
    order,
    form: formFor({
      items: [
        { key: "k1", itemDescription: "A", batchId: "", expiry: "", quantity: 2, unitPrice: 10 },
      ],
    }),
  });
  assert.equal(doc.items[0].batchId, "");
  assert.equal(doc.items[0].expiry, "");
  assert.equal(doc.items[0].amount, 20); // qty*price recomputed
});

test("missing optional template fields remain blank (no fake identifiers)", () => {
  const doc = serializeInvoiceDoc({ orderId: order.id, order, form: formFor() });
  // legal / printer footer — never invented from the template photo
  for (const k of [
    "bookletInfo",
    "atpNumber",
    "atpDate",
    "printerBlock",
    "accreditationNo",
    "accreditationDates",
    // other blank-by-default template fields
    "customerTin",
    "customerCode",
    "shipTo",
    "vaccinesTemp",
    "salesRepCode",
    "soloParentId",
    "companyTin",
    "companyAddress",
  ]) {
    assert.equal(doc[k], "", `${k} should be blank`);
  }
});

test("Date Order: formatOrderDate renders createdAt; safe for null/invalid", () => {
  assert.equal(formatOrderDate(order.createdAt), "Jul 26, 2026");
  assert.equal(formatOrderDate(new Date(2026, 6, 26, 12)), "Jul 26, 2026");
  assert.equal(formatOrderDate(null), "—");
  assert.equal(formatOrderDate({ toDate: () => new Date("nope") }), "—");
});

// ---------------------------------------------------------------------------
// compatibility (issued / legacy / grandTotal)
// ---------------------------------------------------------------------------

test("isIssued flags only issued invoices (read-only lock signal)", () => {
  assert.equal(isIssued({ invoiceStatus: "issued" }), true);
  assert.equal(isIssued({ invoiceStatus: "draft" }), false);
  assert.equal(isIssued(null), false);
  assert.equal(isIssued(undefined), false);
});

test("legacy invoice (taxRate, no Phase 5C fields) normalizes safely", () => {
  const legacy = {
    invoiceStatus: "draft",
    taxRate: 12, // old numeric tax model, no vatClassification
    items: [{ itemDescription: "X", quantity: 1, unitPrice: 100 }],
    // NONE of the Phase 5C fields present
  };
  const form = buildInitialForm(order, legacy, "");
  assert.equal(form.vatClassification, "vatable"); // taxRate>=12 -> vatable
  // new template fields default to blank / zero, no crash
  assert.equal(form.vaccinesTemp, "");
  assert.equal(form.customerCode, "");
  assert.equal(form.atpNumber, "");
  assert.equal(form.withholdingTax, 0);
  assert.equal(form.shipTo, "");
});

test("legacy taxRate 0 maps to VAT-Exempt (0% VAT)", () => {
  const legacy = { invoiceStatus: "draft", taxRate: 0, items: [] };
  const form = buildInitialForm(order, legacy, "");
  assert.equal(form.vatClassification, "vat_exempt");
});

test("normalizeStoredTotals surfaces STORED figures (legacy taxAmount -> vatAmount)", () => {
  const legacy = {
    grandTotal: 896,
    subtotal: 800,
    taxAmount: 96, // legacy name, no vatAmount / totalAmountDue / net
  };
  const live = computeVatExclusiveTotals({ items: [] }); // all zeros
  const t = normalizeStoredTotals(legacy, live);
  assert.equal(t.grandTotal, 896); // stored, not recomputed
  assert.equal(t.subtotal, 800);
  assert.equal(t.vatAmount, 96); // legacy taxAmount surfaced
  assert.equal(t.totalAmountDue, 896); // derived: grandTotal - 0 withholding
});

test("normalizeStoredTotals uses new-model stored values when present", () => {
  const stored = {
    grandTotal: 1904,
    net: 1700,
    vatAmount: 204,
    withholdingTax: 0,
    subtotal: 1700,
    vatableSales: 1700,
    vatClassification: "vatable",
    totalSalesVatInclusive: 1904,
    totalAmountDue: 1904,
  };
  const live = computeVatExclusiveTotals({ items: [] });
  const t = normalizeStoredTotals(stored, live);
  assert.equal(t.grandTotal, 1904);
  assert.equal(t.vatableSales, 1700);
  assert.equal(t.totalAmountDue, 1904);
});

test("Phase 5B grandTotal contract: grandTotal excludes withholding, totalAmountDue includes it", () => {
  const t = computeVatExclusiveTotals({
    items: [{ quantity: 10, unitPrice: 100 }],
    withholdingTax: 100,
  });
  approx(t.grandTotal, 1120); // net + VAT (+0 other) — withholding NOT subtracted
  approx(t.totalAmountDue, 1020); // grandTotal - withholding
});

// ---------------------------------------------------------------------------
// persistence guard: assertConsistentInvoiceTotals (Phase 5E)
// ---------------------------------------------------------------------------

test("assertConsistentInvoiceTotals: consistent subtotal + items pass", () => {
  assert.doesNotThrow(() =>
    assertConsistentInvoiceTotals({
      items: [{ quantity: 20, unitPrice: 85 }],
      subtotal: 1700,
      grandTotal: 1904,
    })
  );
  assert.doesNotThrow(() =>
    assertConsistentInvoiceTotals({ items: [], subtotal: 0, grandTotal: 0 })
  );
});

test("assertConsistentInvoiceTotals: tampered subtotal throws", () => {
  assert.throws(
    () =>
      assertConsistentInvoiceTotals({
        items: [{ quantity: 20, unitPrice: 85 }],
        subtotal: 1, // != 1700
        grandTotal: 1904,
      }),
    /subtotal does not match/
  );
});

test("assertConsistentInvoiceTotals: negative/invalid grandTotal throws", () => {
  assert.throws(
    () =>
      assertConsistentInvoiceTotals({
        items: [{ quantity: 1, unitPrice: 100 }],
        subtotal: 100,
        grandTotal: -5,
      }),
    /total is not valid/
  );
});

test("assertConsistentInvoiceTotals: serializer output is always consistent", () => {
  const built = serializeInvoiceDoc({
    orderId: "O1",
    order: { id: "O1" },
    form: {
      ...buildInitialForm({ id: "O1" }, null, ""),
      items: [{ key: "k", quantity: 3, unitPrice: 50, itemDescription: "X" }],
    },
  });
  assert.equal(built.subtotal, 150); // 3 x 50
  assert.doesNotThrow(() => assertConsistentInvoiceTotals(built));
});
