import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  calendarCounts,
  calendarDay,
  canReschedule,
  compareCalendarOrders,
  eventDestination,
  filterCalendarOrders,
  formatScheduleTime,
  isUrgent,
  medRepNameFor,
  originalRequestNote,
  priorityLabel,
  scheduleLabel,
  scheduledDateOf,
  scheduledTimeOf,
  unscheduledOrders,
  validateReschedule,
  RESCHEDULE_MESSAGES,
} from "../src/services/deliverySchedule.js";
import { manilaToday } from "../src/services/requestedDate.js";
import { ROLES, resolveAccess } from "../src/services/authorization.js";

/**
 * The Delivery Calendar (Admin + Dispatcher). The server transaction and the
 * rules are proven in functions/test/integration/scheduleOperations.test.js and
 * tests/firestore.rules.test.js (SD1d, SD6, SCH1–3); this pins the pure
 * calendar rules, the client/server validation parity and the page wiring.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) =>
  read(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const require = createRequire(import.meta.url);
const server = require("../functions/src/scheduleOperations.js");

const order = (over = {}) => ({
  id: over.id || "o",
  orderNumber: over.orderNumber || "VT-ORD-1",
  statusKey: "pending_dispatch",
  statusType: "pending_dispatch",
  priority: "Standard",
  requestedDeliveryDate: "2026-10-08",
  ...over,
});

// ------------------------------------------------------------ Manila days

test("'today' turns over at Manila midnight, not UTC midnight", () => {
  assert.equal(manilaToday(new Date("2026-10-04T15:59:00Z")), "2026-10-04");
  assert.equal(manilaToday(new Date("2026-10-04T16:00:00Z")), "2026-10-05");
  // So a reschedule to Oct 4 is "past" from 00:00 Manila on Oct 5.
  const todayIso = manilaToday(new Date("2026-10-04T16:30:00Z"));
  assert.equal(validateReschedule({ date: "2026-10-04", todayIso }).message, RESCHEDULE_MESSAGES.datePast);
  assert.equal(validateReschedule({ date: "2026-10-05", todayIso }).ok, true);
});

test("an advance order sits on its own scheduled day, never on the day it was placed", () => {
  const advance = order({ id: "adv", requestedDeliveryDate: "2026-11-20", createdAt: "2026-10-05" });
  const orders = [advance, order({ id: "now", requestedDeliveryDate: "2026-10-05" })];
  assert.deepEqual(calendarDay(orders, "2026-11-20").map((o) => o.id), ["adv"]);
  assert.deepEqual(calendarDay(orders, "2026-10-05").map((o) => o.id), ["now"]);
  assert.deepEqual(calendarCounts(orders).counts, { "2026-11-20": 1, "2026-10-05": 1 });
});

test("a rescheduled order moves day; its original request is shown, not used", () => {
  const moved = order({ requestedDeliveryDate: "2026-10-12", originalRequestedDeliveryDate: "2026-10-08", scheduledDeliveryTime: "09:30" });
  assert.equal(scheduledDateOf(moved), "2026-10-12");
  assert.deepEqual(calendarDay([moved], "2026-10-08"), []);
  assert.equal(calendarDay([moved], "2026-10-12").length, 1);
  assert.equal(scheduleLabel(moved), "Oct 12, 2026 · 9:30 AM");
  assert.equal(originalRequestNote(moved), "Originally requested for Oct 8, 2026");
  // Only a time change: same day, so no "originally" note.
  assert.equal(originalRequestNote(order({ originalRequestedDeliveryDate: "2026-10-08" })), null);
});

// ------------------------------------------------------------ legacy dates

test("missing or malformed dates are Unscheduled — never given a fake day", () => {
  const legacy = [
    order({ id: "none", requestedDeliveryDate: undefined }),
    order({ id: "null", requestedDeliveryDate: null }),
    order({ id: "blank", requestedDeliveryDate: "" }),
    order({ id: "slash", requestedDeliveryDate: "2026/10/08" }),
    order({ id: "impossible", requestedDeliveryDate: "2026-02-31" }),
    order({ id: "timestamp", requestedDeliveryDate: { seconds: 1790000000 } }),
  ];
  for (const o of legacy) {
    assert.equal(scheduledDateOf(o), null, o.id);
    assert.equal(scheduleLabel(o), "Unscheduled", o.id);
  }
  assert.deepEqual(calendarCounts(legacy).counts, {});
  assert.deepEqual(unscheduledOrders(legacy).map((o) => o.id).sort(), legacy.map((o) => o.id).sort());
  // Finished historical orders without a date are not a worklist item.
  assert.deepEqual(unscheduledOrders([order({ requestedDeliveryDate: null, statusType: "delivered" })]), []);
  // A malformed time is ignored, not shown.
  assert.equal(scheduledTimeOf(order({ scheduledDeliveryTime: "9:30" })), null);
  assert.equal(scheduleLabel(order({ scheduledDeliveryTime: "25:00" })), "Oct 8, 2026");
});

// ------------------------------------------------------------ ordering

test("Urgent comes before Standard, then by time (untimed last), then order number", () => {
  const day = [
    order({ id: "s-untimed", orderNumber: "VT-3" }),
    order({ id: "s-0800", orderNumber: "VT-4", scheduledDeliveryTime: "08:00" }),
    order({ id: "u-1400", orderNumber: "VT-5", priority: "Urgent", scheduledDeliveryTime: "14:00" }),
    order({ id: "u-untimed", orderNumber: "VT-1", priority: "urgent" }),
    order({ id: "u-0900", orderNumber: "VT-2", priority: " URGENT ", scheduledDeliveryTime: "09:00" }),
    order({ id: "s-legacy-high", orderNumber: "VT-0", priority: "High" }),
  ];
  assert.deepEqual(calendarDay(day, "2026-10-08").map((o) => o.id), [
    "u-0900", "u-1400", "u-untimed", "s-0800", "s-legacy-high", "s-untimed",
  ]);
  assert.equal(compareCalendarOrders(day[3], day[0]) < 0, true);
  assert.equal(priorityLabel(order({ priority: "Normal" })), "Standard");
  assert.equal(priorityLabel(order({ priority: undefined })), "Standard");
  assert.equal(calendarCounts(day).urgent["2026-10-08"], 3);
});

test("urgency only orders the list — it is never part of any calculation", () => {
  const src = code("src/services/deliverySchedule.js");
  assert.equal(/centavos|price|fee|vat|discount|total/i.test(src), false);
  const page = code("src/components/schedule/DeliveryCalendar.jsx");
  assert.equal(/centavos|unitPrice|handlingFee|deliveryFee|vatAmount/i.test(page), false);
});

// ------------------------------------------------------------ filters

test("status and priority filters combine, and 'all' keeps everything", () => {
  const orders = [
    order({ id: "a", statusType: "assigned", priority: "Urgent" }),
    order({ id: "b", statusType: "assigned" }),
    order({ id: "c", statusType: "in_transit", priority: "Urgent" }),
    order({ id: "d", statusType: "delivered" }),
  ];
  const ids = (f) => filterCalendarOrders(orders, f).map((o) => o.id);
  assert.deepEqual(ids({}), ["a", "b", "c", "d"]);
  assert.deepEqual(ids({ status: "assigned" }), ["a", "b"]);
  assert.deepEqual(ids({ priority: "urgent" }), ["a", "c"]);
  assert.deepEqual(ids({ priority: "standard" }), ["b", "d"]);
  assert.deepEqual(ids({ status: "assigned", priority: "urgent" }), ["a"]);
  assert.deepEqual(ids({ status: "cancelled" }), []);
  assert.deepEqual(filterCalendarOrders(null, {}), []);
});

// ------------------------------------------------------------ event fields

test("each entry shows doctor, clinic, location and Med Rep from real data only", () => {
  const doctorFirst = order({ doctorName: "Dr. Ana Reyes", destinationName: "Laguna Clinic", deliveryAddress: "1 National Hwy", createdByUid: "rep1" });
  assert.deepEqual(eventDestination(doctorFirst), { doctor: "Dr. Ana Reyes", clinic: "Laguna Clinic", location: "1 National Hwy" });
  const legacy = order({ clinicName: "Old Clinic", clinicAddress: "Old St" });
  assert.deepEqual(eventDestination(legacy), { doctor: null, clinic: "Old Clinic", location: "Old St" });

  const users = new Map([["rep1", { fullName: "Maria Santos" }]]);
  assert.equal(medRepNameFor(doctorFirst, users), "Maria Santos");
  // Dispatcher (no directory): only a snapshot on the order can answer.
  assert.equal(medRepNameFor(doctorFirst, null), null);
  assert.equal(medRepNameFor(order({ createdByEmail: "rep@x.com" }), null), "rep@x.com");
  assert.equal(medRepNameFor(order({ createdByUid: "ghost" }), users), null);
});

test("time display is Manila wall-clock as stored", () => {
  assert.equal(formatScheduleTime("00:05"), "12:05 AM");
  assert.equal(formatScheduleTime("12:00"), "12:00 PM");
  assert.equal(formatScheduleTime("23:59"), "11:59 PM");
  assert.equal(formatScheduleTime("bad"), "");
});

// ------------------------------------------------------------ validation parity

test("client validation agrees with the server's rescheduleOrderDelivery rules", () => {
  const now = new Date("2026-10-05T02:00:00Z");
  const todayIso = manilaToday(now);
  const serverOk = (date, time) => {
    try {
      server.normalizeScheduleDate(date, now);
      server.normalizeScheduleTime(time);
      return true;
    } catch {
      return false;
    }
  };
  const cases = [
    ["2026-10-05", ""], ["2026-10-05", "00:00"], ["2027-02-28", "23:59"],
    ["2026-10-04", ""], ["2026-02-31", ""], ["2026-13-01", ""], ["10/05/2026", ""],
    ["2026-10-06", "24:00"], ["2026-10-06", "9:30"], ["2026-10-06", "09:60"],
  ];
  for (const [date, time] of cases) {
    assert.equal(validateReschedule({ date, time, todayIso }).ok, serverOk(date, time), `${date} ${time}`);
  }
  assert.equal(validateReschedule({ date: "", todayIso }).message, RESCHEDULE_MESSAGES.dateRequired);
  assert.deepEqual(validateReschedule({ date: "2026-10-09", time: "", todayIso }).value, {
    requestedDeliveryDate: "2026-10-09",
    scheduledDeliveryTime: null,
  });
  // Unchanged is refused on both sides.
  const current = order({ requestedDeliveryDate: "2026-10-09", scheduledDeliveryTime: "10:00" });
  assert.equal(validateReschedule({ date: "2026-10-09", time: "10:00", order: current, todayIso }).message, RESCHEDULE_MESSAGES.unchanged);
  assert.equal(validateReschedule({ date: "2026-10-09", time: "", order: current, todayIso }).ok, true, "clearing the time is a change");
});

test("reschedule is offered before and after assignment/dispatch, never on closed orders", () => {
  for (const s of ["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivery_failed"]) {
    assert.equal(canReschedule(order({ statusType: s })), true, s);
  }
  for (const s of ["delivered", "cancelled"]) assert.equal(canReschedule(order({ statusType: s })), false, s);
  // Matches the server's terminal set.
  for (const s of ["delivered", "completed", "cancelled", "canceled"]) assert.ok(server.TERMINAL_STATUSES.has(s), s);
});

// ------------------------------------------------------------ permissions + wiring

test("the calendar is reachable by Admin and Dispatcher only", () => {
  const app = code("src/App.jsx");
  const adminBlock = app.slice(app.indexOf("<Route element={<AdminRoute />}>"), app.indexOf("<Route path=\"/inventory\""));
  assert.match(adminBlock, /<Route path="\/admin\/delivery-calendar" element={<AdminDeliveryCalendar \/>} \/>/);
  assert.match(app, /const AdminDeliveryCalendar = lazy\(\(\) => import\("\.\/pages\/admin\/AdminDeliveryCalendar"\)\);/);
  const dispatcherBlock = app.slice(app.indexOf("<Route element={<DispatcherRoute />}>"));
  assert.match(dispatcherBlock.slice(0, dispatcherBlock.indexOf("</Route>\n          </Route>") + 1 || undefined), /\/dispatcher\/schedule/);
  // Neither path appears under the Sales Rep guard.
  const repBlock = app.slice(app.indexOf("<Route element={<SalesRepRoute />}>"), app.indexOf("<Route element={<DispatcherRoute />}>"));
  assert.equal(/delivery-calendar|dispatcher\/schedule|DeliveryCalendar/.test(repBlock), false);

  // The guards' shared decision: Med Rep and Rider are turned away from both areas.
  const profile = (role) => ({ role, status: "approved" });
  assert.equal(resolveAccess({ profile: profile("admin"), requiredRole: ROLES.ADMIN }).allowed, true);
  assert.equal(resolveAccess({ profile: profile("dispatcher"), requiredRole: ROLES.DISPATCHER }).allowed, true);
  for (const role of ["salesrep", "rider"]) {
    assert.equal(resolveAccess({ profile: profile(role), requiredRole: ROLES.ADMIN }).allowed, false, `${role} → admin`);
    assert.equal(resolveAccess({ profile: profile(role), requiredRole: ROLES.DISPATCHER }).allowed, false, `${role} → dispatcher`);
  }
  assert.equal(resolveAccess({ profile: profile("dispatcher"), requiredRole: ROLES.ADMIN }).allowed, false);
});

test("only the Admin view can reschedule, and only through the callable", () => {
  assert.match(code("src/pages/admin/AdminDeliveryCalendar.jsx"), /<DeliveryCalendar role="admin" \/>/);
  assert.match(code("src/pages/dispatcher/DispatcherSchedule.jsx"), /<DeliveryCalendar role="dispatcher" \/>/);
  const page = code("src/components/schedule/DeliveryCalendar.jsx");
  assert.match(page, /const isAdmin = role === "admin";/);
  assert.match(page, /\{isAdmin \? \(\s*canReschedule\(order\)/);
  assert.match(page, /\{isAdmin && editing \? \(/);
  // The user directory (Med Rep names) is only subscribed for Admin.
  assert.match(page, /if \(!isAdmin\) return undefined;\s*return subscribeUsers\(/);
  // No direct Firestore write from the calendar — the callable is the only path.
  assert.equal(/from "firebase\/firestore"|updateDoc|setDoc|writeBatch/.test(page), false);
  const callable = code("src/services/scheduleCallables.js");
  assert.match(callable, /httpsCallable\(getFunctions\(app, FUNCTIONS_REGION\), "rescheduleOrderDelivery"\)/);
  // It sends the order id, date, time and reason — nothing else.
  assert.match(callable, /const payload = \{ orderId, requestedDeliveryDate \};/);
  assert.deepEqual([...callable.matchAll(/payload\.(\w+) =/g)].map((m) => m[1]), ["scheduledDeliveryTime", "reason"]);
  // The Admin sidebar and title know the route.
  assert.match(code("src/components/admin/AdminSidebar.jsx"), /to="\/admin\/delivery-calendar"/);
  assert.match(code("src/components/admin/AdminShell.jsx"), /"\/admin\/delivery-calendar": "Delivery Calendar"/);
});

test("the calendar has loading, error and empty states, and keyboard-operable controls", () => {
  const page = code("src/components/schedule/DeliveryCalendar.jsx");
  assert.match(page, /<div className="dcal-state" role="status">[\s\S]*?Loading delivery calendar…/);
  assert.match(page, /<div className="dcal-state" role="alert">[\s\S]*?Could not load the delivery calendar/);
  assert.match(page, /You do not have permission to view the delivery calendar\./);
  assert.match(page, /<strong>No orders yet<\/strong>/);
  assert.match(page, /<strong>Nothing scheduled<\/strong>/);
  assert.match(page, /No order on this day matches the current filters\./);
  assert.match(page, /<strong>All active orders are dated<\/strong>/);
  // Dialog: modal semantics, Escape, focus trap, focus return.
  assert.match(page, /role="dialog"\s*aria-modal="true"/);
  assert.match(page, /e\.key === "Escape"/);
  assert.match(page, /triggerRef\.current\.focus\(\)/);
  // Month navigation: previous, current, next.
  assert.match(page, /onPrevMonth=\{goPrevMonth\}/);
  assert.match(page, /onNextMonth=\{goNextMonth\}/);
  assert.match(page, /onCurrentMonth=\{goCurrentMonth\}/);
  const cal = code("src/components/ui/MonthCalendar.jsx");
  assert.match(cal, /aria-label="Previous month"/);
  assert.match(cal, /This month/);
  assert.match(cal, /aria-label="Next month"/);
  assert.match(cal, /\$\{urgent > 0 \? `, \$\{urgent\} urgent` : ""\}/, "urgency is spoken, not colour-only");
});

test("the Med Rep's tracking page shows the current schedule and the original request", () => {
  const tracking = code("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.match(tracking, /scheduledDeliveryTime: raw\.scheduledDeliveryTime/);
  assert.match(tracking, /originalRequestedDeliveryDate: raw\.originalRequestedDeliveryDate/);
  assert.match(tracking, /\{scheduleLabel\(selectedOrder\)\}/);
  assert.match(tracking, /originalRequestNote\(selectedOrder\)/);
  // ...and no calendar or reschedule control.
  assert.equal(/DeliveryCalendar|rescheduleOrderDelivery/.test(tracking), false);
});

test("isUrgent is a strict, case-insensitive match on the stored priority", () => {
  assert.equal(isUrgent({ priority: "Urgent" }), true);
  assert.equal(isUrgent({ priority: "urgent " }), true);
  assert.equal(isUrgent({ priority: "Urgently" }), false);
  assert.equal(isUrgent({}), false);
  assert.equal(isUrgent(null), false);
});
