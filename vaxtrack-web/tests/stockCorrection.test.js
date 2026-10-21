import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  CORRECTION_REASON_CODES,
  MAX_CORRECTION_REASON_LENGTH,
  MIN_CORRECTION_REASON_LENGTH,
  readReserved,
  validateStockCorrection,
} from "../src/services/stockCorrection.js";
import { createServiceLoader, createStore, installCallables, installStore } from "./serviceHarness.js";

/**
 * Admin stock correction fixes a human error in a batch's on-hand figure. The
 * one invariant it must never break is the reservation floor: availability
 * (quantity − reservedQuantity) can never go negative, so a correction may not
 * set quantity below what open orders have already reserved. The Firestore rules
 * are the real boundary (tests/firestore.rules.test.js); this suite pins the
 * client validation and the page shape that feed them.
 */

const base = {
  newQuantity: 120,
  currentQuantity: 100,
  reservedQuantity: 10,
  reasonCode: "count_discrepancy",
  reason: "Recount confirms 120",
};

// ---------------------------------------------------------------- reserved floor

test("a correction cannot drop below what is reserved", () => {
  const out = validateStockCorrection({ ...base, newQuantity: 5, reservedQuantity: 10 });
  assert.equal(out.ok, false);
  assert.match(out.message, /reserved/i);
});

test("a correction down to exactly the reserved amount is allowed", () => {
  const out = validateStockCorrection({ ...base, newQuantity: 10, reservedQuantity: 10 });
  assert.equal(out.ok, true);
});

test("a missing or zero reserved figure is treated as zero", () => {
  assert.equal(readReserved(undefined), 0);
  assert.equal(readReserved(null), 0);
  assert.equal(readReserved(0), 0);
  assert.equal(readReserved(7), 7);
  // With no reservations, correcting to 0 is permitted.
  const out = validateStockCorrection({
    newQuantity: 0,
    currentQuantity: 50,
    reservedQuantity: undefined,
    reasonCode: "entry_error",
    reason: "Add Stock entered 50; the delivery note shows none",
  });
  assert.equal(out.ok, true);
});

// --------------------------------------------------------------- number shape

test("the corrected quantity must be a whole, non-negative number", () => {
  assert.equal(validateStockCorrection({ ...base, newQuantity: 12.5 }).ok, false);
  assert.equal(validateStockCorrection({ ...base, newQuantity: -1 }).ok, false);
  assert.equal(validateStockCorrection({ ...base, newQuantity: Number.NaN }).ok, false);
});

// ------------------------------------------------------------------- reason

test("a meaningful reason (10–500 characters) and a correction category are required", () => {
  assert.equal(validateStockCorrection({ ...base, reason: "" }).ok, false);
  assert.equal(validateStockCorrection({ ...base, reason: "   " }).ok, false);
  assert.equal(MIN_CORRECTION_REASON_LENGTH, 10);
  assert.equal(validateStockCorrection({ ...base, reason: "x" }).field, "reason", "a token reason is refused");
  assert.equal(validateStockCorrection({ ...base, reason: "Recount 1" }).field, "reason", "9 characters is too short");
  assert.equal(validateStockCorrection({ ...base, reasonCode: undefined }).field, "reasonCode");
  assert.equal(validateStockCorrection({ ...base, reasonCode: "damaged" }).field, "reasonCode", "unusable stock is not a correction");
  assert.deepEqual([...CORRECTION_REASON_CODES], ["entry_error", "count_discrepancy"]);
  assert.equal(
    validateStockCorrection({ ...base, reason: "x".repeat(MAX_CORRECTION_REASON_LENGTH + 1) }).ok,
    false
  );
  const out = validateStockCorrection({ ...base, reason: "  Miscount at intake  " });
  assert.equal(out.ok, true);
  assert.equal(out.value.reason, "Miscount at intake", "the reason is trimmed");
  assert.equal(out.value.reasonCode, "count_discrepancy");
});

test("an expired batch cannot be reduced by a correction — that is quarantine, then dispose", () => {
  const down = validateStockCorrection({ ...base, newQuantity: 60, expired: true });
  assert.equal(down.ok, false);
  assert.match(down.message, /Remove unusable stock/);
  assert.equal(validateStockCorrection({ ...base, newQuantity: 140, expired: true }).ok, true, "raising a miscounted expired batch is a record fix");
  assert.equal(validateStockCorrection({ ...base, newQuantity: 60, expired: false }).ok, true);
});

test("web and server agree on the correction rules", () => {
  const server = createRequire(import.meta.url)("../functions/src/inventoryRemoval.js");
  assert.deepEqual([...CORRECTION_REASON_CODES], [...server.CORRECTION_REASON_CODES]);
  assert.equal(MIN_CORRECTION_REASON_LENGTH, server.MIN_CORRECTION_REASON);
  const now = new Date("2026-10-05T02:00:00Z");
  const data = (over) => ({ quantity: 100, reservedQuantity: 10, returnPendingQuantity: 5, quarantinedQuantity: 5, expiryDate: "2027-06-30", ...over });
  const cases = [
    [{}, 120],
    [{}, 19],
    [{}, 20],
    [{}, 100],
    [{ expiryDate: "2026-10-01" }, 60],
    [{ expiryDate: "2026-10-01" }, 140],
  ];
  for (const [over, newQuantity] of cases) {
    const d = data(over);
    const web = validateStockCorrection({
      newQuantity, currentQuantity: d.quantity, reservedQuantity: d.reservedQuantity,
      returnPendingQuantity: d.returnPendingQuantity, quarantinedQuantity: d.quarantinedQuantity,
      reasonCode: "count_discrepancy", reason: "Recount confirms the figure", expired: d.expiryDate < "2026-10-05",
    });
    let srv = null;
    try {
      server.planStockCorrection({ data: d, inventoryId: "b", expectedQuantity: d.quantity, newQuantity, now });
    } catch (e) {
      srv = e.message;
    }
    assert.equal(web.ok, srv === null, JSON.stringify([over, newQuantity]));
  }
});

// ----------------------------------------------------------------- no-op guard

test("correcting to the same clean integer is refused as a no-op", () => {
  const out = validateStockCorrection({ ...base, newQuantity: 100, currentQuantity: 100 });
  assert.equal(out.ok, false);
  assert.match(out.message, /same/i);
});

test("a batch with a corrupt (text) quantity can still be corrected", () => {
  // The no-op guard only applies when the current value is itself an integer,
  // so a batch whose quantity is stored as text is exactly one this can fix.
  const out = validateStockCorrection({
    newQuantity: 100,
    currentQuantity: "100",
    reservedQuantity: 0,
    reasonCode: "entry_error",
    reason: "Quantity was stored as text; recount is 100",
  });
  assert.equal(out.ok, true);
});

// ============================================================ page + service shape

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("Correct Stock is a server callable: the client sends the figures it saw and writes nothing itself", async () => {
  const vaccineService = read("src/services/vaccineService.js").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/correctStockQuantity|quantityCorrected/.test(vaccineService), false, "no direct-write correction remains");

  const loader = createServiceLoader();
  const svc = await loader.load("inventoryRemovalService.js");
  const store = installStore(createStore(), { uid: "admin1", email: "admin@vaxtrack.test" });
  const calls = installCallables({ correctStockQuantity: () => ({ inventoryId: "inv1", newQuantity: 120, replayed: false, reallocated: [] }) });
  await svc.correctStockQuantity({
    requestId: "req_abcdefghijklmnop", inventoryId: "inv1", expectedQuantity: 100, newQuantity: 120,
    reasonCode: "count_discrepancy", reason: "  Recount confirms 120  ",
  });
  assert.deepEqual(calls, [{
    name: "correctStockQuantity",
    data: { requestId: "req_abcdefghijklmnop", inventoryId: "inv1", expectedQuantity: 100, newQuantity: 120, reasonCode: "count_discrepancy", reason: "Recount confirms 120" },
  }]);
  assert.equal(store.writes.length, 0, "no Firestore write from the browser");
});

const PAGE = "src/pages/admin/Inventory.jsx";

test("the page wires a Correct stock control through the real service", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import \{[^}]*correctStockQuantity[^}]*\} from "\.\.\/\.\.\/services\/inventoryRemovalService"/,
    "must import correctStockQuantity"
  );
  assert.match(src, /Correct stock/, "the drawer must offer a Correct stock control");
  assert.match(src, /onClick=\{\(\) => openCorrectDialog\(drawerItem\)\}/, "wired to the dialog");
  // Still no direct Firestore access from the page.
  assert.equal(
    /from ["']firebase\/firestore["']/.test(src),
    false,
    "Inventory must reach Firestore only through services"
  );
});

test("the correction reports success only after an awaited write, and blocks double-submit", () => {
  const src = read(PAGE);
  const handler = /const handleSaveCorrection = async \(\) => \{[\s\S]*?\n {2}\};/.exec(src);
  assert.ok(handler, "handleSaveCorrection must exist");
  const body = handler[0];

  assert.match(body, /if \(savingCorrection[\s\S]*?\breturn;/, "a re-entrancy guard must exist");
  assert.match(body, /setSavingCorrection\(true\)/);
  assert.match(body, /setSavingCorrection\(false\)/);
  assert.match(body, /\}\s*finally\s*\{/, "the flag must clear in finally");

  const awaitAt = body.indexOf("await correctStockQuantity");
  const toastAt = body.indexOf("showToast(");
  assert.ok(awaitAt !== -1, "the write must be awaited");
  assert.ok(toastAt > awaitAt, "success feedback must follow the awaited write");

  assert.match(
    src,
    /onClick=\{handleSaveCorrection\}[\s\S]*?disabled=\{savingCorrection \|\| correctionBlocked\}/,
    "the save button must be disabled while saving, and while the batch changed elsewhere"
  );
  // Stock changed elsewhere while the dialog was open: flagged, and saving
  // waits for the Admin to load the new figures or keep their own.
  assert.match(body, /if \(savingCorrection \|\| !correcting \|\| correctionBlocked\) return;/);
});
