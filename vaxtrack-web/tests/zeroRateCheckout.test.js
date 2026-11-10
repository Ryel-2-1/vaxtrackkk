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
