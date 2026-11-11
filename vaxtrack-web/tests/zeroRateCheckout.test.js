import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { canonicalSubmission, diffSubmission } from "../src/services/orderDraftRequest.js";
import { quoteUnitPrice as displayQuote } from "../src/services/vatQuote.js";
import { approvedZeroRateForOrder, matchingZeroRateOrderRequests, zeroRateCheckoutBlock } from "../src/services/zeroRateOrderMatch.js";

const require = createRequire(import.meta.url);
const { quoteUnitPrice: serverQuote } = require("../functions/src/vatQuote.js");

test("a pending review blocks checkout only for its exact order, until Admin decides", () => {
  const order = { doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: "2026-11-10",
    items: [{ inventoryId: "batch1", quantity: 2 }] };
  const pending = { ...order, id: "request1", status: "pending" };
  const block = (rows, details = order, overrides = {}) => zeroRateCheckoutBlock({
    requests: matchingZeroRateOrderRequests(rows, details), ready: true, ...overrides,
  });
  assert.match(block([pending]), /Wait for Admin/);
  for (const status of ["approved", "rejected", "used"]) assert.equal(block([{ ...pending, status }]), "");
  assert.equal(block([]), "", "optional review does not block ordinary orders");
  for (const change of [{ doctorId: "doctor2" }, { doctorAddressId: "clinic2" },
    { requestedDeliveryDate: "2026-11-11" }, { items: [{ inventoryId: "batch1", quantity: 3 }] }]) {
    assert.equal(block([pending], { ...order, ...change }), "");
  }
  assert.match(block([], order, { sending: true }), /Sending/);
  assert.match(block([], order, { ready: false }), /Checking/);
  assert.match(block([], order, { loadError: new Error("offline") }), /could not be verified/);
  assert.match(block([pending], order, { recovering: true }), /Wait for Admin/);
  assert.equal(block([], order, { recovering: true, ready: false, loadError: new Error("offline") }), "", "saved attempts can reach server replay during an outage");
  assert.match(block([pending], order, { recovering: true, sending: true }), /Sending/);
});

test("the Med Rep's quote matches the server for both price bases and approved zero-rating", () => {
  for (const enteredCentavos of [10000, 11200, 12345]) {
    for (const priceIsVatInclusive of [false, true]) {
      for (const approvedZeroRate of [false, true]) {
        const input = { enteredCentavos, priceIsVatInclusive, productVatClassification: "vatable", approvedZeroRate };
        assert.deepEqual(displayQuote(input), serverQuote(input));
      }
    }
  }
  assert.equal(displayQuote({ enteredCentavos: 10000, priceIsVatInclusive: false, productVatClassification: "vatable" }).unitPriceCentavos, 11200);
  assert.equal(displayQuote({ enteredCentavos: 10000, priceIsVatInclusive: false, productVatClassification: "vatable", approvedZeroRate: true }).unitPriceCentavos, 10000);
});

test("a saved checkout cannot change its approval or quoted amount under the same request key", () => {
  const base = {
    doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: "2026-11-10",
    zeroRateRequestId: "approval1", items: [{ inventoryId: "batch1", quantity: 2,
      expectedUnitPriceCentavos: 10000, expectedQuotedUnitPriceCentavos: 10000,
      agreedUnitPriceCentavos: 10000 }],
  };
  assert.equal(canonicalSubmission(base).zeroRateRequestId, "approval1");
  assert.deepEqual(diffSubmission(base, { ...base, zeroRateRequestId: "approval2" }), ["zero-rating approval"]);
  assert.deepEqual(diffSubmission(base, { ...base, items: [{ ...base.items[0], expectedQuotedUnitPriceCentavos: 11200 }] }), ["price"]);
});

test("only an exact approved request applies automatically, and a saved retry keeps its original approval", () => {
  const order = { doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: "2026-11-10",
    items: [{ inventoryId: "batch1", quantity: 2 }] };
  const at = (time) => ({ toMillis: () => time });
  const requests = [
    { ...order, id: "older", status: "approved", createdAt: at(1) },
    { ...order, id: "newer", status: "approved", createdAt: at(2) },
    { ...order, id: "pending", status: "pending", createdAt: at(3) },
  ];
  assert.equal(approvedZeroRateForOrder(requests, order)?.id, "newer");
  assert.equal(approvedZeroRateForOrder(requests, { ...order, items: [{ inventoryId: "batch1", quantity: 3 }] }), null);
  assert.equal(approvedZeroRateForOrder(requests, { ...order, doctorAddressId: "clinic2" }), null);
  assert.equal(approvedZeroRateForOrder(requests, { ...order, recoveryAllowed: true,
    recoveryApprovalId: "older", restored: { ...order, zeroRateRequestId: "older" } })?.id, "older");
  assert.equal(approvedZeroRateForOrder([], { ...order, recoveryAllowed: true,
    recoveryApprovalId: "older", restored: { ...order, zeroRateRequestId: "older" } })?.id, "older");
  assert.equal(approvedZeroRateForOrder([], { ...order, items: [{ inventoryId: "batch1", quantity: 3 }],
    recoveryAllowed: true, recoveryApprovalId: "older", restored: { ...order, zeroRateRequestId: "older" } }), null);
  assert.equal(approvedZeroRateForOrder(requests, { ...order, recoveryAllowed: true,
    recoveryApprovalId: "", restored: { ...order } }), null);
});

// ---- 2026-11-11: zero-rating is asked first, and approval shows VAT removed ----
import { ZERO_RATE_STEP as Z, answerChangeClearsPrices, pricingLockedReason, zeroRateStep, zeroRateStepBlock } from "../src/services/zeroRateStep.js";
import { readFileSync } from "node:fs";
const readSrc = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("a Med Rep answers the zero-rating question before pricing or finalizing", () => {
  const base = { hasVatable: true, approved: false, pending: false, denied: false, answer: "" };
  assert.equal(zeroRateStep(base), Z.UNANSWERED);
  assert.equal(zeroRateStep({ ...base, answer: "no" }), Z.STANDARD);
  assert.equal(zeroRateStep({ ...base, answer: "yes" }), Z.REQUESTING);
  assert.equal(zeroRateStep({ ...base, answer: "yes", denied: true }), Z.DENIED);
  assert.equal(zeroRateStep({ ...base, pending: true }), Z.PENDING, "a sent request holds whatever the answer");
  assert.equal(zeroRateStep({ ...base, approved: true, answer: "no" }), Z.APPROVED, "an exact approval always applies");
  assert.equal(zeroRateStep({ ...base, hasVatable: false }), Z.NOT_NEEDED, "nothing to zero-rate, nothing to ask");
  assert.equal(zeroRateStep({ ...base, recovering: true }), Z.STANDARD, "a saved attempt resumes as sent");
  // Finalize waits until the answer settles the VAT; pending is held by zeroRateCheckoutBlock.
  for (const step of [Z.UNANSWERED, Z.REQUESTING, Z.DENIED]) assert.notEqual(zeroRateStepBlock(step), "", step);
  for (const step of [Z.STANDARD, Z.APPROVED, Z.NOT_NEEDED, Z.PENDING]) assert.equal(zeroRateStepBlock(step), "", step);
  // Prices wait too, including while Admin decides.
  for (const step of [Z.UNANSWERED, Z.REQUESTING, Z.DENIED, Z.PENDING]) assert.notEqual(pricingLockedReason(step), "", step);
  for (const step of [Z.STANDARD, Z.APPROVED, Z.NOT_NEEDED]) assert.equal(pricingLockedReason(step), "", step);
});

test("switching to or from Yes clears agreed prices typed on the other VAT basis", () => {
  assert.equal(answerChangeClearsPrices("", "no"), false);
  assert.equal(answerChangeClearsPrices("", "yes"), true);
  assert.equal(answerChangeClearsPrices("no", "yes"), true);
  assert.equal(answerChangeClearsPrices("yes", "no"), true);
  assert.equal(answerChangeClearsPrices("no", "no"), false);
});

test("the checkout asks first, locks pricing and Finalize, and shows the VAT removed on approval", () => {
  const page = readSrc("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  const review = readSrc("src/pages/salesRep/OrderPriceReview.jsx");
  const hook = readSrc("src/pages/salesRep/useCheckoutPriceReview.js");
  // The question sits before the price review, not in the sidebar as an option.
  assert.ok(page.indexOf("Is this a zero-rated sale?") < page.indexOf("<PriceReview"), "asked before pricing");
  assert.doesNotMatch(page, /<span>Optional<\/span>/);
  assert.match(page, /lockedReason=\{pricingLockedReason\(zeroStep\)\}/);
  assert.match(page, /saving \|\| Boolean\(zeroRateBlock\) \|\| Boolean\(zeroStepBlock\) \|\|/);
  assert.match(page, /if \(reviewBlock \|\| zeroStepBlock\) \{/, "re-checked on Review and Confirm");
  assert.match(page, /Zero-rating approved — VAT removed/);
  // Each approved line keeps its with-VAT price for display; the tally says how much came off.
  assert.match(hook, /vatRemoved: withVat !== null && withVat > quotedUnitPriceCentavos/);
  assert.match(review, /VAT removed: <s>\{formatCentavos\(vatRemoved\.fromUnitCentavos\)\}<\/s> → \{formatCentavos\(vatRemoved\.toUnitCentavos\)\} each/);
  assert.match(review, /<dt>VAT removed \(zero-rating approved\)<\/dt>/);
  assert.match(review, /disabled=\{disabled \|\| locked\}/);
});

test("the with-VAT price shown on an approved line is exactly what the server would have charged", () => {
  for (const enteredCentavos of [100000, 115000, 12345]) {
    for (const priceIsVatInclusive of [true, false]) {
      const withVat = displayQuote({ enteredCentavos, priceIsVatInclusive, productVatClassification: "vatable" });
      const approved = displayQuote({ enteredCentavos, priceIsVatInclusive, productVatClassification: "vatable", approvedZeroRate: true });
      assert.equal(approved.vatClassification, "zero_rated");
      assert.ok(withVat.unitPriceCentavos > approved.unitPriceCentavos, "approval always lowers a VATable price");
      assert.deepEqual(withVat, serverQuote({ enteredCentavos, priceIsVatInclusive, productVatClassification: "vatable" }));
    }
  }
  // ₱1,000.00 VAT-inclusive → ₱892.86 with the VAT removed.
  assert.equal(displayQuote({ enteredCentavos: 100000, priceIsVatInclusive: true, productVatClassification: "vatable", approvedZeroRate: true }).unitPriceCentavos, 89286);
});
