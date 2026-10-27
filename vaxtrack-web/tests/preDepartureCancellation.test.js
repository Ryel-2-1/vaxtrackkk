import test from "node:test";
import assert from "node:assert/strict";
import { canCancelBeforeDeparture, createCancellationRequest } from "../src/services/preDepartureCancellation.js";
import { createServiceLoader, installCallables, callableError } from "./serviceHarness.js";

const order = (changes = {}) => ({ id: "order-doc", orderNumber: "VT-ORD-123", createdByUid: "rep",
  status: "pending_dispatch", allocationVersion: 2, allocationStatus: "reserved", ...changes });
const allowed = (uid, role, target = order(), status = "approved") =>
  canCancelBeforeDeparture({ uid, profile: { role, status }, order: target });

test("only approved Admin or the owning Med Rep see pre-departure cancellation", () => {
  assert.equal(allowed("admin", "admin"), true);
  assert.equal(allowed("rep", "salesrep"), true);
  assert.equal(allowed("other", "salesrep"), false);
  assert.equal(allowed(null, "admin"), false);
  for (const role of ["rider", "dispatcher", "unknown"]) assert.equal(allowed("rep", role), false);
  for (const status of ["pending", "disabled", "rejected", null]) assert.equal(allowed("admin", "admin", order(), status), false);
  assert.equal(allowed("rep", "salesrep", order({ createdByUid: null, salesRepId: "rep" })), false);
});

test("handled, departed and ambiguous orders stay unavailable even after unticking", () => {
  const forming = { status: "loading", isLoaded: false, assignedRiderId: "rider", dispatchTripId: "trip" };
  assert.equal(allowed("rep", "salesrep", order(forming)), true);
  for (const change of [{ loadedByUid: "disp" }, { loadedAt: new Date() }, { dispatchedAt: new Date() },
    { isLoaded: true }, { isLoaded: null }, { failureCount: 1 }, { allocationVersion: undefined },
    { dispatchTripId: null }, { status: "in_transit" }, { status: "delayed" }, { status: "delivery_failed" },
    { status: "delivered" }, { status: "cancelled" }]) {
    assert.equal(allowed("admin", "admin", order({ ...forming, ...change })), false, JSON.stringify(change));
  }
});

test("a required bounded reason is trimmed before the cancellation request", async () => {
  const calls = [];
  const submit = createCancellationRequest(async (...args) => { calls.push(args); return { status: "cancelled" }; });
  for (const reason of [null, "", "  ", "x".repeat(501)]) await assert.rejects(submit("order-doc", reason));
  await assert.rejects(submit("bad/id", "reason"));
  assert.deepEqual(calls, []);
  await submit("order-doc", "  Doctor agreed to available items  ");
  assert.deepEqual(calls, [["order-doc", "Doctor agreed to available items"]]);
});

test("duplicate submissions share one request; a failure permits a deliberate retry", async () => {
  let complete; let calls = 0;
  const submit = createCancellationRequest(() => { calls++; return new Promise((resolve) => { complete = resolve; }); });
  const first = submit("order-doc", "reason");
  assert.equal(submit("order-doc", "reason"), first);
  assert.equal(calls, 1);
  complete({ status: "cancelled" }); await first;
  let attempts = 0;
  const retry = createCancellationRequest(async () => { if (++attempts === 1) throw new Error("offline"); return { status: "cancelled" }; });
  await assert.rejects(retry("order-doc", "reason"));
  assert.equal((await retry("order-doc", "reason")).status, "cancelled");
  await assert.rejects(createCancellationRequest(async () => ({}))("order-doc", "reason"), /could not be confirmed/);
});

test("the real callable sends only the order and reason and preserves the server refusal", async () => {
  const service = await createServiceLoader().load("inventoryCallables.js");
  const calls = installCallables({ cancelOrderWithInventoryRelease: async () => ({ status: "cancelled" }) });
  await service.cancelOrderWithInventoryRelease("order-doc", "reason");
  assert.deepEqual(calls[0].data, { orderId: "order-doc", reason: "reason" });
  installCallables({ cancelOrderWithInventoryRelease: async () => { throw callableError("cancellation-not-eligible", "Loading was confirmed. Refresh the order."); } });
  await assert.rejects(service.cancelOrderWithInventoryRelease("order-doc", "reason"), (error) => error.code === "cancellation-not-eligible");
  installCallables({ cancelOrderWithInventoryRelease: async () => { throw new Error("offline"); } });
  await assert.rejects(service.cancelOrderWithInventoryRelease("order-doc", "reason"), /Cancellation could not be confirmed/);
});
