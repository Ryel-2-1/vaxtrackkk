import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServiceLoader, createStore, installStore, SERVER_TIMESTAMP } from "./serviceHarness.js";
import * as Q from "../src/services/assignmentQueue.js";

/**
 * Dispatcher › Assign Rider.
 *
 * The bug: after a successful assignment the page ran
 * `setTimeout(() => navigate("/dispatcher"), 1200)` and dumped the dispatcher
 * on the Dashboard. The page is now a live queue + dialog that stays put.
 *
 * The real assignRiderToOrder runs against the in-memory Firestore stand-in
 * (serviceHarness) through the same one-at-a-time runner the page uses; the
 * page's wiring (no navigation, listeners, states) is checked by source shape,
 * as elsewhere in this repo (no DOM renderer).
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const PAGE = strip(read("src/pages/dispatcher/DispatcherAssignRider.jsx"));

const loader = createServiceLoader();
const { assignRiderToOrder } = await loader.load("orderService.js");
const LQ = await loader.load("assignmentQueue.js");

const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };
const pending = (over = {}) => ({
  orderNumber: "VT-ORD-5001",
  status: "pending_dispatch",
  assignedRiderId: null,
  createdByUid: "rep1",
  requestedDeliveryDate: "2026-01-01",
  ...over,
});
const seed = (order = pending(), riders = { rider1: { role: "rider", status: "approved", fullName: "QA Rider" } }) =>
  createStore({ orders: { o1: order }, users: riders });

// ---------------------------------------------------------------- the assignment run

test("success: one transactional assignment with attribution, and the success message", async () => {
  const store = installStore(seed(), DISPATCHER);
  const runner = LQ.createAssignmentRunner(assignRiderToOrder);
  const outcome = await runner.run("o1", "rider1");
  assert.deepEqual([outcome.ok, outcome.message], [true, "Rider assigned successfully."]);
  const order = store.collections.orders.o1.data;
  assert.equal(order.status, "assigned");
  assert.equal(order.assignedRiderId, "rider1");
  assert.equal(order.assignedByUid, DISPATCHER.uid);
  assert.equal(order.assignedAt, SERVER_TIMESTAMP);
});

test("a double click sends exactly one assignment; the second is refused while pending", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const runner = Q.createAssignmentRunner(async () => {
    calls += 1;
    await gate;
    return { assignedRiderName: "QA" };
  });
  const first = runner.run("o1", "rider1");
  assert.equal(runner.pending, true, "pending while the request runs (the button is disabled)");
  const second = await runner.run("o1", "rider1");
  assert.deepEqual(second, { ok: false, busy: true });
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls, 1);
  assert.equal(runner.pending, false);
});

test("another dispatcher assigned first: the clear conflict message, nothing overwritten", async () => {
  const store = installStore(seed(pending({ status: "assigned", assignedRiderId: "otherRider" })), DISPATCHER);
  const outcome = await LQ.createAssignmentRunner(assignRiderToOrder).run("o1", "rider1");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.conflict, true);
  assert.equal(outcome.message, "This order has already been assigned. The list has been updated.");
  assert.equal(store.collections.orders.o1.data.assignedRiderId, "otherRider");
});

test("unavailable rider and invalid status stay on the page with a clear message", async () => {
  installStore(seed(pending(), { rider1: { role: "rider", status: "disabled" } }), DISPATCHER);
  const rider = await LQ.createAssignmentRunner(assignRiderToOrder).run("o1", "rider1");
  assert.deepEqual([rider.ok, rider.conflict, rider.message], [false, false, "That rider is no longer available. Choose another rider."]);

  installStore(seed(pending({ status: "cancelled" })), DISPATCHER);
  const status = await LQ.createAssignmentRunner(assignRiderToOrder).run("o1", "rider1");
  assert.equal(status.ok, false);
  assert.equal(status.conflict, true);
  assert.equal(status.message, "This order was cancelled. The list has been updated.");

  installStore(seed(pending({ status: "delivery_failed" })), DISPATCHER);
  const other = await LQ.createAssignmentRunner(assignRiderToOrder).run("o1", "rider1");
  assert.equal(other.message, "This order is no longer waiting for a rider. The list has been updated.");
});

test("permission and network failures never show raw Firebase text", async () => {
  const cases = [
    [{ code: "permission-denied", message: "Missing or insufficient permissions." }, /do not have permission to assign riders/],
    [{ code: "firestore/permission-denied", message: "FirebaseError: [code=permission-denied]" }, /do not have permission/],
    [{ code: "unavailable", message: "Failed to get document because the client is offline." }, /Could not reach the server.*nothing was assigned/],
    [{ code: "deadline-exceeded", message: "x" }, /Could not reach the server/],
    [new Error("FirebaseError: internal assertion 0x88"), /^Unable to assign the rider\. Please try again\.$/],
  ];
  for (const [error, expected] of cases) {
    const outcome = await Q.createAssignmentRunner(async () => {
      throw error;
    }).run("o1", "r1");
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, expected);
    assert.equal(/Firebase|insufficient|offline|0x88/.test(outcome.message), false, outcome.message);
  }
});

// ---------------------------------------------------------------- the live queue

const NOW = new Date("2026-10-10T02:00:00Z"); // 10:00 Manila
const q = (orders, opts = {}) => Q.buildAssignmentQueue({ orders, now: NOW, ...opts });
const o = (id, over = {}) => ({ id, orderNumber: `VT-ORD-${id}`, status: "pending_dispatch", requestedDeliveryDate: "2026-10-10", clinicName: "Clinic", vaccineName: "Flu", ...over });

test("the assigned order disappears with the next live snapshot; search, filter and page are kept", () => {
  const snap1 = [o("a", { clinicName: "Laguna Clinic" }), o("b", { clinicName: "Laguna East" }), o("c", { clinicName: "Manila" })];
  const view = { search: "laguna", filter: "all" };
  assert.deepEqual(q(snap1, view).map((r) => r.id), ["a", "b"]);
  // "a" was assigned (here or in another browser): the subscription re-delivers without it.
  const snap2 = snap1.filter((x) => x.id !== "a");
  assert.deepEqual(q(snap2, view).map((r) => r.id), ["b"], "same search, updated rows, no refetch");
  // An external NEW order appears without a refresh, too.
  assert.deepEqual(q([...snap2, o("d", { clinicName: "Laguna North" })], view).map((r) => r.id).sort(), ["b", "d"]);
});

test("filters: urgent, overdue, due today; only dispatchable orders are listed", () => {
  const orders = [
    o("today"),
    o("old", { requestedDeliveryDate: "2026-10-01" }),
    o("urgent", { priority: "Urgent" }),
    o("future", { requestedDeliveryDate: "2026-12-01" }),
    o("undated", { requestedDeliveryDate: null }),
  ];
  assert.deepEqual(q(orders).map((r) => r.id), ["old", "urgent", "today"], "soonest date first, urgent within a date; future and undated excluded");
  assert.deepEqual(q(orders, { filter: "urgent" }).map((r) => r.id), ["urgent"]);
  assert.deepEqual(q(orders, { filter: "overdue" }).map((r) => r.id), ["old"]);
  assert.deepEqual(q(orders, { filter: "today" }).map((r) => r.id).sort(), ["today", "urgent"]);
  assert.deepEqual(q(orders, { search: "VT-ORD-OLD" }).map((r) => r.id), ["old"], "case-insensitive");
});

test("paging stays on a real page when the live snapshot removes the last row", () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: String(i) }));
  assert.deepEqual([Q.pageOf(rows, 2).rows.length, Q.pageOf(rows, 2).pageCount], [1, 2]);
  const after = Q.pageOf(rows.slice(0, 10), 2);
  assert.deepEqual([after.page, after.pageCount, after.rows.length], [1, 1, 10]);
});

test("an order that left the queue while its dialog was open says why", () => {
  assert.equal(Q.goneOrderMessage("assigned"), "This order has already been assigned. The list has been updated.");
  assert.equal(Q.goneOrderMessage("in_transit"), Q.ALREADY_ASSIGNED_MESSAGE);
  assert.match(Q.goneOrderMessage("cancelled"), /was cancelled/);
  assert.match(Q.goneOrderMessage(undefined), /no longer waiting/);
});

// ---------------------------------------------------------------- the page

test("assigning never navigates, reloads, refetches or submits a form", () => {
  const handler = PAGE.slice(PAGE.indexOf("const handleConfirmAssignment"), PAGE.indexOf("const goneMessage"));
  assert.ok(handler.length > 100);
  assert.equal(/navigate\(|setTimeout|window\.location|location\.reload|getDocs|subscribe/.test(handler), false);
  assert.equal(/window\.location|\.reload\(/.test(PAGE), false);
  assert.equal(/<form/.test(PAGE), false, "no form, so no implicit submit");
  // Every button is an explicit type="button".
  const buttons = [...PAGE.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 6);
  for (const b of buttons) assert.match(b, /type="button"/, b);
  // The only navigation is the explicit Back to dashboard control.
  assert.deepEqual([...PAGE.matchAll(/navigate\(/g)].length, 1);
  assert.match(PAGE, /aria-label="Back to dashboard"/);
});

test("success closes the dialog and says so; failures keep the user's context", () => {
  const handler = PAGE.slice(PAGE.indexOf("const handleConfirmAssignment"), PAGE.indexOf("const goneMessage"));
  assert.match(handler, /const outcome = await runner\.run\(selectedOrder\.id, selectedRider\.uid\);/);
  assert.match(handler, /if \(outcome\.ok\) \{\s*\n?\s*setDialogOrderId\(null\);[\s\S]*?setToast\(\{ message: outcome\.message, type: "success" \}\);/);
  assert.match(handler, /if \(outcome\.conflict\) \{[\s\S]*?setToast\(\{ message: outcome\.message, type: "error" \}\);/);
  assert.match(handler, /setDialogError\(outcome\.message\);/);
  // Search, filter and page are never reset by the assignment.
  assert.equal(/setSearch|setFilter|setPage/.test(handler), false);
  // The confirm button is disabled while pending.
  assert.match(PAGE, /const canAssign =\s*!saving && !!selectedRiderId && !!selectedRider && !!selectedOrder && !scheduleBlocked && !stockBlock;/);
  assert.match(PAGE, /onClick=\{handleConfirmAssignment\}\s*disabled=\{!canAssign\}/);
  assert.match(PAGE, /const \[runner\] = useState\(\(\) => createAssignmentRunner\(assignRiderToOrder\)\);/);
});

test("one live listener per feed, created once and removed on unmount", () => {
  assert.equal([...PAGE.matchAll(/subscribePendingDispatchOrders\(/g)].length, 1);
  assert.equal([...PAGE.matchAll(/subscribeRiders\(/g)].length, 1);
  const effect = PAGE.slice(PAGE.indexOf("const unsubOrders = subscribePendingDispatchOrders("), PAGE.indexOf("const queue = useMemo("));
  assert.match(effect, /return \(\) => \{\s*unsubOrders\(\);\s*unsubRiders\(\);\s*\};\s*\}, \[\]\);/, "empty deps: no duplicate listeners on re-render");
  // The dialog shows only the LIVE order, never a stale cached copy.
  assert.match(PAGE, /const selectedOrder = dialogOrderId && orders \? orders\.find\(\(o\) => o\.id === dialogOrderId\) \|\| null : null;/);
  // The subscription reports errors instead of loading forever.
  assert.match(strip(read("src/services/orderService.js")), /export function subscribePendingDispatchOrders\(callback, onError\)[\s\S]*?\(error\) => onError\?\.\(error\)/);
});

test("the Dashboard hand-off still opens that order on this page", () => {
  const dash = strip(read("src/pages/dispatcher/DispatcherDashboard.jsx"));
  assert.match(dash, /localStorage\.setItem\("selectedDispatchOrderId", order\.id\);/);
  assert.match(dash, /navigate\("\/dispatcher\/assign-rider"\);/);
  assert.match(PAGE, /localStorage\.getItem\("selectedDispatchOrderId"\)/);
});

test("the route guard never redirects an authenticated Dispatcher while loading or on token refresh", () => {
  const guard = strip(read("src/components/DispatcherRoute.jsx"));
  assert.match(guard, /onAuthStateChanged\(auth,/, "sign-in/out only — token refreshes do not re-run it");
  assert.equal(/onIdTokenChanged/.test(guard), false);
  assert.match(guard, /if \(state === "loading"\) return null;/, "loading renders nothing, not a redirect");
  // The decision is the shared resolver run on each profile snapshot; the
  // watcher's cleanup closes both listeners.
  assert.match(guard, /watchRouteAccess\(\{[\s\S]*requiredRole: ROLES\.DISPATCHER/);
  const watcher = strip(read("src/services/liveRouteAccess.js"));
  assert.match(watcher, /return decision\.allowed\s*\?\s*\{ state: "allowed"/);
  assert.match(watcher, /return \(\) => \{\s*closeProfile\(\);\s*stopAuth\(\);\s*\};/);
});
