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
  // A dispatcher-only destination correction changes an order's address and audit, not stock.
  "correctOrderDestination",
  "requestOrderDestinationChange",
  "reviewOrderDestinationChange",
  // Invoice pricing. Each names one business action on one order's invoice.
  "saveInvoiceDraftForPricedOrder",
  "issueInvoiceForPricedOrder",
  // Admin-only delivery reschedule: date/time + history, never stock or price.
  "rescheduleOrderDelivery",
  // Future-order allocation and failed-delivery returns. Each is one named
  // business action, role-checked on the server (functions/src/inventoryWorkflow.js).
  "addStockBatchWithAllocation", // Admin: add a batch + reserve it for waiting orders
  "reportDeliveryFailure", // Rider: reserved units → return-pending
  "confirmReturnDisposition", // Admin: usable | damaged | temperature_excursion | missing
  "requeueFailedOrder", // Dispatcher: delivery_failed → pending_dispatch, re-enters allocation
  "getReservationProvenance", // Admin: read-only — which orders hold a batch's units
  // Rider: read-only delivery-geofence preflight before evidence upload. The
  // completion callable repeats the decision authoritatively.
  "validateDeliveryCompletionGeofence",
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
  // The other exports are triggers, callable by no one:
  //   recordOrderStatusEvent       status history (its module never names inventory)
  //   allocateOnInventoryWrite /
  //   allocateOnOrderWrite /
  //   continueAllocation           the same server allocator, which never sets
  //                                an order status
  //   settleClientReportedFailure  TEMPORARY rollout compatibility: settles a
  //                                failure written directly by an older Rider
  //                                build, through the same code as the callable
  //   materializeOrderHistory      records a new order's initial-allocation
  //                                history from its outbox marker (running the
  //                                same allocator first); never sets a status
  const NON_CALLABLE_EXPORTS = [
    "recordOrderStatusEvent",
    "allocateOnInventoryWrite",
    "allocateOnOrderWrite",
    "continueAllocation",
    "settleClientReportedFailure",
    "materializeOrderHistory",
    // Rider live tracking: route-deviation state, alerts, Med Rep visibility
    // and retention. They never name inventory and never write an order
    // (checked below).
    "trackRiderLocation",
    "trackNavigationSession",
    "syncRiderTrackingOnOrderWrite",
    "purgeRiderTrackingData",
  ];
  const exported = [...index.matchAll(/^exports\.(\w+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(
    exported.sort(),
    [...CALLABLE_NAMES, ...NON_CALLABLE_EXPORTS].sort(),
    "exactly these callables, plus the ten triggers / scheduled jobs"
  );
  assert.match(index, /exports\.materializeOrderHistory = onDocumentWritten\(\s*\{ document: "orderHistoryOutbox\/\{orderId\}", retry: true \}/);
  const outboxModule = read("functions/src/orderHistoryOutbox.js").replace(/^\s*(\*|\/\/).*$/gm, "");
  assert.doesNotMatch(outboxModule, /status:\s*"(pending_dispatch|assigned|loading|in_transit|delayed|delivered|cancelled|delivery_failed)"/,
    "the history trigger never writes an order status");
  assert.match(index, /exports\.continueAllocation = onDocumentWritten\(\s*\{ document: "allocationContinuations\/\{productKey\}", retry: true \}/);
  assert.match(index, /exports\.settleClientReportedFailure = onDocumentWritten\(\s*\{ document: "orders\/\{orderId\}", retry: true \}/);
  assert.match(index, /exports\.allocateOnInventoryWrite = onDocumentWritten\(\s*\{ document: "inventory\/\{inventoryId\}", retry: true \}/);
  assert.match(index, /exports\.allocateOnOrderWrite = onDocumentWritten\(\s*\{ document: "orders\/\{orderId\}", retry: true \}/);
  // The allocator moves reservations only: it never writes an order status,
  // so no trigger can advance (or regress) the delivery lifecycle.
  const allocator = read("functions/src/allocation.js").replace(/^\s*(\*|\/\/).*$/gm, "");
  // The only `status:` values it writes are the RESERVATION document's own
  // "reserved" and its continuation records' pending/done/stalled — never an
  // order's. Every order write it makes is the one tx.update in the round.
  const statuses = [...allocator.matchAll(/\bstatus:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(statuses, ['"reserved"', '"pending"', 'result.done ? "done" : "stalled"']);
  assert.match(allocator, /db\.collection\("inventoryReservations"\)\.doc\(u\.orderId\),\s*\{[^}]*status: "reserved"/);
  const orderWrites = allocator.match(/tx\.update\(db\.collection\("orders"\)[\s\S]*?\}\);/g) ?? [];
  assert.equal(orderWrites.length, 1);
  assert.equal(/\bstatus\b/.test(orderWrites[0]), false, "the allocator's order write has no status field");
  // The reschedule callable cannot move stock: its code never names inventory.
  // A new date does change the order's PLACE in the allocation queue, so it
  // recomputes the priority key — and touches no other allocation field.
  const schedule = read("functions/src/scheduleOperations.js").replace(/^\s*(\*|\/\/).*$/gm, "");
  assert.equal(/inventory|reservedQuantity|RESERVATIONS|Centavos/i.test(schedule), false);
  assert.deepEqual(
    [...new Set([...schedule.matchAll(/\b(allocation\w*)/gi)].map((m) => m[1]))].sort(),
    // The import (`ALLOCATION_VERSION_BACKORDER` from "./allocation") plus the
    // version check and the one key it writes.
    ["ALLOCATION_VERSION_BACKORDER", "allocation", "allocationPriorityKey", "allocationVersion"]
  );
  // Rider tracking cannot move stock or the lifecycle: neither module names
  // inventory, and it only ever READS orders.
  for (const file of ["functions/src/riderTracking.js", "functions/src/riderTrackingOps.js"]) {
    const code = read(file).replace(/^\s*(\*|\/\/).*$/gm, "");
    assert.equal(/inventory|reservedQuantity|RESERVATIONS|allocation/i.test(code), false, file);
    assert.equal(/(tx|batch)\.(set|update|delete)\(\s*(db\.collection\(C\.ORDERS\)|orderRef)/.test(code), false, `${file} never writes an order`);
  }
  assert.match(index, /exports\.recordOrderStatusEvent = onDocumentWritten\(/);
  const history = read("functions/src/statusEvents.js").replace(/^\s*(\*|\/\/).*$/gm, "");
  assert.equal(/inventory|reservedQuantity|RESERVATIONS|allocation/i.test(history), false);
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

  // The Rider app completes — and fails — a delivery through callables too.
  const deliveryService = read("../vaxtrack_mobile/lib/services/delivery_service.dart");
  assert.match(deliveryService, /markOrderDeliveredWithInventoryConsumption/);
  assert.match(deliveryService, /httpsCallable\('reportDeliveryFailure'\)/);
  assert.equal(/'status': 'delivery_failed'/.test(deliveryService), false, "no direct failure write");

  // Stock is added only through the allocating callable, and failed orders are
  // recovered only through the requeue callable.
  assert.match(read("src/pages/admin/AddStock.jsx"), /submit: addStockBatchWithAllocation/);
  assert.equal(/addDoc\(collection\(db, INVENTORY\)/.test(read("src/services/vaccineService.js")), false);
  assert.match(shipments, /requeueFailedOrder\(order\.id\)/);
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
  assert.deepEqual([...RESERVATION_STATUSES].sort(), ["consumed", "released", "reserved", "returned"]);

  // Only `reserved` is non-terminal for the units it held. The settled states
  // are final, which is what makes a repeated cancel, deliver or failure report
  // a no-op instead of a second movement of stock. `returned` means a failed
  // delivery moved the units to return-pending; an Admin disposition resolves
  // them, and a requeue starts a FRESH reservation for the order.
  const operations = read("functions/src/operations.js");
  assert.match(operations, /reservation\.status !== "reserved"/);
  assert.match(operations, /settlementType: "cancelled"/);
  assert.match(operations, /settlementType: "delivered"/);
  // The failed-delivery settlement lives in ONE module, used by the callable,
  // the compatibility trigger, requeue and cancel.
  const failure = read("functions/src/failureReturn.js");
  assert.match(failure, /status: "returned"/);
  assert.match(failure, /mode: "return"/);
  for (const user of ["functions/src/inventoryWorkflow.js", "functions/src/operations.js"]) {
    assert.match(read(user), /require\("\.\/failureReturn"\)/, `${user} uses the shared settlement`);
  }
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
  // Fields a page must never author. Deliberate exclusions:
  //   `sellingPriceCentavos` — Admin Inventory IS the price-management page,
  //     and hands that value to updateStockPrice for the rules to validate;
  //   `subtotalCentavos` — PlaceOrder relays the SERVER's figure into the
  //     confirmation payload, which is display state, not a write;
  //   `reservedQuantity` — handled separately below, because Admin Inventory is
  //     now allowed to READ it as a stock-correction validation input.
  // No page can reach Firestore directly anyway; that is asserted per page.
  const alwaysForbidden = ["pricingVersion", "pricedAt", "allocationStatus"];
  // Anchored to a real property-key position (start of line, `{` or `,`), so a
  // ternary like `? raw.reservedQuantity : 0` is not mistaken for a write.
  const keyOf = (field) => new RegExp(`(^|[{,])\\s*${field}\\s*:`, "m");

  for (const page of [
    "src/pages/salesRep/SalesRepPlaceOrder.jsx",
    "src/pages/salesRep/SalesRepRequestOrder.jsx",
    "src/pages/admin/Inventory.jsx",
  ]) {
    const src = read(page);
    for (const field of alwaysForbidden) {
      assert.equal(
        keyOf(field).test(src),
        false,
        `${page} must not write ${field} — that belongs to the callable or the service`
      );
    }
    // And no page talks to Firestore directly about stock. Admin Inventory
    // re-prices / corrects through vaccineService, so the validation and the
    // audit fields live in one place rather than being re-implemented per page.
    assert.equal(
      /from ["']firebase\/firestore["']/.test(src),
      false,
      `${page} must reach Firestore through a service, not the SDK directly`
    );
  }

  // `reservedQuantity` is a settlement counter no page may AUTHOR — it moves
  // only inside the callable's reservation/consumption transaction. Admin
  // Inventory is allowed to READ it as the validation input to a stock
  // correction (a correction may never drop on-hand below what is reserved),
  // but must never WRITE it. Verified precisely, not by a blunt key match that
  // the read-only validation argument would otherwise trip.
  const RESERVED = "reservedQuantity";
  const reservedKey = keyOf(RESERVED);

  // The Sales Rep pages have no legitimate reason to name it as a key at all.
  for (const page of [
    "src/pages/salesRep/SalesRepPlaceOrder.jsx",
    "src/pages/salesRep/SalesRepRequestOrder.jsx",
  ]) {
    assert.equal(reservedKey.test(read(page)), false, `${page} must not write ${RESERVED}`);
  }

  // Admin Inventory: the ONLY permitted key-position use is the read passed to
  // validateStockCorrection. Blank that call out, and no reservedQuantity key
  // may remain anywhere else in the file.
  const inventory = read("src/pages/admin/Inventory.jsx");
  const withoutValidationInput = inventory.replace(
    /validateStockCorrection\(\{[\s\S]*?\}\)/g,
    "validateStockCorrection({})"
  );
  assert.equal(
    reservedKey.test(withoutValidationInput),
    false,
    "Inventory.jsx may read reservedQuantity only as a validation input, never write it"
  );

  // And the actual correction WRITE must not send reservedQuantity — the
  // service writes quantity + audit only, leaving the reserved counter alone.
  const correctionWrite = /correctStockQuantity\(\{[\s\S]*?\}\)/.exec(inventory);
  assert.ok(correctionWrite, "Inventory.jsx must save corrections through correctStockQuantity");
  assert.equal(
    new RegExp(RESERVED).test(correctionWrite[0]),
    false,
    "the correctStockQuantity write must not include reservedQuantity"
  );
});

test("the VAT convention is recorded on the order, not inferred", () => {
  const policy = read("functions/src/policy.js");
  const ops = read("functions/src/operations.js");
  // Confirmed client rule: prices are VAT-inclusive — taken from the one
  // pricing configuration, never restated.
  assert.match(policy, /PRICE_IS_VAT_INCLUSIVE\s*=\s*require\("\.\/pricingConfig"\)\.PRICES_INCLUDE_VAT/);
  assert.match(read("functions/src/pricingConfig.js"), /const PRICES_INCLUDE_VAT = true;/);
  assert.match(policy, /PRICE_CURRENCY\s*=\s*"PHP"/);
  // Both are written onto every priced order, so a reader never has to deduce
  // which convention applied.
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

test("the confirmation shows the server's stored money, never a client figure", () => {
  // The confirmation is now built from the stored order the callable named
  // (services/orderConfirmation.js), re-read after the commit — so its money is
  // the server-written centavos, and a replayed order can never be shown with
  // values edited after the original attempt.
  //
  // The old handoff merged a hardcoded sample order underneath, so every real
  // confirmation also showed a ₱150 "handling fee" and a ₱16,850 "estimated
  // total" nothing had charged. Those must not return.
  const place = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  const confirmation = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  const builder = read("src/services/orderConfirmation.js");

  assert.match(place, /loadAuthoritativeConfirmation\(\{[\s\S]*?loadOrder: getOrderById,/);
  assert.match(builder, /subtotalCentavos: typeof order\.subtotalCentavos === "number"/);
  assert.equal(/expectedUnitPriceCentavos/.test(builder), false, "never the client's expectation");
  assert.match(confirmation, /formatCentavos\(order\.subtotalCentavos\)/);
  for (const invented of ["handlingFee", "estimatedTotal", "fallbackOrder"]) {
    assert.equal(confirmation.includes(invented), false, `${invented} must not return`);
  }
});
