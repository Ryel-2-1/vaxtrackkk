import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the stock chart uses one colour, so no bar looks like a warning", () => {
  const page = read("src/pages/salesRep/SalesRepInventory.jsx");
  assert.ok(page.includes('className="hbar-fill"'));
  assert.doesNotMatch(page, /tones\[/);
  assert.doesNotMatch(read("src/pages/salesRep/SalesRep.css"), /\.hbar-fill\.(blue|green|gold|red|purple)/);
});

test("the chart shows exact vials, never a rounded figure", () => {
  const page = read("src/pages/salesRep/SalesRepInventory.jsx");
  assert.ok(page.includes('{formatNumber(qty)} {Number(qty) === 1 ? "vial" : "vials"}'));
});

test("no screen or server message says doses", () => {
  for (const file of ["src/pages/salesRep/SalesRepInventory.jsx", "src/pages/admin/InventoryRemovalDialogs.jsx", "src/services/inventoryRemovalModel.js", "functions/src/inventoryRemoval.js"]) {
    assert.doesNotMatch(read(file), /\bdoses?\b/i, file);
  }
});
