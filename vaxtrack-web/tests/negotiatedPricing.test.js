// Negotiated prices + statutory (SC/PWD) line discounts — web side.
//
// Pure arithmetic (parsing, totals, per-line VAT after discount, rounding,
// reset, reasons, discount bounds), parity with the authoritative server
// module, and the page wiring that has no DOM here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  ELIGIBILITY_ATTESTATION_TEXT,
  NEGOTIATED_PRICE_LABEL,
  STATUTORY_DISCOUNT_LABELS,
  STATUTORY_DISCOUNT_TYPES,
  agreedInputFor,
  negotiatedRequestLine,
  parseAgreedPriceInput,
  parseDiscountInput,
  priceReviewLine,
  reviewProblems,
  summarizeReviewVat,
} from "../src/services/negotiatedPricing.js";
import { buildConfirmationFromOrder, withLiveLifecycle } from "../src/services/orderConfirmation.js";
import { canonicalSubmission, diffSubmission } from "../src/services/orderDraftRequest.js";
import {
  adjustmentsFromForm,
  buildInitialForm,
  computeInvoiceTotals,
  invoiceLineAmount,
  isLineDiscountOrder,
  itemsFromOrder,
} from "../src/services/invoiceModel.js";
import { parseAdjustmentPesosToCentavos } from "../src/services/money.js";
import { splitVatInclusiveCentavos } from "../src/services/pricingConfig.js";

const require = createRequire(import.meta.url);
const server = require("../functions/src/negotiatedPricing.js");
const serverPolicy = require("../functions/src/policy.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const vatOf = (c) => splitVatInclusiveCentavos(c).vatCentavos;

// The attestation box is ticked by default; tests that need it unticked say so.
const line = (over = {}) =>
  priceReviewLine({ quantity: 3, expectedUnitPriceCentavos: 12500, vatClassification: "vatable", eligibilityConfirmed: true, ...over });

// ---------------------------------------------------------------- parsing

test("peso input → centavos: whole pesos and one or two decimals", () => {
  for (const [text, value] of [["1250", 125000], ["1250.5", 125050], ["1250.50", 125050], [" 1,250.00 ", 125000], ["0.01", 1]]) {
    assert.deepEqual(parseAgreedPriceInput(text), { ok: true, value }, text);
    assert.deepEqual(parseDiscountInput(text), { ok: true, value }, text);
  }
});

test("excess decimals, malformed, negative, NaN, Infinity, zero and over-limit input are refused", () => {
  for (const text of ["12.345", "1.", ".5", "abc", "1e3", "-5", "NaN", "Infinity", "₱100", "0", "0.00", "", "999999999999999999"]) {
    assert.equal(parseAgreedPriceInput(text).ok, false, text);
    assert.equal(parseDiscountInput(text).ok, false, text);
  }
  assert.match(parseDiscountInput("").message, /Enter the discount amount/);
  assert.match(parseDiscountInput("0").message, /No discount/);
  assert.match(parseDiscountInput("1.234").message, /two decimal places/);
});

// ---------------------------------------------------------------- one line

test("negotiated price only", () => {
  const l = line({ agreedInput: "110.50", negotiationReason: "  bulk   deal " });
  assert.equal(l.negotiatedGrossCentavos, 33150);
  assert.equal(l.negotiatedAdjustmentCentavos, -4350);
  assert.equal(l.priceNegotiated, true);
  assert.equal(l.negotiationReason, "bulk deal");
  assert.equal(l.statutoryDiscountCentavos, 0);
  assert.equal(l.finalLineTotalCentavos, 33150);
  assert.match(line({ agreedInput: "110.50" }).reasonError, /reason/);
  assert.match(line({ agreedInput: "" }).priceError, /Enter the agreed price/, "a cleared field is an error");
  assert.equal(line({ agreedInput: "125.00" }).priceNegotiated, false, "typing the standard needs no reason");
});

test("SC/PWD discount only: subtracted from its line; VAT extracted after it", () => {
  const l = line({ discountType: "senior_citizen", discountInput: "75" });
  assert.equal(l.priceNegotiated, false);
  assert.equal(l.statutoryDiscountCentavos, 7500);
  assert.equal(l.statutoryDiscountType, "senior_citizen");
  assert.equal(l.finalLineTotalCentavos, 30000);
  assert.equal(l.lineVatCentavos, vatOf(30000));
  assert.equal(l.lineNetOfVatCentavos + l.lineVatCentavos, 30000);
});

test("both on one line, as separate figures", () => {
  const l = line({ agreedInput: "110", negotiationReason: "volume", discountType: "pwd", discountInput: "66" });
  assert.equal(l.negotiatedAdjustmentCentavos, -4500);
  assert.equal(l.statutoryDiscountCentavos, 6600);
  assert.equal(l.finalLineTotalCentavos, 26400);
});

test("the discount boundary is the line's NEGOTIATED gross; a category needs an amount", () => {
  assert.equal(line({ discountType: "pwd", discountInput: "375" }).finalLineTotalCentavos, 0, "equal allowed");
  assert.match(line({ discountType: "pwd", discountInput: "375.01" }).discountError, /larger than this line/);
  assert.match(line({ agreedInput: "100", negotiationReason: "r", discountType: "pwd", discountInput: "300.01" }).discountError, /larger/);
  assert.match(line({ discountType: "pwd" }).discountError, /Enter the discount amount/);
  assert.match(line({ discountType: "employee", discountInput: "5" }).discountError, /valid discount category/);
  assert.equal(line({ discountType: "", discountInput: "999" }).statutoryDiscountCentavos, 0, "No discount ignores the amount");
});

test("the categories match the server — Senior Citizen and PWD only — and need no personal data", () => {
  assert.deepEqual([...STATUTORY_DISCOUNT_TYPES], ["senior_citizen", "pwd"]);
  assert.deepEqual([...STATUTORY_DISCOUNT_TYPES], [...serverPolicy.STATUTORY_DISCOUNT_TYPES]);
  assert.deepEqual(Object.keys(STATUTORY_DISCOUNT_LABELS), ["senior_citizen", "pwd"]);
  for (const t of ["naac", "medal_of_valor", "solo_parent"]) {
    assert.match(line({ discountType: t, discountInput: "5" }).discountError, /valid discount category/, t);
  }
  const page = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.equal(/idNumber|seniorCitizenId|pwdId|beneficiary|type="file"|capture=/i.test(page), false, "no SC/PWD identification is collected");
  assert.equal(/NAAC|Medal of Valor|Solo Parent/.test(page), false, "no unconfirmed category is offered");
});

test("a discounted line needs the eligibility attestation before it can be placed", () => {
  const unticked = line({ discountType: "pwd", discountInput: "30", eligibilityConfirmed: false });
  assert.match(unticked.eligibilityError, /Confirm that you verified the customer's eligibility/);
  assert.equal(reviewProblems([unticked]).ok, false);
  for (const notTrue of [undefined, "true", 1]) {
    assert.ok(line({ discountType: "pwd", discountInput: "30", eligibilityConfirmed: notTrue }).eligibilityError, String(notTrue));
  }
  const ticked = line({ discountType: "pwd", discountInput: "30" });
  assert.equal(ticked.eligibilityError, null);
  assert.equal(ticked.eligibilityConfirmed, true);
  assert.equal(reviewProblems([ticked]).ok, true);
  // No discount: no attestation needed, none recorded.
  const none = line({ eligibilityConfirmed: false });
  assert.equal(none.eligibilityError, null);
  assert.equal(none.eligibilityConfirmed, false);
  assert.equal(ELIGIBILITY_ATTESTATION_TEXT, serverPolicy.ELIGIBILITY_ATTESTATION_TEXT);
  assert.equal(ELIGIBILITY_ATTESTATION_TEXT, "I confirm that I verified the customer’s eligibility for this statutory discount.");
});

// ---------------------------------------------------------------- the order

const sample = () => [
  line({ quantity: 7, expectedUnitPriceCentavos: 33333, discountType: "senior_citizen", discountInput: "46.67" }),
  line({ quantity: 3, expectedUnitPriceCentavos: 1999, agreedInput: "18.99", negotiationReason: "promo" }),
  line({ quantity: 2, expectedUnitPriceCentavos: 45050, vatClassification: "vat_exempt", discountType: "pwd", discountInput: "90.10" }),
  line({ quantity: 11, expectedUnitPriceCentavos: 1001, agreedInput: "9.99", negotiationReason: "loyalty", vatClassification: "zero_rated" }),
];

test("mixed classes, discounts on selected lines: reconciles exactly, no proportional allocation", () => {
  const lines = sample();
  const s = summarizeReviewVat(lines);
  assert.equal(s.negotiatedSubtotalCentavos - s.statutoryDiscountTotalCentavos, s.totalCentavos);
  assert.equal(s.vatableSalesCentavos + s.vatAmountCentavos + s.vatExemptSalesCentavos + s.zeroRatedSalesCentavos, s.totalCentavos);
  assert.equal(s.vatAmountCentavos, vatOf(7 * 33333 - 4667) + vatOf(3 * 1899));
  assert.equal(lines[1].finalLineTotalCentavos, lines[1].negotiatedGrossCentavos, "undiscounted line untouched");
  assert.equal(lines[3].finalLineTotalCentavos, lines[3].negotiatedGrossCentavos);
});

test("rounding is half-up per line at the centavo boundary", () => {
  for (const [final, vat] of [[14, 2], [13, 1], [42, 5], [41, 4], [5, 1], [4, 0], [112, 12]]) {
    const l = line({ quantity: 1, expectedUnitPriceCentavos: 200, discountType: "pwd", discountInput: ((200 - final) / 100).toString() });
    assert.equal(l.finalLineTotalCentavos, final);
    assert.equal(l.lineVatCentavos, vat, `final ${final}`);
  }
});

test("web and server agree centavo for centavo on random orders", () => {
  let seed = 11;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const classes = ["vatable", "vat_exempt", "zero_rated"];
  const types = [null, ...STATUTORY_DISCOUNT_TYPES];
  for (let round = 0; round < 200; round += 1) {
    const raw = Array.from({ length: 1 + rand(6) }, () => {
      const quantity = 1 + rand(40);
      const agreed = 1 + rand(500000);
      const type = types[rand(types.length)];
      return { quantity, standard: 1 + rand(500000), agreed, cls: classes[rand(3)], type, discount: type ? 1 + rand(quantity * agreed) : 0 };
    });
    const web = raw.map((r) =>
      priceReviewLine({
        quantity: r.quantity, expectedUnitPriceCentavos: r.standard, vatClassification: r.cls,
        agreedInput: agreedInputFor(r.agreed), negotiationReason: "reason",
        discountType: r.type ?? "", discountInput: r.type ? agreedInputFor(r.discount) : "",
      })
    );
    const srv = raw.map((r) =>
      server.priceOrderLine({
        quantity: r.quantity, standardUnitPriceCentavos: r.standard, agreedUnitPriceCentavos: r.agreed,
        negotiationReason: "reason", statutoryDiscountType: r.type, statutoryDiscountCentavos: r.discount,
        eligibilityConfirmed: true, vatClassification: r.cls,
      })
    );
    raw.forEach((_, i) => {
      for (const k of ["negotiatedGrossCentavos", "statutoryDiscountCentavos", "finalLineTotalCentavos", "lineVatCentavos", "lineNetOfVatCentavos"]) {
        assert.equal(web[i][k], srv[i][k], `${k} line ${i}`);
      }
    });
    const w = summarizeReviewVat(web);
    const s = server.summarizeAgreement(srv);
    assert.equal(w.negotiatedSubtotalCentavos, s.negotiatedSubtotalCentavos);
    assert.equal(w.statutoryDiscountTotalCentavos, s.statutoryDiscountTotalCentavos);
    assert.equal(w.totalCentavos, s.finalTotalCentavos);
    assert.equal(w.negotiatedAdjustmentCentavos, s.negotiatedAdjustmentTotalCentavos);
    for (const k of ["vatableGrossCentavos", "vatableSalesCentavos", "vatAmountCentavos", "vatExemptSalesCentavos", "zeroRatedSalesCentavos"]) {
      assert.equal(w[k], s.vatSummary[k], k);
    }
  }
});

test("no floating-point currency in the pricing module", () => {
  const src = strip(read("src/services/negotiatedPricing.js"));
  assert.equal(/parseFloat|toFixed|\* 100\b|\/ 100\b|Number\(text\)/.test(src), false);
});

test("invalid lines make the totals unavailable, never wrong", () => {
  assert.equal(summarizeReviewVat([line({ agreedInput: "abc" })]), null);
  assert.equal(summarizeReviewVat([line({ discountType: "pwd", discountInput: "999" })]), null);
  const problems = reviewProblems([line({ agreedInput: "abc" }), line({ agreedInput: "100" }), line({ discountType: "pwd" })]);
  assert.equal(problems.ok, false);
  assert.equal(problems.problems.length, 3);
});

// ---------------------------------------------------------------- the request

test("the request carries unit price, reason and the line's discount — no totals, no VAT", () => {
  const cart = { inventoryId: "inv1", quantity: 3, expectedUnitPriceCentavos: 12500 };
  assert.deepEqual(negotiatedRequestLine(cart, line({ agreedInput: "110", negotiationReason: "deal", discountType: "pwd", discountInput: "30" })), {
    expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 11000, negotiationReason: "deal",
    statutoryDiscountType: "pwd", statutoryDiscountCentavos: 3000, eligibilityConfirmed: true,
  });
  assert.deepEqual(negotiatedRequestLine(cart, line()), { expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12500 });
  const fn = read("src/services/negotiatedPricing.js").slice(read("src/services/negotiatedPricing.js").indexOf("export function negotiatedRequestLine"));
  assert.equal(/vat|finalLine|negotiatedGross|lineTotal/i.test(fn), false);
  const callables = strip(read("src/services/inventoryCallables.js"));
  assert.match(callables, /negotiationReason: item\.negotiationReason/);
  assert.match(callables, /statutoryDiscountType: item\.statutoryDiscountType,\s*statutoryDiscountCentavos: item\.statutoryDiscountCentavos,\s*eligibilityConfirmed: item\.eligibilityConfirmed === true,/);
});

test("a retry under the same request id must carry the same price, reason and discount", () => {
  const base = { doctorId: "d", doctorAddressId: "home", requestedDeliveryDate: "2026-10-20",
    items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100, agreedUnitPriceCentavos: 90, negotiationReason: "deal", statutoryDiscountType: "pwd", statutoryDiscountCentavos: 10, eligibilityConfirmed: true }] };
  assert.deepEqual(diffSubmission(base, base), []);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], agreedUnitPriceCentavos: 80 }] }), ["agreed price"]);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], statutoryDiscountCentavos: 11 }] }), ["statutory discount"]);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], statutoryDiscountType: "senior_citizen" }] }), ["statutory discount"]);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], eligibilityConfirmed: false }] }), ["statutory discount"]);
  const old = { ...base, items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100 }] };
  assert.deepEqual(canonicalSubmission(old).items[0], {
    inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 100, agreedUnitPriceCentavos: 100,
    negotiationReason: null, statutoryDiscountType: null, statutoryDiscountCentavos: 0, eligibilityConfirmed: false,
  });
});

// ---------------------------------------------------------------- the page

const PAGE = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
const CODE = strip(PAGE);

test("each line edits its agreed price; checkout offers no SC/PWD discount entry", () => {
  assert.match(PAGE, /Agreed unit price \(VAT-inclusive\) for \{item\.name\}/);
  for (const label of ["Standard unit price", "Negotiated line total", "Price adjustment", "Final line total"]) {
    assert.match(PAGE, new RegExp(`<dt>${label}</dt>`), label);
  }
  // Removed from the review: the standard line total and the SC/PWD figure,
  // the per-line discount selector, its amount and its attestation.
  for (const gone of ["<dt>Standard line total</dt>", "<dt>SC/PWD discount</dt>", "SC/PWD discount for", "No discount", "Discount amount for this line", "place-v2-price-discount", "place-v2-eligibility"]) {
    assert.equal(PAGE.includes(gone), false, `${gone} must be gone`);
  }
  for (const gone of ["onDiscountTypeChange", "onDiscountChange", "onEligibilityChange", "discountType", "discountInput", "eligibilityConfirmed", "ELIGIBILITY_ATTESTATION_TEXT", "STATUTORY_DISCOUNT_TYPES"]) {
    assert.equal(CODE.includes(gone), false, `${gone} must be gone`);
  }
  // One money input per line: the agreed unit price. No total input.
  assert.equal((PAGE.match(/inputMode="decimal"/g) || []).length, 1);
  // Reset clears the price and its reason.
  assert.match(CODE, /delete rest\.agreedInput;\s*delete rest\.reason;\s*return \{ \.\.\.current, \[sku\]: rest \};/);
  assert.match(PAGE, /Reset to standard price/);
});

test("with no discount entry, a checkout line is reviewed and sent at its agreed price", () => {
  // The page reviews each line with exactly these inputs — no discount fields.
  assert.match(
    CODE,
    /price: priceReviewLine\(\{\s*quantity: item\.quantity,\s*expectedUnitPriceCentavos: item\.expectedUnitPriceCentavos,\s*vatClassification,\s*agreedInput: entry\.agreedInput,\s*negotiationReason: entry\.reason \?\? "",\s*\}\)/
  );
  // Same inputs through the model: no discount, VAT-inclusive totals intact.
  const cart = { inventoryId: "inv1", quantity: 3, expectedUnitPriceCentavos: 12500 };
  const standard = line({ vatClassification: "vatable" });
  assert.equal(standard.statutoryDiscountCentavos, 0);
  assert.equal(standard.statutoryDiscountType, null);
  assert.equal(standard.finalLineTotalCentavos, 37500);
  assert.equal(standard.lineVatCentavos, vatOf(37500));
  assert.equal(line({ vatClassification: "vat_exempt" }).lineVatCentavos, 0);
  assert.deepEqual(negotiatedRequestLine(cart, standard), { expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 12500 });
  const negotiated = line({ agreedInput: "110", negotiationReason: "deal" });
  assert.equal(negotiated.negotiatedAdjustmentCentavos, -4500);
  assert.equal(negotiated.finalLineTotalCentavos, 33000);
  assert.deepEqual(negotiatedRequestLine(cart, negotiated), {
    expectedUnitPriceCentavos: 12500, agreedUnitPriceCentavos: 11000, negotiationReason: "deal",
  });
  // The request line is still built from the reviewed price.
  assert.match(CODE, /\.\.\.negotiatedRequestLine\(item, reviewBySku\.get\(item\.sku\)\.price\)/);
});

test("the summary shows negotiated subtotal, VAT and the final total", () => {
  for (const label of ["Negotiated subtotal", "VATable sales (net of VAT)", "VAT-exempt sales", "Zero-rated sales", "VAT (12%)", "Final total (VAT-inclusive)"]) {
    assert.match(PAGE, new RegExp(`<dt>${label.replace(/[()/]/g, "\\$&")}</dt>`), label);
  }
  assert.equal(PAGE.includes("Less: SC/PWD discounts"), false);
});

test("the reconfirmation dialog lists each line's price, and still sends once", () => {
  const dialog = PAGE.slice(PAGE.indexOf("function ReconfirmDialog"));
  assert.match(dialog, /Reason: \{price\.negotiationReason\}/);
  assert.match(dialog, /<strong>\{formatAmount\(price\.finalLineTotalCentavos\)\}<\/strong>/);
  assert.equal(/statutoryDiscount/.test(dialog), false);
  assert.match(CODE, /const confirmed = reconfirmedRef\.current;\s*reconfirmedRef\.current = false;/);
  assert.match(CODE, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;/);
});

// ---------------------------------------------------------------- after placement

const placed = {
  id: "o1", orderNumber: "VT-1", status: "pending_dispatch", priceIsVatInclusive: true, pricingVersion: 1,
  priceAgreementVersion: 1, subtotalCentavos: 33000, priceNegotiated: true, standardSubtotalCentavos: 37500,
  negotiatedAdjustmentTotalCentavos: -4500, statutoryDiscountTotalCentavos: 3300, finalTotalCentavos: 29700,
  vatSummary: { vatableSalesCentavos: 29700 - vatOf(29700), vatAmountCentavos: vatOf(29700), vatExemptSalesCentavos: 0, zeroRatedSalesCentavos: 0, totalCentavos: 29700 },
  items: [{ name: "Hep B", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, standardUnitPriceCentavos: 12500,
    priceNegotiated: true, negotiatedAdjustmentCentavos: -4500, negotiationReason: "deal",
    statutoryDiscountType: "pwd", statutoryDiscountCentavos: 3300, finalLineTotalCentavos: 29700, lineVatCentavos: vatOf(29700), vatClassification: "vatable" }],
};

test("the Order Confirmation keeps the agreed prices and discounts; only the lifecycle is live", () => {
  const record = buildConfirmationFromOrder(placed);
  assert.equal(record.items[0].statutoryDiscountCentavos, 3300);
  assert.equal(record.items[0].finalLineTotalCentavos, 29700);
  assert.equal(record.finalTotalCentavos, 29700);
  assert.equal(record.statutoryDiscountTotalCentavos, 3300);
  const later = { ...placed, status: "assigned", finalTotalCentavos: 1, statutoryDiscountTotalCentavos: 0,
    items: [{ ...placed.items[0], statutoryDiscountCentavos: 0, finalLineTotalCentavos: 1, negotiationReason: "rewritten" }] };
  const shown = withLiveLifecycle(record, later);
  assert.equal(shown.status, "assigned");
  assert.equal(shown.items[0].statutoryDiscountCentavos, 3300);
  assert.equal(shown.items[0].negotiationReason, "deal");
  assert.equal(shown.finalTotalCentavos, 29700);
  // Legacy order: the subtotal is the charged amount, nothing inferred.
  const legacy = buildConfirmationFromOrder({ id: "o2", subtotalCentavos: 500, items: [{ name: "X", quantity: 1, unitPriceCentavos: 500, lineTotalCentavos: 500 }] });
  assert.equal(legacy.items[0].priceNegotiated, false);
  assert.equal(legacy.items[0].statutoryDiscountCentavos, 0);
  assert.equal(legacy.finalTotalCentavos, 500);
});

test("the confirmation page cannot edit a placed price and shows the final total", () => {
  const page = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  assert.equal(/<input|<textarea|contentEditable/i.test(page), false);
  assert.match(page, /Less: SC\/PWD discounts/);
  assert.match(page, /formatAmount\(order\.finalTotalCentavos\)/);
});

// The visible invoice in the editor: Σ line amounts = Total Sales = VAT
// breakdown = total due, with no discount line.
function assertEditorInvoiceAddsUp(items, t) {
  const sumC = items.reduce((s, it) => s + Math.round(invoiceLineAmount(it) * 100), 0);
  const c = (v) => Math.round(v * 100);
  assert.equal(c(t.subtotal), sumC, "subtotal = Σ printed amounts");
  assert.equal(c(t.discount), 0, "no discount");
  assert.equal(c(t.totalSalesVatInclusive), sumC);
  assert.equal(c(t.vatableSales) + c(t.vatAmount) + c(t.vatExemptSales) + c(t.zeroRatedSales), sumC);
  assert.equal(c(t.grandTotal), sumC);
  for (const it of items) {
    if (it.unitPriceCentavos !== null) assert.equal(it.unitPriceCentavos * it.quantity, it.lineTotalCentavos);
  }
}

test("the invoice editor shows final charged amounts and no discount line for an agreement order", () => {
  assert.equal(isLineDiscountOrder(placed), true);
  assert.equal(isLineDiscountOrder({ pricingVersion: 1 }), false, "legacy priced order");
  const items = itemsFromOrder(placed);
  // ₱297.00 over 3 vials divides exactly: ₱99.00 net.
  assert.equal(items[0].lineTotalCentavos, 29700);
  assert.equal(items[0].amountIsFinalCharged, true);
  assert.equal(items[0].unitPriceCentavos, 9900);
  assert.equal(invoiceLineAmount(items[0]), 297);
  assert.equal("statutoryDiscountCentavos" in items[0], false);
  const form = buildInitialForm(placed, null, "Rep");
  assert.equal(form.discount, 0, "no invoice discount");
  const t = computeInvoiceTotals({ items, discount: 0, otherCharges: 0, withholdingTax: 0, vatClassification: "per_item", priceIsVatInclusive: true, lineLevel: true });
  assert.equal(Math.round(t.grandTotal * 100), 29700);
  assert.equal(Math.round(t.vatAmount * 100), vatOf(29700), "VAT on the final charged amount");
  assertEditorInvoiceAddsUp(items, t);
  // No discount is sent; other adjustments still are.
  const adj = adjustmentsFromForm({ discount: "33", otherCharges: "0", withholdingTax: "0", vatClassification: "per_item" }, parseAdjustmentPesosToCentavos, { recordedDiscount: true });
  assert.equal("discountCentavos" in adj, false);
  assert.equal(adj.otherChargesCentavos, 0);
  assert.equal(NEGOTIATED_PRICE_LABEL, "Negotiated price");
});

test("a charged amount that does not divide by the quantity shows no unit price", () => {
  // 3 × ₱110.00 − ₱33.01 = ₱296.99 — not divisible by 3.
  const odd = { ...placed, statutoryDiscountTotalCentavos: 3301, finalTotalCentavos: 29699,
    items: [{ ...placed.items[0], statutoryDiscountCentavos: 3301, finalLineTotalCentavos: 29699, lineVatCentavos: vatOf(29699) }] };
  const items = itemsFromOrder(odd);
  assert.equal(items[0].unitPriceCentavos, null, "never a rounded ₱99.00 × 3 = ₱297.00");
  assert.equal(items[0].unitPrice, null);
  assert.equal(invoiceLineAmount(items[0]), 296.99);
  const t = computeInvoiceTotals({ items, otherCharges: 0, withholdingTax: 0, vatClassification: "per_item", priceIsVatInclusive: true, lineLevel: true });
  assertEditorInvoiceAddsUp(items, t);
  // Web and server present the same invoice lines.
  const serverInvoice = require("../functions/src/invoicePricing.js");
  const base = serverInvoice.buildInvoiceBaseFromOrder(odd);
  assert.equal(base.items[0].lineTotalCentavos, items[0].lineTotalCentavos);
  assert.equal(base.items[0].unitPriceCentavos, items[0].unitPriceCentavos);
});

test("the editor template: net labels, a dash for a non-exact unit price, no discount row for agreement invoices", () => {
  const editor = strip(read("src/pages/admin/InvoiceEditor.jsx"));
  const page = read("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /const lineLevel = serverPriced && isLineDiscountOrder\(order\);\s*const discountLocked = readOnly \|\| lineLevel;/);
  assert.match(editor, /const finalChargedAmounts = lineLevel \|\| invoice\?\.lineAmountBasis === "final_charged";/);
  assert.match(page, /finalChargedAmounts \? "Amount Charged \(Net\)" : "Amount"/);
  assert.match(page, /isFinalChargedLine\(it\) && it\.unitPriceCentavos == null \? \(/);
  assert.match(editor, /formatCurrency\(invoiceLineAmount\(it\)\)/);
  // The legacy discount row — labels unchanged — renders only for other invoices.
  assert.match(page, /\{!finalChargedAmounts && \(\s*<div className="sit-tt-row sit-tt-input">\s*<span>Less: Discount \[SC\/PWD\/NAAC\/MOV\/SP\]<\/span>/);
  assert.equal(/orderHasNegotiatedPrice/.test(editor), false, "negotiation alone no longer locks the discount");
});

test("legacy invoices are unchanged: quantity × unit price lines and the Admin's own discount", () => {
  const legacyOrder = { pricingVersion: 1, priceIsVatInclusive: true, subtotalCentavos: 33000,
    items: [{ name: "A", quantity: 3, unitPriceCentavos: 11000, lineTotalCentavos: 33000, vatClassification: "vatable" }] };
  const items = itemsFromOrder(legacyOrder);
  assert.equal("amountIsFinalCharged" in items[0], false);
  assert.equal(invoiceLineAmount(items[0]), 330);
  const t = computeInvoiceTotals({ items, discount: 5, otherCharges: 0, withholdingTax: 0, vatClassification: "per_item", priceIsVatInclusive: true });
  assert.equal(Math.round(t.discount * 100), 500);
  assert.equal(Math.round(t.grandTotal * 100), 32500);
  // A stored legacy invoice keeps its discount on reopening.
  assert.equal(buildInitialForm(legacyOrder, { items: [], discount: 5 }, "Rep").discount, 5);
});
