import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LARGE_STOCK_QUANTITY, isLargeStockQuantity, largeQuantityMessage } from "../src/services/stockQuantityLimit.js";

// Above 5,000 vials a batch is still accepted, but only after the Admin
// confirms the figure — on both Add Stock and Correct Stock, and on the server.

const require = createRequire(import.meta.url);
const P = require("../functions/src/policy.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the web and the server agree on the limit", () => {
  assert.equal(LARGE_STOCK_QUANTITY, 5000);
  assert.equal(P.LARGE_STOCK_QUANTITY, LARGE_STOCK_QUANTITY);
});

test("exactly 5,000 needs no confirmation; 5,001 does", () => {
  assert.equal(isLargeStockQuantity(5000), false);
  assert.equal(isLargeStockQuantity(5001), true);
  assert.equal(isLargeStockQuantity(Number.NaN), false);
  assert.equal(largeQuantityMessage(12000), "12,000 vials is above the usual 5,000 per batch.");
});

test("the server refuses a large figure unless the confirmation is exactly true", () => {
  assert.doesNotThrow(() => P.requireLargeQuantityConfirmed(5000, undefined));
  assert.throws(() => P.requireLargeQuantityConfirmed(5001, undefined), { code: "large-quantity-unconfirmed" });
  assert.throws(() => P.requireLargeQuantityConfirmed(5001, "true"), { code: "large-quantity-unconfirmed" });
  assert.doesNotThrow(() => P.requireLargeQuantityConfirmed(5001, true));
});

test("Add Stock and Correct Stock ask first, and only send the flag after a yes", () => {
  const add = read("src/pages/admin/AddStock.jsx");
  assert.match(add, /isLargeStockQuantity\(typedQuantity\) && !largeQuantityConfirmed/);
  assert.match(add, /handleSubmit\(null, \{ largeQuantityConfirmed: true \}\)/);
  assert.match(add, /<AdminDialogLayer>\s*<ConfirmDialog/, "portaled: the page's <main> is transformed");
  const inventory = read("src/pages/admin/Inventory.jsx");
  assert.match(inventory, /isLargeStockQuantity\(pre\.value\.newQuantity\) && !largeQuantityConfirmed/);
  assert.match(inventory, /handleSaveCorrection\(\{ largeQuantityConfirmed: true \}\)/);
});

test("the search box keeps its height when the toolbar stacks", () => {
  const css = read("src/pages/admin/Inventory.css").replace(/\r\n/g, "\n");
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*?\.v2-inventory-search \{[\s\S]*?flex: 0 0 auto !important;/);
});
