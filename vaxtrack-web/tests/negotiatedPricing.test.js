// Negotiated (agreed) pricing on the Med Rep's final review — web side.
//
// Pure arithmetic (parsing, totals, VAT, rounding, reset, reasons), parity with
// the authoritative server module, and the page wiring that has no DOM here:
// the review controls, the reconfirmation dialog, the stale-price path, the
// single-request guard, immutability after placement and the invoice's
// no-double-discount rule.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  NEGOTIATED_PRICE_LABEL,
  agreedInputFor,
  negotiatedRequestLine,
  parseAgreedPriceInput,
  priceReviewLine,
  reviewProblems,
  summarizeReviewVat,
} from "../src/services/negotiatedPricing.js";
import { buildConfirmationFromOrder, withLiveLifecycle } from "../src/services/orderConfirmation.js";
import { canonicalSubmission, diffSubmission } from "../src/services/orderDraftRequest.js";
import { orderHasNegotiatedPrice } from "../src/services/invoiceModel.js";
import { splitVatInclusiveCentavos } from "../src/services/pricingConfig.js";

const require = createRequire(import.meta.url);
const server = require("../functions/src/negotiatedPricing.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const line = (over = {}) =>
  priceReviewLine({ quantity: 3, expectedUnitPriceCentavos: 12500, vatClassification: "vatable", ...over });

// ---------------------------------------------------------------- parsing

test("peso input → centavos: whole pesos and one or two decimals", () => {
  for (const [text, value] of [["1250", 125000], ["1250.5", 125050], ["1250.50", 125050], [" 1,250.00 ", 125000], ["0.01", 1], ["19.99", 1999]]) {
    assert.deepEqual(parseAgreedPriceInput(text), { ok: true, value }, text);
  }
});

test("excess decimals, malformed, negative, NaN, Infinity, zero and over-limit input are refused", () => {
  for (const text of ["12.345", "1.", ".5", "abc", "1e3", "-5", "NaN", "Infinity", "₱100", "12,50.5.0", "0", "0.00", "", "   ", "999999999999999999"]) {
    const r = parseAgreedPriceInput(text);
    assert.equal(r.ok, false, text);
    assert.ok(typeof r.message === "string" && r.message.length > 0);
  }
  assert.match(parseAgreedPriceInput("0").message, /more than ₱0\.00/);
  assert.match(parseAgreedPriceInput("").message, /Enter the agreed price/);
  assert.match(parseAgreedPriceInput("999999999999999999").message, /too large/);
  assert.match(parseAgreedPriceInput("12.345").message, /two decimal places/);
});

// ---------------------------------------------------------------- one line

test("an untouched line is at its standard price; reset returns to it", () => {
  const l = line();
  assert.equal(l.agreedUnitPriceCentavos, 12500);
  assert.equal(l.priceAdjusted, false);
  assert.equal(l.adjustmentReason, null);
  assert.equal(l.priceError, null);
  // Reset = removing the rep's entry, i.e. the untouched state again.
  assert.deepEqual(line({ agreedInput: undefined }), l);
  assert.equal(agreedInputFor(12500), "125.00");
});

test("an edited price: integer line totals, signed adjustment, reason required", () => {
  const l = line({ agreedInput: "110.50", adjustmentReason: "  bulk   deal " });
  assert.equal(l.agreedUnitPriceCentavos, 11050);
  assert.equal(l.agreedLineTotalCentavos, 33150);
  assert.equal(l.standardLineTotalCentavos, 37500);
  assert.equal(l.adjustmentCentavos, -4350);
  assert.equal(l.priceAdjusted, true);
  assert.equal(l.adjustmentReason, "bulk deal");
  assert.equal(l.reasonError, null);
  assert.match(line({ agreedInput: "110.50" }).reasonError, /reason/);
  assert.match(line({ agreedInput: "110.50", adjustmentReason: "x".repeat(501) }).reasonError, /500/);
  // Typing the standard price back needs no reason.
  assert.equal(line({ agreedInput: "125.00" }).priceAdjusted, false);
  // A cleared field is an error, not a silent reset to the standard.
  assert.match(line({ agreedInput: "" }).priceError, /Enter the agreed price/);
});

test("VAT classification labels and rates per line", () => {
  assert.equal(line({ vatClassification: "vatable" }).vatRatePercent, 12);
  assert.equal(line({ vatClassification: "vat_exempt" }).vatRatePercent, 0);
  assert.equal(line({ vatClassification: "zero_rated" }).vatRatePercent, 0);
  assert.equal(NEGOTIATED_PRICE_LABEL, "Negotiated price");
  const page = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(page, /\{vatClassification === "vatable" && " · VAT included"\}/);
});

// ---------------------------------------------------------------- VAT breakdown

test("VATable 12/112 extraction, exempt and zero-rated with no VAT", () => {
  const s = summarizeReviewVat([line({ quantity: 1, expectedUnitPriceCentavos: 112000 })]);
  assert.equal(s.vatAmountCentavos, 12000);
  assert.equal(s.vatableSalesCentavos, 100000);
  const e = summarizeReviewVat([line({ quantity: 2, expectedUnitPriceCentavos: 5000, vatClassification: "vat_exempt" })]);
  assert.deepEqual([e.vatAmountCentavos, e.vatExemptSalesCentavos, e.zeroRatedSalesCentavos], [0, 10000, 0]);
  const z = summarizeReviewVat([line({ quantity: 2, expectedUnitPriceCentavos: 5000, vatClassification: "zero_rated" })]);
  assert.deepEqual([z.vatAmountCentavos, z.vatExemptSalesCentavos, z.zeroRatedSalesCentavos], [0, 0, 10000]);
});

test("rounding is half-up at the centavo boundary", () => {
  for (const [gross, vat] of [[14, 2], [13, 1], [42, 5], [41, 4], [5, 1], [4, 0], [112, 12]]) {
    const s = summarizeReviewVat([line({ quantity: 1, expectedUnitPriceCentavos: gross })]);
    assert.equal(s.vatAmountCentavos, vat, `gross ${gross}`);
    assert.equal(s.vatableSalesCentavos + s.vatAmountCentavos, gross);
  }
});

test("a mixed order reconciles exactly and matches the server, centavo for centavo", () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const classes = ["vatable", "vat_exempt", "zero_rated"];
  for (let round = 0; round < 200; round += 1) {
    const raw = Array.from({ length: 1 + rand(6) }, () => ({
      quantity: 1 + rand(40),
      standard: 1 + rand(500000),
      agreed: 1 + rand(500000),
      cls: classes[rand(3)],
    }));
    const web = raw.map((r) =>
      priceReviewLine({
        quantity: r.quantity,
        expectedUnitPriceCentavos: r.standard,
        vatClassification: r.cls,
        agreedInput: agreedInputFor(r.agreed),
        adjustmentReason: "reason",
      })
    );
    const srv = raw.map((r) =>
      server.priceOrderLine({
        quantity: r.quantity,
        standardUnitPriceCentavos: r.standard,
        agreedUnitPriceCentavos: r.agreed,
        adjustmentReason: "reason",
        vatClassification: r.cls,
      })
    );
    const w = summarizeReviewVat(web);
    const s = server.summarizeAgreement(srv);
    assert.equal(w.totalCentavos, s.subtotalCentavos);
    assert.equal(w.standardTotalCentavos, s.standardSubtotalCentavos);
    assert.equal(w.adjustmentCentavos, s.priceAdjustmentCentavos);
    for (const k of ["vatableGrossCentavos", "vatableSalesCentavos", "vatAmountCentavos", "vatExemptSalesCentavos", "zeroRatedSalesCentavos", "totalCentavos"]) {
      assert.equal(w[k], s.vatSummary[k], k);
    }
    assert.equal(w.vatableSalesCentavos + w.vatAmountCentavos + w.vatExemptSalesCentavos + w.zeroRatedSalesCentavos, w.totalCentavos);
    assert.equal(w.vatAmountCentavos, splitVatInclusiveCentavos(w.vatableGrossCentavos).vatCentavos);
  }
});

test("no floating-point currency in the pricing module", () => {
  const src = strip(read("src/services/negotiatedPricing.js"));
  assert.equal(/parseFloat|toFixed|\* 100\b|\/ 100\b|Number\(text\)/.test(src), false);
});

test("an invalid line or unknown class makes the breakdown unavailable, never wrong", () => {
  assert.equal(summarizeReviewVat([line({ agreedInput: "abc" })]), null);
  assert.equal(summarizeReviewVat([line({ vatClassification: null })]), null);
  const problems = reviewProblems([line({ agreedInput: "abc" }), line({ agreedInput: "100", adjustmentReason: "" })]);
  assert.equal(problems.ok, false);
  assert.equal(problems.problems.length, 2);
  assert.deepEqual(reviewProblems([line()]), { ok: true, problems: [] });
});

// ---------------------------------------------------------------- the request

test("the request carries the agreed UNIT price and reason — no totals, no VAT", () => {
  const cart = { inventoryId: "inv1", quantity: 3, expectedUnitPriceCentavos: 12500 };
  assert.deepEqual(negotiatedRequestLine(cart, line({ agreedInput: "110", adjustmentReason: "deal" })), {
    expectedUnitPriceCentavos: 12500,
    agreedUnitPriceCentavos: 11000,
    adjustmentReason: "deal",
  });
  assert.deepEqual(negotiatedRequestLine(cart, line()), { expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12500 });
  const callables = strip(read("src/services/inventoryCallables.js"));
  assert.match(callables, /agreedUnitPriceCentavos: item\.agreedUnitPriceCentavos/);
  assert.match(callables, /adjustmentReason: item\.adjustmentReason/);
  assert.equal(/lineTotalCentavos|vatAmount|subtotalCentavos/.test(callables.slice(callables.indexOf("export async function createOrderWithReservation"))), false);
});

test("a retry under the same request id must carry the same agreed price and reason", () => {
  const base = { doctorId: "d", doctorAddressId: "home", requestedDeliveryDate: "2026-10-20", items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100, agreedUnitPriceCentavos: 90, adjustmentReason: "deal" }] };
  assert.deepEqual(diffSubmission(base, base), []);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], agreedUnitPriceCentavos: 80 }] }), ["agreed price"]);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], adjustmentReason: "other" }] }), ["agreed price"]);
  // An older saved attempt without an agreed price means "the standard".
  const old = { ...base, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100 }] };
  assert.equal(canonicalSubmission(old).items[0].agreedUnitPriceCentavos, 100);
});

// ---------------------------------------------------------------- the page

const PAGE = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
const CODE = strip(PAGE);

test("each line has an editable agreed unit price and a Reset to standard price action — no total input", () => {
  assert.match(PAGE, /Agreed unit price \(VAT-inclusive\) for \{item\.name\}/);
  assert.match(CODE, /onChange=\{\(event\) => onAgreedChange\(item\.sku, event\.target\.value\)\}/);
  assert.match(CODE, /onClick=\{\(\) => onReset\(item\.sku\)\}/);
  assert.match(PAGE, /Reset to standard price/);
  assert.match(CODE, /const resetToStandard = \(sku\) =>/);
  // Every money input in the page is the per-line agreed unit price.
  assert.equal((PAGE.match(/inputMode="decimal"/g) || []).length, 1);
  assert.equal(/Total[^"]*"\s*\n?\s*(value|onChange)/.test(PAGE), false);
  for (const label of ["Standard unit price", "Standard line total", "Agreed line total", "Adjustment"]) {
    assert.match(PAGE, new RegExp(`<dt>${label}</dt>`), label);
  }
  // A negotiated line is highlighted, labelled and must be explained.
  assert.match(CODE, /className=\{`place-v2-price-line\$\{price\.priceAdjusted \? " negotiated" : ""\}`\}/);
  assert.match(PAGE, /Reason for the negotiated price \(required\)/);
  assert.equal(/>\s*Discount\b/.test(PAGE), false, "called a negotiated price, never a discount");
});

test("the summary shows the VAT breakdown and the final VAT-inclusive total", () => {
  for (const label of ["VATable sales (net of VAT)", "VAT-exempt sales", "Zero-rated sales", "VAT (12%)", "Final total (VAT-inclusive)"]) {
    assert.match(PAGE, new RegExp(`<dt>${label.replace(/[()]/g, "\\$&")}</dt>`), label);
  }
  assert.match(CODE, /<VatBreakdown summary=\{priceSummary\} \/>/);
});

test("Finalize opens a reconfirmation dialog; only its Confirm sends, once", () => {
  assert.match(CODE, /if \(!confirmed\) \{\s*submittingRef\.current = false;\s*setMessage\(""\);\s*setConfirmOpen\(true\);\s*return;\s*\}/);
  assert.match(CODE, /const confirmed = reconfirmedRef\.current;\s*reconfirmedRef\.current = false;/);
  assert.match(CODE, /onConfirm=\{\(\) => \{\s*reconfirmedRef\.current = true;\s*handleFinalizeOrder\(\);\s*\}\}/);
  // The single-request guard still runs first.
  assert.match(CODE, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;/);
  // The dialog lists doctor and destination, each line, classification, prices, reasons, breakdown.
  const dialog = PAGE.slice(PAGE.indexOf("function ReconfirmDialog"));
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby="reconfirm-title"/);
  assert.match(dialog, /\{doctorName\}/);
  assert.match(dialog, /\{destination\}/);
  assert.match(dialog, /vatLabelFor\(vatClassification\)/);
  assert.match(dialog, /\(standard \{formatCentavos\(price\.standardUnitPriceCentavos\)\}\)/);
  assert.match(dialog, /Reason: \{price\.adjustmentReason\}/);
  assert.match(dialog, /<VatBreakdown summary=\{summary\} \/>/);
  assert.match(dialog, /event\.key === "Escape" && !saving/);
  assert.match(dialog, /disabled=\{saving\}/);
});

test("a stale standard price returns the rep to the review", () => {
  assert.match(CODE, /setConfirmOpen\(false\);\s*setMessage\(messageForCallableError\(error\)\);/);
  assert.match(PAGE, /Accept the new standard price on that line, check your agreed price, and confirm again\./);
  // The live listener flags the line; accepting updates only the standard, never the agreed price.
  assert.match(CODE, /const handleAcceptLine = \(line\) => setItems\(\(current\) => acceptLiveLine\(current, line\)\);/);
  assert.equal(/setNegotiation\([^)]*live/i.test(CODE), false);
});

test("invalid prices or missing reasons block Finalize", () => {
  assert.match(CODE, /review\.blocked \|\|\s*!pricingCheck\.ok/);
  assert.match(CODE, /if \(!pricingCheck\.ok\) \{\s*submittingRef\.current = false;/);
});

test("keyboard and screen-reader labels", () => {
  assert.match(PAGE, /<label htmlFor=\{inputId\}>/);
  assert.match(PAGE, /<label htmlFor=\{reasonId\}>/);
  assert.match(PAGE, /aria-invalid=\{price\.priceError \? "true" : "false"\}/);
  assert.match(PAGE, /aria-describedby=\{price\.priceError \? errorId : undefined\}/);
  assert.match(PAGE, /aria-label=\{`Reset \$\{item\.name\} to the standard price`\}/);
  assert.match(PAGE, /role="alert"/);
});

test("320 px and larger text: the review stacks and wraps", () => {
  const css = read("src/pages/salesRep/salesrep-polish.css");
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.salesrep-main \.place-v2-price-line \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.salesrep-main \.place-v2-price-product strong \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.salesrep-main \.place-v2-confirm \{[^}]*width: min\(600px, 100%\);[^}]*overflow-y: auto;/);
});

// ---------------------------------------------------------------- after placement

test("the Order Confirmation keeps the agreed snapshot; only the lifecycle is live", () => {
  const placed = {
    id: "o1", orderNumber: "VT-1", status: "pending_dispatch", priceIsVatInclusive: true, subtotalCentavos: 33000,
    priceAgreementVersion: 1, priceAdjusted: true, standardSubtotalCentavos: 37500, priceAdjustmentCentavos: -4500,
    vatSummary: { vatableSalesCentavos: 29464, vatAmountCentavos: 3536, vatExemptSalesCentavos: 0, zeroRatedSalesCentavos: 0, totalCentavos: 33000 },
    items: [{ name: "Hep B", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, standardUnitPriceCentavos: 12500, priceAdjusted: true, adjustmentCentavos: -4500, adjustmentReason: "deal", vatClassification: "vatable" }],
  };
  const record = buildConfirmationFromOrder(placed);
  assert.equal(record.items[0].unitPriceCentavos, 11000);
  assert.equal(record.items[0].standardUnitPriceCentavos, 12500);
  assert.equal(record.items[0].adjustmentReason, "deal");
  assert.equal(record.priceAdjusted, true);
  assert.equal(record.vatSummary.vatAmountCentavos, 3536);
  // Later the order is assigned and (hypothetically) every price restated:
  const later = { ...placed, status: "assigned", subtotalCentavos: 1, vatSummary: { vatAmountCentavos: 0 },
    items: [{ ...placed.items[0], unitPriceCentavos: 1, standardUnitPriceCentavos: 1, adjustmentReason: "rewritten" }] };
  const shown = withLiveLifecycle(record, later);
  assert.equal(shown.status, "assigned");
  assert.equal(shown.items[0].unitPriceCentavos, 11000);
  assert.equal(shown.items[0].standardUnitPriceCentavos, 12500);
  assert.equal(shown.items[0].adjustmentReason, "deal");
  assert.equal(shown.subtotalCentavos, 33000);
  assert.equal(shown.vatSummary.vatAmountCentavos, 3536);
  // Legacy orders read as standard-priced, never inferred.
  const legacy = buildConfirmationFromOrder({ id: "o2", items: [{ name: "X", quantity: 1, unitPriceCentavos: 500, lineTotalCentavos: 500 }] });
  assert.equal(legacy.items[0].priceAdjusted, false);
  assert.equal(legacy.items[0].standardUnitPriceCentavos, 500);
  assert.equal(legacy.priceAdjusted, false);
});

test("the confirmation page cannot edit a placed price", () => {
  const page = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  assert.equal(/<input|<textarea|contentEditable/i.test(page), false);
  assert.match(page, /Negotiated price \{formatCentavos\(agreed\)\} \(standard \{formatCentavos\(price\.standardUnitPriceCentavos\)\}\)/);
  assert.match(page, /Final total \(VAT-inclusive\)/);
});

test("the invoice uses the agreed snapshot and refuses a second discount on a negotiated order", () => {
  assert.equal(orderHasNegotiatedPrice({ priceAgreementVersion: 1, priceAdjusted: true }), true);
  assert.equal(orderHasNegotiatedPrice({ priceAgreementVersion: 1, priceAdjusted: false, items: [] }), false);
  assert.equal(orderHasNegotiatedPrice({ pricingVersion: 1, items: [{ unitPriceCentavos: 1 }] }), false, "legacy");
  const editor = strip(read("src/pages/admin/InvoiceEditor.jsx"));
  assert.match(editor, /const discountLocked = readOnly \|\| \(serverPriced && orderHasNegotiatedPrice\(order\)\);/);
  assert.match(editor, /value=\{form\.discount\}\s*onChange=\{\(v\) => setField\("discount", v\)\}\s*readOnly=\{discountLocked\}/);
  // Base pricing on a priced invoice is the order's own (agreed) unit price.
  const pricing = read("functions/src/invoicePricing.js");
  assert.match(pricing, /unitPriceCentavos: it\.unitPriceCentavos,/);
  assert.match(pricing, /priceNegotiated: orderHasNegotiatedPrice\(order\)/);
});
