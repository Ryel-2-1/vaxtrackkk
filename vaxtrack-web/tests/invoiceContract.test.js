import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRESENTATION_FIELDS,
  adjustmentsFromForm,
  isServerPricedOrder,
  itemsFromOrder,
  presentationFromForm,
} from "../src/services/invoiceModel.js";
import { parseAdjustmentPesosToCentavos } from "../src/services/money.js";

/**
 * The invoice authority boundary, asserted structurally.
 *
 * Behaviour lives in functions/test/invoicePricing.test.js (pure),
 * functions/test/integration/invoiceOperations.test.js (real transactions) and
 * tests/firestore.rules.test.js (the direct-write lockdown). What these pin is
 * the SHAPE: that the two sides agree on which fields exist, that no page can
 * send a base price, and that the legacy path is genuinely still there.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("client and server agree on the presentation allowlist", () => {
  // Two hand-maintained lists. A field added to one alone fails at save time
  // with `unknown-field`, which is safe but baffling — so they are pinned here.
  const server = read("functions/src/invoicePricing.js");
  const block = /PRESENTATION_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(server);
  assert.ok(block, "the server list must exist");
  const serverFields = [...block[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);

  assert.deepEqual(
    [...serverFields].sort(),
    [...PRESENTATION_FIELDS].sort(),
    "the client and server presentation allowlists must be identical"
  );
});

test("no money field can travel as presentation", () => {
  // The allowlist is the mechanism; this is the property it exists for.
  for (const money of [
    "unitPrice", "unitPriceCentavos", "quantity", "items", "subtotal",
    "subtotalCentavos", "grandTotal", "grandTotalCentavos", "vatAmount",
    "discount", "discountCentavos", "pricingVersion",
  ]) {
    assert.equal(
      PRESENTATION_FIELDS.includes(money),
      false,
      `${money} must never be a presentation field`
    );
  }
});

test("the editor sends no base pricing for a priced order", () => {
  const editor = read("src/pages/admin/InvoiceEditor.jsx");

  // The priced save path sends exactly two things, and neither is money the
  // client chose. `serializeInvoiceDoc` — which builds items and totals — is
  // reachable only through the LEGACY branch.
  assert.match(editor, /saveInvoiceDraftForPricedOrder\(\{\s*orderId,\s*presentation:/);
  assert.match(editor, /presentation: presentationFromForm\(form\)/);
  assert.match(editor, /adjustments: adjustmentsFromForm\(/);

  const pricedBranch = /if \(serverPriced\) \{([\s\S]*?)\} else if \(invoice\?\.id\)/.exec(editor);
  assert.ok(pricedBranch, "the priced save branch must exist");
  for (const forbidden of ["buildInvoiceData", "serializeInvoiceDoc", "items", "subtotal"]) {
    assert.equal(
      pricedBranch[1].includes(forbidden),
      false,
      `the priced save path must not send ${forbidden}`
    );
  }
});

test("the editor locks base fields separately from the issued lock", () => {
  // `readOnly` means "already issued". `baseLocked` additionally covers a
  // priced draft, where the numbers are the order's rather than the admin's.
  // The distinction matters: a priced DRAFT is still editable — just not its
  // prices — so reusing `readOnly` would have frozen the whole form.
  const editor = read("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /const baseLocked = readOnly \|\| serverPriced;/);
  assert.match(editor, /onChange=\{\(v\) => setItem\(it\.key, "quantity", v\)\}\s*\n\s*readOnly=\{baseLocked\}/);
  assert.match(editor, /onChange=\{\(v\) => setItem\(it\.key, "unitPrice", v\)\}\s*\n\s*readOnly=\{baseLocked\}/);
  // Adding or removing a LINE changes the base as surely as editing one.
  assert.match(editor, /\{!baseLocked && \(\s*\n\s*<button[\s\S]{0,200}onClick=\{addItem\}/);
});

test("the UI lock is a courtesy — the enforcement is elsewhere", () => {
  // Stated in the code, and true of it: rules refuse the write and the callable
  // recomputes regardless of what arrives.
  const editor = read("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /COURTESY, not the control/);

  const rules = read("firestore.rules");
  assert.match(rules, /function invoiceOrderIsServerPriced\(invoiceId\)/);
  assert.match(rules, /allow create: if isAdmin\(\)\s*\n\s*&& !invoiceOrderIsServerPriced\(invoiceId\)/);
  assert.match(rules, /allow update: if isAdmin\(\)\s*\n\s*\/\/[^\n]*\n\s*&& !invoiceOrderIsServerPriced\(invoiceId\)/);
  // Reading a missing key errors in rules, so the default matters — without it
  // every legacy invoice write would be denied.
  assert.match(rules, /\.data\.get\('pricingVersion', 0\) == 1/);
});

test("a legacy order still reaches the manual path, and only a legacy one", () => {
  assert.equal(isServerPricedOrder({ pricingVersion: 1 }), true);
  assert.equal(isServerPricedOrder({}), false);
  assert.equal(isServerPricedOrder({ pricingVersion: "1" }), false);
  // Never inferred from item shape.
  assert.equal(isServerPricedOrder({ items: [{ unitPriceCentavos: 125000 }] }), false);

  const editor = read("src/pages/admin/InvoiceEditor.jsx");
  // The old client-side functions are still imported and still called — for
  // legacy orders only.
  for (const fn of ["createInvoiceDraft", "updateInvoiceDraft", "issueInvoice"]) {
    assert.match(editor, new RegExp(`\\b${fn}\\b`), `${fn} must remain for legacy orders`);
  }

  // And a legacy order's invoice lines still open at whatever it stored.
  const legacy = itemsFromOrder({
    items: [{ name: "Hepatitis B", sku: "HEP-3", quantity: 5, unitPrice: 0 }],
  });
  assert.equal(legacy[0].unitPrice, 0, "no price is invented for a legacy line");
});

test("presentationFromForm picks from the allowlist rather than deleting money", () => {
  const form = {
    customerName: "Clinic One",
    notes: "AM delivery",
    // Every one of these is money or identity and must not survive.
    subtotalCentavos: 1,
    grandTotal: 2,
    items: [{ unitPrice: 3 }],
    unitPrice: 4,
    invoiceNumber: "INV-2026-000001",
  };
  const out = presentationFromForm(form);
  assert.equal(out.customerName, "Clinic One");
  assert.equal(out.notes, "AM delivery");
  for (const leaked of ["subtotalCentavos", "grandTotal", "items", "unitPrice", "invoiceNumber"]) {
    assert.equal(leaked in out, false, `${leaked} must not survive`);
  }
  assert.deepEqual(Object.keys(out).sort(), [...PRESENTATION_FIELDS].sort());
});

test("adjustmentsFromForm converts pesos to exact centavos", () => {
  const adj = adjustmentsFromForm(
    { discount: "350.50", otherCharges: "", withholdingTax: 0, vatClassification: "zero_rated" },
    parseAdjustmentPesosToCentavos
  );
  assert.deepEqual(adj, {
    discountCentavos: 35050,
    otherChargesCentavos: 0,
    withholdingTaxCentavos: 0,
    vatClassification: "zero_rated",
  });

  // An empty adjustment is "none", not an error — the editor leaves them blank.
  assert.equal(
    adjustmentsFromForm({}, parseAdjustmentPesosToCentavos).discountCentavos,
    0
  );
  // An unrecognised classification falls back rather than travelling; the
  // server refuses anything it does not know regardless.
  assert.equal(
    adjustmentsFromForm({ vatClassification: "made_up" }, parseAdjustmentPesosToCentavos)
      .vatClassification,
    "vatable"
  );
  // A malformed amount is refused here rather than sent as a silent zero.
  assert.throws(
    () => adjustmentsFromForm({ discount: "abc" }, parseAdjustmentPesosToCentavos),
    /Discount must be a valid amount/
  );
});

test("the confirmation shows the callable's prices, not the client's expectation", () => {
  const place = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");

  // The stored confirmation payload is built from `result.pricing` — the
  // server's own copy — and the helper falls back to NO price rather than to
  // the client's expected value.
  assert.match(place, /\.\.\.confirmationPricing\(result\.pricing, items\)/);
  const helper = /function confirmationPricing\(pricing, cartItems\) \{([\s\S]*?)\n\}/.exec(place);
  assert.ok(helper, "the helper must exist");
  assert.equal(
    /unitPrice:\s*centavosToPesos\(item\.expectedUnitPriceCentavos\)/.test(helper[1]),
    false,
    "the confirmation must never bill from the client's expected price"
  );
  assert.match(helper[1], /unitPrice: centavosToPesos\(line\.unitPriceCentavos\)/);
  assert.match(helper[1], /unitPrice: null/, "no server pricing means no price shown");

  // And the server actually returns it, on both the fresh and replayed paths.
  const ops = read("functions/src/operations.js");
  assert.match(ops, /pricing: \{/);
  assert.match(ops, /pricing: pricingFromOrder\(/);
});
