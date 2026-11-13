import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the Med Rep may change the date only until the rider leaves, matching the server", async () => {
  const { medRepMayReschedule, MED_REP_RESCHEDULABLE_STATUSES } = await import("../src/services/medRepReschedule.js");
  assert.deepEqual([...MED_REP_RESCHEDULABLE_STATUSES], ["pending_dispatch", "assigned", "loading"]);
  for (const s of ["pending_dispatch", "assigned", "loading"]) assert.equal(medRepMayReschedule(s), true, s);
  for (const s of ["in_transit", "delayed", "delivered", "cancelled", "delivery_failed"]) assert.equal(medRepMayReschedule(s), false, s);
  assert.ok(
    read("functions/src/scheduleOperations.js").includes('const MED_REP_RESCHEDULABLE = new Set(["pending_dispatch", "assigned", "loading"]);'),
    "the server allows the same statuses"
  );
});

test("the server checks ownership, the reason and the status for a Med Rep", () => {
  const server = read("functions/src/scheduleOperations.js");
  assert.match(server, /if \(role === "salesrep" && reason === null\) \{/);
  assert.match(server, /if \(order\.createdByUid !== uid\) \{\s*\/\/[^\n]*\n\s*throw new PolicyError\("order-not-found"/);
  assert.match(server, /if \(!MED_REP_RESCHEDULABLE\.has\(status\)\) \{/);
  assert.match(server, /changedByRole: role,/);
});

test("Order Tracking shows the Change delivery date action with a date and a required reason", () => {
  const page = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.match(page, /<MedRepRescheduleAction\s+order=\{selectedOrder\}/);
  const ui = read("src/components/orders/MedRepRescheduleAction.jsx");
  assert.match(ui, /type="date"\s+min=\{today\}/);
  assert.match(ui, /if \(!reason\.trim\(\)\) \{/);
  assert.match(ui, /if \(!order \|\| !medRepMayReschedule\(order\.statusKey\)\) return null;/);
});
