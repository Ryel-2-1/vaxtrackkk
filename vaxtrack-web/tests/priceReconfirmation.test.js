import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONVENTION_NOT_RECORDED_NOTE,
  describePriceReconfirmation,
  priceNeedsReconfirmation,
  priceReconfirmationFlag,
} from "../src/services/priceReconfirmation.js";
import { LEGACY_VAT_EXCLUSIVE_NOTE, legacyVatOnTopCentavos } from "../src/services/pricingConfig.js";
import { evaluateBatchEligibility, ELIGIBILITY_REASONS } from "../src/services/orderEligibility.js";

// Re-confirming a batch price recorded VAT-exclusive (Admin → Inventory).
// The Admin sees which batches need it and what the old figure amounted to;
// nothing is converted for them.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const require = createRequire(import.meta.url);
const server = require("../functions/src/pricingConfig.js");

const batch = (over = {}) => ({ sellingPriceCentavos: 100000, priceIsVatInclusive: false, ...over });

test("only a PRICED batch not recorded VAT-inclusive needs re-confirmation — the server's rule", () => {
  assert.equal(priceNeedsReconfirmation(batch()), true, "recorded VAT-exclusive");
  assert.equal(priceNeedsReconfirmation(batch({ priceIsVatInclusive: undefined })), true, "no convention recorded");
  assert.equal(priceNeedsReconfirmation(batch({ priceIsVatInclusive: true })), false, "already VAT-inclusive");
  assert.equal(priceNeedsReconfirmation(batch({ sellingPriceCentavos: null })), false, "unpriced is just unpriced");
  // Exactly the batches the Sales Rep catalog refuses as legacy-priced.
  for (const b of [batch(), batch({ priceIsVatInclusive: undefined }), batch({ priceIsVatInclusive: true })]) {
    const elig = evaluateBatchEligibility(
      { id: "i", quantity: 10, reservedQuantity: 0, status: "Stable", expiryDate: "2030-01-01", ...b },
      "2026-10-09"
    );
    assert.equal(elig.reasonCode === ELIGIBILITY_REASONS.LEGACY_PRICE_CONVENTION, priceNeedsReconfirmation(b));
  }
});

test("the Inventory row flag names the recorded convention and the action", () => {
  assert.equal(
    priceReconfirmationFlag(batch()),
    `${LEGACY_VAT_EXCLUSIVE_NOTE} Re-confirm the price before this batch can be ordered.`
  );
  assert.match(priceReconfirmationFlag(batch({ priceIsVatInclusive: null })), new RegExp(`^${CONVENTION_NOT_RECORDED_NOTE}`));
  assert.equal(priceReconfirmationFlag(batch({ priceIsVatInclusive: true })), null);
  assert.equal(priceReconfirmationFlag(batch({ sellingPriceCentavos: undefined })), null);
});

test("a VATable legacy ₱1,000 shows ₱1,120 with VAT on top, and offers both figures — same amount first", () => {
  const d = describePriceReconfirmation({ priceCentavos: 100000, priceIsVatInclusive: false, vatClassification: "vatable" });
  assert.equal(d.legacy, true);
  assert.equal(d.recordedNote, "Legacy pricing — VAT recorded as exclusive.");
  assert.deepEqual([d.recordedCentavos, d.withVatCentavos], [100000, 112000]);
  assert.match(d.recordedLine, /₱1,000\.00/);
  assert.match(d.explanation, /₱1,120\.00/);
  assert.deepEqual(d.options.map((o) => [o.key, o.centavos]), [["same-amount", 112000], ["same-figure", 100000]]);
  assert.match(d.options[0].detail, /pays the same/);
  assert.match(d.options[1].detail, /pays less/);
});

test("a VAT-exempt product had no VAT: one figure, unchanged", () => {
  const d = describePriceReconfirmation({ priceCentavos: 100000, priceIsVatInclusive: false, vatClassification: "vat_exempt" });
  assert.deepEqual(d.options.map((o) => o.centavos), [100000]);
  assert.match(d.explanation, /VAT-exempt/);
  assert.doesNotMatch(d.explanation, /₱1,120/);
});

test("an unclassified product shows both readings without choosing one", () => {
  const d = describePriceReconfirmation({ priceCentavos: 100000, priceIsVatInclusive: false, vatClassification: null });
  assert.match(d.explanation, /not classified/);
  assert.match(d.explanation, /₱1,120\.00/);
  assert.deepEqual(d.options.map((o) => o.centavos), [112000, 100000]);
});

test("nothing to describe for a VAT-inclusive or unpriced batch; no convention recorded is labelled so", () => {
  assert.equal(describePriceReconfirmation({ priceCentavos: 100000, priceIsVatInclusive: true, vatClassification: "vatable" }), null);
  assert.equal(describePriceReconfirmation({ priceCentavos: null, priceIsVatInclusive: false, vatClassification: "vatable" }), null);
  const d = describePriceReconfirmation({ priceCentavos: 100000, priceIsVatInclusive: null, vatClassification: "vatable" });
  assert.deepEqual([d.legacy, d.recordedNote], [false, CONVENTION_NOT_RECORDED_NOTE]);
});

test("odd centavo amounts round the VAT exactly as the legacy calculation did", () => {
  for (const c of [1, 4, 5, 125, 99999, 123457]) {
    const d = describePriceReconfirmation({ priceCentavos: c, priceIsVatInclusive: false, vatClassification: "vatable" });
    assert.equal(d.withVatCentavos, c + Math.round((c * 12) / 100), String(c));
    assert.ok(Number.isSafeInteger(d.withVatCentavos));
  }
});

test("the web legacy VAT helper equals the server's", () => {
  for (let c = 0; c <= 20000; c += 1) {
    assert.equal(legacyVatOnTopCentavos(c), server.legacyVatOnTopCentavos(c), String(c));
  }
  assert.throws(() => legacyVatOnTopCentavos(-1), RangeError);
  assert.throws(() => legacyVatOnTopCentavos(1.5), RangeError);
});

test("Admin Inventory: flagged rows, a re-confirm action, and a dialog that never pre-fills the legacy figure", () => {
  const page = read("src/pages/admin/Inventory.jsx");
  // Row: the flag joins the ⚠ list, the price cell is tagged, the button says what it does.
  assert.match(page, /const reconfirmFlag = priceReconfirmationFlag\(raw\);\n\s+if \(reconfirmFlag\) flags\.push\(reconfirmFlag\);/);
  assert.match(page, /"Legacy · VAT exclusive"/);
  assert.match(page, /\? "Re-confirm price"/);
  // Dialog: a legacy price opens EMPTY, so saving it unchanged cannot re-read it.
  assert.match(page, /setPriceInput\(item\.priceNeedsReconfirm \? "" : centavosToInputValue\(item\.priceCentavos\)\)/);
  // A choice only fills the field; saving stays an explicit click.
  assert.match(page, /onClick=\{\(\) => \{\n\s+setPriceInput\(centavosToInputValue\(option\.centavos\)\);/);
  assert.match(page, /reconfirm \? "Confirm VAT-inclusive price" : "Save price"/);
  // The save path is unchanged: updateStockPrice stamps the current convention, audited.
  const svc = read("src/services/vaccineService.js");
  assert.match(svc, /priceIsVatInclusive: PRICES_INCLUDE_VAT,/);
});
