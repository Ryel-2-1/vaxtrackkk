"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalRequestFingerprint, validateCreatePayload } = require("../src/policy");
const { approvedCartMatches } = require("../src/zeroRateApproval");

test("an approved request ID and reviewed quote are bound to the order retry key", () => {
  const input = { uid: "rep1", doctorId: "doctor1", doctorAddressId: "clinic1",
    items: [{ inventoryId: "batch1", quantity: 1, expectedUnitPriceCentavos: 10000,
      expectedQuotedUnitPriceCentavos: 10000, agreedUnitPriceCentavos: 10000 }],
    schedule: { requestedDeliveryDate: "2026-11-10", requestedArrival: null } };
  const first = canonicalRequestFingerprint({ ...input, zeroRateRequestId: "approval1" });
  assert.notEqual(first, canonicalRequestFingerprint({ ...input, zeroRateRequestId: "approval2" }));
  assert.notEqual(first, canonicalRequestFingerprint({ ...input, zeroRateRequestId: null }));
  assert.notEqual(first, canonicalRequestFingerprint({ ...input, items: [{ ...input.items[0], expectedQuotedUnitPriceCentavos: 11200 }], zeroRateRequestId: "approval1" }));
});

test("an approval applies only to the reviewed batches and vial counts", () => {
  const approved = [{ inventoryId: "batch2", quantity: 3, vaccineName: "B" }, { inventoryId: "batch1", quantity: 1, vaccineName: "A" }];
  assert.equal(approvedCartMatches(approved, [{ inventoryId: "batch1", quantity: 1 }, { inventoryId: "batch2", quantity: 3 }]), true);
  assert.equal(approvedCartMatches(approved, [{ inventoryId: "batch1", quantity: 2 }, { inventoryId: "batch2", quantity: 3 }]), false);
  assert.equal(approvedCartMatches(approved, [{ inventoryId: "batch1", quantity: 1 }]), false);
  assert.equal(approvedCartMatches(approved, [{ inventoryId: "batch1", quantity: 1 }, { inventoryId: "batch3", quantity: 3 }]), false);
});

test("checkout rejects client-supplied VAT classification and totals", () => {
  const base = { doctorId: "doctor1", doctorAddressId: "clinic1", items: [{
    inventoryId: "batch1", quantity: 1, expectedUnitPriceCentavos: 10000,
    expectedQuotedUnitPriceCentavos: 10000,
  }] };
  assert.doesNotThrow(() => validateCreatePayload(base));
  for (const field of ["vatClassification", "vatAmountCentavos", "finalTotalCentavos"]) {
    assert.throws(() => validateCreatePayload({ ...base, items: [{ ...base.items[0], [field]: field }] }), { code: "unknown-field" });
  }
});
