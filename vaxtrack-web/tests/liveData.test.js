// Live data across the Admin, Dispatcher and Med Rep web pages.
//
// Three layers:
//   1. Pure modules — error mapping, the route-access watcher, live-form
//      reconciliation, live cart annotations, the online signal — driven
//      through several snapshots in a row.
//   2. The REAL services, run against a multi-snapshot Firestore stand-in:
//      listeners stay open, every write re-delivers to them, a failure can be
//      injected, and an unsubscribed listener hears nothing more.
//   3. Source checks for the page wiring that cannot run without a DOM: error
//      callbacks on every listener, cleanup, no reload, no re-read after a
//      write, and the documented list of remaining one-time reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";
import { friendlyErrorMessage, isFirebaseError, liveErrorKind, liveErrorMessage } from "../src/services/liveDataErrors.js";
import { UserMessageError } from "../src/services/userMessageError.js";
import { ACCESS_LOADING, accessAfterProfileError, accessFromProfile, watchRouteAccess } from "../src/services/liveRouteAccess.js";
import { formSignature, reconcileLiveForm } from "../src/services/liveFormSync.js";
import { acceptLiveLine, cartBatchIds, cartReview, lineReview, liveCartLines } from "../src/services/cartLiveStock.js";
import { buildAssignmentQueue, pageOf } from "../src/services/assignmentQueue.js";
import { buildConfirmationFromOrder, CONFIRMATION_LIFECYCLE_FIELDS, withLiveLifecycle } from "../src/services/orderConfirmation.js";
import { OFFLINE_MESSAGE, readOnlineStatus, subscribeOnlineStatus } from "../src/components/shell/onlineStatus.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const fbError = (code, message = `raw firebase text for ${code}`) => {
  const e = new Error(message);
  e.name = "FirebaseError";
  e.code = code;
  return e;
};

// ======================================================================
// 1. Pure modules
// ======================================================================

test("errors: permission denied is never phrased as an empty result", () => {
  const msg = liveErrorMessage(fbError("permission-denied"), "orders");
  // Says what is refused and what to do next (approved wording, 2026-10-11).
  assert.equal(
    msg,
    "You do not have permission to view orders. Contact an administrator if you believe this is incorrect."
  );
  assert.match(msg, /^You do not have permission to view orders\./);
  assert.doesNotMatch(msg, /no orders|nothing|empty|no records|not found/i);
  assert.doesNotMatch(msg, /raw firebase text|permission-denied/);
});

test("errors: each failure kind has its own message and never leaks Firebase text", () => {
  const cases = [
    [fbError("permission-denied"), "permission"],
    [fbError("unauthenticated"), "signed-out"],
    [fbError("unavailable"), "offline"],
    [fbError("deadline-exceeded"), "offline"],
    [fbError("failed-precondition", "The query requires an index. You can create it here: https://console…"), "index"],
    [fbError("failed-precondition", "something else"), "generic"],
    [fbError("not-found"), "not-found"],
    [fbError("internal"), "generic"],
    [new Error("boom"), "generic"],
  ];
  const seen = new Set();
  for (const [err, kind] of cases) {
    assert.equal(liveErrorKind(err), kind, err.code || err.message);
    const msg = liveErrorMessage(err, "the dispatch queue");
    assert.doesNotMatch(msg, /raw firebase text|https:\/\/|requires an index/, `no raw text for ${kind}`);
    seen.add(msg);
  }
  assert.match(liveErrorMessage(fbError("unavailable"), "orders"), /server could not be reached/);
  assert.match(liveErrorMessage(fbError("failed-precondition", "needs an index"), "orders"), /index is missing/);
  assert.match(liveErrorMessage(fbError("unauthenticated"), "orders"), /session has ended/i);
  assert.match(liveErrorMessage(fbError("not-found"), "the invoice"), /no longer exists/);
  assert.ok(seen.size >= 6, "the kinds read differently");
});

test("errors: write failures keep the app's own wording and replace Firebase's", () => {
  class AssignmentError extends UserMessageError {
    constructor(code, message) { super(message); this.name = "AssignmentError"; this.code = code; }
  }
  // A trusted domain error whose code happens to share a Firebase word keeps its message.
  assert.equal(friendlyErrorMessage(new AssignmentError("not-found", "That rider is gone."), "x"), "That rider is gone.");
  assert.equal(isFirebaseError(new AssignmentError("permission-denied", "…")), false);
  // The app's own validation errors keep theirs — they are UserMessageErrors.
  assert.equal(friendlyErrorMessage(new UserMessageError("Batch ID already exists."), "x"), "Batch ID already exists.");
  // A PLAIN Error is never trusted, however harmless its text looks.
  assert.equal(friendlyErrorMessage(new Error("Batch ID already exists."), "Fallback."), "Fallback.");
  // Firebase's never surface; the permission message is actionable.
  assert.equal(
    friendlyErrorMessage(fbError("permission-denied"), "x"),
    "You do not have permission to perform this action. Contact an administrator if you believe this is incorrect."
  );
  assert.doesNotMatch(friendlyErrorMessage(fbError("permission-denied"), "x"), /raw firebase text/);
  assert.equal(friendlyErrorMessage(fbError("internal"), "Failed to save."), "Failed to save.");
  assert.equal(friendlyErrorMessage({ code: "functions/internal", message: "INTERNAL" }, "Failed."), "Failed.");
  assert.equal(
    friendlyErrorMessage({ code: "unavailable", message: "Failed to get document because the client is offline." }, "x"),
    "We couldn't reach the server, so nothing was saved. Check your connection and try again."
  );
  assert.equal(friendlyErrorMessage(null, "Fallback."), "Fallback.");
});

// ---------------------------------------------------------- route access

function fakeAuthAndProfiles() {
  const authListeners = new Set();
  const profileListeners = new Map(); // uid -> Set<{onProfile,onError}>
  let unsubscribedProfiles = 0;
  return {
    subscribeAuth: (cb) => {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
    subscribeProfile: (uid, onProfile, onError) => {
      const entry = { onProfile, onError };
      if (!profileListeners.has(uid)) profileListeners.set(uid, new Set());
      profileListeners.get(uid).add(entry);
      return () => {
        unsubscribedProfiles += 1;
        profileListeners.get(uid)?.delete(entry);
      };
    },
    signIn: (uid) => authListeners.forEach((cb) => cb(uid ? { uid } : null)),
    profile: (uid, data) => profileListeners.get(uid)?.forEach((l) => l.onProfile(data)),
    profileError: (uid, error) => profileListeners.get(uid)?.forEach((l) => l.onError(error)),
    openProfiles: () => [...profileListeners.values()].reduce((n, s) => n + s.size, 0),
    authCount: () => authListeners.size,
    unsubscribedProfiles: () => unsubscribedProfiles,
  };
}

test("route access: a role or status change applies without a refresh", () => {
  const f = fakeAuthAndProfiles();
  const states = [];
  const stop = watchRouteAccess({ ...f, requiredRole: "dispatcher", onChange: (s) => states.push(s) });

  f.signIn("u1");
  assert.equal(states.length, 0, "nothing decided before the profile arrives (renders null)");
  f.profile("u1", { role: "dispatcher", status: "approved" });
  assert.deepEqual(states.at(-1), { state: "allowed", redirectTo: "/login" });

  // An admin moves this account to Med Rep in another browser.
  f.profile("u1", { role: "salesrep", status: "approved" });
  assert.equal(states.at(-1).state, "redirect");
  assert.equal(states.at(-1).redirectTo, "/sales-rep", "routed by the new role, same resolver");

  // …and back, then disabled.
  f.profile("u1", { role: "dispatcher", status: "approved" });
  assert.equal(states.at(-1).state, "allowed");
  f.profile("u1", { role: "dispatcher", status: "disabled" });
  assert.deepEqual(states.at(-1), { state: "redirect", redirectTo: "/login" });

  stop();
  assert.equal(f.openProfiles(), 0, "cleanup closes the profile listener");
  assert.equal(f.authCount(), 0, "cleanup closes the auth listener");
});

test("route access: sign-out removes the profile listener; a new user starts from loading", () => {
  const f = fakeAuthAndProfiles();
  const states = [];
  const stop = watchRouteAccess({ ...f, requiredRole: "admin", onChange: (s) => states.push(s) });
  f.signIn("a1");
  f.profile("a1", { role: "admin", status: "approved" });
  assert.equal(f.openProfiles(), 1);

  f.signIn(null);
  assert.equal(f.openProfiles(), 0, "no listener survives sign-out");
  assert.deepEqual(states.at(-1), { state: "redirect", redirectTo: "/login" });
  // A late snapshot for the old account changes nothing.
  f.profile("a1", { role: "admin", status: "approved" });
  assert.equal(states.at(-1).state, "redirect");

  f.signIn("a2");
  assert.deepEqual(states.at(-1), ACCESS_LOADING, "another account never inherits the previous decision");
  f.profile("a2", { role: "admin", status: "approved" });
  assert.equal(states.at(-1).state, "allowed");
  assert.equal(f.openProfiles(), 1, "exactly one profile listener at a time");

  // The same user re-announced (e.g. a token refresh) does not re-subscribe.
  const before = f.unsubscribedProfiles();
  f.signIn("a2");
  assert.equal(f.unsubscribedProfiles(), before);
  assert.equal(f.openProfiles(), 1);
  stop();
});

test("route access: a dropped connection keeps an open session, any other failure fails closed", () => {
  const allowed = accessFromProfile({ role: "admin", status: "approved" }, "admin");
  assert.equal(accessAfterProfileError(allowed, { code: "unavailable" }), allowed);
  assert.deepEqual(accessAfterProfileError(allowed, { code: "permission-denied" }), { state: "redirect", redirectTo: "/login" });
  assert.deepEqual(accessAfterProfileError(ACCESS_LOADING, { code: "unavailable" }), { state: "redirect", redirectTo: "/login" });
  assert.deepEqual(accessFromProfile(null, "admin").state, "redirect", "a missing profile is not access");

  const f = fakeAuthAndProfiles();
  const states = [];
  watchRouteAccess({ ...f, requiredRole: "admin", onChange: (s) => states.push(s) });
  f.signIn("a1");
  f.profile("a1", { role: "admin", status: "approved" });
  f.profileError("a1", { code: "permission-denied" });
  assert.deepEqual(states.at(-1), { state: "redirect", redirectTo: "/login" });
});

test("route guards use the shared watcher and keep their render contract", () => {
  for (const [file, role] of [["AdminRoute.jsx", "ADMIN"], ["DispatcherRoute.jsx", "DISPATCHER"], ["SalesRepRoute.jsx", "SALES_REP"]]) {
    const src = strip(read("src", "components", file));
    assert.match(src, new RegExp(`watchRouteAccess\\(\\{[\\s\\S]*requiredRole: ROLES\\.${role}`), file);
    assert.match(src, /onSnapshot\(\s*doc\(db, "users", uid\)/, `${file}: the profile is watched`);
    assert.equal(/getDoc\(/.test(src), false, `${file}: no one-time profile read remains`);
    assert.match(src, /if \(state === "loading"\) return null;/);
  }
});

// ---------------------------------------------------------- live forms

test("live form: a clean form follows the server; unsaved edits are never overwritten", () => {
  const seeded = { customerName: "Clinic A", items: [{ key: "it-1", quantity: 2 }] };
  const baseline = formSignature(seeded, { status: "draft" });
  // Row keys are regenerated on every seed and must not count as a change.
  assert.equal(formSignature({ ...seeded, items: [{ key: "it-99", quantity: 2 }] }, { status: "draft" }), baseline);

  const changed = formSignature({ ...seeded, customerName: "Clinic A (corrected)" }, { status: "draft" });
  assert.equal(reconcileLiveForm({ dirty: false, busy: false, baselineKey: baseline, serverKey: baseline }), "same");
  assert.equal(reconcileLiveForm({ dirty: false, busy: false, baselineKey: baseline, serverKey: changed }), "seed");
  assert.equal(reconcileLiveForm({ dirty: true, busy: false, baselineKey: baseline, serverKey: changed }), "stale", "edits kept; the page says newer data exists");
  assert.equal(reconcileLiveForm({ dirty: true, busy: true, baselineKey: baseline, serverKey: changed }), "defer", "our own save is settling");
  // Issued elsewhere is a change even when the fields are identical.
  assert.notEqual(formSignature(seeded, { status: "issued" }), baseline);
  // After our own save the baseline is reset, so the stored version is taken.
  assert.equal(reconcileLiveForm({ dirty: false, busy: false, baselineKey: null, serverKey: baseline }), "seed");
});

test("InvoiceEditor follows the order and invoice live and protects unsaved edits", () => {
  const src = read("src", "pages", "admin", "InvoiceEditor.jsx");
  const code = strip(src);
  assert.match(code, /subscribeOrder\(\s*orderId,/);
  assert.match(code, /subscribeInvoice\(\s*orderId,/);
  assert.match(code, /return \(\) => \{\s*active = false;\s*unsubOrder\(\);\s*unsubInvoice\(\);\s*\};/, "both listeners close on unmount / retry");
  assert.match(code, /\}, \[orderId, reloadKey, applyServer\]\);/, "a different order replaces the listeners");
  assert.equal(/getInvoiceByOrderId|getOrderById/.test(code), false, "no re-read after a save or issue");
  assert.match(code, /reconcileLiveForm\(\{/);
  assert.match(src, /This invoice was changed in another session\. Your unsaved edits are still here/);
  assert.match(code, /onClick=\{loadLatest\}/, "newer data is loaded only on the admin's request");
  // Every edit path marks the form dirty through the ref-backed helper.
  assert.equal((code.match(/markDirty\(\);/g) || []).length, 4);
  // Duplicate submissions are refused while a save or issue is in flight.
  assert.match(code, /if \(saving \|\| readOnly \|\| busyRef\.current\) return;/);
  assert.match(code, /if \(issuing \|\| busyRef\.current\) return;/);
  assert.equal(/err\.message \|\|/.test(code), false, "no raw error text");
});

// ---------------------------------------------------------- live cart

const TODAY = "2026-10-11";
const cartLine = (inventoryId, quantity, expectedUnitPriceCentavos, availableNow) => ({
  inventoryId, sku: inventoryId.toUpperCase(), name: inventoryId, chain: "Cold Chain", quantity, expectedUnitPriceCentavos, availableNow,
});
const batch = (id, quantity, price, extra = {}) => ({
  id, quantity, reservedQuantity: 0, sellingPriceCentavos: price, priceIsVatInclusive: true, status: "Stable", expiryDate: "2027-12-31", ...extra,
});

test("live cart: current stock and price are shown, the cart itself is never changed", () => {
  const cart = [cartLine("b1", 10, 12500, 40), cartLine("b2", 5, 30000, 8), cartLine("b3", 1, 5000, 2)];

  // Not loaded yet (or the listener failed): exactly what the catalog showed.
  const before = liveCartLines(cart, null, TODAY);
  assert.deepEqual(before.map((l) => l.availableNow), [40, 8, 2]);
  assert.ok(before.every((l) => lineReview(l) === null));

  // Snapshot 1: b1 sold down below the line, b2 repriced, b3 removed.
  const s1 = liveCartLines(cart, [batch("b1", 3, 12500), batch("b2", 8, 32000)], TODAY);
  assert.equal(s1[0].availableNow, 3, "stock now, not when added");
  assert.equal(s1[0].stockShortNow, true);
  assert.equal(s1[1].priceChanged, true);
  assert.equal(s1[1].livePriceCentavos, 32000);
  assert.equal(s1[1].expectedUnitPriceCentavos, 30000, "the price the server will check is untouched");
  assert.equal(s1[2].batchGone, true);
  assert.deepEqual(s1.map(lineReview), ["accept-stock", "accept-price", "remove"]);
  assert.deepEqual(s1.map((l) => l.quantity), [10, 5, 1], "quantities never move");

  // Snapshot 2: restocked, price back, batch back.
  const s2 = liveCartLines(cart, [batch("b1", 50, 12500), batch("b2", 8, 30000), batch("b3", 2, 5000)], TODAY);
  assert.deepEqual(s2.map(lineReview), [null, null, null]);

  // A batch the server will no longer sell, or one without a price, must go.
  const expired = liveCartLines([cart[0]], [batch("b1", 5, 12500, { expiryDate: "2026-01-01" })], TODAY);
  assert.ok(expired[0].liveBlockedReason);
  assert.equal(lineReview(expired[0]), "remove");
  const unpriced = liveCartLines([cart[0]], [batch("b1", 50, undefined)], TODAY);
  assert.equal(lineReview(unpriced[0]), "remove", "no price is never accepted as a price");

  // A shortfall the rep already saw (and accepted as a future order) is not new.
  const known = liveCartLines([cartLine("b1", 10, 12500, 4)], [batch("b1", 2, 12500)], TODAY);
  assert.equal(known[0].stockShortNow, false);
});

test("checkout gate: finalizing is blocked until every changed line is reviewed", () => {
  const cart = [cartLine("b1", 10, 12500, 40), cartLine("b2", 5, 30000, 8)];
  // The listener watches exactly the cart's batches: de-duplicated, sorted, id-less lines skipped.
  assert.deepEqual(cartBatchIds([...cart, cartLine("b1", 1, 12500, 40), { sku: "OLD", quantity: 1 }]), ["b1", "b2"]);
  const changed = liveCartLines(cart, [batch("b1", 40, 12500), batch("b2", 8, 32000)], TODAY);

  assert.deepEqual(cartReview(liveCartLines(cart, null, TODAY), "loading"), { checking: true, unverified: false, pending: [], blocked: true }, "blocked while the current prices are being read");
  const gate = cartReview(changed, "live");
  assert.equal(gate.blocked, true);
  assert.deepEqual(gate.pending.map((l) => l.inventoryId), ["b2"], "the affected item is identified");

  // A failed check does not block — the server re-checks every price — but says so.
  const failed = cartReview(liveCartLines(cart, null, TODAY), "failed");
  assert.equal(failed.blocked, false);
  assert.equal(failed.unverified, true);
  assert.equal(cartReview([], "loading").blocked, false, "an empty cart is not 'checking'");

  // Accepting is explicit and touches only that line's expected price.
  const accepted = acceptLiveLine(cart, changed[1]);
  assert.equal(accepted[1].expectedUnitPriceCentavos, 32000);
  assert.equal(accepted[1].quantity, 5);
  assert.equal(accepted[0], cart[0], "other lines are the same objects");
  assert.equal(cart[1].expectedUnitPriceCentavos, 30000, "the input cart is not mutated");
  const after = liveCartLines(accepted, [batch("b1", 40, 12500), batch("b2", 8, 32000)], TODAY);
  assert.equal(cartReview(after, "live").blocked, false, "reviewed — finalizing is allowed again");

  // A line that must be removed cannot be "accepted".
  const gone = liveCartLines(cart, [batch("b1", 40, 12500)], TODAY);
  assert.equal(acceptLiveLine(cart, gone[1]), cart);
  assert.equal(cartReview(gone, "live").blocked, true);
  assert.equal(cartReview(liveCartLines([cart[0]], [batch("b1", 40, 12500)], TODAY), "live").blocked, false, "removed — unblocked");

  // Acknowledging a new shortfall records the stock now seen; the quantity stays.
  const short = liveCartLines([cart[0]], [batch("b1", 3, 12500)], TODAY);
  const ack = acceptLiveLine([cart[0]], short[0]);
  assert.equal(ack[0].availableNow, 3);
  assert.equal(ack[0].quantity, 10);
  assert.equal(cartReview(liveCartLines(ack, [batch("b1", 3, 12500)], TODAY), "live").blocked, false);
});

test("Place Order watches only the cart's batches and gates Finalize on the review", () => {
  const code = strip(read("src", "pages", "salesRep", "SalesRepPlaceOrder.jsx"));
  // The cart's listeners live in useCartLiveStock; the page only reads them.
  const live = strip(read("src", "pages", "salesRep", "useCartLiveStock.js"));
  for (const src of [code, live]) {
    assert.equal(/subscribeInventory\(/.test(src), false, "never the whole inventory collection");
  }
  assert.match(code, /= useCartLiveStock\(items\);/);
  assert.match(live, /const batchIdsKey = cartBatchIds\(items\)\.join\("\|"\);/);
  assert.match(live, /if \(!batchIdsKey\) return undefined;\s*return subscribeInventoryBatches\(\s*batchIdsKey\.split\("\|"\),/);
  assert.match(live, /\}, \[batchIdsKey\]\);/, "replaced when the cart's set of batches changes");
  assert.doesNotMatch(live, /setItems|acceptLiveLine/, "the listeners never edit the cart");
  assert.match(code, /const review = cartReview\(displayItems, liveStatus\);/);
  // Blocked both on the button and inside the handler.
  assert.match(code, /!selectedDestination \|\|\s*review\.blocked \|\|\s*!pricingCheck\.ok\s*\}/);
  assert.match(code, /if \(review\.blocked\) \{\s*submittingRef\.current = false;/);
  // The only cart write from live data is the rep's explicit acceptance.
  assert.match(code, /const handleAcceptLine = \(line\) => setItems\(\(current\) => acceptLiveLine\(current, line\)\);/);
  assert.equal((code.match(/acceptLiveLine\(/g) || []).length, 1);
  assert.match(code, /onAccept=\{\(\) => handleAcceptLine\(item\)\}/);
  // The server still decides: the submission carries the cart's expected
  // prices — reviewed in the price-review state, sent from that review.
  const priceState = strip(read("src", "pages", "salesRep", "useCheckoutPriceReview.js"));
  assert.match(priceState, /expectedUnitPriceCentavos: item\.expectedUnitPriceCentavos/);
  assert.match(code, /\.\.\.negotiatedRequestLine\(item, reviewByBatch\.get\(item\.inventoryId\)\.price\)/);
  assert.match(code, /createOrderWithReservation\(\{/);
});

// ---------------------------------------------------------- queue + online

test("assignment queue: a new order appears and an assigned one leaves, filters and page kept", () => {
  const now = new Date("2026-10-11T02:00:00Z");
  const order = (id, extra = {}) => ({ id, status: "pending_dispatch", requestedDeliveryDate: "2026-10-11", priority: "Standard", items: [], ...extra });
  const s1 = [order("o1"), order("o2", { priority: "Urgent" })];
  assert.deepEqual(buildAssignmentQueue({ orders: s1, now, filter: "urgent" }).map((o) => o.id), ["o2"]);

  // Another browser places an urgent order: it appears under the same filter.
  const s2 = [...s1, order("o3", { priority: "Urgent" })];
  assert.deepEqual(buildAssignmentQueue({ orders: s2, now, filter: "urgent" }).map((o) => o.id).sort(), ["o2", "o3"]);

  // Another dispatcher assigns o2: the pending snapshot no longer carries it.
  const s3 = s2.filter((o) => o.id !== "o2");
  assert.deepEqual(buildAssignmentQueue({ orders: s3, now, filter: "urgent" }).map((o) => o.id), ["o3"]);

  // The page stays on a real page when rows leave.
  const many = Array.from({ length: 21 }, (_, i) => order(`p${i}`));
  assert.equal(pageOf(buildAssignmentQueue({ orders: many, now }), 3).page, 3);
  assert.equal(pageOf(buildAssignmentQueue({ orders: many.slice(0, 15), now }), 3).page, 2, "clamped, not blank");
});

test("offline: the shells say so, and the online signal is followed", () => {
  const listeners = {};
  const win = {
    navigator: { onLine: true },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; },
  };
  let changes = 0;
  const stop = subscribeOnlineStatus(win, () => { changes += 1; });
  assert.equal(readOnlineStatus(win), true);
  win.navigator.onLine = false;
  listeners.offline();
  assert.equal(readOnlineStatus(win), false);
  win.navigator.onLine = true;
  listeners.online();
  assert.equal(changes, 2);
  stop();
  assert.deepEqual(Object.keys(listeners), [], "unsubscribed");
  assert.equal(readOnlineStatus(null), true, "unknown counts as online");
  assert.match(OFFLINE_MESSAGE, /last data received/);

  for (const shell of [
    ["src", "components", "admin", "AdminShell.jsx"],
    ["src", "pages", "dispatcher", "DispatcherLayout.jsx"],
    ["src", "pages", "salesRep", "SalesRepShell.jsx"],
  ]) {
    assert.match(read(...shell), /<OfflineNotice \/>/, shell.at(-1));
  }
  assert.match(read("src", "components", "shell", "OfflineNotice.jsx"), /createPortal\(/, "outside the shells' layout containers");
});

// ======================================================================
// 2. Real services against a multi-snapshot stand-in
// ======================================================================

const LIVE_STANDIN = `
const __live = (globalThis.__vaxLive = globalThis.__vaxLive || { listeners: new Set() });
const __val = (v) => (v && typeof v === "object" && "__ms" in v ? v.__ms : v);
const __cmp = (a, b) => { const x = __val(a); const y = __val(b); return x < y ? -1 : x > y ? 1 : 0; };
const __test = (data, c) => {
  const v = data[c.field];
  switch (c.op) {
    case "==": return v === c.value;
    case ">=": return __cmp(v, c.value) >= 0;
    case "<": return __cmp(v, c.value) < 0;
    case "in": return c.value.includes(v);
    case "array-contains": return Array.isArray(v) && v.includes(c.value);
    default: return true;
  }
};
const __query = (ref) => {
  const clauses = ref.__clauses || [];
  let rows = Object.entries(col(ref.__col)).map(([id, rec]) => ({ id, rec }));
  for (const c of clauses) {
    if (c && c.__t === "where") rows = rows.filter((r) => (c.field === "__name__" ? c.value.includes(r.id) : __test(r.rec.data, c)));
  }
  const ob = clauses.find((c) => c && c.__t === "orderBy");
  if (ob) {
    const [field, dir = "asc"] = ob.a;
    rows.sort((p, q) => (dir === "desc" ? -1 : 1) * __cmp(p.rec.data[field], q.rec.data[field]));
  }
  const lim = clauses.find((c) => c && c.__t === "limit");
  if (lim) rows = rows.slice(0, lim.n);
  const docs = rows.map(({ id, rec }) => ({ id, data: () => ({ ...rec.data }), exists: () => true }));
  return { docs, empty: docs.length === 0, size: docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
};
const __emit = (l) => {
  if (!l.active) return;
  l.next(l.ref.__id !== undefined ? snapOf(l.ref.__col, l.ref.__id) : __query(l.ref));
};
__live.emitAll = () => { for (const l of [...__live.listeners]) __emit(l); };
__live.fail = (pred, error) => {
  for (const l of [...__live.listeners]) {
    if (!pred(l.ref)) continue;
    l.active = false;
    __live.listeners.delete(l);
    if (l.err) l.err(error);
  }
};
export const onSnapshot = (ref, next, err) => {
  const l = { ref, next: typeof next === "function" ? next : next.next, err, active: true };
  __live.listeners.add(l);
  __emit(l);
  return () => { l.active = false; __live.listeners.delete(l); };
};
export const startAfter = (c) => ({ __t: "startAfter", c });
export const documentId = () => "__name__";
export const deleteDoc = async (ref) => { delete col(ref.__col)[ref.__id]; __live.emitAll(); };
`;

const loader = createServiceLoader();
{
  const path = join(loader.dir, "__firestore.mjs");
  const base = readFileSync(path, "utf8");
  const withoutOnce = base.replace(/export const onSnapshot = \(ref, next, _err\) => \{[\s\S]*?return \(\) => \{\};\n\};\n/, "");
  assert.notEqual(withoutOnce, base, "the single-shot onSnapshot was replaced");
  // Every write re-delivers to the open listeners, as Firestore does.
  const live = withoutOnce.replaceAll("S().writes.push(", "queueMicrotask(() => globalThis.__vaxLive.emitAll()); S().writes.push(");
  writeFileSync(path, live + LIVE_STANDIN);
}
const historyService = await loader.load("orderHistoryService.js");
const invoiceService = await loader.load("invoiceService.js");
const alertService = await loader.load("alertService.js");
const vaccineService = await loader.load("vaccineService.js");
const userService = await loader.load("userService.js");
const inventoryService = await loader.load("inventoryService.js");

const ts = (ms) => ({ __ms: ms, toMillis() { return this.__ms; } });
const settle = () => new Promise((r) => setTimeout(r, 0));
function fresh(seed, user = { uid: "admin1", email: "admin@x.com" }) {
  globalThis.__vaxLive?.listeners.clear();
  const store = installStore(createStore(seed), user);
  // A write made by ANOTHER browser: straight into the store, then delivered.
  const external = (colName, id, data) => {
    store.collections[colName] ??= {};
    const rec = store.collections[colName][id];
    store.collections[colName][id] = { data: { ...(rec?.data ?? {}), ...data }, version: (rec?.version ?? 0) + 1 };
    globalThis.__vaxLive.emitAll();
  };
  return { store, external, open: () => globalThis.__vaxLive.listeners.size };
}

test("order history window: a new order appears at the top and a status change shows in its row", async () => {
  const { external, open } = fresh({
    orders: {
      o1: { orderNumber: "VT-1", createdByUid: "rep1", createdAt: ts(1000), status: "pending_dispatch" },
      o2: { orderNumber: "VT-2", createdByUid: "rep1", createdAt: ts(2000), status: "pending_dispatch" },
      x9: { orderNumber: "VT-9", createdByUid: "rep2", createdAt: ts(3000), status: "pending_dispatch" },
    },
  });
  const snaps = [];
  const stop = historyService.subscribeOrderHistoryWindow({ medRepUid: "rep1", size: 2 }, (s) => snaps.push(s));
  assert.deepEqual(snaps.at(-1).orders.map((o) => o.id), ["o2", "o1"], "newest first, own orders only");
  assert.equal(snaps.at(-1).hasMore, true, "a full window may have older orders");

  external("orders", "o3", { orderNumber: "VT-3", createdByUid: "rep1", createdAt: ts(4000), status: "pending_dispatch" });
  assert.deepEqual(snaps.at(-1).orders.map((o) => o.id), ["o3", "o2"], "the new order arrives without a reload");

  external("orders", "o2", { status: "assigned" });
  assert.equal(snaps.at(-1).orders.find((o) => o.id === "o2").status, "assigned", "a dispatcher's change reaches the row");

  // Another rep's order never enters this rep's window.
  external("orders", "x10", { createdByUid: "rep2", createdAt: ts(9000) });
  assert.ok(snaps.at(-1).orders.every((o) => o.createdByUid === "rep1"));

  // "Load older orders": a larger window replaces the listener.
  stop();
  assert.equal(open(), 0, "the old listener is closed");
  const count = snaps.length;
  external("orders", "o4", { createdByUid: "rep1", createdAt: ts(5000) });
  assert.equal(snaps.length, count, "a closed listener hears nothing");
  const bigger = [];
  const stop2 = historyService.subscribeOrderHistoryWindow({ medRepUid: "rep1", size: 4 }, (s) => bigger.push(s));
  assert.deepEqual(bigger.at(-1).orders.map((o) => o.id), ["o4", "o3", "o2", "o1"]);
  assert.equal(bigger.at(-1).hasMore, true);
  stop2();
});

test("order history window: a refused listener reports through onError, not as an empty list", () => {
  fresh({ orders: { o1: { createdByUid: "rep1", createdAt: ts(1) } } });
  const got = [];
  const errors = [];
  historyService.subscribeOrderHistoryWindow({ medRepUid: "rep1", size: 25 }, (s) => got.push(s), (e) => errors.push(e));
  globalThis.__vaxLive.fail((ref) => ref.__col === "orders", fbError("permission-denied"));
  assert.equal(errors.length, 1);
  assert.equal(got.length, 1, "no empty snapshot is fabricated after the failure");
});

test("Med Rep filter list is live", () => {
  const { external } = fresh({ users: { r1: { role: "salesrep", name: "Ana" }, d1: { role: "dispatcher", name: "Dan" } } });
  const lists = [];
  const stop = historyService.subscribeMedReps((l) => lists.push(l));
  assert.deepEqual(lists.at(-1).map((m) => m.label), ["Ana"]);
  external("users", "r2", { role: "salesrep", name: "Ben" });
  assert.deepEqual(lists.at(-1).map((m) => m.label), ["Ana", "Ben"]);
  stop();
});

test("invoice: a draft saved and issued in another browser reaches the open editor", () => {
  const { external } = fresh({ invoices: {} });
  const seen = [];
  const stop = invoiceService.subscribeInvoice("orderA", (inv) => seen.push(inv));
  assert.equal(seen.at(-1), null, "no invoice yet is null, not an error");
  external("invoices", "orderA", { orderId: "orderA", invoiceStatus: "draft", customerName: "Clinic A", id: "SHADOW" });
  assert.equal(seen.at(-1).invoiceStatus, "draft");
  assert.equal(seen.at(-1).id, "orderA", "the document id wins over a stored id");
  external("invoices", "orderA", { invoiceStatus: "issued", invoiceNumber: "INV-2026-000001" });
  assert.equal(seen.at(-1).invoiceStatus, "issued");
  stop();
});

test("order confirmation: only the lifecycle is live — the financial record stays as placed", () => {
  const placed = {
    id: "ord1",
    orderNumber: "VT-7",
    status: "pending_dispatch",
    pricingVersion: 1,
    priceIsVatInclusive: true,
    subtotalCentavos: 37500,
    allocationVersion: 2,
    allocationState: "partially_reserved",
    items: [
      { inventoryId: "b1", name: "Hep B", batchId: "B1", quantity: 2, unitPriceCentavos: 12500, lineTotalCentavos: 25000, vatClassification: "vatable", reservedQuantity: 2, backorderedQuantity: 0 },
      { inventoryId: "b2", name: "Rabies", batchId: "B2", quantity: 1, unitPriceCentavos: 12500, lineTotalCentavos: 12500, vatClassification: "vat_exempt", reservedQuantity: 0, backorderedQuantity: 1 },
    ],
  };
  const record = buildConfirmationFromOrder(placed);

  // Later: assigned and fully reserved — and, hypothetically, every financial
  // field different (a catalog repricing must never reach the confirmation).
  const later = {
    ...placed,
    status: "assigned",
    allocationState: "fully_reserved",
    subtotalCentavos: 99999,
    priceIsVatInclusive: false,
    items: placed.items.map((it) => ({
      ...it, name: "Renamed", quantity: 9, unitPriceCentavos: 1, lineTotalCentavos: 9, vatClassification: "zero_rated",
      reservedQuantity: it.quantity, backorderedQuantity: 0,
    })),
  };
  const shown = withLiveLifecycle(record, later);

  assert.deepEqual(CONFIRMATION_LIFECYCLE_FIELDS, ["status", "allocation"]);
  assert.equal(shown.status, "assigned", "status follows the order");
  assert.deepEqual(shown.allocation, buildConfirmationFromOrder(later).allocation, "reservation progress follows the order");
  assert.deepEqual(shown.items.map((it) => it.reservedQuantity), [2, 1]);
  assert.deepEqual(shown.items.map((it) => it.backorderedQuantity), [0, 0]);

  // The financial record is exactly what was placed.
  for (const field of ["subtotalCentavos", "priceIsVatInclusive", "priceCurrency", "orderNumber", "clinicName", "requestedDeliveryDate", "priority"]) {
    assert.deepEqual(shown[field], record[field], field);
  }
  const money = (it) => ({ name: it.name, quantity: it.quantity, unitPriceCentavos: it.unitPriceCentavos, lineTotalCentavos: it.lineTotalCentavos, vatLabel: it.vatLabel, sku: it.sku });
  assert.deepEqual(shown.items.map(money), record.items.map(money), "items, quantities, prices and VAT unchanged");

  // A different order, an unverified record, or a reshaped line list changes nothing financial.
  assert.equal(withLiveLifecycle(record, { ...later, id: "other" }), record);
  const unverified = { verified: false, id: "ord1", orderNumber: "VT-7" };
  assert.equal(withLiveLifecycle(unverified, later), unverified);
  const reshaped = withLiveLifecycle(record, { ...later, items: later.items.slice(0, 1) });
  assert.deepEqual(reshaped.items, record.items, "no per-line mixing when the lines no longer correspond");
  assert.equal(reshaped.status, "assigned");
});

test("order confirmation page: lifecycle overlay from the live order; nothing from inventory or the catalog", () => {
  const { external } = fresh({
    orders: { ord1: { orderNumber: "VT-7", status: "pending_dispatch", createdByUid: "rep1", items: [{ name: "Hep B", quantity: 2, unitPriceCentavos: 100 }] } },
  });
  const record = buildConfirmationFromOrder({ id: "ord1", orderNumber: "VT-7", status: "pending_dispatch", items: [{ name: "Hep B", quantity: 2, unitPriceCentavos: 100 }] });
  const seen = [];
  const stop = historyService.subscribeOrder("ord1", (o) => seen.push(o));
  external("orders", "ord1", { status: "in_transit", items: [{ name: "Hep B", quantity: 2, unitPriceCentavos: 999 }] });
  const shown = withLiveLifecycle(record, seen.at(-1));
  assert.equal(shown.status, "in_transit");
  assert.equal(shown.items[0].unitPriceCentavos, 100, "the agreed price, not a later figure");
  stop();

  const page = strip(read("src", "pages", "salesRep", "SalesRepOrderConfirmation.jsx"));
  assert.match(page, /subscribeOrder\(\s*id,/);
  assert.match(page, /toDisplay\(withLiveLifecycle\(savedRecord, live\.doc\)\)/);
  assert.equal(/buildConfirmationFromOrder\(/.test(page), false, "the page never rebuilds the record from the live order");
  assert.equal(/subscribeInventory|subscribeVaccines|inventoryService|vaccineCatalogService/.test(page), false, "no inventory or catalog source");
  assert.match(page, /\}, \[stored\.verified, stored\.orderId\]\);/);
  const builder = strip(read("src", "services", "orderConfirmation.js"));
  assert.equal(/import[^;]*(inventory|vaccineCatalog|firebase)/i.test(builder), false, "the record is built only from the order");

  // Order History: the receipt's money comes from the immutable receipt document.
  const detail = strip(read("src", "components", "history", "OrderHistoryDetail.jsx"));
  const receiptFn = detail.slice(detail.indexOf("function Receipt("), detail.indexOf("function", detail.indexOf("function Receipt(") + 10));
  assert.equal(/\border\./.test(receiptFn), false, "the receipt never reads the live order");
  assert.match(detail, /<Receipt receipt=\{row\.receipt\}/);
});

test("cart batches: the listener reads only the named batches, in groups Firestore accepts", async () => {
  const seed = { inventory: {} };
  for (let i = 0; i < 35; i += 1) seed.inventory[`b${i}`] = { quantity: 10, reservedQuantity: 0, sellingPriceCentavos: 100 };
  seed.inventory.other = { quantity: 1, sellingPriceCentavos: 1 };
  const { external, open } = fresh(seed, { uid: "rep1" });

  const got = [];
  const ids = Array.from({ length: 32 }, (_, i) => `b${i}`).concat(["b0", "missing"]);
  const stop = inventoryService.subscribeInventoryBatches(ids, (b) => got.push(b));
  assert.equal(open(), 2, "33 unique ids → two `in` groups of at most 30");
  const listened = [...globalThis.__vaxLive.listeners].map((l) => l.ref.__clauses.find((c) => c.__t === "where"));
  assert.ok(listened.every((w) => w.field === "__name__" && w.op === "in" && w.value.length <= inventoryService.BATCH_IN_LIMIT));
  assert.equal(got.length, 1, "delivered once both groups reported");
  assert.equal(got.at(-1).length, 32, "only the named batches; a missing id is simply absent");
  assert.ok(!got.at(-1).some((b) => b.id === "other"));

  external("inventory", "b5", { sellingPriceCentavos: 250 });
  assert.equal(got.at(-1).find((b) => b.id === "b5").sellingPriceCentavos, 250, "a price change reaches the cart");

  stop();
  assert.equal(open(), 0, "one unsubscribe closes every group");

  // One failing group reports once.
  fresh(seed, { uid: "rep1" });
  const errors = [];
  inventoryService.subscribeInventoryBatches(ids, () => {}, (e) => errors.push(e));
  globalThis.__vaxLive.fail((ref) => ref.__col === "inventory", fbError("permission-denied"));
  assert.equal(errors.length, 1);
});

test("alerts: a refused listener reaches the page's error callback", () => {
  fresh({ alerts: { a1: { status: "active", createdAt: ts(1) } } });
  for (const subscribe of [alertService.subscribeAllAlerts, alertService.subscribeActiveAlerts]) {
    const rows = [];
    const errors = [];
    subscribe((r) => rows.push(r), (e) => errors.push(e));
    assert.equal(rows.length, 1);
    globalThis.__vaxLive.fail((ref) => ref.__col === "alerts", fbError("permission-denied"));
    assert.equal(errors.length, 1, "the failure is reported, never swallowed");
    assert.equal(rows.length, 1, "and no empty list is delivered in its place");
  }
});

test("alerts: resolving in one browser updates the other", () => {
  const { external } = fresh({ alerts: { a1: { status: "active", severity: "critical", createdAt: ts(1) } } });
  const rows = [];
  alertService.subscribeAllAlerts((r) => rows.push(r));
  external("alerts", "a1", { status: "resolved" });
  assert.equal(rows.at(-1)[0].status, "resolved");
});

test("vaccine types: a type added on this page appears from the listener, no re-read", async () => {
  fresh({ vaccineTypes: { t1: { name: "Hepatitis" } } });
  const lists = [];
  const stop = vaccineService.subscribeVaccineTypes((l) => lists.push(l));
  assert.deepEqual(lists.at(-1).map((t) => t.name), ["Hepatitis"]);
  await vaccineService.addVaccineType("Influenza");
  await settle();
  assert.deepEqual(lists.at(-1).map((t) => t.name), ["Hepatitis", "Influenza"]);
  stop();
});

test("users: an approval made elsewhere reaches Admin Settings without a reload", () => {
  const { external } = fresh({ users: { u1: { name: "Pat", role: "dispatcher", status: "pending" } } });
  const lists = [];
  const errors = [];
  userService.subscribeUsers((l) => lists.push(l), (e) => errors.push(e));
  external("users", "u1", { status: "approved" });
  assert.equal(lists.at(-1)[0].status, "approved");
  globalThis.__vaxLive.fail((ref) => ref.__col === "users", fbError("permission-denied"));
  assert.equal(errors.length, 1);
});

// ======================================================================
// 3. Page wiring
// ======================================================================

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const uiFiles = [...walk(join(root, "src", "pages")), ...walk(join(root, "src", "components"))];

test("no page reloads the browser to show new data", () => {
  for (const f of uiFiles) {
    const code = strip(readFileSync(f, "utf8"));
    assert.equal(/location\.reload\(|window\.location\.href\s*=\s*window\.location\.href/.test(code), false, f);
  }
});

// The minimum argument count at which each listener receives an error callback.
const WITH_ERROR = {
  subscribeActiveAlerts: 2, subscribeAllAlerts: 2, subscribeBackorderQueue: 2, subscribePendingReturns: 2,
  subscribeAreas: 2, subscribeCargoLoadingGroups: 2, subscribeClinics: 2, subscribeDeliveries: 2,
  subscribeDestinationCorrections: 3, subscribeDoctorAddresses: 3, subscribeDoctors: 2,
  subscribeLatestAnalyticsRun: 2, subscribeInventoryForecasts: 2, subscribeAnalyticsConfigs: 2,
  subscribeInventory: 2, subscribeInvoiceQueue: 2, subscribeInvoice: 3, subscribeAllocationEvents: 4,
  subscribeOrder: 3, subscribeOrderHistoryWindow: 3, subscribeMedReps: 2, subscribeSalesRepOrders: 3,
  subscribePendingDispatchOrders: 2, subscribeRiders: 2, subscribeAllRiderLocations: 2,
  subscribeAllDeviationStates: 2, subscribeRiderLocation: 3, subscribeRiderDeviationState: 3,
  subscribeOrderStatusEvents: 3, subscribeUsers: 2, subscribeOwnProfile: 3, subscribeVaccines: 2,
  subscribeVaccineTypes: 2, subscribeInventoryBatches: 3,
};

function callArgCounts(src) {
  const out = [];
  const re = /\b(subscribe[A-Z]\w*)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    if (/import|export function|function\s/.test(src.slice(lineStart, m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    let commas = 0;
    let sawArg = false;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) depth -= 1;
      else if (c === "," && depth === 1) commas += 1;
      if (depth > 0 && !/\s/.test(c)) sawArg = true;
    }
    const body = src.slice(m.index, i);
    const trailing = /,\s*\)$/.test(body) ? 1 : 0;
    out.push({ name: m[1], args: sawArg ? commas + 1 - trailing : 0, at: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("every page listener passes an error callback (permission ≠ empty, no endless spinner)", () => {
  let checked = 0;
  for (const f of uiFiles) {
    const src = strip(readFileSync(f, "utf8"));
    for (const call of callArgCounts(src)) {
      if (!(call.name in WITH_ERROR)) continue;
      checked += 1;
      assert.ok(call.args >= WITH_ERROR[call.name], `${f}:${call.at} ${call.name} has no error callback`);
    }
  }
  assert.ok(checked > 60, `scanned the page listeners (${checked})`);
});

test("listeners are opened in effects that return their cleanup", () => {
  const cases = [
    ["src/pages/admin/Alerts.jsx", /const unsubscribe = subscribeAllAlerts\([\s\S]*?return \(\) => unsubscribe\(\);/],
    ["src/pages/admin/Settings.jsx", /const unsubscribe = subscribeUsers\([\s\S]*?return \(\) => unsubscribe\(\);/],
    ["src/pages/admin/AddVaccine.jsx", /useEffect\(\s*\(\) =>\s*subscribeVaccineTypes\(/],
    ["src/pages/admin/AddStock.jsx", /useEffect\(\s*\(\) =>\s*subscribeVaccines\(/],
    ["src/components/history/OrderHistoryView.jsx", /return \(\) => unsubscribe\(\);\s*\}, \[signedOut, isAdmin, scopeUid, repFilter, range, windowSize, toRows\]\);/],
    ["src/components/history/OrderHistoryView.jsx", /return subscribeMedReps\(/],
    ["src/pages/salesRep/useCartLiveStock.js", /if \(!batchIdsKey\) return undefined;\s*return subscribeInventoryBatches\(/],
    ["src/pages/salesRep/useCartLiveStock.js", /if \(!vaccineIdsKey\) return undefined;\s*return subscribeVaccinesByIds\(/],
    ["src/pages/dispatcher/DispatcherDashboard.jsx", /return \(\) => \{\s*unsubPending\(\);\s*unsubAll\(\);\s*unsubRiders\(\);\s*if \(unsubAlerts\) unsubAlerts\(\);\s*\};/],
  ];
  for (const [file, re] of cases) assert.match(strip(read(file)), re, file);
});

test("a failed source shows its figures as unavailable, never as zero", () => {
  const admin = strip(read("src/pages/admin/AdminDashboard.jsx"));
  assert.match(admin, /failSource\("alerts", "alerts"\)/);
  assert.match(admin, /failed\[c\.source\] \? \{ \.\.\.c, value: "—", note: "Unavailable", tone: "" \} : c/);
  assert.match(admin, /!hasAttention && !failed\.alerts && !failed\.deliveries && !failed\.inventory/, "no false 'All clear'");
  const disp = strip(read("src/pages/dispatcher/DispatcherDashboard.jsx"));
  assert.match(disp, /\}, fail\("pending", "the dispatch queue"\)\);/);
  assert.match(disp, /\}, fail\("alerts", "alerts"\)\);/);
  assert.match(disp, /const shown = \(sources, value\) => \(sources\.some\(\(s\) => failed\[s\]\) \? "—" : value\);/);
  const alerts = strip(read("src/pages/admin/Alerts.jsx"));
  assert.match(alerts, /\{loading && \(/);
  assert.match(alerts, /!loading && !loadError && filteredAlerts\.length === 0/);
  const settings = strip(read("src/pages/admin/Settings.jsx"));
  assert.match(settings, /!usersLoading && !usersError && filteredStaff\.length === 0/);
  const inv = strip(read("src/pages/admin/Inventory.jsx"));
  assert.match(inv, /!loading && !loadError && filteredVaccines\.length === 0/);
});

test("dialogs follow the live record and close only on success", () => {
  const alerts = strip(read("src/pages/admin/Alerts.jsx"));
  assert.match(alerts, /const selectedAlert = selectedAlertId \? alerts\.find\(\(a\) => a\.id === selectedAlertId\) \?\? null : null;/);
  // Resolving runs from the shared confirmation: a failure rethrows (the
  // dialog stays open with the reason) and the dialogs close only after the
  // awaited write. The shared dialog ignores a second press while running.
  assert.match(
    alerts,
    /await resolveAlert\(alertId\);\s*\} catch \(error\) \{\s*logSafeError\("Resolve alert", error\);\s*throw error;\s*\}\s*setConfirmResolveId\(null\);\s*setSelectedAlertId\(null\);/
  );
  assert.match(alerts, /onConfirm=\{handleResolveAlert\}/);
  const dialog = strip(read("src/components/ui/ConfirmDialog.jsx"));
  assert.match(dialog, /if \(flight\.current\.busy\) return;/, "a second press while running is ignored");
  const settings = strip(read("src/pages/admin/Settings.jsx"));
  assert.match(settings, /const selectedStaff = selectedStaffUid \? staff\.find\(\(p\) => p\.uid === selectedStaffUid\) \?\? null : null;/);
  // Status changes: confirmed first, closed only once the write landed.
  assert.match(settings, /onApprove=\{\(\) => requestStatusChange\(selectedStaff, "approve"\)\}/);
  assert.match(settings, /await updateStatus\(person\.uid, ACCOUNT_ACTIONS\[action\]\.status\);\s*setStatusChange\(null\);/);
  assert.match(settings, /setRoleChangeTarget\(null\);\s*\} catch \(error\) \{/, "the role dialog closes on success only");
});

test("load errors never show raw Firebase text", () => {
  for (const f of uiFiles) {
    const code = strip(readFileSync(f, "utf8"));
    assert.equal(/set\w*Error\((error|err)\.message \|\|/.test(code), false, `${f}: raw load error`);
    assert.equal(/showToast\((err|error)\.message \|\|/.test(code), false, `${f}: raw write error`);
  }
});

// The one-time reads that remain, each for a stated reason. A new getDoc /
// getDocs in a service must be added here with its justification.
const RETAINED_ONE_TIME_READS = {
  "areaService.js": ["setAreaActive"], // read inside a write, to validate it
  "clinicService.js": ["clinicNameExists", "updateClinicLocation"], // submit-time duplicate check; read inside a write
  "invoiceService.js": ["getInvoiceByOrderId", "updateInvoiceDraft"], // identity tests / legacy callers; read inside a write
  "orderHistoryService.js": [
    "fetchOrderHistoryPage", // superseded by the live window; kept for its contract tests
    "fetchReceiptsForOrders", // receipts are written once, in the order's own transaction
    "findOrdersByReference", "findOrderIdsBySku", "findOrderIdsByBatchId", "fetchOrdersByIds", // user-run exact lookups
    "fetchMedReps", // superseded by subscribeMedReps
  ],
  "orderService.js": ["getOrderById"], // checkout confirmation re-read; Assign Rider's "why did it leave" lookup
  "userService.js": ["getUserProfile"], // a blank-field default in InvoiceEditor
  "vaccineService.js": ["getVaccineTypes", "skuExists", "getVaccines", "batchIdExists"], // submit-time checks
};

test("remaining one-time reads are only the documented ones", () => {
  const dir = join(root, "src", "services");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = strip(readFileSync(join(dir, file), "utf8"));
    const fns = [...src.matchAll(/export (?:async )?function (\w+)\(([\s\S]*?)\n\}/g)];
    for (const [, name, body] of fns) {
      if (!/\bgetDocs?\(/.test(body)) continue;
      if (/runTransaction|tx\.get\(/.test(body) && !/getDocs?\(/.test(body.replace(/tx\.get\(/g, ""))) continue;
      assert.ok((RETAINED_ONE_TIME_READS[file] || []).includes(name), `${file} › ${name} is an undocumented one-time read`);
    }
  }
});

test("pages that used a one-time read for live data no longer do", () => {
  const checks = [
    ["src/pages/admin/InvoiceEditor.jsx", ["getInvoiceByOrderId", "getOrderById"]],
    ["src/pages/admin/AddStock.jsx", ["getVaccines"]],
    ["src/pages/admin/AddVaccine.jsx", ["getVaccineTypes"]],
    ["src/pages/dispatcher/DispatcherCargoLoading.jsx", ["getUserProfile"]],
    ["src/components/history/OrderHistoryView.jsx", ["fetchOrderHistoryPage", "fetchMedReps"]],
  ];
  for (const [file, gone] of checks) {
    const code = strip(read(file));
    for (const fn of gone) assert.equal(new RegExp(`\\b${fn}\\b`).test(code), false, `${file} still uses ${fn}`);
  }
  // Cargo Loading no longer reads the Dispatcher's profile solely for a print sheet.
  assert.doesNotMatch(strip(read("src/pages/dispatcher/DispatcherCargoLoading.jsx")), /Print sheet|PrintSheet|window\.print/);
});
