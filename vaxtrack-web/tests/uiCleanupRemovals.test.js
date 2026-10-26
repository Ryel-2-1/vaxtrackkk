import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression coverage for the obsolete-UI cleanup: Sales Rep Inventory row
 * selection, Order Tracking "Contact Driver", and the storage-temperature
 * surfaces are gone, while the legitimate flows they sat beside remain. These
 * are precise source-boundary assertions — not keyword bans that would also
 * trip on comments — plus behavioural checks in the sibling suites
 * (inventoryExport / invoiceModel / orderLocation).
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Strip comments so temperature/cold-chain assertions target USER-FACING text,
// not code comments or historical technical notes.
const stripComments = (s) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // {/* jsx comment */}
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* block */
    .replace(/^\s*\/\/[^\n]*$/gm, ""); // // line

const inventory = read("src/pages/salesRep/SalesRepInventory.jsx");
const requestOrder = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
const adminInventory = read("src/pages/admin/Inventory.jsx");
const invoiceEditor = read("src/pages/admin/InvoiceEditor.jsx");

// ------------------------------------------- Sales Rep Inventory row selection

test("Sales Rep Inventory has no selection checkboxes", () => {
  assert.equal(
    /type="checkbox"/.test(inventory),
    false,
    "no checkbox input may remain in the inventory table"
  );
});

test("Sales Rep Inventory has no Request Selected workflow", () => {
  for (const token of [
    "selectedRows",
    "toggleRow",
    "toggleVisibleRows",
    "requestSelected",
    "Request Selected",
    "inventory-request-btn",
  ]) {
    assert.ok(!inventory.includes(token), `${token} must be gone from Sales Rep Inventory`);
  }
});

test("no salesRepSelectedInventory localStorage workflow remains", () => {
  assert.ok(
    !inventory.includes("salesRepSelectedInventory"),
    "Inventory must not write the selection to localStorage"
  );
  assert.ok(
    !requestOrder.includes("salesRepSelectedInventory"),
    "Request Order must not read the inventory selection"
  );
  assert.ok(!requestOrder.includes("applyPreselection"), "the preselection reader is gone");
  assert.ok(
    !requestOrder.includes("added from inventory selection"),
    "no 'added from inventory selection' message remains"
  );
});

test("the inventory table shows exactly the five intended columns, in order", () => {
  const headers = [...inventory.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(headers, [
    "Vaccine name",
    "Batch ID",
    "Expiry date",
    "Remaining qty",
    "Status",
  ]);
});

test("legitimate Sales Rep selections and the normal cart flow are preserved", () => {
  // Filters the task said to KEEP.
  for (const kept of ["selectedType", "selectedStatus", "expiryWindow"]) {
    assert.ok(inventory.includes(kept), `${kept} filter must remain`);
  }
  // Request Order still adds to the quick cart and places a normal order.
  // The quick-cart flow remains, now saved under the signed-in user only.
  assert.ok(requestOrder.includes("saveCartDraft("), "the quick-cart flow must remain");
  assert.ok(requestOrder.includes("addToCart") || requestOrder.includes("setCart"), "add-to-order remains");
});

// ------------------------------------------------- Order Tracking Contact Driver

test("Order Tracking has no Contact Driver button or fake handler", () => {
  for (const token of [
    "handleContactDriver",
    "Contact Driver",
    "contact-driver",
    "Contact request sent",
  ]) {
    assert.ok(!tracking.includes(token), `${token} must be gone from Order Tracking`);
  }
  // The Phone icon it used is no longer imported.
  assert.equal(/^\s*Phone,\s*$/m.test(tracking), false, "the Phone icon import must be removed");
});

test("Order Tracking has no New Order or Share button; order creation stays on Request Order", () => {
  for (const token of ["+ New Order", "handleShare", "share-btn", "Share2", "navigator.clipboard", "tracking-v2-side-actions"]) {
    assert.ok(!tracking.includes(token), `${token} must be gone from Order Tracking`);
  }
  // The tabs, status filter, search and panel close still work as before.
  assert.match(tracking, /onClick=\{\(\) => handleTabChange\("active"\)\}/);
  assert.match(tracking, /onClick=\{\(\) => handleTabChange\("history"\)\}/);
  assert.match(tracking, /onChange=\{\(event\) => setStatusFilter\(event\.target\.value\)\}/);
  assert.match(tracking, /onChange=\{\(event\) => setSearchTerm\(event\.target\.value\)\}/);
  assert.match(tracking, /onClick=\{\(\) => selectOrder\(""\)\}/);
  // The Med Rep still creates orders from Request Order, reachable from the sidebar.
  assert.match(read("src/pages/salesRep/SalesRepShell.jsx"), /to="\/sales-rep\/request-order"/);
});

test("Order Tracking keeps destination approval, rider info and delivery status", () => {
  assert.match(tracking, /reviewOrderDestinationChange/, "destination-change approval remains wired");
  assert.match(tracking, /Approve new destination/, "the approval action remains");
  assert.match(tracking, /aria-label="Destination change request"/, "the request section remains");
  assert.match(tracking, /Destination change history/, "the destination history remains");
  assert.match(tracking, /Delivery Status/, "delivery status remains");
  assert.match(tracking, /selectedOrder\.driverName/, "rider assignment info remains");
});

// ------------------------------------- follow-up: residual temperature wording

test("no user-facing storage-temperature instruction remains on the invoice", () => {
  assert.ok(!invoiceEditor.includes("Store at 2 to 8"), "the 2–8°C storage line must be gone");
  assert.ok(!invoiceEditor.includes("Do not freeze"), "the do-not-freeze line must be gone");
  assert.ok(!invoiceEditor.includes("sit-head-store"), "the storage-instruction block must be gone");
});

test("inventory pages make no temperature or cold-chain capability claim", () => {
  for (const [name, src] of [
    ["Admin Inventory", adminInventory],
    ["Sales Rep Inventory", inventory],
  ]) {
    const text = stripComments(src).toLowerCase();
    for (const claim of [
      "cold-chain status",
      "cold-chain visibility",
      "cold-chain monitoring",
      "temperature monitoring",
      "storage temperature",
    ]) {
      assert.equal(text.includes(claim), false, `${name} must not claim "${claim}"`);
    }
  }
});

test("removed temperature CSS has no live JSX dependency, and the rules are gone", () => {
  // No component renders these classes any more.
  const jsx = [
    inventory,
    requestOrder,
    tracking,
    adminInventory,
    invoiceEditor,
    read("src/pages/dispatcher/DispatcherAssignRider.jsx"),
  ].join("\n");
  for (const cls of ["temp-pill", "v2-temp-pill", "temp-chip", "sit-temp", "sit-head-store"]) {
    assert.equal(
      new RegExp(`className=("|\\{\`)[^"\`]*\\b${cls}\\b`).test(jsx),
      false,
      `no JSX may reference the .${cls} class`
    );
  }
  // And the dead temperature CSS definitions were removed.
  assert.equal(/\.temp-pill\b/.test(read("src/styles.css")), false, ".temp-pill CSS must be gone");
  assert.equal(
    /\.progress-card\.temp\b/.test(read("src/pages/dispatcher/Dispatcher.css")),
    false,
    ".progress-card.temp CSS must be gone"
  );
});

// ------------------------------------------- Med Rep revisions (2026-10-27)

test("the Med Rep Dashboard has no Quick actions card; its destinations stay in the sidebar", () => {
  const dashboard = stripComments(read("src/pages/salesRep/SalesRepDashboard.jsx"));
  for (const token of ["Quick actions", "quickActions", "srd-action", "Track shipment", "View alerts"]) {
    assert.ok(!dashboard.includes(token), `${token} must be gone from the Dashboard`);
  }
  const shell = read("src/pages/salesRep/SalesRepShell.jsx");
  for (const route of ["/sales-rep/request-order", "/sales-rep/order-tracking", "/sales-rep/alerts"]) {
    assert.ok(shell.includes(`to="${route}"`), `${route} stays in the sidebar`);
  }
});

test("Med Rep Inventory rows lead with the vaccine name, not an icon", () => {
  const row = inventory.slice(inventory.indexOf('<div className="stock-name">'));
  assert.match(row, /^<div className="stock-name">\s*<div>\s*<strong>\{stock\.name\}<\/strong>\s*<small>\{stock\.manufacturer\} · \{stock\.type\}<\/small>/);
  assert.equal(/<span><PackageCheck/.test(inventory), false);
});

test("Order Confirmation has no Return to Catalog; tracking stays one click away", () => {
  const confirmation = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  assert.equal(confirmation.includes("Return to Catalog"), false);
  assert.match(confirmation, /onClick=\{\(\) => navigate\("\/sales-rep\/order-tracking"\)\}/);
});
