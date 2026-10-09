import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  NOT_CLASSIFIED,
  NOT_RECORDED,
  PRODUCT_VAT_CLASSIFICATIONS,
  VAT_REQUIRED_TO_ORDER_MESSAGE,
  applyVatToCatalogProduct,
  batchVatClassification,
  itemVatLabel,
  productVatLabel,
  readVatClassification,
} from "../src/services/vatClassification.js";
import {
  ITEMIZED_VAT,
  buildInitialForm,
  computeVatExclusiveTotals,
  hasItemizedVat,
  itemVatLabelForLine,
  itemsFromOrder,
  vatClassificationLabel,
} from "../src/services/invoiceModel.js";
import { buildConfirmationFromOrder } from "../src/services/orderConfirmation.js";

// Per-item VAT classification on the web side. The server decisions (snapshot
// at order time, invoice arithmetic) are in functions/test/vatClassification
// .test.js and the emulator suites; here: what each screen shows, what the
// Med Rep can order, and that the client's invoice preview equals the server.

const require = createRequire(import.meta.url);
const server = require("../functions/src/invoicePricing.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) => read(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("2/3/4 · only vatable and vat_exempt are classifications", () => {
  assert.deepEqual([...PRODUCT_VAT_CLASSIFICATIONS], ["vatable", "vat_exempt"]);
  assert.equal(readVatClassification("vatable"), "vatable");
  assert.equal(readVatClassification("vat_exempt"), "vat_exempt");
  for (const bad of [undefined, null, "", "VAT", "zero_rated", "exempt", true]) {
    assert.equal(readVatClassification(bad), null, String(bad));
  }
});

test("6/15 · labels: products read Not classified, order items Not recorded — never inferred", () => {
  assert.equal(productVatLabel({ vatClassification: "vatable" }), "VAT");
  assert.equal(productVatLabel({ vatClassification: "vat_exempt" }), "VAT Exempt");
  assert.equal(productVatLabel({}), NOT_CLASSIFIED);
  assert.equal(NOT_CLASSIFIED, "Not classified");
  assert.equal(itemVatLabel({ vatClassification: "vat_exempt" }), "VAT Exempt");
  assert.equal(itemVatLabel({ name: "legacy item" }), NOT_RECORDED);
  assert.equal(NOT_RECORDED, "Not recorded");
  assert.equal(itemVatLabelForLine({}), "Not recorded");
});

test("7 · an unclassified or unlinked product is visible but cannot be ordered", () => {
  const vaccines = new Map([
    ["vVat", { vatClassification: "vatable" }],
    ["vLegacy", { vaccineName: "No class yet" }],
  ]);
  const card = (over) => ({ inventoryId: "b", orderable: true, blockedReason: null, status: "In Stock", ...over });

  const ok = applyVatToCatalogProduct(card({ vaccineId: "vVat" }), vaccines);
  assert.equal(ok.orderable, true);
  assert.equal(ok.vatLabel, "VAT");

  for (const vaccineId of ["vLegacy", "vMissing", null]) {
    const blocked = applyVatToCatalogProduct(card({ vaccineId }), vaccines);
    assert.equal(blocked.orderable, false, String(vaccineId));
    assert.equal(blocked.vatLabel, "Not classified");
    assert.equal(`${blocked.blockedReason}.`, VAT_REQUIRED_TO_ORDER_MESSAGE);
    assert.equal(blocked.blockedReasonCode, "vat-classification-required");
  }
  assert.equal(VAT_REQUIRED_TO_ORDER_MESSAGE, "This vaccine needs a VAT classification before it can be ordered.");

  // A more specific existing block (e.g. expired) keeps its own reason.
  const expired = applyVatToCatalogProduct(card({ vaccineId: "vLegacy", orderable: false, blockedReason: "Expired" }), vaccines);
  assert.equal(expired.blockedReason, "Expired");
  assert.equal(batchVatClassification({ vaccineId: "vVat" }, { vVat: { vatClassification: "vat_exempt" } }), "vat_exempt");
});

test("10 · the Med Rep never sends a VAT field; the server snapshots the product's value", () => {
  const checkout = code("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(checkout, /items: items\.map\(\(item\) => \(\{\s*inventoryId: item\.inventoryId,\s*quantity: Number\(item\.quantity\),\s*expectedUnitPriceCentavos: item\.expectedUnitPriceCentavos,\s*\}\)\)/);
  const ops = read("functions/src/operations.js");
  assert.match(ops, /vatClassification: lineVat\[index\],/);
  assert.match(ops, /resolveLineVatClassification\(\{/);
});

// ---------------------------------------------------------------- display

test("13 · final order review and confirmation show each item's classification", () => {
  const checkout = code("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(checkout, /PRODUCT_VAT_LABELS\[item\.vatClassification\]/);
  const confirmation = buildConfirmationFromOrder({
    id: "o1",
    items: [
      { inventoryId: "a", name: "A", quantity: 1, vatClassification: "vatable" },
      { inventoryId: "b", name: "B", quantity: 1, vatClassification: "vat_exempt" },
      { inventoryId: "c", name: "C", quantity: 1 }, // created before snapshots
    ],
  });
  assert.deepEqual(confirmation.items.map((i) => i.vatLabel), ["VAT", "VAT Exempt", "Not recorded"]);
});

test("12/14 · an invoice for a mixed order is itemized and labels every line", () => {
  const order = {
    unit: "vials",
    items: [
      { inventoryId: "a", name: "A", quantity: 2, unitPriceCentavos: 100000, lineTotalCentavos: 200000, vatClassification: "vatable" },
      { inventoryId: "b", name: "B", quantity: 1, unitPriceCentavos: 50000, lineTotalCentavos: 50000, vatClassification: "vat_exempt" },
    ],
  };
  assert.equal(hasItemizedVat(order.items), true);
  const form = buildInitialForm(order, null, "");
  assert.equal(form.vatClassification, ITEMIZED_VAT);
  assert.deepEqual(itemsFromOrder(order).map(itemVatLabelForLine), ["VAT", "VAT Exempt"]);
  assert.equal(vatClassificationLabel(ITEMIZED_VAT), "Per item (VAT / VAT Exempt)");
  // A legacy order keeps the Admin's invoice-level choice (default VATable).
  assert.equal(buildInitialForm({ items: [{ name: "x", quantity: 1, unitPrice: 5 }] }, null, "").vatClassification, "vatable");

  const editor = code("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /<span className="sit-vat">\{itemVatLabelForLine\(it\)\}<\/span>/, "printed per line");
  assert.match(editor, /form\.vatClassification === ITEMIZED_VAT \? \(/, "no invoice-level selector for itemized orders");
});

// ---------------------------------------------------------------- arithmetic parity

test("19/20 · the invoice preview equals the server's authoritative totals, VAT only on VAT lines", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 300; k += 1) {
    const items = Array.from({ length: 1 + rnd(4) }, (_, i) => {
      const quantity = 1 + rnd(20);
      const unitPriceCentavos = 1 + rnd(250000);
      return {
        inventoryId: `b${i}`,
        quantity,
        unitPriceCentavos,
        unitPrice: unitPriceCentavos / 100,
        lineTotalCentavos: quantity * unitPriceCentavos,
        vatClassification: rnd(2) ? "vatable" : "vat_exempt",
      };
    });
    const subtotalCentavos = items.reduce((s, i) => s + i.lineTotalCentavos, 0);
    const discountCentavos = rnd(3) ? rnd(subtotalCentavos + 1) : 0;
    const otherChargesCentavos = rnd(5000);
    const withholdingTaxCentavos = rnd(3000);

    const s = server.computeInvoiceTotalsCentavos({
      subtotalCentavos,
      items,
      adjustments: { discountCentavos, otherChargesCentavos, withholdingTaxCentavos, vatClassification: ITEMIZED_VAT },
    });
    const c = computeVatExclusiveTotals({
      items,
      discount: discountCentavos / 100,
      otherCharges: otherChargesCentavos / 100,
      withholdingTax: withholdingTaxCentavos / 100,
      vatClassification: ITEMIZED_VAT,
    });
    const cents = (pesos) => Math.round(pesos * 100);
    assert.equal(cents(c.vatableSales), s.vatableSalesCentavos, `case ${k}`);
    assert.equal(cents(c.vatExemptSales), s.vatExemptSalesCentavos, `case ${k}`);
    assert.equal(cents(c.vatAmount), s.vatAmountCentavos, `case ${k}`);
    assert.equal(cents(c.grandTotal), s.grandTotalCentavos, `case ${k}`);
    // VAT is 12% of the VATable bucket only — never of the exempt sales.
    assert.equal(s.vatAmountCentavos, Math.round((s.vatableSalesCentavos * 12) / 100));
    assert.equal(s.vatableSalesCentavos + s.vatExemptSalesCentavos, subtotalCentavos - discountCentavos);
  }
});

test("18 · an order without snapshots keeps the existing invoice totals exactly", () => {
  const items = [{ quantity: 4, unitPrice: 200 }];
  const legacy = computeVatExclusiveTotals({ items, vatClassification: "vatable" });
  assert.deepEqual([legacy.net, legacy.vatAmount, legacy.grandTotal], [800, 96, 896]);
  // Asking for itemized on items that lack snapshots falls back to the old path.
  assert.equal(computeVatExclusiveTotals({ items, vatClassification: ITEMIZED_VAT }).vatClassification, "vatable");
});

// ---------------------------------------------------------------- registration + admin

test("1 · Register New Vaccine requires an explicit classification with no default", () => {
  const page = code("src/pages/admin/AddVaccine.jsx");
  assert.match(page, /const \[vatClassification, setVatClassification\] = useState\(""\);/);
  assert.match(page, /if \(!PRODUCT_VAT_CLASSIFICATIONS\.includes\(vatClassification\)\) \{\s*showMessage\("Select VAT or VAT Exempt for this vaccine\."\);\s*return false;/);
  assert.match(page, /<legend>VAT Classification<\/legend>/);
  assert.match(page, /Becomes the VAT status of every future order item/);
});

test("6 · Admin Inventory shows and edits the product classification; export carries it", () => {
  const inventory = code("src/pages/admin/Inventory.jsx");
  assert.match(inventory, /<span>VAT Classification<\/span>\s*<strong>\{drawerItem\.vatLabel\}<\/strong>/);
  assert.match(inventory, /await setVaccineVatClassification\(drawerItem\.vaccineId, vatChoice\);/);
  assert.match(read("src/services/inventoryExport.js"), /header: "VAT Classification"/);
});
