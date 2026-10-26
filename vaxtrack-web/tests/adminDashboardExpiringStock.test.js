import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countExpiringOrExpiredBatches } from "../src/services/inventoryRemovalModel.js";

/**
 * The Admin Dashboard "Expiring or expired stock" figure under the inventory
 * removal model.
 *
 * A VOIDED batch is an Admin's record of a mistaken entry — never stock
 * (server: allocation.allocatableUnits, inventoryAnalytics.stockByProduct;
 * Admin Inventory's stockBatches). Before this fix the dashboard counted every
 * inventory document by expiry alone, so a voided batch with a past or near
 * expiry date inflated the figure. Negative control: run against the
 * unfiltered count, the two voided cases below failed (expected 3, got 5).
 *
 * Expired or quarantined stock that is NOT voided is real and still counts:
 * quarantine holds doses for disposal, it does not make the batch disappear.
 */

const TODAY = "2026-10-26";
const batch = (over) => ({ quantity: 10, reservedQuantity: 0, ...over });

const expired = batch({ id: "expired", expiryDate: "2026-09-30" });
const quarantinedExpired = batch({ id: "quarantined", expiryDate: "2026-10-01", quarantinedQuantity: 10 });
const critical = batch({ id: "critical", expiryDate: "2026-11-10" });
const stable = batch({ id: "stable", expiryDate: "2027-12-31" });
const voidedExpired = batch({ id: "voided-expired", expiryDate: "2026-09-01", voided: true });
const voidedCritical = batch({ id: "voided-critical", expiryDate: "2026-11-05", voided: true });
const voidedStable = batch({ id: "voided-stable", expiryDate: "2027-12-31", voided: true });

test("valid expired, quarantined-expired and critical batches are counted; stable is not", () => {
  assert.equal(countExpiringOrExpiredBatches([expired, quarantinedExpired, critical, stable], TODAY), 3);
});

test("a voided batch is never counted, whatever its expiry date", () => {
  assert.equal(countExpiringOrExpiredBatches([voidedExpired], TODAY), 0);
  assert.equal(countExpiringOrExpiredBatches([voidedCritical], TODAY), 0);
  assert.equal(countExpiringOrExpiredBatches([voidedStable], TODAY), 0);
});

test("mixed snapshot: voided batches drop out, valid expiring stock stays", () => {
  const all = [expired, quarantinedExpired, critical, stable, voidedExpired, voidedCritical, voidedStable];
  assert.equal(countExpiringOrExpiredBatches(all, TODAY), 3);
});

test("only `voided: true` excludes — a falsy or absent flag is still stock", () => {
  assert.equal(countExpiringOrExpiredBatches([{ ...expired, voided: false }, { ...expired, voided: "true" }], TODAY), 2);
  assert.equal(countExpiringOrExpiredBatches(null, TODAY), 0);
});

test("the dashboard figure comes from the shared helper, not an inline filter", () => {
  const src = readFileSync(new URL("../src/pages/admin/AdminDashboard.jsx", import.meta.url), "utf8");
  assert.match(src, /setCriticalCount\(countExpiringOrExpiredBatches\(batches, manilaToday\(Date\.now\(\)\)\)\)/);
  assert.equal(/deriveExpiryCondition/.test(src), false, "no second, unfiltered expiry count on the page");
});
