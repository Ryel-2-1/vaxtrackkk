import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  buildMonthGrid,
  countsByDate,
  groupOrdersByRequestedDate,
  monthLabel,
  monthOf,
  ordersOnDate,
  WEEKDAY_LABELS,
} from "../src/services/deliveryCalendar.js";

/**
 * The month-grid and order-grouping logic shared by the Sales Rep planner and
 * the Dispatcher day-view. The requested date itself is validated elsewhere
 * (requestedDate.js + functions policy); this pins the calendar maths and the
 * "unscheduled is never dropped" guarantee.
 */

// --------------------------------------------------------------- month rollover

test("addMonths normalises across year boundaries in both directions", () => {
  assert.deepEqual(addMonths(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(addMonths(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(addMonths(2026, 5, 0), { year: 2026, month: 5 });
});

test("monthOf reads the year/month of a valid date and rejects junk", () => {
  assert.deepEqual(monthOf("2026-09-23"), { year: 2026, month: 8 });
  assert.equal(monthOf("2026-13-01"), null);
  assert.equal(monthOf("nope"), null);
});

test("monthLabel is the human heading", () => {
  assert.equal(monthLabel(2026, 8), "September 2026");
  assert.equal(monthLabel(2027, 0), "January 2027");
});

// ------------------------------------------------------------------ month grid

test("buildMonthGrid returns a fixed 6x7 grid, Sunday-first", () => {
  const weeks = buildMonthGrid(2026, 8, { today: "2026-09-23" }); // September 2026
  assert.equal(weeks.length, 6);
  for (const week of weeks) assert.equal(week.length, 7);
  // Every first cell of a row is a Sunday.
  for (const week of weeks) assert.equal(week[0].weekday, 0);
  assert.equal(WEEKDAY_LABELS[0], "Sun");
  assert.equal(WEEKDAY_LABELS[6], "Sat");
});

test("buildMonthGrid marks the first-of-month, in/out days, and today", () => {
  // Sep 1 2026 is a Tuesday -> row 0 has Aug 30, Aug 31 (out), then Sep 1..
  const weeks = buildMonthGrid(2026, 8, { today: "2026-09-23" });
  const flat = weeks.flat();

  const sep1 = flat.find((c) => c.iso === "2026-09-01");
  assert.ok(sep1 && sep1.inMonth && sep1.day === 1 && sep1.weekday === 2);

  const aug31 = flat.find((c) => c.iso === "2026-08-31");
  assert.ok(aug31 && aug31.inMonth === false, "trailing prev-month day is out of month");

  const today = flat.filter((c) => c.isToday);
  assert.equal(today.length, 1);
  assert.equal(today[0].iso, "2026-09-23");

  // The in-month days are exactly the 30 days of September.
  assert.equal(flat.filter((c) => c.inMonth).length, 30);
});

test("buildMonthGrid handles a 31-day month spilling into six rows without drift", () => {
  const weeks = buildMonthGrid(2026, 2, { today: "2026-03-15" }); // March 2026
  const inMonth = weeks.flat().filter((c) => c.inMonth);
  assert.equal(inMonth.length, 31);
  assert.equal(inMonth[0].iso, "2026-03-01");
  assert.equal(inMonth[inMonth.length - 1].iso, "2026-03-31");
});

// ------------------------------------------------------------------- grouping

const ORDERS = [
  { id: "a", requestedDeliveryDate: "2026-09-23" },
  { id: "b", requestedDeliveryDate: "2026-09-23" },
  { id: "c", requestedDeliveryDate: "2026-09-25" },
  { id: "d", requestedDeliveryDate: null }, // optional -> unscheduled
  { id: "e" }, // legacy order, no field -> unscheduled
  { id: "f", requestedDeliveryDate: "2026-02-31" }, // impossible -> unscheduled
];

test("groupOrdersByRequestedDate keeps undated and invalid orders in unscheduled", () => {
  const { byDate, unscheduled } = groupOrdersByRequestedDate(ORDERS);
  assert.deepEqual(
    byDate.get("2026-09-23").map((o) => o.id),
    ["a", "b"]
  );
  assert.deepEqual(byDate.get("2026-09-25").map((o) => o.id), ["c"]);
  assert.deepEqual(unscheduled.map((o) => o.id).sort(), ["d", "e", "f"]);
});

test("countsByDate reports per-day markers and ignores undated orders", () => {
  const counts = countsByDate(ORDERS);
  assert.equal(counts["2026-09-23"], 2);
  assert.equal(counts["2026-09-25"], 1);
  assert.equal(counts["2026-02-31"], undefined);
});

test("ordersOnDate returns just that day's orders", () => {
  assert.deepEqual(ordersOnDate(ORDERS, "2026-09-23").map((o) => o.id), ["a", "b"]);
  assert.deepEqual(ordersOnDate(ORDERS, "2026-09-24"), []);
  assert.deepEqual(ordersOnDate(ORDERS, "bad-date"), []);
});

test("grouping tolerates a non-array input", () => {
  const { byDate, unscheduled } = groupOrdersByRequestedDate(null);
  assert.equal(byDate.size, 0);
  assert.deepEqual(unscheduled, []);
  assert.deepEqual(countsByDate(undefined), {});
});
