import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildConfirmationFromOrder,
  loadAuthoritativeConfirmation,
} from "../src/services/orderConfirmation.js";

/**
 * The Med Rep confirmation is built only from the stored order the callable
 * named. A replay under the same request id returns the ORIGINAL order — and
 * the server fingerprint ignores priority, instructions and the requested date
 * — so a confirmation built from the checkout form could show values that were
 * never stored. These prove it cannot.
 */

/** What the server stored for the original attempt. */
const STORED = {
  id: "orderDoc1",
  orderNumber: "VT-ORD-1790000000000-ABCD",
  status: "pending_dispatch",
  doctorName: "Dr. Sample Alonzo",
  destinationType: "home",
  destinationName: "Home / Doorstep",
  clinicName: "Dr. Sample Alonzo — Home / Doorstep",
  clinicAddress: "Sample Home 01, Biñan",
  requestedDeliveryDate: "2026-10-20",
  priority: "Standard",
  deliveryInstructions: "Leave at reception",
  items: [
    { inventoryId: "inv1", batchId: "BATCH-01", name: "Vaccine A", chain: "Viral",
      quantity: 2, unitPriceCentavos: 50000, lineTotalCentavos: 100000 },
  ],
  subtotalCentavos: 100000,
  priceCurrency: "PHP",
  priceIsVatInclusive: false,
};

/** What the rep had edited the form to before retrying. Never stored. */
const EDITED_FORM = {
  priority: "Urgent",
  deliveryInstructions: "Call the doctor first",
  requestedDeliveryDate: "2026-10-25",
};

test("14. a replay confirmation is built from the stored order, not the form", async () => {
  const loads = [];
  const out = await loadAuthoritativeConfirmation({
    orderId: "orderDoc1",
    orderNumber: "VT-ORD-1790000000000-ABCD",
    replayed: true,
    loadOrder: async (id) => {
      loads.push(id);
      return STORED;
    },
  });
  assert.deepEqual(loads, ["orderDoc1"], "the order the server named is re-read");
  assert.equal(out.verified, true);
  const d = out.details;
  assert.equal(d.verified, true);
  assert.equal(d.replayed, true, "a recovered order is identified as such");
  assert.equal(d.priority, "Standard");
  assert.equal(d.deliveryInstructions, "Leave at reception");
  assert.equal(d.requestedDeliveryDate, "2026-10-20");
  for (const [field, value] of Object.entries(EDITED_FORM)) {
    assert.notEqual(d[field], value, `${field} is the stored value, not the edited one`);
  }
  assert.equal(d.subtotalCentavos, 100000);
  assert.equal(d.items[0].unitPriceCentavos, 50000, "server-written price");
  assert.equal(d.items[0].sku, "BATCH-01");
  assert.equal(d.clinicAddress, "Sample Home 01, Biñan");
});

test("a fresh (non-replayed) order is built the same way, not marked recovered", async () => {
  const out = await loadAuthoritativeConfirmation({
    orderId: "orderDoc1", orderNumber: "x", replayed: false, loadOrder: async () => STORED,
  });
  assert.equal(out.details.replayed, false);
  assert.equal(out.details.orderNumber, STORED.orderNumber, "the stored order number wins");
});

test("15. if the stored order cannot be re-read, nothing from the form is shown as confirmed", async () => {
  for (const [label, loadOrder] of [
    ["read throws", async () => { throw new Error("permission-denied"); }],
    ["order missing", async () => null],
    ["a different document", async () => ({ ...STORED, id: "someOtherOrder" })],
  ]) {
    const out = await loadAuthoritativeConfirmation({
      orderId: "orderDoc1", orderNumber: "VT-ORD-1790000000000-ABCD", replayed: true, loadOrder,
    });
    assert.equal(out.verified, false, label);
    assert.deepEqual(
      Object.keys(out.details).sort(),
      ["id", "orderNumber", "replayed", "verified"],
      `${label}: only server-returned identity, no checkout values`
    );
    assert.equal(out.details.verified, false);
    assert.equal(out.details.orderNumber, "VT-ORD-1790000000000-ABCD");
  }
});

test("a missing order id is unverified and never triggers a read", async () => {
  let called = false;
  const out = await loadAuthoritativeConfirmation({
    orderId: "", orderNumber: null, replayed: false, loadOrder: async () => { called = true; },
  });
  assert.equal(out.verified, false);
  assert.equal(called, false);
});

test("the builder never invents a price", () => {
  const d = buildConfirmationFromOrder({ ...STORED, subtotalCentavos: undefined, items: [{ inventoryId: "i", quantity: 1 }] });
  assert.equal(d.subtotalCentavos, null);
  assert.equal(d.items[0].unitPriceCentavos, null);
  assert.equal(d.items[0].lineTotalCentavos, null);
});

// ---------------------------------------------------------- the page itself
// It cannot be rendered here (React + Firebase), so these pin narrowly that it
// shows nothing it cannot verify.

const PAGE = readFileSync(new URL("../src/pages/salesRep/SalesRepOrderConfirmation.jsx", import.meta.url), "utf8");
const PLACE = readFileSync(new URL("../src/pages/salesRep/SalesRepPlaceOrder.jsx", import.meta.url), "utf8");

test("the confirmation page treats anything unverified as unverified", () => {
  assert.match(PAGE, /if \(!saved \|\| saved\.verified !== true\) \{/);
  assert.match(PAGE, /if \(!order\.verified\) \{/);
  assert.match(PAGE, /details could not be loaded/);
  assert.match(PAGE, /navigate\("\/sales-rep\/order-tracking"\)/);
});

test("the fabricated sample order and invented fees are gone", () => {
  for (const fake of ["fallbackOrder", "Makati Medical Center", "Vaxin-B Plus", "handlingFee", "urgentFee", "estimatedTotal"]) {
    assert.equal(PAGE.includes(fake), false, `${fake} must not appear`);
  }
  assert.match(PAGE, /formatCentavos\(order\.subtotalCentavos\)/, "the server's subtotal, in centavos");
});

test("a recovered order is labelled as recovered", () => {
  assert.match(PAGE, /order\.replayed \? "Order recovered" : "Order placed"/);
});

test("Place Order hands the confirmation only what the authoritative reload produced", () => {
  assert.match(PLACE, /loadAuthoritativeConfirmation\(\{[\s\S]*?loadOrder: getOrderById,/);
  assert.match(PLACE, /localStorage\.setItem\("latestSalesOrderDetails", JSON\.stringify\(confirmation\.details\)\)/);
  assert.equal(/confirmationPricing/.test(PLACE), false);
});
