import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PRICES_INCLUDE_VAT,
  VAT_INCLUSIVE_NOTE,
  VAT_RATE_PERCENT,
  splitVatInclusiveCentavos,
} from "../src/services/pricingConfig.js";
import { receiptPriceLabels } from "../src/services/orderHistory.js";

// Confirmed client rules: VAT is 12% for VATable sales, and prices entered and
// displayed in VaxTrack are VAT-inclusive. One authoritative configuration on
// the server (functions/src/pricingConfig.js), mirrored once for display.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const require = createRequire(import.meta.url);
const server = require("../functions/src/pricingConfig.js");

test("the web mirror equals the authoritative server configuration", () => {
  assert.equal(VAT_RATE_PERCENT, 12);
  assert.equal(PRICES_INCLUDE_VAT, true);
  assert.equal(server.VAT_RATE_PERCENT, VAT_RATE_PERCENT);
  assert.equal(server.PRICES_INCLUDE_VAT, PRICES_INCLUDE_VAT);
  for (let g = 0; g <= 20000; g += 1) {
    assert.deepEqual(splitVatInclusiveCentavos(g), server.splitVatInclusiveCentavos(g), `gross ${g}`);
  }
});

test("₱1,000.00 → VAT ₱107.14, net ₱892.86; ₱3,000.00 → VAT ₱321.43, net ₱2,678.57", () => {
  assert.deepEqual(splitVatInclusiveCentavos(100000), { grossCentavos: 100000, vatCentavos: 10714, netCentavos: 89286 });
  assert.deepEqual(splitVatInclusiveCentavos(300000), { grossCentavos: 300000, vatCentavos: 32143, netCentavos: 267857 });
});

test("net + VAT = gross, always; VAT is never added on top", () => {
  const check = (g) => {
    const s = splitVatInclusiveCentavos(g);
    assert.equal(s.netCentavos + s.vatCentavos, g, `gross ${g}`);
    assert.equal(s.grossCentavos, g, "the gross is unchanged");
    assert.ok(s.vatCentavos >= 0 && s.vatCentavos <= g);
    // round-half-up of g·12/112, checked against an exact rational bound.
    assert.ok(Math.abs(s.vatCentavos * 112 - g * 12) <= 56, `rounding at ${g}`);
  };
  for (let g = 0; g <= 50000; g += 1) check(g);
  let x = 123456789;
  for (let i = 0; i < 2000; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    check(x * 997);
  }
  check(Number.MAX_SAFE_INTEGER);
});

test("zero and very small centavo amounts are deterministic", () => {
  assert.deepEqual(splitVatInclusiveCentavos(0), { grossCentavos: 0, vatCentavos: 0, netCentavos: 0 });
  const small = [1, 2, 4, 5, 9, 13, 14, 15, 28, 112].map((g) => [g, splitVatInclusiveCentavos(g).vatCentavos]);
  // 14 × 12 / 112 = 1.5 exactly → half up → 2.
  assert.deepEqual(small, [[1, 0], [2, 0], [4, 0], [5, 1], [9, 1], [13, 1], [14, 2], [15, 2], [28, 3], [112, 12]]);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(splitVatInclusiveCentavos(14), splitVatInclusiveCentavos(14));
  assert.throws(() => splitVatInclusiveCentavos(-1), RangeError);
  assert.throws(() => splitVatInclusiveCentavos(1.5), RangeError);
});

/** Every .js/.jsx/.mjs source file under a directory. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") out.push(...sources(p));
    } else if (/\.(js|jsx|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("no code adds VAT on top of a price, and 12 is defined only in the pricing configuration", () => {
  const files = [...sources(join(root, "src")), ...sources(join(root, "functions", "src"))];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\*\s*1\.12\b|\*\s*0\.12\b|vatRate\s*\/\s*100|VAT_STANDARD_RATE\)?\s*\/\s*100|\+\s*vatAmount\s*\+\s*other/i, f);
    if (!/pricingConfig\.js$/.test(f)) {
      assert.doesNotMatch(code, /VAT[A-Z_]*\s*=\s*12\b/, `${f} must take the VAT rate from pricingConfig`);
    }
  }
  assert.match(read("src/services/invoiceModel.js"), /export const VAT_STANDARD_RATE = VAT_RATE_PERCENT;/);
  assert.match(read("functions/src/invoicePricing.js"), /const VAT_STANDARD_RATE = VAT_RATE_PERCENT;/);
});

test("price wording says VAT-inclusive for VATable products, never that every vaccine is VATable", () => {
  assert.equal(VAT_INCLUSIVE_NOTE, "Prices are VAT-inclusive for VATable products.");
  const files = sources(join(root, "src"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /excl\.? VAT|excluding VAT|(?<!no )VAT is added|added at invoicing|adds 12%/i, f);
    assert.doesNotMatch(text, /all (vaccines|products) are VATable/i, f);
  }
  for (const page of [
    "src/pages/salesRep/SalesRepPlaceOrder.jsx",
    "src/pages/salesRep/SalesRepOrderConfirmation.jsx",
    "src/pages/admin/AddStock.jsx",
    "src/pages/admin/Inventory.jsx",
    "src/pages/admin/InvoiceEditor.jsx",
  ]) {
    assert.match(read(page), /VAT_INCLUSIVE_NOTE/, `${page} states the convention`);
  }
  assert.match(read("src/pages/salesRep/SalesRepRequestOrder.jsx"), /per vial · VAT-inclusive for VATable products/);
});

test("a receipt is described by the convention recorded on it — historical ones are not re-labelled", () => {
  const now = receiptPriceLabels({ priceIsVatInclusive: true });
  assert.equal(now.inclusive, true);
  assert.match(now.subtotalLabel, /VAT-inclusive for VATable products/);
  const old = receiptPriceLabels({ priceIsVatInclusive: false });
  assert.equal(old.inclusive, false);
  assert.match(old.subtotalLabel, /recorded as VAT-exclusive/);
  assert.match(old.note, /shown exactly as recorded/);
  const detail = read("src/components/history/OrderHistoryDetail.jsx");
  assert.match(detail, /formatCentavos\(receipt\.subtotalCentavos\)/, "stored amounts, never recomputed");
  assert.match(detail, /formatCentavos\(receipt\.vatAmountCentavos\)/);
});

test("the client never sets a stored VAT amount: a priced invoice sends adjustments only", () => {
  const model = read("src/services/invoiceModel.js");
  const start = model.indexOf("export function adjustmentsFromForm");
  const fn = model.slice(start, model.indexOf("\n}\n", start));
  assert.match(fn, /discountCentavos: read\("discount"\)/);
  assert.doesNotMatch(fn, /vatAmount|grandTotal|totalAmountDue|vatableSales|net/, "no totals travel to the server");
});
