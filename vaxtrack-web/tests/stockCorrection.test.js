import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_CORRECTION_REASON_LENGTH,
  readReserved,
  validateStockCorrection,
} from "../src/services/stockCorrection.js";

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
    reason: "Batch written off after spoilage",
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

test("a non-empty reason within the length limit is required", () => {
  assert.equal(validateStockCorrection({ ...base, reason: "" }).ok, false);
  assert.equal(validateStockCorrection({ ...base, reason: "   " }).ok, false);
  assert.equal(
    validateStockCorrection({ ...base, reason: "x".repeat(MAX_CORRECTION_REASON_LENGTH + 1) }).ok,
    false
  );
  const out = validateStockCorrection({ ...base, reason: "  Miscount at intake  " });
  assert.equal(out.ok, true);
  assert.equal(out.value.reason, "Miscount at intake", "the reason is trimmed");
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
    reason: "Quantity was stored as text; recount is 100",
  });
  assert.equal(out.ok, true);
});

// ============================================================ page + service shape

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the service reads the batch fresh, then writes only quantity + audit", () => {
  const src = read("src/services/vaccineService.js");
  const fn = /export async function correctStockQuantity\([\s\S]*?\n}\n/.exec(src);
  assert.ok(fn, "correctStockQuantity must exist");
  const body = fn[0];
  assert.match(body, /getDoc\(/, "must read the current batch");
  assert.match(body, /validateStockCorrection\(/, "must validate before writing");
  assert.match(body, /quantityCorrectedByUid: auth\.currentUser/, "actor comes from the session");
  assert.match(body, /quantityCorrectedAt: serverTimestamp\(\)/, "time is server-stamped");

  // The WRITE payload (not the read/validate args) must never carry
  // reservedQuantity — that field moves only inside a callable transaction.
  const write = /updateDoc\(ref, \{[\s\S]*?\}\);/.exec(body);
  assert.ok(write, "must write via updateDoc(ref, { ... })");
  assert.equal(
    /reservedQuantity/.test(write[0]),
    false,
    "the correction write must not include reservedQuantity"
  );
});

const PAGE = "src/pages/admin/Inventory.jsx";

test("the page wires a Correct stock control through the real service", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import \{[^}]*correctStockQuantity[^}]*\} from "\.\.\/\.\.\/services\/vaccineService"/,
    "must import correctStockQuantity"
  );
  assert.match(src, /Correct stock/, "the drawer must offer a Correct stock control");
  assert.match(src, /onClick=\{\(\) => openCorrectDialog\(selectedVaccine\)\}/, "wired to the dialog");
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
    /onClick=\{handleSaveCorrection\}[\s\S]*?disabled=\{savingCorrection\}/,
    "the save button must be disabled while saving"
  );
});
