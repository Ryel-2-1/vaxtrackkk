// Runs under Node, which provides `process`; the shared ESLint config targets
// browser source — same directive as tests/firestore.rules.test.js.
/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  DISPATCH_STATUSES,
  INVALID_DATE_MESSAGE,
  MISSING_DATE_MESSAGE,
  SCHEDULED_DATE_INVALID,
  SCHEDULED_DATE_MISSING,
  SCHEDULED_DATE_NOT_REACHED,
  dispatchEligibility,
  formatScheduledDate,
  isDispatchEligible,
  isEarlyDispatchAnomaly,
  manilaStartOfDayMs,
  nextManilaMidnightMs,
  notYetDispatchableMessage,
  partitionPendingDispatch,
} from "../src/services/dispatchEligibility.js";
import { canTransition, ACTOR_DISPATCHER } from "../src/services/orderWorkflow.js";

/**
 * Scheduled-order dispatch eligibility.
 *
 * The boundary is 00:00 Asia/Manila on `requestedDeliveryDate` — for
 * 2026-10-04 that is 2026-10-03T16:00:00.000Z. These pin it to the millisecond,
 * prove it does not move with the device's timezone, and pin that the services,
 * rules and dispatcher pages all consult the same rule. The rules themselves
 * are exercised against the emulator in tests/firestore.rules.test.js (SD1–SD9).
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const policy = require("../functions/src/policy.js");

const OCT4 = "2026-10-04";
const order = (fields = {}) => ({ status: "pending_dispatch", requestedDeliveryDate: OCT4, ...fields });
const at = (iso) => new Date(iso);

// ------------------------------------------------------------- the boundary

test("Oct 4 begins at 2026-10-03T16:00:00Z (00:00 Manila)", () => {
  assert.equal(manilaStartOfDayMs(OCT4), Date.UTC(2026, 9, 3, 16, 0, 0, 0));
});

test("one second before Manila midnight: blocked", () => {
  const result = dispatchEligibility(order(), at("2026-10-03T15:59:59.000Z"));
  assert.equal(result.eligible, false);
  assert.equal(result.code, SCHEDULED_DATE_NOT_REACHED);
  // ...and one millisecond before, too.
  assert.equal(isDispatchEligible(order(), at("2026-10-03T15:59:59.999Z")), false);
});

test("exactly midnight on the scheduled date: allowed", () => {
  const result = dispatchEligibility(order(), at("2026-10-03T16:00:00.000Z"));
  assert.deepEqual(result, { eligible: true, iso: OCT4 });
});

test("after midnight, later that day, and on later days: allowed", () => {
  for (const iso of [
    "2026-10-03T16:00:00.001Z",
    "2026-10-04T03:00:00.000Z", // 11:00 Manila
    "2026-10-04T15:59:59.999Z", // 23:59:59.999 Manila
    "2026-10-09T00:00:00.000Z", // overdue
  ]) {
    assert.equal(isDispatchEligible(order(), at(iso)), true, iso);
  }
});

test("today is Oct 2 Manila: an Oct 4 order is blocked with the exact message", () => {
  const result = dispatchEligibility(order(), at("2026-10-02T04:00:00.000Z"));
  assert.equal(result.eligible, false);
  assert.equal(result.code, "scheduled-date-not-reached");
  assert.equal(
    result.message,
    "This order is scheduled for Oct 4, 2026 and cannot be dispatched yet."
  );
  assert.equal(notYetDispatchableMessage(OCT4), result.message);
  assert.equal(formatScheduledDate(OCT4), "Oct 4, 2026");
});

// ------------------------------------------------- UTC / Manila date boundary

test("the Manila date, not the UTC date, decides", () => {
  // 20:00Z on Oct 3 is already 04:00 on Oct 4 in Manila — the UTC calendar
  // date still says Oct 3, and must not hold the order back.
  assert.equal(isDispatchEligible(order(), at("2026-10-03T20:00:00.000Z")), true);
  // 15:00Z on Oct 3 is 23:00 on Oct 3 in Manila — blocked.
  assert.equal(isDispatchEligible(order(), at("2026-10-03T15:00:00.000Z")), false);
  // Month and year roll-overs land on the same 16:00Z rule.
  assert.equal(manilaStartOfDayMs("2026-11-01"), Date.UTC(2026, 9, 31, 16));
  assert.equal(manilaStartOfDayMs("2027-01-01"), Date.UTC(2026, 11, 31, 16));
});

test("agrees with the server's Manila date at every hour of a week", () => {
  // functions/src/policy.js manilaDateString is what validated the date at
  // checkout. For any instant, the day it calls "today" must have begun
  // (eligible) and the following day must not have (blocked).
  const start = Date.UTC(2026, 9, 1, 0, 0, 0);
  for (let h = 0; h < 24 * 7; h += 1) {
    const now = new Date(start + h * 3600000 + 1234);
    const today = policy.manilaDateString(now);
    const tomorrow = policy.manilaDateString(new Date(now.getTime() + 86400000));
    assert.equal(isDispatchEligible(order({ requestedDeliveryDate: today }), now), true, now.toISOString());
    assert.equal(isDispatchEligible(order({ requestedDeliveryDate: tomorrow }), now), false, now.toISOString());
  }
});

test("the device timezone cannot move the boundary", () => {
  // Run the same checks in child processes whose local zone is far from
  // Manila. UTC+14 is the adversarial one: one second before Manila midnight
  // its LOCAL date is already Oct 4, so any code reading the device date
  // would wrongly allow the dispatch.
  const moduleUrl = new URL("../src/services/dispatchEligibility.js", import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const o = { requestedDeliveryDate: "2026-10-04" };
    const out = [
      new Date("2026-10-03T15:59:59Z").getTimezoneOffset(),
      m.isDispatchEligible(o, new Date("2026-10-03T15:59:59Z")),
      m.isDispatchEligible(o, new Date("2026-10-03T16:00:00Z")),
      m.formatScheduledDate("2026-10-04"),
      m.nextManilaMidnightMs(new Date("2026-10-03T12:00:00Z")),
    ];
    console.log(JSON.stringify(out));
  `;
  const expectedOffsets = {
    "America/Los_Angeles": 420,
    "Pacific/Kiritimati": -840,
    "Asia/Manila": -480,
    UTC: 0,
  };
  for (const [tz, offset] of Object.entries(expectedOffsets)) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const [tzOffset, before, atMidnight, label, nextMidnight] = JSON.parse(run.stdout);
    assert.equal(tzOffset, offset, `${tz} really is in effect in the child`);
    assert.equal(before, false, `${tz}: 1s before Manila midnight is blocked`);
    assert.equal(atMidnight, true, `${tz}: Manila midnight is allowed`);
    assert.equal(label, "Oct 4, 2026", `${tz}: the date label does not shift`);
    assert.equal(nextMidnight, Date.UTC(2026, 9, 3, 16), `${tz}: next boundary`);
  }
});

// ------------------------------------------------- unusable dates fail closed

test("a missing field fails closed with its own code and message", () => {
  // Orders created before the date became required. Late enough that any real
  // date would be due — so the refusal can only be about the missing date.
  const now = at("2026-12-31T04:00:00Z");
  for (const legacy of [
    { status: "pending_dispatch" },
    // Present-but-undefined can only be a client object that never had it;
    // Firestore cannot store undefined.
    { requestedDeliveryDate: undefined },
    {},
  ]) {
    assert.deepEqual(dispatchEligibility(legacy, now), {
      eligible: false,
      code: SCHEDULED_DATE_MISSING,
      message: "This order needs a delivery date before it can be dispatched.",
      iso: null,
    });
  }
  assert.equal(dispatchEligibility(null, now).code, SCHEDULED_DATE_MISSING);
  assert.equal(MISSING_DATE_MESSAGE, "This order needs a delivery date before it can be dispatched.");
});

test("null, blank, malformed, impossible and legacy dates are blocked", () => {
  const now = at("2026-12-31T04:00:00Z"); // late enough that any real date is due
  const bad = [
    null,
    "",
    "   ",
    "2026/10/04",
    "2026-10-4",
    "04-10-2026",
    " 2026-10-04",
    "2026-10-04 ",
    "2026-10-04T00:00:00Z",
    "2026-02-31",
    "2026-13-01",
    "not a date",
    20261004,
    0,
    true,
    new Date("2026-10-04T00:00:00Z"),
    { seconds: 1791072000, nanoseconds: 0 }, // a Firestore Timestamp's shape
    { toDate: () => new Date("2026-10-04T00:00:00Z") },
    ["2026-10-04"],
  ];
  for (const value of bad) {
    const result = dispatchEligibility({ requestedDeliveryDate: value }, now);
    assert.equal(result.eligible, false, JSON.stringify(value));
    assert.equal(result.code, SCHEDULED_DATE_INVALID, JSON.stringify(value));
    assert.equal(
      result.message,
      "This order has an invalid delivery date and cannot be dispatched.",
      JSON.stringify(value)
    );
  }
  assert.equal(INVALID_DATE_MESSAGE, "This order has an invalid delivery date and cannot be dispatched.");
});

test("today and past valid dates stay eligible; future ones stay blocked", () => {
  const now = at("2026-10-02T04:00:00Z"); // Oct 2, 12:00 Manila
  assert.equal(isDispatchEligible(order({ requestedDeliveryDate: "2026-10-02" }), now), true);
  assert.equal(isDispatchEligible(order({ requestedDeliveryDate: "2026-09-01" }), now), true);
  assert.equal(isDispatchEligible(order({ requestedDeliveryDate: "2025-12-31" }), now), true);
  assert.equal(dispatchEligibility(order({ requestedDeliveryDate: "2026-10-03" }), now).code, SCHEDULED_DATE_NOT_REACHED);
  assert.equal(dispatchEligibility(order({ requestedDeliveryDate: "2027-01-01" }), now).code, SCHEDULED_DATE_NOT_REACHED);
});

// ------------------------------------------------- queue partition and counts

test("only valid, reached dates are actionable; undated orders need scheduling", () => {
  const now = at("2026-10-02T04:00:00Z"); // Oct 2, 12:00 Manila
  const orders = [
    { id: "today", requestedDeliveryDate: "2026-10-02" },
    { id: "overdue", requestedDeliveryDate: "2026-09-28" },
    { id: "undated" },
    { id: "oct3", requestedDeliveryDate: "2026-10-03" },
    { id: "oct4", requestedDeliveryDate: OCT4 },
    { id: "broken", requestedDeliveryDate: "2026-02-31" },
    { id: "null", requestedDeliveryDate: null },
    { id: "blank", requestedDeliveryDate: "" },
  ];
  const { actionable, upcoming, missing, invalid } = partitionPendingDispatch(orders, now);
  assert.deepEqual(actionable.map((o) => o.id), ["today", "overdue"]);
  assert.deepEqual(upcoming.map((o) => o.id), ["oct3", "oct4"]);
  assert.deepEqual(missing.map((o) => o.id), ["undated"]);
  assert.deepEqual(invalid.map((o) => o.id), ["broken", "null", "blank"]);
  // On Oct 4 the same snapshot needs no new query for the dated ones to become
  // actionable — and the undated one STILL does not.
  const later = partitionPendingDispatch(orders, at("2026-10-03T16:00:00Z"));
  assert.deepEqual(later.actionable.map((o) => o.id), ["today", "overdue", "oct3", "oct4"]);
  assert.deepEqual(later.missing.map((o) => o.id), ["undated"]);
  const empty = partitionPendingDispatch(null, now);
  assert.equal(empty.actionable.length + empty.missing.length, 0);
});

test("the next re-evaluation point is the next Manila midnight", () => {
  assert.equal(nextManilaMidnightMs(at("2026-10-02T04:00:00Z")), Date.UTC(2026, 9, 2, 16));
  // Exactly at a boundary, the next one is a full day later.
  assert.equal(nextManilaMidnightMs(at("2026-10-02T16:00:00Z")), Date.UTC(2026, 9, 3, 16));
  assert.equal(nextManilaMidnightMs(at("2026-10-02T15:59:59.999Z")), Date.UTC(2026, 9, 2, 16));
});

test("an order already dispatched ahead of its date is flagged, not changed", () => {
  const now = at("2026-10-02T04:00:00Z");
  for (const statusKey of ["assigned", "loading", "in_transit", "delayed"]) {
    assert.equal(isEarlyDispatchAnomaly(order(), statusKey, now), true, statusKey);
  }
  // Not an anomaly: still pending, already finished, or genuinely due.
  assert.equal(isEarlyDispatchAnomaly(order(), "pending_dispatch", now), false);
  assert.equal(isEarlyDispatchAnomaly(order(), "delivered", now), false);
  assert.equal(isEarlyDispatchAnomaly(order({ requestedDeliveryDate: "2026-10-02" }), "in_transit", now), false);
  assert.equal(isEarlyDispatchAnomaly({}, "in_transit", now), false);
});

test("eligibility never relaxes the existing status rules", () => {
  // The schedule is an ADDITIONAL gate. Terminal and out-of-order moves stay
  // refused whatever the date says.
  assert.equal(canTransition(ACTOR_DISPATCHER, "delivered", "assigned").ok, false);
  assert.equal(canTransition(ACTOR_DISPATCHER, "cancelled", "assigned").ok, false);
  assert.equal(canTransition(ACTOR_DISPATCHER, "pending_dispatch", "in_transit").ok, false);
  assert.equal(canTransition(ACTOR_DISPATCHER, "pending_dispatch", "assigned").ok, true);
  assert.deepEqual([...DISPATCH_STATUSES], ["assigned", "loading", "in_transit"]);
});

// ------------------------------------- every dispatch path consults the rule

const orderService = read("src/services/orderService.js");
const cargoService = read("src/services/cargoLoadingService.js");
const rules = read("firestore.rules");

/** The body of `export async function name(` up to the next top-level export. */
function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("assignment re-checks the schedule inside its transaction (stale UI)", () => {
  const body = fnBody(orderService, "assignRiderToOrder");
  const txAt = body.indexOf("runTransaction(");
  const readAt = body.indexOf("tx.get(orderRef)");
  const checkAt = body.indexOf("assertScheduleReached(order)");
  const writeAt = body.indexOf("tx.update(orderRef");
  assert.ok(txAt !== -1 && txAt < readAt && readAt < checkAt && checkAt < writeAt,
    "the stored order is read, then checked, then written — all in one transaction");
});

test("failed-delivery recovery re-enters through normal, schedule-gated assignment", () => {
  // Recovery now only returns the order to pending_dispatch (server callable
  // requeueFailedOrder); the client reassignment that skipped the queue is gone,
  // so the only way back to a rider is assignRiderToOrder, checked above.
  assert.equal(/export async function reassignFailedOrder/.test(orderService), false);
  const body = fnBody(orderService, "assignRiderToOrder");
  assert.ok(body.indexOf("assertScheduleReached(order)") < body.indexOf("assignmentBlockReason(order)"),
    "the stock check runs on the same stored order, after the schedule check");
});

test("cargo loading's promotion and finalize both check the stored order", () => {
  const load = fnBody(cargoService, "updateOrderLoadedState");
  assert.match(load, /assertTransition\(ACTOR_DISPATCHER, status, "loading"\);\s*\n\s*\/\/[^\n]*\n\s*assertScheduleReached\(order\);/);
  const finalize = fnBody(cargoService, "finalizeRiderDispatch");
  // Inside the validation pass that runs before ANY write, so one early order
  // refuses the whole group.
  const checkAt = finalize.indexOf("assertScheduleReached(order)");
  assert.ok(checkAt !== -1 && checkAt < finalize.indexOf("refs.forEach((ref) =>"));
});

test("both services raise the stable code from the shared rule", () => {
  for (const [src, errorClass] of [[orderService, "AssignmentError"], [cargoService, "WorkflowError"]]) {
    assert.match(src, /const schedule = dispatchEligibility\(order\);/);
    assert.match(src, new RegExp(`throw new ${errorClass}\\(schedule\\.code, schedule\\.message\\)`));
  }
});

test("the unguarded in_transit writer is gone", () => {
  // startRiderDelivery wrote status: "in_transit" with a bare updateDoc and no
  // checks at all. Nothing called it; it is removed rather than left armed.
  assert.equal(orderService.includes("startRiderDelivery"), false);
  assert.equal(/status:\s*"in_transit"/.test(orderService), false);
});

test("the rules carry the same instant and guard every client write", () => {
  assert.match(rules, /timestamp\.value\(date \+ 'T00:00:00Z'\)/);
  assert.match(rules, /utcMidnightOf\(date\) - duration\.value\(8, 'h'\)/);
  assert.match(rules, /request\.time >= manilaStartOf\(d\[scheduledDateField\(\)\]\)/);
  // An impossible date is caught by a round-trip, not by hoping it errors.
  assert.match(rules, /utcMidnightOf\(value\)\.day\(\) == int\(value\[8:10\]\)/);
  // In the guard EVERY client order write carries — admin included.
  assert.match(rules, /function clientOrderWriteIsAllowed\(\) \{[\s\S]*?&& scheduleGuardHolds\(\)\s*\n\s*&& scheduledDateWriteIsValid\(\);/);
  assert.match(rules, /next in \['assigned', 'loading', 'in_transit'\]/);
  // The Med Rep cannot pull their own date forward.
  assert.match(rules, /&& scheduledDateUnchanged\(\)\s*\n\s*\/\/ The snapshot is immutable after creation\./);
  // FAIL CLOSED: a missing field is not an exemption — presence is required.
  assert.match(
    rules,
    /function scheduleAllowsDispatch\(d\) \{\s*\n\s*return \(scheduledDateField\(\) in d\)\s*\n\s*&& isScheduledDateShape/
  );
  assert.equal(/return !\(scheduledDateField\(\) in d\)/.test(rules), false, "no 'absent is allowed' escape");
  // No client — Admin included — writes the date directly any more (so it can
  // never be erased or set to garbage either): the only path is the
  // rescheduleOrderDelivery callable, which also records the history.
  assert.match(rules, /function scheduledDateWriteIsValid\(\) \{\s*\n\s*return scheduledDateUnchanged\(\);\s*\n\s*\}/);
  // Even an admin-created order must carry a real date.
  assert.match(
    rules,
    /clinicSnapshotValidOnCreate\(\)[\s\S]{0,400}&& \(scheduledDateField\(\) in request\.resource\.data\)\s*\n\s*&& isScheduledDateShape\(request\.resource\.data\[scheduledDateField\(\)\]\)/
  );
});

// ------------------------------------------------------ dispatcher surfaces

test("the dashboard counts and queues only actionable orders", () => {
  const page = read("src/pages/dispatcher/DispatcherDashboard.jsx");
  assert.match(page, /partitionPendingDispatch\(pendingOrders, now\)/);
  assert.match(page, /label="Pending orders"\s*\n\s*value=\{actionable\.length\}/);
  assert.match(page, /\[\.\.\.actionable\]\.sort\(comparePending\)/);
  assert.match(page, /const urgentOrders = actionable\.filter/);
  // No count or queue still reads the unpartitioned list.
  assert.equal(/pendingOrders\.length/.test(page), false);
  // Upcoming is read-only: its rows render the reason, never an Assign button.
  const upcoming = page.slice(page.indexOf("dispatcher-dash-upcoming"));
  assert.equal(upcoming.includes("handleAssignRider"), false);
  assert.match(upcoming, /\{schedule\.message\}/);
  // A stale screen is caught at click time as well.
  assert.match(page, /const schedule = dispatchEligibility\(order, new Date\(\)\);\s*\n\s*if \(!schedule\.eligible\)/);
});

test("legacy undated and invalid-dated orders appear under Needs scheduling, read-only", () => {
  const page = read("src/pages/dispatcher/DispatcherDashboard.jsx");
  assert.match(page, /const \{ actionable, upcoming, missing, invalid \} = useMemo\(/);
  assert.match(page, /const needsScheduling = useMemo\(\(\) => \[\.\.\.missing, \.\.\.invalid\]/);
  const section = /<ReadOnlyQueue\s*\n\s*id="needs-scheduling-title"[\s\S]*?\/>/.exec(page);
  assert.ok(section, "the Needs scheduling section exists");
  assert.match(section[0], /kicker="Needs scheduling · read-only"/);
  assert.match(section[0], /orders=\{needsScheduling\}/);
  // The shared read-only table renders the reason and never a dispatch control.
  const table = page.slice(page.indexOf("function ReadOnlyQueue("));
  assert.equal(/handleAssignRider|onClick=/.test(table.slice(0, table.indexOf("\nfunction MonitorInfo"))), false);
  assert.match(table, /<p className="dispatcher-dash-not-yet">\{schedule\.message\}<\/p>/);
  // ...and the shared Delivery Calendar (the Dispatcher schedule page) names
  // the bucket the same way.
  assert.match(read("src/pages/dispatcher/DispatcherSchedule.jsx"), /<DeliveryCalendar role="dispatcher" \/>/);
  assert.match(read("src/components/schedule/DeliveryCalendar.jsx"), />Unscheduled — needs scheduling<\/h2>/);
});

test("rider assignment, cargo loading and recovery disable their controls", () => {
  const assign = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  assert.match(assign, /const canAssign =\s*!saving[^;]*&& !scheduleBlocked && !stockBlock;/);
  assert.match(assign, /\{schedule\.message\}/);

  const cargo = read("src/pages/dispatcher/DispatcherCargoLoading.jsx");
  assert.match(cargo, /group\.allLoaded && !dispatched && !finalizing && heldOrders\.length === 0/);
  assert.match(cargo, /disabled=\{saving \|\| dispatched \|\| loadBlocked\}/);

  const shipments = read("src/pages/dispatcher/DispatcherShipments.jsx");
  // Recovery only returns the order to the queue; it is not schedule-gated
  // itself — the assignment that follows is.
  assert.match(shipments, /const reassignable = canReassign\(sKey\) && !legacyReturned;/);
  assert.match(shipments, /isEarlyDispatchAnomaly\(order, sKey, now\)/);

  const schedule = read("src/components/schedule/DeliveryCalendar.jsx");
  assert.match(schedule, /Upcoming — not dispatchable until 00:00 that day/);
  assert.match(schedule, /Early dispatch — dispatched before its scheduled date/);
});

test("pages re-evaluate at Manila midnight rather than on a server job", () => {
  for (const p of [
    "src/pages/dispatcher/DispatcherDashboard.jsx",
    "src/pages/dispatcher/DispatcherAssignRider.jsx",
    "src/pages/dispatcher/DispatcherCargoLoading.jsx",
    "src/pages/dispatcher/DispatcherShipments.jsx",
    "src/components/schedule/DeliveryCalendar.jsx",
  ]) {
    assert.match(read(p), /const now = useManilaDayNow\(\);/, p);
  }
  const hook = read("src/components/useManilaDayNow.js");
  assert.match(hook, /nextManilaMidnightMs\(now\)/);
  // No scheduled Cloud Function was introduced.
  assert.equal(/onSchedule|pubsub\.schedule/.test(read("functions/index.js")), false);
});
