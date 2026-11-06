import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { inactiveAfter, inactiveProductIds } from "../src/services/inventoryVisibility.js";
const require = createRequire(import.meta.url);
const server = require("../functions/src/inventoryVisibility.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const START = new Date("2026-10-27T02:00:00Z");
const THRESHOLD = Date.parse("2027-01-27T02:00:00Z");
const product = (extra = {}) => ({ id: "v1", inventoryVisibilityVersion: 1, inventoryStockState: "empty", inventoryEmptySince: START, ...extra });
const batch = (extra = {}) => ({ vaccineId: "v1", quantity: 0, ...extra });

test("visibility control owns its gutters, stacks the help text and resists legacy input sizing", () => {
  const css = read("src/components/inventory/InventoryVisibilityToggle.css");
  const jsx = read("src/components/inventory/InventoryVisibilityToggle.jsx");
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /color-scheme: light/);
  assert.match(css, /min-height: 16px !important/);
  assert.match(css, /input:focus-visible/);
  assert.match(css, /\.v2-inventory-table-card > \.inventory-visibility-control\s*\{\s*margin: 0 0 12px/);
  assert.match(css, /\.salesrep-main \.inventory-v2-table-card > \.inventory-visibility-control\s*\{\s*margin: 0;\s*padding: 14px 16px 0/);
  assert.match(jsx, /const descriptionId = useId\(\)/);
  assert.match(jsx, /aria-describedby=\{descriptionId\}/);
  assert.match(jsx, /<p id=\{descriptionId\}>/);
});

test("strictly more than three months, not 90 days and not exactly the anniversary", () => {
  assert.deepEqual([...inactiveProductIds([product()], [batch()], THRESHOLD - 1)], []);
  assert.deepEqual([...inactiveProductIds([product()], [batch()], THRESHOLD)], []);
  assert.deepEqual([...inactiveProductIds([product()], [batch()], THRESHOLD + 1)], ["v1"]);
  assert.deepEqual([...inactiveProductIds([product()], [batch()], START.getTime() + 90 * 86400000)], []);
});

test("current positive stock beats stale empty metadata immediately, including fully reserved stock", () => {
  for (const b of [batch({ quantity: 1 }), batch({ quantity: 5, reservedQuantity: 5 }),
    batch({ quantity: 5, quarantinedQuantity: 5 }), batch({ quantity: 5, returnPendingQuantity: 5 }),
    batch({ quantity: 5, expiryDate: "2000-01-01" })]) {
    assert.equal(inactiveProductIds([product()], [batch(), b], THRESHOLD + 1).size, 0);
  }
});

test("malformed/unknown counters and outstanding custody cannot be hidden", () => {
  for (const b of [batch({ quantity: "0" }), batch({ quantity: null }), batch({ quantity: -1 }),
    batch({ reservedQuantity: 1 }), batch({ quarantinedQuantity: 1 }), batch({ returnPendingQuantity: 1 }),
    batch({ voided: true, returnPendingQuantity: 1 }), batch({ reservedQuantity: "0" })]) {
    assert.equal(inactiveProductIds([product()], [b], THRESHOLD + 1).size, 0, JSON.stringify(b));
  }
});

test("missing, malformed or unverified legacy timestamps never hide a product", () => {
  for (const p of [{ id: "v1" }, product({ inventoryEmptySince: null }), product({ inventoryEmptySince: "2020-01-01" }),
    product({ inventoryStockState: "needs_review" }), product({ inventoryStockState: "in_stock" }),
    product({ inventoryVisibilityVersion: 2 }), product({ inventoryEmptySince: new Date("2030-01-01") })]) {
    assert.equal(inactiveProductIds([p], [batch()], THRESHOLD + 1).size, 0);
  }
});

test("one product's stock cannot restore or hide another product", () => {
  const products = [product(), product({ id: "v2" })];
  const batches = [batch(), batch({ vaccineId: "v2", quantity: 2 })];
  assert.deepEqual([...inactiveProductIds(products, batches, THRESHOLD + 1)], ["v1"]);
});

test("voided mistakes aren't stock; valid zeros are hidden without deleting or mutating data", () => {
  const products = [product()];
  const batches = [batch(), batch({ voided: true, quantity: 100 })];
  const before = JSON.stringify({ products, batches });
  assert.equal(inactiveProductIds(products, batches, THRESHOLD + 1).size, 1);
  assert.equal(JSON.stringify({ products, batches }), before);
});

test("server and browser month calculations match across every month and Manila midnight", () => {
  for (let year = 2024; year <= 2028; year++) {
    for (let month = 0; month < 12; month++) {
      for (const day of [1, 28, 29, 30, 31]) {
        for (const hour of [0, 15, 16, 23]) {
          const start = new Date(Date.UTC(year, month, day, hour, 59, 59, 123));
          assert.equal(inactiveAfter(start), server.inactiveAfter(start));
        }
      }
    }
  }
});

test("Firestore timestamp objects work; invalid clock/data fails open", () => {
  const p = product({ inventoryEmptySince: { toMillis: () => START.getTime() } });
  assert.equal(inactiveProductIds([p], [batch()], THRESHOLD + 1).size, 1);
  for (const [vaccines, batches, now] of [[null, [], THRESHOLD], [[], null, THRESHOLD], [[p], [], NaN]]) {
    assert.equal(inactiveProductIds(vaccines, batches, now).size, 0);
  }
});

test("all intended lists share the policy; carts, checkout, Add Stock and history don't apply housekeeping", () => {
  for (const page of ["admin/Inventory", "salesRep/SalesRepInventory", "salesRep/SalesRepRequestOrder", "salesRep/SalesRepDashboard"]) {
    assert.match(read(`src/pages/${page}.jsx`), /useInventoryVisibility\(/);
  }
  for (const page of ["admin/Inventory", "salesRep/SalesRepInventory", "salesRep/SalesRepRequestOrder"]) {
    assert.match(read(`src/pages/${page}.jsx`), /<InventoryVisibilityToggle/);
  }
  assert.doesNotMatch(read("src/pages/admin/Inventory.jsx"), /inactiveIds\.size > 0 \|\| showInactive/, "the Admin visibility filter stays visible at zero inactive products");
  for (const file of ["src/pages/admin/AddStock.jsx", "src/pages/salesRep/SalesRepPlaceOrder.jsx", "src/components/history/OrderHistoryView.jsx"]) {
    assert.doesNotMatch(read(file), /inactiveProductIds|useInventoryVisibility/);
  }
  assert.match(read("src/pages/salesRep/SalesRepRequestOrder.jsx"), /estimateBackorders\(cart, catalog\)/);
  assert.match(read("src/components/useInventoryVisibility.js"), /setInterval\(refresh, 60_000\)/);
  assert.match(read("src/components/useInventoryVisibility.js"), /removeEventListener\("focus", refresh\)/);
});

test("server observation fields and sweep cursor are denied to clients on both create and update", () => {
  const rules = read("firestore.rules");
  const vaccine = rules.slice(rules.indexOf("match /vaccines/{id}"), rules.indexOf("match /inventoryVisibilityMaintenance/{id}"));
  assert.match(vaccine, /keys\(\)\.hasAny\(vaccineVisibilityFields\(\)\)/);
  assert.match(vaccine, /changedKeys\(\)\.hasAny\(vaccineVisibilityFields\(\)\)/);
  assert.match(rules, /match \/inventoryVisibilityMaintenance\/\{id\} \{\s*allow read, write: if false;/);
});

test("Dashboard derives visibility from its complete inventory feed, never the Med Rep's orders", () => {
  const dashboard = read("src/pages/salesRep/SalesRepDashboard.jsx");
  const orderFeed = dashboard.slice(dashboard.indexOf("const unsubscribe = subscribeSalesRepOrders("), dashboard.indexOf("const unsubscribe = subscribeInventory("));
  assert.doesNotMatch(orderFeed, /setRawInventory/);
  const stockFeed = dashboard.slice(dashboard.indexOf("const unsubscribe = subscribeInventory("), dashboard.indexOf("const metrics = useMemo("));
  assert.match(stockFeed, /\(raw\) => \{\s*setRawInventory\(raw\);/);
  assert.match(dashboard, /useInventoryVisibility\(vaccines, rawInventory\)/);
  assert.match(dashboard, /r\.watch && !inactiveIds\.has\(r\.vaccineId\)/);
});

test("rules harness uses a per-run demo namespace and dedicated approved-role fixtures", () => {
  const rulesTest = read("tests/firestore.rules.test.js");
  assert.match(rulesTest, /const PROJECT_ID = `demo-vt-rules-\$\{randomBytes\(4\)\.toString\("hex"\)\}`/);
  assert.match(rulesTest, /projectId: `\$\{PROJECT_ID\}-strict`/);
  const section = rulesTest.slice(rulesTest.indexOf("const visibilityRoles ="));
  assert.match(section, /visibilityRoles = \["admin", "dispatcher", "salesrep", "rider"\]/);
  assert.match(section, /authenticatedContext\(`visibility_\$\{role\}`\)/);
  assert.match(section, /setDoc\(doc\(ctx\.firestore\(\), "users", `visibility_\$\{role\}`\), \{ role, status: "approved" \}\)/);
  assert.match(section, /for \(const \[role, ctx\] of Object\.entries\(visibilityActors\)\)/);
  assert.match(section, /visibility_pending/);
  assert.match(section, /visibility_disabled/);
  assert.doesNotMatch(section, /for \(const ctx of \[admin, dispatcher, salesRep, rider/);
});
