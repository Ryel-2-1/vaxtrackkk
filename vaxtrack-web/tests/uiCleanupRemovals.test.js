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
  assert.match(row, /^<div className="stock-name">\s*<button\s+type="button"\s+className="stock-name-trigger"[\s\S]*?>\s*<strong>\{stock\.name\}<\/strong>\s*<small>\{stock\.manufacturer\} · \{stock\.type\}<\/small>/);
  assert.equal(/<span><PackageCheck/.test(inventory), false);
});

test("Order Confirmation has no Return to Catalog; tracking stays one click away", () => {
  const confirmation = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  assert.equal(confirmation.includes("Return to Catalog"), false);
  assert.match(confirmation, /onClick=\{\(\) => navigate\("\/sales-rep\/order-tracking"\)\}/);
});

// ------------------------------------------- Med Rep UI 1.1 (2026-10-27)

/** The JSX between an opening `<div className="NAME">` and its matching close. */
const block = (src, className) => {
  const start = src.indexOf(`<div className="${className}">`);
  assert.notEqual(start, -1, `${className} must exist`);
  let depth = 0;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index);
  }
  throw new Error(`${className} is not closed`);
};

test("Order Tracking: the one search sits in the filter toolbar with the tabs and status filter", () => {
  const page = stripComments(tracking);
  assert.equal((page.match(/className="tracking-v2-search"/g) || []).length, 1, "exactly one search");
  const toolbar = block(page, "tracking-toolbar tracking-v2-toolbar");
  for (const part of ['className="tracking-v2-tabs"', 'className="tracking-v2-search"', 'className="tracking-v2-status-filter"']) {
    assert.ok(toolbar.includes(part), `${part} is in the toolbar`);
  }
  assert.match(toolbar, /onChange=\{\(event\) => setSearchTerm\(event\.target\.value\)\}/);
  assert.match(toolbar, /placeholder="Search order ID, clinic, vaccine, or status\.\.\."/);
  assert.equal(block(page, "tracking-v2-header").includes("tracking-v2-search"), false, "no search left in the header");
});

test("Alerts: lifecycle tabs, category chips and the one search share a single toolbar", () => {
  const page = stripComments(read("src/pages/salesRep/SalesRepAlerts.jsx"));
  assert.equal((page.match(/className="alerts-v2-search"/g) || []).length, 1, "exactly one search");
  const toolbar = block(page, "alerts-v2-toolbar");
  for (const part of ['className="sales-alert-tabs alerts-v2-tabs"', 'className="sales-alert-filters alerts-v2-filters"', 'className="alerts-v2-search"']) {
    assert.ok(toolbar.includes(part), `${part} is in the toolbar`);
  }
  // The categories and counts are unchanged.
  for (const label of ["All (${filterCounts.all})", "Critical (${filterCounts.critical})", "Updates (${filterCounts.info})", "Delivered (${filterCounts.success})"]) {
    assert.ok(toolbar.includes(label), label);
  }
  assert.match(toolbar, /placeholder="Search order ID, title, or clinic\.\.\."/);
});

test("Order History: Print receipt is offered to Admin only; the Med Rep view has none", () => {
  const detail = read("src/components/history/OrderHistoryDetail.jsx");
  assert.match(detail, /\{canPrint && \(\s*<button type="button" className="ohx-btn ohx-noprint" onClick=\{printReceipt\}>Print receipt<\/button>\s*\)\}/);
  assert.match(detail, /canPrint=\{mode === "admin"\}/);
  assert.match(read("src/pages/salesRep/SalesRepOrderHistory.jsx"), /<OrderHistoryView mode="salesrep" medRepUid=\{uid\} \/>/);
  assert.match(read("src/pages/admin/AdminOrderHistory.jsx"), /<OrderHistoryView mode="admin" \/>/);
});

test("Inventory and Alerts are not capped at 1280px; the Tracking toolbar pins only above 768px", () => {
  const legacy = read("src/pages/salesRep/SalesRep.css");
  const cap = legacy.slice(0, legacy.indexOf("max-width: 1280px !important;"));
  const selectors = cap.slice(cap.lastIndexOf("}") + 1);
  for (const gone of [".salesrep-page-title", ".inventory-table-card", ".sales-alerts-header", ".sales-alert-tabs", ".sales-alert-filters", ".sales-alert-grid"]) {
    assert.equal(selectors.includes(gone), false, `${gone} must not be capped`);
  }
  const polish = read("src/pages/salesRep/salesrep-polish.css");
  assert.match(polish, /@media \(min-width: 769px\) \{\s*\.salesrep-main \.tracking-v2-toolbar \{\s*position: sticky;\s*top: 0;/);
});
