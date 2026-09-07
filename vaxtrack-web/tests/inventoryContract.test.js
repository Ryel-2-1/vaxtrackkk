import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The inventory boundary, asserted structurally.
 *
 * Three operations move stock — creating an order (reserve), cancelling one
 * (release) and delivering one (consume) — and each has to change several
 * documents together. They now run inside trusted callable Cloud Functions.
 * These tests pin the SHAPE of that boundary: which module owns each operation,
 * that no page reaches around it, and that the client and the server agree on
 * the constants they both depend on.
 *
 * Behaviour is covered elsewhere: functions/test (policy + emulator
 * transactions) and tests/firestore.rules.test.js (the direct-write lockdown).
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const CALLABLE_NAMES = [
  "createOrderWithReservation",
  "cancelOrderWithInventoryRelease",
  "markOrderDeliveredWithInventoryConsumption",
  // Invoice pricing. Each names one business action on one order's invoice.
  "saveInvoiceDraftForPricedOrder",
  "issueInvoiceForPricedOrder",
];

test("the callables are the only inventory-affecting entry points", () => {
  const index = read("functions/index.js");
  for (const name of CALLABLE_NAMES) {
    assert.match(index, new RegExp(`exports\\.${name}\\s*=`), `${name} must be exported`);
  }
  // No generic escape hatch. A "update any status" or "adjust inventory"
  // callable would hand the lifecycle straight back to the caller.
  for (const forbidden of [
    "updateOrderStatus", "adjustInventory", "setInventoryQuantity", "updateStatus",
    // A generic invoice mutation entry point would hand the pricing straight
    // back to the caller, which is the whole thing this boundary removes.
    "updateInvoice", "saveInvoice", "writeInvoice", "setInvoice", "mutateInvoice",
  ]) {
    // Anchored to the whole export name: `saveInvoiceDraftForPricedOrder` must
    // not trip a substring check for `saveInvoice`.
    assert.equal(
      new RegExp(`exports\\.${forbidden}\\s*=`).test(index),
      false,
      `must not export ${forbidden}`
    );
  }
  const exported = [...index.matchAll(/^exports\.(\w+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), [...CALLABLE_NAMES].sort(), "exactly these five callables");
});

test("no page reaches around the boundary", () => {
  // The Sales Rep checkout and the Dispatcher cancel dialog must go through
  // the callable wrapper, not the old direct-write services.
  const placeOrder = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(placeOrder, /createOrderWithReservation/);
  assert.equal(placeOrder.includes("createSalesRepOrder"), false);

  const shipments = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(shipments, /cancelOrderWithInventoryRelease/);
  assert.equal(shipments.includes("cancelOrderByDispatcher"), false);

  // The Rider app completes a delivery through the callable too.
  const deliveryService = read("../vaxtrack_mobile/lib/services/delivery_service.dart");
  assert.match(deliveryService, /markOrderDeliveredWithInventoryConsumption/);
  assert.match(deliveryService, /httpsCallable/);
});

test("proof submission still does not touch order status", () => {
  // Unchanged by this checkpoint, and worth re-asserting: proof and completion
  // remain separate acts, and proof is still not required to deliver.
  const proofService = read("../vaxtrack_mobile/lib/services/proof_service.dart");
  // It READS the order's status to decide whether proof may be attached; what
  // it must never do is write one. A written field is `'status': …` inside an
  // update map, which is what this looks for.
  assert.equal(
    /'status'\s*:/.test(proofService),
    false,
    "proof service must not write a status field"
  );
  assert.match(proofService, /Status is deliberately NOT touched/);
});

test("the region is the same on every side", () => {
  // A mismatch fails only at call time, in production, so it is pinned here.
  const region = "asia-southeast1";
  assert.match(read("functions/index.js"), new RegExp(`region: "${region}"`));
  assert.match(read("src/services/inventoryCallables.js"), new RegExp(`"${region}"`));
  assert.match(read("../vaxtrack_mobile/lib/services/delivery_service.dart"), new RegExp(`'${region}'`));
});

test("client and server agree on the derived-availability rule", () => {
  // `availableQuantity` must never be persisted anywhere: it is the one total
  // that could drift with nothing able to enforce it.
  for (const file of [
    "functions/src/policy.js",
    "functions/src/operations.js",
    "src/services/inventoryCallables.js",
  ]) {
    // A WRITTEN field is `availableQuantity:` in an object literal. Prose
    // about why it is not stored is exactly what these files should contain.
    assert.equal(
      /availableQuantity\s*:/.test(read(file)),
      false,
      `${file} must not persist availableQuantity`
    );
  }
});

test("the reservation state machine is exhaustive and terminal", async () => {
  const { RESERVATION_STATUSES } = await import("../functions/src/policy.js");
  assert.deepEqual([...RESERVATION_STATUSES].sort(), ["consumed", "released", "reserved"]);

  // Only `reserved` is non-terminal. Both settled states are final, which is
  // what makes a repeated cancel or deliver a no-op instead of a second
  // movement of stock.
  const operations = read("functions/src/operations.js");
  assert.match(operations, /reservation\.status !== "reserved"/);
  assert.match(operations, /settlementType: "cancelled"/);
  assert.match(operations, /settlementType: "delivered"/);
});

test("legacy orders are detected only by the version stamp", async () => {
  const { isLegacyOrder, ALLOCATION_VERSION } = await import("../functions/src/policy.js");
  assert.equal(ALLOCATION_VERSION, 1);
  // Never by item name, sku, batch text or shape — those are guesses.
  assert.equal(isLegacyOrder({ items: [{ sku: "MOD-STG-001", name: "Moderna" }] }), true);
  assert.equal(isLegacyOrder({ allocationVersion: 1 }), false);

  const policy = read("functions/src/policy.js");
  assert.match(policy, /allocationVersion !== ALLOCATION_VERSION/);
});

test("the recipient-name and reason bounds still match across the stack", async () => {
  const { MAX_REASON_LENGTH } = await import("../functions/src/policy.js");
  assert.equal(MAX_REASON_LENGTH, 500);
  assert.match(read("firestore.rules"), /maxReasonLength\(\)\s*\{\s*return 500;/);
  assert.match(read("../vaxtrack_mobile/lib/utils/order_workflow.dart"), /kMaxReasonLength = 500/);
});

test("the migration planner cannot write", () => {
  // Restated here as a cross-cutting contract: the preview is a planner, and a
  // module that CAN write is one flag away from writing.
  const source = read("functions/src/migrationPreview.js");
  for (const token of ["require(", "firebase-admin", ".set(", ".update(", ".commit(", "runTransaction"]) {
    assert.equal(source.includes(token), false, `migration preview must not contain ${token}`);
  }
});

// ---------------------------------------------------------------- pricing
//
// Prices are now read from the batch inside the reservation transaction. These
// pin the SHAPE of that: that the constants agree across the stack, that no
// caller-supplied price is accepted anywhere, and that no page writes one.

test("no invented price ceiling exists on either side", () => {
  // An earlier draft capped a unit price at ₱100,000. Nobody approved that
  // figure, and a made-up limit is a business rule smuggled in as validation.
  // What both sides enforce instead is arithmetic exactness.
  const policy = read("functions/src/policy.js");
  const money = read("src/services/money.js");
  for (const [name, src] of [["policy", policy], ["money", money]]) {
    assert.equal(
      /MAX_UNIT_PRICE_CENTAVOS\s*=\s*\d/.test(src),
      false,
      `${name} must not declare a maximum price`
    );
    assert.match(src, /isSafeInteger/, `${name} must enforce exact representability`);
  }
  // The rules bound is MAX_SAFE_INTEGER exactly, not a chosen price.
  assert.match(read("firestore.rules"), /maxSafeInteger\(\)\s*\{\s*return 9007199254740991;/);
});

test("no caller-supplied price is accepted by the boundary", () => {
  const policy = read("functions/src/policy.js");
  // `unitPrice` was the old caller-supplied field. It must no longer appear in
  // the accepted line keys at all — being absent is what makes a stale client
  // fail loudly with `unknown-field` instead of appearing to set a price.
  const allowed = /ALLOWED_LINE_KEYS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(policy);
  assert.ok(allowed, "the line allowlist must exist");
  assert.equal(allowed[1].includes("unitPrice\""), false, "`unitPrice` must not be accepted");
  assert.match(allowed[1], /expectedUnitPriceCentavos/, "only the EXPECTED price is accepted");

  // And the client must not send one either.
  const callables = read("src/services/inventoryCallables.js");
  assert.equal(
    /unitPrice\s*:/.test(callables),
    false,
    "the client must not put a unitPrice on the wire"
  );
  assert.match(callables, /expectedUnitPriceCentavos/);
});

test("the order's stored price comes from the batch, not the payload", () => {
  const ops = read("functions/src/operations.js");
  // The old line was `unitPrice: Number(items[index].unitPrice) || 0` — a value
  // taken straight off the request. Nothing may index the caller's items for a
  // price again.
  assert.equal(
    /items\[index\]\.unitPrice/.test(ops),
    false,
    "the stored price must never be read from the caller's payload"
  );
  assert.match(ops, /unitPriceCentavos:\s*e\.unitPriceCentavos/, "taken from the evaluated batch");
  assert.match(ops, /lineTotalCentavos:\s*e\.lineTotalCentavos/, "line total is server-computed");
  assert.match(ops, /subtotalCentavos\s*=\s*sumLineTotalsCentavos\(evaluated\)/);
});

test("no page writes a price onto an order or a batch counter", () => {
  for (const page of [
    "src/pages/salesRep/SalesRepPlaceOrder.jsx",
    "src/pages/salesRep/SalesRepRequestOrder.jsx",
    "src/pages/admin/Inventory.jsx",
  ]) {
    const src = read(page);
    // Matches the field used as an OBJECT KEY, which is what a write looks
    // like. Reading one, or deriving a local figure to show on screen, is fine
    // — PlaceOrder deliberately computes a `subtotalCentavos` estimate.
    // Fields a page must never author. Two deliberate exclusions:
    //   `sellingPriceCentavos` — Admin Inventory IS the price-management page,
    //     and hands that value to updateStockPrice for the rules to validate;
    //   `subtotalCentavos` — PlaceOrder relays the SERVER's figure into the
    //     confirmation payload, which is display state, not a write.
    // Neither page can reach Firestore directly anyway; that is asserted below.
    for (const field of [
      "pricingVersion", "pricedAt", "reservedQuantity", "allocationStatus",
    ]) {
      // Anchored to a real property-key position (start of line, `{` or `,`),
      // so a ternary like `? raw.reservedQuantity : 0` is not mistaken for one.
      assert.equal(
        new RegExp(`(^|[{,])\\s*${field}\\s*:`, "m").test(src),
        false,
        `${page} must not write ${field} — that belongs to the callable or the service`
      );
    }
    // And no page talks to Firestore directly about stock. Admin Inventory
    // re-prices through vaccineService, so the validation and the audit fields
    // live in one place rather than being re-implemented per page.
    assert.equal(
      /from ["']firebase\/firestore["']/.test(src),
      false,
      `${page} must reach Firestore through a service, not the SDK directly`
    );
  }
});

test("the VAT convention is recorded on the order, not inferred", () => {
  const policy = read("functions/src/policy.js");
  const ops = read("functions/src/operations.js");
  assert.match(policy, /PRICE_IS_VAT_INCLUSIVE\s*=\s*false/);
  assert.match(policy, /PRICE_CURRENCY\s*=\s*"PHP"/);
  // Both are written onto every priced order, so a reader never has to deduce
  // the convention from the fact that the invoice happens to apply 12%.
  assert.match(ops, /priceCurrency:\s*PRICE_CURRENCY/);
  assert.match(ops, /priceIsVatInclusive:\s*PRICE_IS_VAT_INCLUSIVE/);
});

test("pricing fields are server-only in the rules", () => {
  const rules = read("firestore.rules");
  const block = /function serverOnlyOrderFields\(\)\s*{([\s\S]*?)}/.exec(rules);
  assert.ok(block, "the server-only field list must exist");
  for (const field of [
    "pricingVersion", "priceCurrency", "priceIsVatInclusive",
    "subtotalCentavos", "subtotal", "pricedAt",
  ]) {
    assert.match(block[1], new RegExp(`'${field}'`), `${field} must be server-only`);
  }
  // And a new batch cannot be created unpriced.
  assert.match(rules, /d\.sellingPriceCentavos is int/);
  assert.match(rules, /d\.sellingPriceCentavos > 0/);
});

test("the confirmation handoff still carries a peso price per line", () => {
  // Regression guard. The cart line carries `expectedUnitPriceCentavos` rather
  // than `unitPrice`, and SalesRepOrderConfirmation bills from
  // `item.unitPrice` — so the handoff must supply one, or every line on the
  // confirmation screen silently reads ₱0.00.
  //
  // WHERE that peso price comes from is the stricter contract, and lives in
  // tests/invoiceContract.test.js: it must be derived from the price the
  // CALLABLE returned, never from the client's own expectation.
  const place = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  const confirmation = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");

  assert.match(
    confirmation,
    /Number\(item\.unitPrice\s*\|\|\s*0\)/,
    "the confirmation screen still bills from a peso unitPrice"
  );
  assert.match(
    place,
    /unitPrice: centavosToPesos\(line\.unitPriceCentavos\)/,
    "the handoff must derive that peso price from the server's returned centavos"
  );
});
