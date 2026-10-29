import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  OUT_OF_STOCK_LABEL,
  REMOVAL_ACTIONS,
  REMOVAL_REASONS,
  describeAuditEvent,
  readRemovalCounters,
  removalSource,
  validateReasonText,
  validateStockRemoval,
  voidEligibility,
} from "../src/services/inventoryRemovalModel.js";
import { ELIGIBILITY_REASONS, evaluateBatchEligibility, reconcileCartLine } from "../src/services/orderEligibility.js";
import { liveCartLines, lineReview } from "../src/services/cartLiveStock.js";
import { callableError, createServiceLoader, createStore, installCallables, installStore } from "./serviceHarness.js";

// Admin inventory removal controls — the web side.
//
// The server (functions/src/inventoryRemoval.js) decides every action inside
// a transaction, and is tested against a real Firestore in
// functions/test/integration/inventoryRemoval.test.js; the rules that refuse
// direct client writes are in tests/firestore.rules.test.js (ALLOC6, REM1–5).
// What is proven here: the web's mirror of those decisions agrees with the
// server, voided batches and archived vaccines never reach new ordering, the
// service sends exactly what the callables accept, and no page can delete.

const server = createRequire(import.meta.url)("../functions/src/inventoryRemoval.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const TODAY = "2026-10-05";

test("inventory names render without icon tiles while status badges remain readable", () => {
  const css = read("src/pages/admin/Inventory.css");
  const page = read("src/pages/admin/Inventory.jsx");
  assert.doesNotMatch(page, /<div className="v2-vaccine-cell">\s*<span>/);
  assert.doesNotMatch(css, /\.v2-vaccine-cell > span\s*\{/);
  assert.match(css, /\.inventory-page \.inv-tag\s*\{[^}]*max-width: 100%;[^}]*white-space: normal;[^}]*overflow-wrap: break-word;[^}]*word-break: normal;/);
  for (const label of ["Voided", "Vaccine archived", "Inactive — long-empty stock"]) {
    assert.ok(page.includes(label), `${label} must stay visible as a status label`);
  }
});

const batch = (over = {}) => ({
  id: "inv1",
  vaccineId: "vacA",
  batchId: "LOT-1",
  status: "Stable",
  expiryDate: "2027-06-30",
  quantity: 10,
  reservedQuantity: 0,
  returnPendingQuantity: 0,
  quarantinedQuantity: 0,
  sellingPriceCentavos: 125000,
  priceIsVatInclusive: true,
  ...over,
});

// ---------------------------------------------------------------- model ↔ server

test("the web's reasons and actions are the server's", () => {
  assert.deepEqual([...REMOVAL_REASONS], [...server.REMOVAL_REASONS]);
  assert.deepEqual([...REMOVAL_ACTIONS], [...server.REMOVAL_ACTIONS]);
});

test("void eligibility agrees with the server's document check, case by case", () => {
  const cases = [
    batch({ usageTracked: true }),
    batch(),
    batch({ usageTracked: true, firstUsedAt: { seconds: 1 } }),
    batch({ usageTracked: true, reservedQuantity: 1 }),
    batch({ usageTracked: true, returnPendingQuantity: 2 }),
    batch({ usageTracked: true, quarantinedQuantity: 3 }),
    batch({ usageTracked: true, writtenOffQuantity: 4 }),
    batch({ usageTracked: true, reservedQuantity: "x" }),
  ];
  for (const b of cases) {
    const web = voidEligibility(removalSource(b));
    const srv = server.voidRefusal(b, b.id);
    assert.equal(web.ok, srv === null, JSON.stringify(b));
    if (srv) {
      assert.equal(web.code, srv.code);
      assert.equal(web.message, srv.message, "the Admin is shown the server's own sentence");
    }
  }
  assert.equal(voidEligibility(removalSource(batch({ voided: true }))).code, "batch-voided");
});

test("stock-removal checks agree with the server's plan on limits", () => {
  const b = batch({ quantity: 10, reservedQuantity: 4, returnPendingQuantity: 3, quarantinedQuantity: 1 });
  assert.deepEqual(readRemovalCounters(b), { onHand: 10, reserved: 4, returnPending: 3, quarantined: 1, writtenOff: 0, free: 2 });
  const now = new Date("2026-10-05T02:00:00Z");
  for (const [action, quantity] of [["quarantine", 2], ["quarantine", 3], ["dispose", 1], ["dispose", 2]]) {
    const web = validateStockRemoval({ action, quantity, reason: "damaged", notes: "", batch: b, expired: false });
    let srvOk = true;
    let srvMessage = null;
    try {
      server.planStockRemoval({ data: b, inventoryId: "inv1", action, quantity, reason: "damaged", now });
    } catch (e) {
      srvOk = false;
      srvMessage = e.message;
    }
    assert.equal(web.ok, srvOk, `${action} ${quantity}`);
    if (!srvOk) assert.equal(web.message, srvMessage, `${action} ${quantity}: same sentence`);
  }
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 1, reason: "expired", batch: b, expired: false }).field, "reason");
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 1, reason: "expired", batch: b, expired: true }).ok, true);
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 0, reason: "damaged", batch: b }).field, "quantity");
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 1, reason: "other", batch: b }).field, "reason");
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 1, reason: "damaged", batch: { ...b, voided: true } }).ok, false);
  assert.equal(validateStockRemoval({ action: "quarantine", quantity: 1, reason: "damaged", notes: "x".repeat(501), batch: b }).field, "notes");
  assert.equal(validateReasonText("ab", "reason").ok, false);
  assert.deepEqual(validateReasonText("  Entered twice ", "reason"), { ok: true, value: "Entered twice" });
});

test("removalSource copies the stored figures by value and nothing else", () => {
  const src = removalSource(batch({ usageTracked: true, writtenOffQuantity: 2, sellingPriceCentavos: 1 }));
  assert.deepEqual(Object.keys(src).sort(), [
    "firstUsedAt", "quantity", "quarantinedQuantity", "reservedQuantity", "returnPendingQuantity",
    "usageTracked", "voided", "writtenOffQuantity",
  ]);
  assert.equal(src.writtenOffQuantity, 2);
});

test("audit entries read as plain sentences", () => {
  assert.equal(describeAuditEvent({ action: "stock_quarantined", quantity: 3, reason: "recalled" }), "Quarantined 3 doses — recalled");
  assert.equal(describeAuditEvent({ action: "stock_disposed", quantity: 1, reason: "damaged" }), "Disposed of 1 dose — damaged");
  assert.equal(describeAuditEvent({ action: "batch_voided" }), "Batch voided");
  assert.equal(describeAuditEvent({ action: "something" }), "Inventory change");
});

// ---------------------------------------------------------------- new ordering

test("a voided batch and an archived vaccine are not orderable; the server's codes are used", () => {
  assert.equal(evaluateBatchEligibility(batch(), TODAY).eligible, true);
  const voided = evaluateBatchEligibility(batch({ voided: true }), TODAY);
  assert.deepEqual([voided.eligible, voided.reasonCode], [false, ELIGIBILITY_REASONS.BATCH_VOIDED]);
  assert.equal(ELIGIBILITY_REASONS.BATCH_VOIDED, "batch-voided");
  const archived = evaluateBatchEligibility(batch(), TODAY, { vaccine: { archived: true } });
  assert.deepEqual([archived.eligible, archived.reasonCode], [false, ELIGIBILITY_REASONS.VACCINE_ARCHIVED]);
  assert.equal(ELIGIBILITY_REASONS.VACCINE_ARCHIVED, "vaccine-archived");
  assert.equal(evaluateBatchEligibility(batch(), TODAY, { vaccine: { archived: false } }).eligible, true);
  // Zero available stays a valid (backordered) quote — shown as out of stock, never deleted.
  const empty = evaluateBatchEligibility(batch({ reservedQuantity: 10 }), TODAY);
  assert.deepEqual([empty.eligible, empty.availableQuantity, empty.backorderOnly], [true, 0, true]);
  assert.equal(OUT_OF_STOCK_LABEL, "Out of stock");
});

test("a cart line whose batch was voided or whose vaccine was archived must be removed", () => {
  const line = { inventoryId: "inv1", quantity: 2 };
  assert.equal(reconcileCartLine(line, batch({ voided: true }), TODAY).reasonCode, "batch-voided");
  assert.equal(reconcileCartLine(line, batch(), TODAY, { vaccine: { archived: true } }).reasonCode, "vaccine-archived");
  assert.equal(reconcileCartLine(line, batch(), TODAY).ok, true);

  const items = [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 125000, availableNow: 10 }];
  const archivedMap = new Map([["vacA", { id: "vacA", archived: true }]]);
  const [blocked] = liveCartLines(items, [batch()], TODAY, archivedMap);
  assert.ok(blocked.liveBlockedReason, "the archived product blocks the line");
  assert.equal(lineReview(blocked), "remove");
  const [fine] = liveCartLines(items, [batch()], TODAY, new Map([["vacA", { id: "vacA" }]]));
  assert.equal(lineReview(fine), null);
  const [stillFine] = liveCartLines(items, [batch()], TODAY);
  assert.equal(lineReview(stillFine), null, "without the catalog nothing is guessed");
});

test("Med Rep pages hide voided batches and archived vaccines from new ordering", () => {
  const request = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
  assert.match(request, /\.filter\(\(product\) => !product\.voided && !vaccinesById\.get\(product\.vaccineId\)\?\.archived\)/);
  assert.match(request, /\{ vaccine: batch \? vaccinesById\.get\(batch\.vaccineId\) \?\? null : null \}/);
  const place = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(place, /liveCartLines\(items, liveStock\.batches, liveStock\.todayIso, catalog\.byId\)/);
  const inventory = read("src/pages/salesRep/SalesRepInventory.jsx");
  assert.match(inventory, /raw\.filter\(\(item\) => item\.voided !== true\)/);
  assert.match(inventory, /stocks\.filter\(\(stock\) => !archivedIds\.has\(stock\.vaccineId\) && \(showInactive \|\| !inactiveIds\.has\(stock\.vaccineId\)\)\)/);
  assert.match(read("src/pages/admin/AddStock.jsx"), /docs\.filter\(\(v\) => v\.archived !== true\)/);
});

// ---------------------------------------------------------------- Admin page

test("Admin Inventory keeps voided batches as records and never deletes anything", () => {
  const page = read("src/pages/admin/Inventory.jsx");
  const dialogs = read("src/pages/admin/InventoryRemovalDialogs.jsx");
  for (const src of [page, dialogs]) {
    assert.equal(/deleteDoc|from ["']firebase\/firestore["']/.test(src), false, "no direct Firestore access, no delete");
  }
  assert.match(page, /stockBatches = useMemo\(\(\) => listedInventory\.filter\(\(i\) => !i\.voided\)/, "voided batches are not stock in the figures");
  assert.match(page, /showInactive \? inventory : inventory\.filter/, "inactive records remain accessible without restoring a manual archive");
  assert.match(page, /className="inv-tag inv-tag-voided"/, "but stay visible, tagged, in the table");
  assert.match(page, /item\.outOfStock && <small className="inv-out-of-stock">\{OUT_OF_STOCK_LABEL\}/);
  // Every destructive dialog explains its consequence before the action.
  assert.match(dialogs, /This cannot be undone/);
  assert.match(dialogs, /Existing orders, reservations, batches and history are kept/);
  assert.match(dialogs, /Reserved doses and returned doses awaiting a decision are not affected/);
  assert.match(dialogs, /I confirm these doses have been physically disposed of/);
});

// ---------------------------------------------------------------- service

const loader = createServiceLoader();
const svc = await loader.load("inventoryRemovalService.js");
const ADMIN = { uid: "admin1", email: "admin@vaxtrack.test" };

test("the service sends exactly the callable payloads and writes nothing itself", async () => {
  const store = installStore(createStore(), ADMIN);
  const calls = installCallables({
    setVaccineArchived: () => ({ vaccineId: "vacA", archived: true, replayed: false }),
    voidInventoryBatch: () => ({ inventoryId: "inv1", voided: true, replayed: false }),
    removeUnusableStock: () => ({ inventoryId: "inv1", action: "quarantine", quantity: 2, replayed: false }),
  });
  await svc.setVaccineArchived({ vaccineId: "vacA", archived: true, reason: "  Discontinued  " });
  await svc.setVaccineArchived({ vaccineId: "vacA", archived: false, reason: "   " });
  await svc.voidInventoryBatch({ inventoryId: "inv1", reason: " Entered twice " });
  await svc.removeUnusableStock({ requestId: "req_abcdefghijklmnop", inventoryId: "inv1", action: "quarantine", quantity: 2, reason: "damaged", notes: " " });
  await svc.removeUnusableStock({ inventoryId: "inv1", action: "dispose", quantity: 1, reason: "recalled", notes: "RN-14" });
  assert.deepEqual(calls.slice(0, 4), [
    { name: "setVaccineArchived", data: { vaccineId: "vacA", archived: true, reason: "Discontinued" } },
    { name: "setVaccineArchived", data: { vaccineId: "vacA", archived: false } },
    { name: "voidInventoryBatch", data: { inventoryId: "inv1", reason: "Entered twice" } },
    { name: "removeUnusableStock", data: { requestId: "req_abcdefghijklmnop", inventoryId: "inv1", action: "quarantine", quantity: 2, reason: "damaged" } },
  ]);
  assert.match(calls[4].data.requestId, /^[A-Za-z0-9_-]{16,64}$/, "a fresh request id the server accepts");
  assert.equal(calls[4].data.notes, "RN-14");
  assert.equal(store.writes.length, 0, "the client writes nothing to Firestore");
});

test("server refusals keep their code and sentence; an unreachable service says the outcome is unknown", async () => {
  installStore(createStore(), ADMIN);
  installCallables({
    voidInventoryBatch: () => {
      throw callableError("batch-usage-unproven", "This batch was added before VaxTrack recorded batch usage, so it cannot be proven unused and cannot be voided.");
    },
  });
  await assert.rejects(svc.voidInventoryBatch({ inventoryId: "inv1", reason: "Entered twice" }), (err) => {
    assert.ok(err instanceof svc.InventoryRemovalError);
    assert.equal(err.code, "batch-usage-unproven");
    assert.match(err.message, /cannot be proven unused/);
    return true;
  });
  installCallables({});
  await assert.rejects(svc.removeUnusableStock({ inventoryId: "inv1", action: "quarantine", quantity: 1, reason: "damaged" }), (err) => {
    assert.equal(err.code, "service-unavailable");
    assert.match(err.message, /may not have been saved/);
    return true;
  });
});
