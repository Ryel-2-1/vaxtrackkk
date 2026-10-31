import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addMonths,
  buildMonthGrid,
  countsByDate,
  groupOrdersByRequestedDate,
  isInMonth,
  monthLabel,
  MONTH_LABELS,
  monthOf,
  ordersOnDate,
  pickerYears,
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

test("buildMonthGrid returns five rows when they fit, Sunday-first", () => {
  const weeks = buildMonthGrid(2026, 8, { today: "2026-09-23" }); // September 2026
  assert.equal(weeks.length, 5);
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
  const weeks = buildMonthGrid(2026, 4, { today: "2026-05-15" }); // May 2026
  assert.equal(weeks.length, 6);
  const inMonth = weeks.flat().filter((c) => c.inMonth);
  assert.equal(inMonth.length, 31);
  assert.equal(inMonth[0].iso, "2026-05-01");
  assert.equal(inMonth[inMonth.length - 1].iso, "2026-05-31");
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

// ------------------------------------------- planner month/year navigation

test("an adjacent-month day selects into its own month, across year ends both ways", () => {
  // September 2026 shows Oct 1 as a dimmed trailing cell; choosing it moves
  // the planner view to the selected day's month.
  const sep = buildMonthGrid(2026, 8, { today: "2026-10-27" }).flat();
  const oct1 = sep.find((c) => c.iso === "2026-10-01");
  assert.ok(oct1 && !oct1.inMonth);
  assert.deepEqual(monthOf(oct1.iso), { year: 2026, month: 9 });

  // December 2026 -> a January 2027 trailing day.
  const dec = buildMonthGrid(2026, 11, { today: "2026-10-27" }).flat();
  const jan = dec.find((c) => !c.inMonth && c.iso.startsWith("2027-01"));
  assert.ok(jan);
  assert.deepEqual(monthOf(jan.iso), { year: 2027, month: 0 });

  // January 2027 -> a December 2026 leading day.
  const janGrid = buildMonthGrid(2027, 0, { today: "2026-10-27" }).flat();
  const decLead = janGrid.find((c) => !c.inMonth && c.iso.startsWith("2026-12"));
  assert.ok(decLead);
  assert.deepEqual(monthOf(decLead.iso), { year: 2026, month: 11 });

  // The selected day is an in-month cell of the month it moved to.
  const view = monthOf(oct1.iso);
  const octGrid = buildMonthGrid(view.year, view.month, { today: "2026-10-27" }).flat();
  assert.equal(octGrid.find((c) => c.iso === oct1.iso).inMonth, true);
});

test("the month picker lists every month and a contiguous year range that always holds the view", () => {
  assert.equal(MONTH_LABELS.length, 12);
  MONTH_LABELS.forEach((name, m) => assert.equal(monthLabel(2026, m), `${name} 2026`));

  assert.deepEqual(pickerYears(2026, "2026-10-27"), [2024, 2025, 2026, 2027, 2028, 2029]);
  // The arrows can leave the default range; the picker stretches to keep the view.
  assert.deepEqual(pickerYears(2031, "2026-10-27"), [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031]);
  assert.deepEqual(pickerYears(2020, "2026-10-27").slice(0, 2), [2020, 2021]);
  const years = pickerYears(2031, "2026-10-27");
  years.slice(1).forEach((y, i) => assert.equal(y, years[i] + 1));
});

test("picking a day never changes the Med Rep planner's month; the arrows and month/year picker do", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const page = strip(readFileSync(new URL("../src/pages/salesRep/SalesRepDashboard.jsx", import.meta.url), "utf8"));
  // A previous/next-month day at the grid's edge is selected in place: the
  // click only selects, it never moves the view (2026-10-31 decision).
  assert.match(page, /const selectPlannerDate = \(iso\) => \{\s*setSelectedDate\(iso\);\s*\};/);
  assert.match(page, /onSelectDate=\{selectPlannerDate\}/);
  assert.match(page, /onJumpToMonth=\{jumpToMonth\}/);
  assert.match(page, /onPrevMonth=\{goPrevMonth\}\s*onNextMonth=\{goNextMonth\}/);
  // Arrows and pickers share one move, which drops a selection outside the new month.
  assert.match(page, /const showMonth = \(next\) => \{\s*setView\(next\);\s*if \(selectedDate && !isInMonth\(selectedDate, next\)\) setSelectedDate\(""\);\s*\};/);
  assert.match(page, /const goPrevMonth = \(\) => showMonth\(addMonths\(view\.year, view\.month, -1\)\);/);
  assert.match(page, /const goNextMonth = \(\) => showMonth\(addMonths\(view\.year, view\.month, 1\)\);/);
  assert.match(page, /const jumpToMonth = \(year, month\) => showMonth\(\{ year, month \}\);/);
  // Admin and Dispatcher share the same calendar controls as the Med Rep planner.
  const sharedCalendar = readFileSync(new URL("../src/components/schedule/DeliveryCalendar.jsx", import.meta.url), "utf8");
  assert.match(sharedCalendar, /onCurrentMonth=\{goCurrentMonth\}/);
  assert.match(sharedCalendar, /onJumpToMonth=\{jumpToMonth\}/);
});

test("isInMonth decides whether a selection survives a month change", () => {
  assert.equal(isInMonth("2026-11-01", { year: 2026, month: 10 }), true);
  assert.equal(isInMonth("2026-11-01", { year: 2026, month: 9 }), false);
  assert.equal(isInMonth("2026-12-31", { year: 2027, month: 11 }), false, "same month, other year");
  assert.equal(isInMonth("", { year: 2026, month: 10 }), false);
  assert.equal(isInMonth("nope", { year: 2026, month: 10 }), false);
});

test("calendar cards: urgent orders show every field, standard orders stay compact", () => {
  const card = readFileSync(new URL("../src/components/schedule/DeliveryEventCard.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // Urgent: tinted card, the Urgent chip beside the status, and the full fields.
  assert.match(card, /className=\{`dcal-event\$\{urgent \? " dcal-event-urgent" : ""\}`\}/);
  assert.match(card, /\{urgent \? \(\s*<dl className="dcal-fields">[\s\S]*?label="Requested arrival"[\s\S]*?label="Doctor"[\s\S]*?label="Clinic"[\s\S]*?label="Location"[\s\S]*?label="Med Rep"/);
  // Standard: one line naming doctor and clinic (2026-11-01).
  assert.match(card, /<p className="dcal-event-summary">\s*\{\[where\.doctor, where\.clinic\]\.filter\(Boolean\)\.join\(" · "\) \|\| "Destination not recorded"\}/);
  // The day list scrolls inside its fixed-height panel.
  const css = readFileSync(new URL("../src/components/schedule/DeliveryCalendar.css", import.meta.url), "utf8");
  assert.match(css, /--dcal-panel-height: clamp\(460px, calc\(100dvh - 238px\), 680px\);/);
});
