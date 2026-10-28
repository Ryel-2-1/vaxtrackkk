import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { canCancelBeforeDeparture, potentiallyCancellable, createCancellationRequest, CANCELLATION_WARNING, REORDER_GUIDANCE } from "../src/services/preDepartureCancellation.js";
import { createServiceLoader, installCallables, callableError } from "./serviceHarness.js";
const require = createRequire(import.meta.url);
const server = require("../functions/src/preDepartureCancellation.js");
const contract = require("../functions/src/preDepartureCancellation.json");
const order = (patch = {}) => ({ id: "doc-id", orderNumber: "VT-ORD-123", createdByUid: "rep", status: "pending_dispatch",
  allocationVersion: 2, allocationStatus: "reserved", ...patch });

test("visibility uses approved identity and authoritative ownership, never labels/email", () => {
  const allows = (uid, role, status = "approved", target = order()) => canCancelBeforeDeparture({ uid, profile: { role, status }, order: target });
  assert.equal(allows("admin", "admin"), true);
  assert.equal(allows("rep", "salesrep"), true);
  assert.equal(allows("other", "salesrep"), false);
  for (const role of ["rider", "dispatcher", "unknown"]) assert.equal(allows("rep", role), false);
  for (const status of ["pending", "disabled", "rejected", null]) assert.equal(allows("admin", "admin", status), false);
  assert.equal(allows(null, "admin"), false);
  assert.equal(allows("rep", "salesrep", "approved", order({ createdByUid: null, salesRepId: "rep", email: "rep" })), false);
});

test("server and UI eligibility agree on valid and ambiguous custody across every state", () => {
  const samples = [null, order(), order({ allocationVersion: 1 }), order({ allocationVersion: undefined }),
    order({ allocationVersion: "2" }), order({ isLoaded: null }), order({ failureCount: "0" }),
    ...contract.custodyFields.flatMap((key) => [order({ [key]: null }), order({ [key]: "" }), order({ [key]: "evidence" })]),
  ];
  for (const status of ["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivery_failed", "delivered", "cancelled", "unknown"]) {
    for (const isLoaded of [undefined, false, true, null, "false"]) {
      samples.push(order({ status, isLoaded, assignedRiderId: "rider", dispatchTripId: "forming" }));
    }
  }
  for (const sample of samples) assert.equal(potentiallyCancellable(sample), server.potentiallyCancellable(sample), JSON.stringify(sample));
  assert.equal(potentiallyCancellable(order({ status: "assigned" })), false, "assignment without a known trip needs review");
  assert.equal(potentiallyCancellable(order({ status: "loading", isLoaded: false, assignedRiderId: "rider", dispatchTripId: "forming" })), true);
  assert.equal(potentiallyCancellable(order({ status: "loading", isLoaded: false, assignedRiderId: "rider", dispatchTripId: "forming", loadedByUid: "dispatcher" })), false);
});

test("invalid reasons never reach the callable; trimmed validated input does", async () => {
  const calls = [];
  const submit = createCancellationRequest(async (...args) => { calls.push(args); return { status: "cancelled" }; });
  for (const reason of ["", "  ", null, "x".repeat(501)]) await assert.rejects(submit("id", reason));
  await assert.rejects(submit("bad/id", "reason"));
  assert.deepEqual(calls, []);
  await submit("id", "  Doctor agreed  ");
  assert.deepEqual(calls, [["id", "Doctor agreed"]]);
});

test("duplicate clicks share one pending call; failures remain retryable and success requires confirmation", async () => {
  let finish; let count = 0;
  const submit = createCancellationRequest(() => { count++; return new Promise((resolve) => { finish = resolve; }); });
  const first = submit("id", "reason"); const second = submit("id", "reason");
  assert.equal(first, second); assert.equal(count, 1);
  finish({ status: "cancelled" }); await first;
  let attempts = 0;
  const failing = createCancellationRequest(async () => { if (++attempts === 1) throw new Error("offline"); return { status: "cancelled" }; });
  await assert.rejects(failing("id", "reason"));
  assert.equal((await failing("id", "reason")).status, "cancelled");
  await assert.rejects(createCancellationRequest(async () => ({}))("id", "reason"), /could not be confirmed/);
});

test("real callable wrapper sends only orderId/reason and preserves friendly domain failures", async () => {
  const svc = await createServiceLoader().load("inventoryCallables.js");
  const calls = installCallables({ cancelOrderWithInventoryRelease: async () => ({ status: "cancelled" }) });
  await svc.cancelOrderWithInventoryRelease("doc-id", "reason");
  assert.deepEqual(calls[0].data, { orderId: "doc-id", reason: "reason" });
  installCallables({ cancelOrderWithInventoryRelease: async () => { throw callableError("cancellation-not-eligible", "Loading was already confirmed. Refresh the order."); } });
  await assert.rejects(svc.cancelOrderWithInventoryRelease("doc-id", "reason"), (e) => e.code === "cancellation-not-eligible" && /Loading/.test(e.message));
  installCallables({ cancelOrderWithInventoryRelease: async () => { throw new Error("network"); } });
  await assert.rejects(svc.cancelOrderWithInventoryRelease("doc-id", "reason"), /Cancellation could not be confirmed/);
});

test("cancel UI uses the body portal, shared confirmation and manual reorder warning without cart mutation", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const ui = read("src/components/orders/OrderCancellationAction.jsx");
  assert.match(ui, /<DialogLayer scope=\{scope\}>/);
  assert.match(ui, /<ConfirmDialog/);
  assert.match(ui, /await submit.current\(order.id, reason\);\s*setSuccess/);
  assert.match(ui, /order.orderNumber \|\| "Order number unavailable"/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|setDoc|updateDoc|createOrderWithReservation|navigate\(/);
  assert.match(CANCELLATION_WARNING, /Other waiting orders may receive it/);
  assert.match(REORDER_GUIDANCE, /do not retain the original stock, price, priority or arrival preference/);
  for (const page of ["admin/Deliveries", "salesRep/SalesRepOrderTracking"]) assert.match(read(`src/pages/${page}.jsx`), /<OrderCancellationAction/);
});
