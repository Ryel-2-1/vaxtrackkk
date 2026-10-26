"use strict";

// Admin inventory removal controls — the pure decisions
// (functions/src/inventoryRemoval.js) and the shared voided/archived checks
// in policy.js and allocation.js. The transactions themselves are exercised
// against a real Firestore in test/integration/inventoryRemoval.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/inventoryRemoval");
const { allocatableUnits, usageMark } = require("../src/allocation");
const { evaluateBatch, isBatchVoided, isVaccineArchived, PolicyError } = require("../src/policy");
const { stockByProduct } = require("../src/inventoryAnalytics");

const NOW = new Date("2026-10-05T02:00:00.000Z"); // 2026-10-05 in Manila
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof PolicyError, `expected PolicyError, got ${e?.constructor?.name}`);
    return e.code;
  }
};
const batch = (over = {}) => ({
  vaccineId: "vacA",
  batchId: "LOT-1",
  status: "Stable",
  expiryDate: "2027-06-30",
  quantity: 10,
  reservedQuantity: 0,
  returnPendingQuantity: 0,
  quarantinedQuantity: 0,
  sellingPriceCentavos: 125000,
  priceIsVatInclusive: true,
  ...over,
});
const REQ = "req_abcdefghijklmnop";

// ---------------------------------------------------------------- validation

test("payloads: unknown keys, ids, reasons and quantities are refused before anything is read", () => {
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "v", archived: true, reason: "Discontinued", extra: 1 })), "unknown-field");
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "v", archived: "yes", reason: "Discontinued" })), "invalid-archive-request");
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "v", archived: true })), "reason-required", "archiving needs a reason");
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "v", archived: true, reason: "ab" })), "reason-required");
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "v", archived: true, reason: "x".repeat(501) })), "reason-too-long");
  assert.deepEqual(R.validateArchivePayload({ vaccineId: "v", archived: false }), { vaccineId: "v", archived: false, reason: null }, "restoring may omit it");
  assert.equal(code(() => R.validateArchivePayload({ vaccineId: "a/b", archived: false })), "invalid-destination");

  assert.equal(code(() => R.validateVoidPayload({ inventoryId: "b1" })), "reason-required");
  assert.deepEqual(R.validateVoidPayload({ inventoryId: "b1", reason: "  Entered twice  " }), { inventoryId: "b1", reason: "Entered twice" });

  const ok = { requestId: REQ, inventoryId: "b1", action: "quarantine", quantity: 2, reason: "damaged" };
  assert.deepEqual(R.validateRemovalPayload(ok), { ...ok, notes: null });
  assert.equal(code(() => R.validateRemovalPayload({ ...ok, requestId: "short" })), "invalid-request-id");
  assert.equal(code(() => R.validateRemovalPayload({ ...ok, action: "delete" })), "invalid-removal-action");
  assert.equal(code(() => R.validateRemovalPayload({ ...ok, reason: "other" })), "invalid-removal-reason");
  for (const quantity of [0, -1, 1.5, "2", null, 100000001]) {
    assert.equal(code(() => R.validateRemovalPayload({ ...ok, quantity })), "invalid-removal-quantity", String(quantity));
  }
  assert.equal(code(() => R.validateRemovalPayload({ ...ok, notes: 5 })), "invalid-notes");
  assert.equal(code(() => R.validateRemovalPayload({ ...ok, counters: {} })), "unknown-field", "no counter can be sent");
});

// ---------------------------------------------------------------- stock removal plan

test("quarantine takes only free units — never reserved or returned ones", () => {
  const data = batch({ quantity: 10, reservedQuantity: 4, returnPendingQuantity: 3, quarantinedQuantity: 1 }); // free 2
  const plan = R.planStockRemoval({ data, inventoryId: "b", action: "quarantine", quantity: 2, reason: "damaged", now: NOW });
  assert.deepEqual(plan.update, { quarantinedQuantity: 3 });
  assert.equal(plan.before.free, 2);
  assert.equal(plan.after.free, 0);
  assert.equal(plan.after.reserved, 4, "reserved untouched");
  assert.equal(plan.after.returnPending, 3, "returned units untouched — never released to available");
  assert.equal(code(() => R.planStockRemoval({ data, inventoryId: "b", action: "quarantine", quantity: 3, reason: "damaged", now: NOW })), "insufficient-free-stock");
  const fullyHeld = batch({ quantity: 4, reservedQuantity: 4 });
  assert.equal(code(() => R.planStockRemoval({ data: fullyHeld, inventoryId: "b", action: "quarantine", quantity: 1, reason: "recalled", now: NOW })), "insufficient-free-stock");
});

test("dispose writes off quarantined units only, from on hand, recorded as written off", () => {
  const data = batch({ quantity: 10, reservedQuantity: 2, quarantinedQuantity: 3, writtenOffQuantity: 1 });
  const plan = R.planStockRemoval({ data, inventoryId: "b", action: "dispose", quantity: 3, reason: "damaged", now: NOW });
  assert.deepEqual(plan.update, { quarantinedQuantity: 0, quantity: 7, writtenOffQuantity: 4 });
  assert.equal(plan.after.reserved, 2);
  assert.equal(code(() => R.planStockRemoval({ data, inventoryId: "b", action: "dispose", quantity: 4, reason: "damaged", now: NOW })), "insufficient-quarantined-stock");
  assert.equal(code(() => R.planStockRemoval({ data: batch(), inventoryId: "b", action: "dispose", quantity: 1, reason: "recalled", now: NOW })), "insufficient-quarantined-stock", "free stock must be quarantined first");
});

test("'expired' applies only to an expired batch; voided and corrupt batches are refused", () => {
  const live = batch({ expiryDate: "2026-10-05" }); // still usable today
  assert.equal(code(() => R.planStockRemoval({ data: live, inventoryId: "b", action: "quarantine", quantity: 1, reason: "expired", now: NOW })), "removal-reason-not-applicable");
  const expired = batch({ expiryDate: "2026-10-04" });
  assert.deepEqual(R.planStockRemoval({ data: expired, inventoryId: "b", action: "quarantine", quantity: 10, reason: "expired", now: NOW }).update, { quarantinedQuantity: 10 }, "expired stock is fully quarantinable whatever its status");
  assert.equal(code(() => R.planStockRemoval({ data: batch({ voided: true }), inventoryId: "b", action: "quarantine", quantity: 1, reason: "damaged", now: NOW })), "batch-voided");
  for (const bad of [{ quantity: "10" }, { reservedQuantity: -1 }, { quarantinedQuantity: 1.5 }, { quantity: 2, reservedQuantity: 3 }]) {
    assert.equal(code(() => R.planStockRemoval({ data: batch(bad), inventoryId: "b", action: "quarantine", quantity: 1, reason: "damaged", now: NOW })), "inventory-invariant-broken", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- void

test("void: only a tracked batch with no recorded use and all-zero held counters", () => {
  assert.equal(R.voidRefusal(batch({ usageTracked: true }), "b"), null);
  assert.equal(R.voidRefusal(batch(), "b").code, "batch-usage-unproven", "a batch from before tracking cannot be proven unused");
  assert.equal(R.voidRefusal(batch({ usageTracked: "true" }), "b").code, "batch-usage-unproven");
  assert.equal(R.voidRefusal(batch({ usageTracked: true, firstUsedAt: { seconds: 1 } }), "b").code, "batch-in-use");
  for (const f of ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity", "writtenOffQuantity"]) {
    assert.equal(R.voidRefusal(batch({ usageTracked: true, [f]: 1 }), "b").code, "batch-in-use", f);
    assert.equal(R.voidRefusal(batch({ usageTracked: true, [f]: "x" }), "b").code, "inventory-invariant-broken", f);
  }
});

// ---------------------------------------------------------------- shared checks

test("a voided batch is never allocatable or orderable; an archived product is recognised", () => {
  assert.equal(allocatableUnits(batch(), NOW), 10);
  assert.equal(allocatableUnits(batch({ voided: true }), NOW), 0);
  assert.equal(isBatchVoided(batch({ voided: "true" })), false, "only the server's boolean counts");
  assert.equal(isVaccineArchived({ archived: true }), true);
  assert.equal(isVaccineArchived({ archived: 1 }), false);
  const quote = (data) => () => evaluateBatch({ inventoryId: "b", data, requested: 1, expectedUnitPriceCentavos: 125000, now: NOW, allowBackorder: true });
  assert.equal(code(quote(batch({ voided: true }))), "batch-voided");
  assert.equal(code(quote(batch())), null);
});

test("the usage marker is written once and never moved", () => {
  const FieldValue = { serverTimestamp: () => "TS" };
  assert.deepEqual(usageMark(null, FieldValue, "order_quote"), { firstUsedAt: "TS", firstUsedBy: "order_quote" });
  assert.deepEqual(usageMark(batch(), FieldValue, "allocation"), { firstUsedAt: "TS", firstUsedBy: "allocation" });
  assert.deepEqual(usageMark(batch({ firstUsedAt: "earlier" }), FieldValue, "allocation"), {});
});

test("analytics counts no stock from a voided batch", () => {
  const out = stockByProduct({
    batches: [
      { id: "real", data: batch({ quantity: 5 }) },
      { id: "mistake", data: batch({ quantity: 500, voided: true }) },
    ],
    now: NOW,
  });
  const s = out.get("vacA");
  assert.equal(s.batchCount, 1);
  assert.equal(s.onHandQuantity, 5);
  assert.equal(s.availableQuantity, 5);
});

test("the removal audit id is per Admin and per request", () => {
  assert.equal(R.removalAuditId("admin1", REQ), `stock_admin1_${REQ}`);
  assert.notEqual(R.removalAuditId("admin1", REQ), R.removalAuditId("admin2", REQ));
});

// ---------------------------------------------------------------- correct stock

test("correction payload: category, meaningful reason, whole quantity, the figure the Admin saw", () => {
  const ok = { requestId: REQ, inventoryId: "b1", expectedQuantity: 100, newQuantity: 120, reasonCode: "count_discrepancy", reason: "Recount confirms 120" };
  assert.deepEqual(R.validateCorrectionPayload(ok), ok);
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, reasonCode: "damaged" })), "invalid-correction-reason", "unusable stock is not a correction");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, reasonCode: undefined })), "invalid-correction-reason");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, reason: "x" })), "reason-required");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, reason: "Recount 1" })), "reason-required", "9 characters");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, reason: "x".repeat(501) })), "reason-too-long");
  for (const newQuantity of [-1, 1.5, "120", null, 100000001]) {
    assert.equal(code(() => R.validateCorrectionPayload({ ...ok, newQuantity })), "invalid-correction-quantity", String(newQuantity));
  }
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, expectedQuantity: undefined })), "invalid-correction-request");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, expectedQuantity: 1.5 })), "invalid-correction-request");
  assert.equal(R.validateCorrectionPayload({ ...ok, expectedQuantity: "100" }).expectedQuantity, "100", "a legacy text figure can be fixed");
  assert.equal(code(() => R.validateCorrectionPayload({ ...ok, quantityCorrectedByUid: "x" })), "unknown-field");
});

test("correction plan: stale figure, floor, no-op, voided and expired-decrease are refused", () => {
  const data = batch({ quantity: 100, reservedQuantity: 10, returnPendingQuantity: 5, quarantinedQuantity: 5, writtenOffQuantity: 2 });
  const plan = R.planStockCorrection({ data, inventoryId: "b", expectedQuantity: 100, newQuantity: 120, now: NOW });
  assert.deepEqual(plan.update, { quantity: 120, previousQuantity: 100 });
  assert.deepEqual([plan.before.onHand, plan.after.onHand, plan.change, plan.mayFreeStock], [100, 120, 20, true]);
  assert.deepEqual([plan.after.reserved, plan.after.returnPending, plan.after.quarantined, plan.after.writtenOff], [10, 5, 5, 2]);
  const p = (over, newQuantity, d = data) => () => R.planStockCorrection({ data: d, inventoryId: "b", expectedQuantity: 100, newQuantity, now: NOW, ...over });
  assert.equal(code(p({ expectedQuantity: 99 }, 120)), "stock-changed");
  assert.equal(code(p({}, 19)), "correction-below-held");
  assert.equal(code(p({}, 20)), null, "exactly the held floor is allowed");
  assert.equal(code(p({}, 100)), "correction-unchanged");
  assert.equal(code(p({}, 120, { ...data, voided: true })), "batch-voided");
  const expired = { ...data, expiryDate: "2026-10-04" };
  assert.equal(code(p({}, 60, expired)), "correction-expired-decrease");
  assert.equal(code(p({}, 140, expired)), null, "raising an expired batch's record is allowed");
  assert.equal(code(p({}, 50, { ...data, reservedQuantity: "x" })), "inventory-invariant-broken");
  const text = R.planStockCorrection({ data: { ...data, quantity: "100" }, inventoryId: "b", expectedQuantity: "100", newQuantity: 100, now: NOW });
  assert.deepEqual([text.update.previousQuantity, text.before.onHand, text.change], ["100", null, null], "a corrupt text figure is fixed and recorded as stored");
});
