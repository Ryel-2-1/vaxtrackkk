import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  SPLIT_OUTCOMES,
  evaluateSplit,
  returnBatches,
  returnReason,
  returnSourceLabel,
  splitTotals,
} from "../src/services/returnSplit.js";
import { cancelStockEffect } from "../src/services/cancelStockEffect.js";
import { hasLoadingAudit, loadingCustodyConfirmed } from "../src/services/loadingCustody.js";

/**
 * Cancelling an order whose vials are with the Rider: the web side.
 * The server behaviour itself is proven against the emulator in
 * functions/test/integration/cancelAfterDispatch.test.js.
 */

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const server = require("../functions/src/policy.js");
const workflow = require("../functions/src/inventoryWorkflow.js");

const twoBatches = {
  items: [
    { inventoryId: "early", batchId: "B-EARLY", productKey: "vacP", quantity: 5 },
    { inventoryId: "later", batchId: "B-LATER", productKey: "vacP", quantity: 3 },
  ],
};

// ---------------------------------------------------------------- cancel wording

test("the cancel dialog explains a physical return exactly where the server makes one", () => {
  assert.deepEqual(server.RETURN_ON_CANCEL_FROM, ["in_transit", "delayed"]);
  for (const status of server.RETURN_ON_CANCEL_FROM) {
    assert.match(cancelStockEffect(status), /with the rider/, status);
    assert.match(cancelStockEffect(status), /held as a return until an Admin checks them/, status);
    assert.match(cancelStockEffect(status), /do not go back into available stock automatically/, status);
  }
  for (const status of ["pending_dispatch", "assigned"]) {
    assert.equal(cancelStockEffect(status), "Its reserved stock is released for other orders.", status);
  }
  // Loading: the Cargo Loading confirmation is the custody boundary
  // (server: cancellationReturnsForInspection, from the stored order).
  assert.match(cancelStockEffect("loading", true), /confirmed as loaded/);
  assert.match(cancelStockEffect("loading", true), /held as a return until an Admin inspects them/);
  assert.match(cancelStockEffect("loading", true), /do not go back into available stock automatically/);
  for (const loaded of [false, undefined]) {
    assert.match(cancelStockEffect("loading", loaded), /reservation is released for other orders straight away/, String(loaded));
  }
  const at = { toMillis: () => Date.parse("2026-01-01T00:30:00Z") };
  const audit = { loadedAt: at, loadedByUid: "disp1" };
  for (const [order, expected] of [
    [{ status: "loading", isLoaded: true }, true],
    [{ status: "loading", isLoaded: true, ...audit }, true],
    [{ status: "loading", isLoaded: false, ...audit }, true],
    [{ status: "loading", ...audit }, true],
    [{ status: "loading", isLoaded: false }, false],
    [{ status: "loading" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: at }, false],
    [{ status: "loading", isLoaded: false, loadedByUid: "disp1" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: null, loadedByUid: null }, false],
    [{ status: "loading", isLoaded: false, loadedAt: "2026-01-01", loadedByUid: "disp1" }, false],
    [{ status: "loading", isLoaded: false, loadedAt: at, loadedByUid: "" }, false],
    [{ status: "assigned", isLoaded: true }, false],
    [{ status: "assigned", ...audit }, false],
  ]) {
    assert.equal(server.cancellationReturnsForInspection(order), expected, JSON.stringify(order));
    // The web helper and the server helper agree on every row.
    assert.equal(loadingCustodyConfirmed(order), server.loadingCustodyConfirmed(order), JSON.stringify(order));
    assert.equal(hasLoadingAudit(order), server.hasLoadingAudit(order), JSON.stringify(order));
    assert.equal(/held as a return/.test(cancelStockEffect(order.status, loadingCustodyConfirmed(order))), expected, "wording matches the server");
  }
});

test("the dialog keeps its irreversible warning and adds the stock sentence; the toast names the return", () => {
  const page = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(page, /be cancelled\. This cannot be undone\. \{cancelStockEffect\(order\.statusKey, loadingCustodyConfirmed\(order\)\)\}/);
  // The success message follows what the server did, not the dialog's copy.
  assert.match(page, /result\?\.returnedForCheck\s*\?\s*`Order \$\{order\.orderNumber \|\| order\.id\} cancelled\. Its vials are held as a return for an Admin to inspect\.`/);
  assert.match(page, /: result\?\.released\s*\?\s*`Order \$\{order\.orderNumber \|\| order\.id\} cancelled\. Its reservation was released for other orders\.`/);
});

// ---------------------------------------------------------------- recording by quantity

test("the quantity form mirrors the server's rules", () => {
  assert.deepEqual(SPLIT_OUTCOMES.map((o) => o.key), workflow.RETURN_DISPOSITIONS);
  assert.deepEqual(returnBatches(twoBatches).map((b) => [b.inventoryId, b.batchLabel, b.quantity]), [
    ["early", "B-EARLY", 5],
    ["later", "B-LATER", 3],
  ]);

  const empty = evaluateSplit(twoBatches, {});
  assert.equal(empty.valid, false);
  assert.deepEqual(empty.rows.map((r) => r.problem), ["5 of 5 vials not yet recorded.", "3 of 3 vials not yet recorded."]);

  const over = evaluateSplit(twoBatches, { early: { usable: "6" }, later: { usable: "3" } });
  assert.equal(over.rows[0].problem, "1 more than the 5 returned.");
  assert.equal(evaluateSplit(twoBatches, { early: { usable: "4.5", damaged: "0.5" }, later: { usable: "3" } }).rows[0].problem,
    "Use whole numbers of vials, zero or more.");
  assert.equal(evaluateSplit(twoBatches, { early: { usable: "-1", damaged: "6" }, later: { usable: "3" } }).valid, false);

  const ok = evaluateSplit(twoBatches, {
    early: { usable: "3", damaged: "2" },
    later: { temperature_excursion: "1", missing: "2" },
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.lines, [
    { inventoryId: "early", usable: 3, damaged: 2, temperature_excursion: 0, missing: 0 },
    { inventoryId: "later", usable: 0, damaged: 0, temperature_excursion: 1, missing: 2 },
  ]);
  assert.deepEqual(splitTotals(ok.lines), { usable: 3, damaged: 2, temperature_excursion: 1, missing: 2 });
});

test("what the form accepts, the server accepts unchanged (and what it refuses, the server refuses)", () => {
  const ok = evaluateSplit(twoBatches, { early: { usable: "5" }, later: { usable: "1", missing: "2" } });
  assert.deepEqual(workflow.normalizeDispositionLines(twoBatches.items, { lines: ok.lines }), ok.lines);
  assert.equal(workflow.dispositionOfLines(ok.lines), "split");
  assert.equal(workflow.dispositionOfLines(evaluateSplit(twoBatches, { early: { usable: "5" }, later: { usable: "3" } }).lines), "usable");
  assert.throws(
    () => workflow.normalizeDispositionLines(twoBatches.items, { lines: [{ inventoryId: "early", usable: 5 }] }),
    (e) => e.code === "invalid-disposition-lines"
  );
});

test("Admin sees where a return came from and why", () => {
  assert.equal(returnSourceLabel({ source: "cancelled_after_dispatch" }), "Cancelled after dispatch");
  assert.equal(returnSourceLabel({ source: "cancelled_after_dispatch", cancelledFromStatus: "in_transit" }), "Cancelled after dispatch");
  assert.equal(returnSourceLabel({ source: "cancelled_after_dispatch", cancelledFromStatus: "loading" }), "Cancelled after loading");
  assert.equal(returnSourceLabel({ source: "delivery_failed" }), "Failed delivery");
  assert.equal(returnSourceLabel({}), "Failed delivery", "returns written before `source` existed");
  assert.equal(returnReason({ source: "cancelled_after_dispatch", cancelReason: "Clinic closed", failureReason: null }), "Clinic closed");
  assert.equal(returnReason({ failureReason: "No one at the clinic" }), "No one at the clinic");

  const page = read("src/pages/admin/AdminAllocation.jsx");
  assert.match(page, /\{returnSourceLabel\(ret\)\} \{formatWhen\(ret\.reportedAt\)\} · Reason: \{returnReason\(ret\) \|\| "not given"\}/);
  assert.match(page, /confirmReturnDisposition\(ret\.id, null, notes\[ret\.id\] \|\| "", lines\)/);
  assert.match(page, /Record by quantity/);
  // The whole-return buttons still work as before.
  assert.match(page, /confirmReturnDisposition\(ret\.id, disposition, notes\[ret\.id\] \|\| ""\)/);
  const svc = read("src/services/inventoryCallables.js");
  assert.match(svc, /\.\.\.\(Array\.isArray\(lines\) \? \{ lines \} : \{ disposition \}\)/);
});
