import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateBatchEligibility,
  reconcileCartLine,
  computeAvailableQuantity,
  isOrderableStatus,
  ORDERABLE_STATUSES,
  ELIGIBILITY_REASONS,
} from "../src/services/orderEligibility.js";

/**
 * Med Rep batch-order eligibility, proven behaviourally against the pure helper.
 *
 * The defect these cover: the catalog gated on expiry, price and stock but never
 * on the batch's STATUS, so a "Critical" batch (valid future date, priced, in
 * stock) was shown as orderable and entered the cart, then failed the whole
 * order at submission with the server's "That batch is not available to order."
 * The helper now mirrors functions/src/policy.js `evaluateBatch`, and the last
 * test pins that the trusted server gate is unchanged and the two lists agree.
 */

const TODAY = "2026-09-25";
const FUTURE = "2027-06-30"; // comfortably beyond the 90-day warning window
const PAST = "2025-01-01";

// A fully valid, orderable Stable batch. Each test overrides only what it tests.
function batch(overrides = {}) {
  return {
    id: "inv-1",
    quantity: 100,
    reservedQuantity: 0,
    status: "Stable",
    expiryDate: FUTURE,
    sellingPriceCentavos: 50000,
    priceIsVatInclusive: true,
    ...overrides,
  };
}

// 1. Stable, valid and available batch is orderable.
test("a Stable, valid, available batch is orderable", () => {
  const result = evaluateBatchEligibility(batch(), TODAY);
  assert.equal(result.eligible, true);
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, "");
  assert.equal(result.availableQuantity, 100);
});

// 2. Warning batch is orderable if the server permits Warning (it does).
test("a Warning batch is orderable (the server permits Warning)", () => {
  const result = evaluateBatchEligibility(batch({ status: "Warning" }), TODAY);
  assert.equal(result.eligible, true);
  assert.equal(result.reasonCode, null);
});

// 3. Critical batch is NOT orderable — the exact bug.
test("a Critical batch is not orderable and reports the critical reason", () => {
  const result = evaluateBatchEligibility(batch({ status: "Critical" }), TODAY);
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, ELIGIBILITY_REASONS.CRITICAL);
  assert.ok(result.reason.length > 0);
  // Reported even though the batch is otherwise fine (future date, priced, stocked).
  assert.equal(result.availableQuantity, 100);
});

// A near-expiry Critical batch has a valid FUTURE date — this is precisely the
// case that slipped through the old expiry/price/stock-only gate.
test("a Critical batch with a valid future date is still blocked", () => {
  const nearExpiry = batch({ status: "Critical", expiryDate: "2026-10-10" });
  const result = evaluateBatchEligibility(nearExpiry, TODAY);
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, ELIGIBILITY_REASONS.CRITICAL);
});

// Any other non-usable status is blocked as "unavailable".
test("an inactive/unavailable status is blocked as unavailable", () => {
  for (const status of ["inactive", "unavailable", "reserved", "disabled", "expired"]) {
    const result = evaluateBatchEligibility(batch({ status }), TODAY);
    assert.equal(result.eligible, false, status);
    assert.equal(result.reasonCode, ELIGIBILITY_REASONS.UNAVAILABLE, status);
  }
});

// 4. Expired batch is not orderable (past date, even with a "Stable" stored status).
test("an expired batch is not orderable", () => {
  const result = evaluateBatchEligibility(batch({ status: "Stable", expiryDate: PAST }), TODAY);
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, ELIGIBILITY_REASONS.EXPIRED);
});

// 5. Missing / malformed expiry is not orderable.
test("a batch with a missing or malformed expiry is not orderable", () => {
  for (const expiryDate of [undefined, null, "", "not-a-date", "2026-02-31"]) {
    const result = evaluateBatchEligibility(batch({ expiryDate }), TODAY);
    assert.equal(result.eligible, false, String(expiryDate));
    assert.equal(result.reasonCode, ELIGIBILITY_REASONS.MISSING_EXPIRY, String(expiryDate));
  }
});

// 6. Unpriced (or invalidly priced) batch is not orderable.
test("an unpriced or invalidly priced batch is not orderable", () => {
  for (const sellingPriceCentavos of [undefined, null, 0, -100, 1.5, "50000"]) {
    const result = evaluateBatchEligibility(batch({ sellingPriceCentavos }), TODAY);
    assert.equal(result.eligible, false, String(sellingPriceCentavos));
    assert.equal(result.reasonCode, ELIGIBILITY_REASONS.MISSING_PRICE, String(sellingPriceCentavos));
  }
  // A price recorded under the legacy VAT-exclusive convention (or with none
  // recorded) is never quoted as if it included VAT — mirrors the server.
  for (const priceIsVatInclusive of [false, undefined, null, "true"]) {
    const result = evaluateBatchEligibility(batch({ priceIsVatInclusive }), TODAY);
    assert.equal(result.eligible, false, String(priceIsVatInclusive));
    assert.equal(result.reasonCode, ELIGIBILITY_REASONS.LEGACY_PRICE_CONVENTION, String(priceIsVatInclusive));
    assert.match(result.reason, /Legacy pricing — VAT recorded as exclusive/);
  }
});

// 7. Zero (or fully reserved) available stock is not orderable.
test("a batch with zero available stock is a FUTURE order, not a refusal", () => {
  // Nothing on hand: still a valid quote (price + VAT); fully backordered.
  const empty = evaluateBatchEligibility(batch({ quantity: 0 }), TODAY);
  assert.equal(empty.eligible, true);
  assert.equal(empty.backorderOnly, true);
  assert.equal(empty.availableQuantity, 0);
  // On hand but fully reserved → nothing available, still orderable.
  const held = evaluateBatchEligibility(batch({ quantity: 40, reservedQuantity: 40 }), TODAY);
  assert.equal(held.eligible, true);
  assert.equal(held.backorderOnly, true);
  // With stock, it is not a backorder-only card.
  assert.equal(evaluateBatchEligibility(batch({ quantity: 5 }), TODAY).backorderOnly, false);
});

test("return-pending and quarantined units are never available", () => {
  const b = batch({ quantity: 20, reservedQuantity: 5, returnPendingQuantity: 3, quarantinedQuantity: 2 });
  assert.equal(evaluateBatchEligibility(b, TODAY).availableQuantity, 10);
  // More held than on hand is a broken invariant, never "some stock".
  assert.equal(evaluateBatchEligibility(batch({ quantity: 4, reservedQuantity: 2, returnPendingQuantity: 3 }), TODAY).eligible, false);
});

// 8. Reserved quantity reduces available stock.
test("reserved quantity reduces available stock", () => {
  const result = evaluateBatchEligibility(batch({ quantity: 100, reservedQuantity: 30 }), TODAY);
  assert.equal(result.eligible, true);
  assert.equal(result.availableQuantity, 70);
});

// 9. Available quantity uses quantity - reservedQuantity, with the legacy default.
test("available = quantity - reservedQuantity, missing reserved defaults to 0", () => {
  assert.equal(computeAvailableQuantity({ quantity: 90, reservedQuantity: 15 }), 75);
  assert.equal(computeAvailableQuantity({ quantity: 90 }), 90); // legacy default
  assert.equal(computeAvailableQuantity({ quantity: 90, reservedQuantity: null }), 90);
  // Corrupt figures are unusable (null), not silently defaulted away.
  assert.equal(computeAvailableQuantity({ quantity: "90" }), null); // legacy string
  assert.equal(computeAvailableQuantity({ quantity: 90, reservedQuantity: -1 }), null);
  assert.equal(computeAvailableQuantity({ quantity: 10, reservedQuantity: 20 }), null); // invariant
});

test("a legacy string quantity is rejected as an invalid-quantity data problem", () => {
  const result = evaluateBatchEligibility(batch({ quantity: "120" }), TODAY);
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, ELIGIBILITY_REASONS.INVALID_QUANTITY);
  assert.match(result.reason, /migration/i); // preserves the existing helpful wording
});

// 10. Missing inventory document ID is rejected.
test("a batch with no inventory document id is rejected", () => {
  for (const id of [undefined, null, "", "   "]) {
    const result = evaluateBatchEligibility(batch({ id }), TODAY);
    assert.equal(result.eligible, false, String(id));
    assert.equal(result.reasonCode, ELIGIBILITY_REASONS.MISSING_INVENTORY_ID, String(id));
  }
});

// 11. Quantity cannot exceed available stock (cart line).
test("a cart line above available stock is allowed and reports the backorder", () => {
  const b = batch({ quantity: 100, reservedQuantity: 40 }); // 60 available
  const exact = reconcileCartLine({ inventoryId: "inv-1", quantity: 60 }, b, TODAY);
  assert.equal(exact.ok, true);
  assert.equal(exact.backorderedQuantity, 0);
  const over = reconcileCartLine({ inventoryId: "inv-1", quantity: 75 }, b, TODAY);
  assert.equal(over.ok, true);
  assert.equal(over.availableQuantity, 60);
  assert.equal(over.backorderedQuantity, 15);
});

test("a cart line with a malformed quantity is rejected", () => {
  const b = batch();
  for (const quantity of [0, -3, 2.5, "5", undefined]) {
    const line = reconcileCartLine({ inventoryId: "inv-1", quantity }, b, TODAY);
    assert.equal(line.ok, false, String(quantity));
    assert.equal(line.reasonCode, ELIGIBILITY_REASONS.INVALID_QUANTITY, String(quantity));
  }
});

// 12. A previously valid cart line that becomes invalid blocks continuation.
test("a cart line whose batch became ineligible blocks continuation", () => {
  // Was orderable when added; the live batch is now Critical.
  const nowCritical = reconcileCartLine(
    { inventoryId: "inv-1", quantity: 5 },
    batch({ status: "Critical" }),
    TODAY
  );
  assert.equal(nowCritical.ok, false);
  assert.equal(nowCritical.reasonCode, ELIGIBILITY_REASONS.CRITICAL);

  // The batch vanished from inventory entirely.
  const gone = reconcileCartLine({ inventoryId: "inv-1", quantity: 5 }, null, TODAY);
  assert.equal(gone.ok, false);
  assert.equal(gone.reasonCode, ELIGIBILITY_REASONS.UNAVAILABLE);
  assert.ok(gone.reason.length > 0);
});

// 13. The user sees a specific reason for each distinct cause.
test("every ineligible outcome carries a specific, distinct, non-empty reason", () => {
  const causes = {
    missingId: evaluateBatchEligibility(batch({ id: "" }), TODAY),
    invalidQty: evaluateBatchEligibility(batch({ quantity: "x" }), TODAY),
    critical: evaluateBatchEligibility(batch({ status: "Critical" }), TODAY),
    expired: evaluateBatchEligibility(batch({ expiryDate: PAST }), TODAY),
    missingExpiry: evaluateBatchEligibility(batch({ expiryDate: "" }), TODAY),
    unpriced: evaluateBatchEligibility(batch({ sellingPriceCentavos: null }), TODAY),
  };
  const reasons = Object.values(causes).map((r) => r.reason);
  for (const reason of reasons) assert.ok(typeof reason === "string" && reason.length > 0);
  // Distinct causes surface distinct messages, not one generic string.
  assert.equal(new Set(reasons).size, reasons.length);
});

// 14. Valid order creation remains unchanged — legitimate carts are not over-blocked.
test("valid batches remain orderable (no over-blocking)", () => {
  assert.equal(evaluateBatchEligibility(batch(), TODAY).eligible, true);
  // Case/whitespace on the status is tolerated exactly as the server tolerates it.
  assert.equal(isOrderableStatus("  stable "), true);
  assert.equal(isOrderableStatus("AVAILABLE"), true);
  assert.equal(isOrderableStatus("Warning"), true);
  assert.equal(isOrderableStatus("Critical"), false);
  // A legacy batch with no reservedQuantity field is still orderable.
  const legacy = evaluateBatchEligibility(
    { id: "inv-9", quantity: 25, status: "stable", expiryDate: FUTURE, sellingPriceCentavos: 12345, priceIsVatInclusive: true },
    TODAY
  );
  assert.equal(legacy.eligible, true);
  assert.equal(legacy.availableQuantity, 25);
});

// 15. The trusted server gate is unchanged, and the client mirrors it exactly.
test("the server eligibility policy remains authoritative and the client mirrors it", () => {
  const policy = readFileSync(new URL("../functions/src/policy.js", import.meta.url), "utf8");
  // The server still refuses a non-usable status with the same code and message.
  assert.match(policy, /isUsableStatus/);
  assert.match(policy, /"batch-unavailable"/);
  assert.match(policy, /That batch is not available to order\./);
  // Its usable set still excludes "critical".
  const usableLine = policy.match(/USABLE_STATUSES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(usableLine, "USABLE_STATUSES must be a frozen array");
  const serverStatuses = usableLine[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  assert.equal(serverStatuses.includes("critical"), false, "server must still reject Critical");
  // Client and server agree on the exact orderable set, so they cannot drift.
  assert.deepEqual([...ORDERABLE_STATUSES].sort(), [...serverStatuses].sort());
  // The client helper performs no network / Firebase access: it must not import
  // any firebase package or a functions/ server module into the browser bundle.
  const helper = readFileSync(new URL("../src/services/orderEligibility.js", import.meta.url), "utf8");
  assert.equal(
    /\bfrom\s+["'][^"']*firebase[^"']*["']/i.test(helper),
    false,
    "eligibility helper must not import Firebase"
  );
  assert.equal(
    /\bfrom\s+["'][^"']*functions\//i.test(helper),
    false,
    "eligibility helper must not import a functions/ server module"
  );
});

test("an on-hand figure above the 100,000,000 ceiling is shown as awaiting confirmation, not orderable", () => {
  const typo = {
    id: "OCvsrsrMCJum7Skfgil8", vaccineId: "p", status: "Warning", expiryDate: "2027-11-07",
    quantity: 99999999999900, reservedQuantity: 70, sellingPriceCentavos: 100, priceIsVatInclusive: true,
  };
  const r = evaluateBatchEligibility(typo, "2026-10-06");
  assert.equal(r.eligible, false);
  assert.equal(r.reasonCode, ELIGIBILITY_REASONS.UNCONFIRMED_QUANTITY);
  // Mirrors the server: same ceiling, same refusal.
  const policy = readFileSync(new URL("../functions/src/policy.js", import.meta.url), "utf8");
  assert.match(policy, /const MAX_STOCK_QUANTITY = 100000000;/);
  assert.match(readFileSync(new URL("../src/services/orderEligibility.js", import.meta.url), "utf8"), /export const MAX_STOCK_QUANTITY = 100000000;/);
  assert.equal(evaluateBatchEligibility({ ...typo, quantity: 100000000, reservedQuantity: 0 }, "2026-10-06").eligible, true);
});
