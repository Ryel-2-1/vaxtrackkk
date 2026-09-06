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
];

test("the callables are the only inventory-affecting entry points", () => {
  const index = read("functions/index.js");
  for (const name of CALLABLE_NAMES) {
    assert.match(index, new RegExp(`exports\\.${name}\\s*=`), `${name} must be exported`);
  }
  // No generic escape hatch. A "update any status" or "adjust inventory"
  // callable would hand the lifecycle straight back to the caller.
  for (const forbidden of ["updateOrderStatus", "adjustInventory", "setInventoryQuantity", "updateStatus"]) {
    assert.equal(index.includes(`exports.${forbidden}`), false, `must not export ${forbidden}`);
  }
  const exported = [...index.matchAll(/^exports\.(\w+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), [...CALLABLE_NAMES].sort(), "exactly three callables");
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
