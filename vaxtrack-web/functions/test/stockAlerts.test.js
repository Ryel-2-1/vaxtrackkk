"use strict";

// Stock and expiry alerts — the pure decision (src/stockAlerts.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/stockAlerts");

const TODAY = "2026-11-03";
const product = (over = {}) => ({ vaccineName: "Hep B", ...over });
const batch = (id, over = {}) => ({
  id,
  data: { vaccineId: "v1", batchId: `HEP-${id}`, quantity: 100, reservedQuantity: 0, expiryDate: "2027-06-30", ...over },
});
const config = (safetyStockQuantity, over = {}) => ({ vaccineId: "v1", enabled: true, leadTimeDays: 7, safetyStockQuantity, ...over });
const evaluate = (batches, { p = product(), c = null } = {}) =>
  S.evaluateStockConditions({ vaccineId: "v1", product: p, batches, config: c, todayIso: TODAY });
const ts = () => "SERVER_TIME";
const plan = (conditions, existing = {}) => S.planStockAlertWrites({ conditions, existing, nowMs: 1, serverTimestamp: ts });

test("available stock subtracts reservations, returns and quarantine; expired and voided batches count for nothing", () => {
  const out = evaluate(
    [
      batch("a", { quantity: 100, reservedQuantity: 30, returnPendingQuantity: 5, quarantinedQuantity: 15 }),
      batch("b", { quantity: 40, expiryDate: "2026-11-01" }),
      batch("c", { quantity: 500, voided: true }),
    ],
    { c: config(60) },
  );
  const low = out[S.stockAlertId("v1")];
  assert.equal(low.conditionKey, "low");
  assert.equal(low.fields.availableQuantity, 50);
  assert.match(low.message, /50 vials available, at or below its safety stock of 60 vials/);
});

test("low stock needs the Admin's own safety stock; none is invented", () => {
  assert.equal(evaluate([batch("a", { quantity: 5 })])[S.stockAlertId("v1")], undefined);
  assert.equal(evaluate([batch("a", { quantity: 5 })], { c: config(10, { enabled: false }) })[S.stockAlertId("v1")], undefined);
  assert.equal(evaluate([batch("a", { quantity: 5 })], { c: { enabled: true, safetyStockDays: 14 } })[S.stockAlertId("v1")], undefined,
    "a days-based safety stock needs a forecast, so it is not judged here");
  assert.equal(evaluate([batch("a", { quantity: 11 })], { c: config(10) })[S.stockAlertId("v1")], undefined);
  assert.equal(evaluate([batch("a", { quantity: 10 })], { c: config(10) })[S.stockAlertId("v1")].conditionKey, "low");
});

test("out of stock is critical, with or without a safety stock; a vaccine with no batches raises nothing", () => {
  const out = evaluate([batch("a", { quantity: 20, reservedQuantity: 20 })])[S.stockAlertId("v1")];
  assert.deepEqual([out.conditionKey, out.severity], ["out", "critical"]);
  assert.match(out.message, /no vials available to order/);
  assert.deepEqual(evaluate([]), {});
  assert.deepEqual(evaluate([batch("a", { voided: true })]), {}, "only voided entries: no stock was ever recorded");
});

test("expiry: within 30 days warns, past expiry with vials on hand is critical, quarantined vials don't count", () => {
  const out = evaluate([
    batch("soon", { expiryDate: "2026-12-03" }),
    batch("later", { expiryDate: "2026-12-04" }),
    batch("gone", { expiryDate: "2026-11-02", quantity: 12 }),
    batch("held", { expiryDate: "2026-11-02", quantity: 12, quarantinedQuantity: 12 }),
    batch("today", { expiryDate: TODAY }),
  ]);
  assert.equal(out[S.expiryAlertId("soon")].conditionKey, "expiring");
  assert.equal(out[S.expiryAlertId("later")], undefined, "31 days out is not yet critical");
  assert.equal(out[S.expiryAlertId("today")].conditionKey, "expiring", "usable through its expiry date");
  const gone = out[S.expiryAlertId("gone")];
  assert.deepEqual([gone.conditionKey, gone.severity], ["expired", "critical"]);
  assert.match(gone.message, /Batch HEP-gone of Hep B expired on 2026-11-02 and still holds 12 vials/);
  assert.equal(out[S.expiryAlertId("held")], undefined, "fully quarantined: already handled");
});

test("an archived vaccine raises nothing; untrusted counters skip the stock total but not other batches' expiry", () => {
  assert.deepEqual(evaluate([batch("gone", { expiryDate: "2026-01-01" })], { p: product({ archived: true }) }), {});
  const out = evaluate([batch("bad", { quantity: "lots" }), batch("soon", { expiryDate: "2026-11-20" })], { c: config(1000) });
  assert.equal(out[S.stockAlertId("v1")], undefined);
  assert.ok(out[S.expiryAlertId("soon")]);
});

test("lifecycle: opens, updates quietly, escalates as new, and is cleared by the server", () => {
  const id = S.stockAlertId("v1");
  const low = evaluate([batch("a", { quantity: 10 })], { c: config(20) });
  const [open] = plan(low);
  assert.deepEqual([open.id, open.merge, open.data.status, open.data.read, open.data.audience, open.data.path],
    [id, false, "active", false, "admin", "/admin/inventory"]);

  const stored = { ...open.data, read: true };
  assert.deepEqual(plan(low, { [id]: stored }), [], "nothing changed, nothing written");

  const lower = evaluate([batch("a", { quantity: 9 })], { c: config(20) });
  const [quiet] = plan(lower, { [id]: stored });
  assert.equal(quiet.merge, true);
  assert.equal("read" in quiet.data, false, "a changed count keeps the read state");

  const out = evaluate([batch("a", { quantity: 0 })], { c: config(20) });
  const [worse] = plan(out, { [id]: stored });
  assert.deepEqual([worse.merge, worse.data.read, worse.data.conditionKey], [false, false, "out"], "worse reads as new");

  const [better] = plan(low, { [id]: { ...worse.data, read: true } });
  assert.equal("read" in better.data, false, "an improvement (out → low) updates quietly");

  const [cleared] = plan({}, { [id]: stored });
  assert.deepEqual([cleared.data.status, cleared.data.resolvedBy, cleared.data.resolutionReason], ["resolved", "server", "cleared"]);
});

test("resolved by a person: left alone while the same condition holds; reopens if worse or after clearing", () => {
  const id = S.stockAlertId("v1");
  const low = evaluate([batch("a", { quantity: 10 })], { c: config(20) });
  const handResolved = { ...plan(low)[0].data, status: "resolved", resolvedBy: null };
  assert.deepEqual(plan(low, { [id]: handResolved }), []);
  const out = evaluate([batch("a", { quantity: 0 })], { c: config(20) });
  assert.equal(plan(out, { [id]: handResolved })[0].data.status, "active");
  // Cleared: the condition key is forgotten, so the next occurrence opens again.
  const [forget] = plan({}, { [id]: handResolved });
  assert.equal(forget.data.conditionKey, null);
  assert.equal(plan(low, { [id]: { ...handResolved, conditionKey: null } })[0].data.status, "active");
});
