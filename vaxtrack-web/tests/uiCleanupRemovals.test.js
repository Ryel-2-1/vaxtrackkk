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
  assert.ok(requestOrder.includes("salesRepQuickCart"), "the quick-cart flow must remain");
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

test("Order Tracking keeps a real, accessibly-labelled Share button", () => {
  assert.ok(tracking.includes("handleShare"), "the share handler remains");
  assert.match(tracking, /navigator\.clipboard\.writeText/, "share uses real clipboard behaviour");
  assert.match(tracking, /className="share-btn"/, "the share button remains");
  assert.match(
    tracking,
    /aria-label="Copy tracking details to clipboard"/,
    "the icon-only share button has an accessible label"
  );
  assert.match(tracking, /title="Copy tracking details"/, "the share button has a title");
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
