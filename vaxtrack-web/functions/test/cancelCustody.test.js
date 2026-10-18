"use strict";

/**
 * Which cancellations hold the order's vials for Admin inspection instead of
 * releasing them (functions/src/policy.js cancellationReturnsForInspection),
 * and that the deployed callable cannot be steered by the request. The stock
 * outcome itself is proven against the emulator in
 * test/integration/cancelAfterDispatch.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Timestamp } = require("firebase-admin/firestore");
const { cancellationReturnsForInspection, RETURN_ON_CANCEL_FROM, CANCELLABLE_FROM } = require("../src/policy");

test("custody follows the stored status and the Cargo Loading confirmation", () => {
  const at = Timestamp.fromDate(new Date("2026-10-04T23:00:00Z"));
  const audit = { loadedAt: at, loadedByUid: "disp1" };
  const cases = [
    // The loading audit outlives an untick: ever confirmed = handled.
    [{ status: "loading", isLoaded: false, ...audit }, true],
    [{ status: "loading", ...audit }, true],
    [{ status: "loading", isLoaded: true, ...audit }, true],
    [{ status: "loading", isLoaded: false, loadedAt: new Date("2026-10-04T23:00:00Z"), loadedByUid: "disp1" }, true],
    // Incomplete or invalid audits are not custody.
    [{ status: "loading", isLoaded: false, loadedAt: at }, false],
    [{ status: "loading", isLoaded: false, loadedByUid: "disp1" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: null, loadedByUid: null }, false],
    [{ status: "loading", isLoaded: false, loadedAt: "2026-10-04", loadedByUid: "disp1" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: at, loadedByUid: "" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: at, loadedByUid: 7 }, false],
    [{ status: "loading", isLoaded: false, loadedAt: new Date("not a date"), loadedByUid: "disp1" }, false],
    // Assigned and Pending Dispatch release, audit or not.
    [{ status: "assigned", ...audit }, false],
    [{ status: "pending_dispatch", isLoaded: true, ...audit }, false],
    [{ status: "pending_dispatch" }, false],
    [{ status: "assigned" }, false],
    [{ status: "assigned", isLoaded: true }, false],
    [{ status: "loading" }, false],
    [{ status: "loading", isLoaded: false }, false],
    [{ status: "loading", isLoaded: null }, false],
    [{ status: "loading", isLoaded: "true" }, false],
    [{ status: "loading", isLoaded: 1 }, false],
    [{ status: "loading", isLoaded: true }, true],
    [{ status: "in_transit" }, true],
    [{ status: "in_transit", isLoaded: false }, true],
    [{ status: "delayed" }, true],
    [{ status: "delivery_failed", isLoaded: true }, false],
    [null, false],
  ];
  for (const [order, expected] of cases) {
    assert.equal(cancellationReturnsForInspection(order), expected, JSON.stringify(order));
  }
  assert.deepEqual(RETURN_ON_CANCEL_FROM, ["in_transit", "delayed"]);
  for (const s of RETURN_ON_CANCEL_FROM) assert.ok(CANCELLABLE_FROM.includes(s), s);
});

test("the cancel callable takes only the order id and the reason from the request", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  const call = /exports\.cancelOrderWithInventoryRelease = callable\([\s\S]*?\n\);/.exec(index)[0];
  const fromRequest = [...call.matchAll(/data\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromRequest, ["orderId", "reason"], "no loaded flag (or anything else) is read from the request");
  assert.equal(/\.\.\.data\b/.test(call), false, "the request is never spread into the operation");

  // The operation decides custody from the order it read in its transaction.
  const ops = fs.readFileSync(path.join(__dirname, "..", "src", "operations.js"), "utf8").replace(/\r\n/g, "\n");
  const cancelTx = ops.slice(ops.indexOf("async function cancelOrderTransaction("), ops.indexOf("const NOT_COMPLETABLE_MESSAGE"));
  assert.match(cancelTx, /const order = orderSnap\.data\(\);/);
  assert.match(cancelTx, /cancellationReturnsForInspection\(order\)/);
});
