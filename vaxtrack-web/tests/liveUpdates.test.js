// Live updates without a browser refresh — the recovery layer and the
// stale-edit protection added on top of the existing live listeners.
//
// Four layers:
//   1. createRecoveringListener() driven by a fake attach/schedule: transient
//      failures reconnect quietly, permanent ones report, Retry opens exactly
//      one replacement, closing cancels everything.
//   2. The REAL services through listenLive(), against a multi-snapshot
//      Firestore stand-in: remote add / update / remove, status propagation
//      between the dashboard queue and the lists, scoped listeners, cleanup on
//      query change, a transient failure that keeps the last data.
//   3. useLiveDraft() run through a minimal hook runner: a clean form follows
//      the server, typed values are never replaced, stale fields block saving
//      until the user loads or keeps, a saved form adopts its own echo.
//   4. Source contracts for page wiring that cannot run without a DOM.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";
import {
  createConnectionRegistry,
  createRecoveringListener,
  isTransientListenerError,
  LIVE_FAILED_MESSAGE,
  RECONNECTING_MESSAGE,
  RETRY_DELAYS_MS,
} from "../src/services/liveConnection.js";
import { applyLatest, editedFields, staleFields } from "../src/services/liveFormSync.js";
import { kpiValue, liveErrorKind } from "../src/services/liveDataErrors.js";

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
// 1. The recovering listener
// ======================================================================

/** A fake Firestore listener source plus a manual clock. */
function rig() {
  const opened = []; // every attach() call
  const timers = [];
  const registry = createConnectionRegistry();
  const attach = (next, error) => {
    // Like Firestore: a listener that reports an error is already closed.
    const l = {
      next,
      error: (e) => {
        l.open = false;
        error(e);
      },
      open: true,
    };
    opened.push(l);
    return () => {
      l.open = false;
    };
  };
  const schedule = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return t;
  };
  const cancel = (t) => {
    t.cancelled = true;
  };
  const fire = () => {
    const t = timers.find((x) => !x.cancelled && !x.fired);
    assert.ok(t, "a retry is pending");
    t.fired = true;
    t.fn();
    return t.ms;
  };
  const live = () => opened.filter((l) => l.open);
  return { opened, timers, registry, attach, schedule, cancel, fire, live };
}

test("recovering listener: a transient failure reconnects quietly and keeps the last data", () => {
  const r = rig();
  const got = [];
  const errors = [];
  createRecoveringListener({
    attach: r.attach,
    onNext: (s) => got.push(s),
    onError: (e) => errors.push(e),
    registry: r.registry,
    schedule: r.schedule,
    cancel: r.cancel,
  });
  r.opened[0].next("first");
  r.opened[0].error(fbError("unavailable"));

  assert.deepEqual(errors, [], "the page is not told — it keeps showing its data");
  assert.deepEqual(got, ["first"], "no empty snapshot is fabricated");
  assert.deepEqual(r.registry.getSnapshot(), { reconnecting: 1, failed: 0, retryable: 0 }, "the shell says Reconnecting…");

  assert.equal(r.fire(), RETRY_DELAYS_MS[0]);
  assert.equal(r.opened.length, 2, "exactly one replacement");
  assert.equal(r.live().length, 1, "never two open at once");

  r.opened[1].next("second");
  assert.deepEqual(got, ["first", "second"]);
  assert.deepEqual(r.registry.getSnapshot(), { reconnecting: 0, failed: 0, retryable: 0 }, "recovered");
});

test("recovering listener: permission, sign-out, index and not-found report at once and never auto-retry", () => {
  for (const code of ["permission-denied", "unauthenticated", "failed-precondition", "not-found"]) {
    const err = code === "failed-precondition" ? fbError(code, "The query requires an index.") : fbError(code);
    const r = rig();
    const errors = [];
    createRecoveringListener({
      attach: r.attach,
      onNext: () => {},
      onError: (e) => errors.push(e),
      registry: r.registry,
      schedule: r.schedule,
      cancel: r.cancel,
    });
    r.opened[0].error(err);
    assert.equal(errors.length, 1, `${code}: reported to the page`);
    assert.equal(r.timers.length, 0, `${code}: no automatic retry`);
    assert.equal(isTransientListenerError(err), false, code);
    assert.deepEqual(r.registry.getSnapshot(), { reconnecting: 0, failed: 1, retryable: 0 }, code);
  }
  for (const code of ["unavailable", "internal", "deadline-exceeded", "resource-exhausted"]) {
    assert.equal(isTransientListenerError(fbError(code)), true, code);
  }
});

test("recovering listener: after the backoff runs out, Try again opens exactly one replacement", () => {
  const r = rig();
  const errors = [];
  const got = [];
  createRecoveringListener({
    attach: r.attach,
    onNext: (s) => got.push(s),
    onError: (e) => errors.push(e),
    registry: r.registry,
    schedule: r.schedule,
    cancel: r.cancel,
  });
  r.opened[0].next("data");
  const waits = [];
  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    r.opened.at(-1).error(fbError("unavailable"));
    waits.push(r.fire());
  }
  assert.deepEqual(waits, [...RETRY_DELAYS_MS], "backoff, not polling");
  assert.deepEqual(errors, []);

  r.opened.at(-1).error(fbError("unavailable"));
  assert.equal(errors.length, 1, "now the page is told");
  assert.deepEqual(r.registry.getSnapshot(), { reconnecting: 0, failed: 1, retryable: 1 }, "the shell offers Try again");
  assert.deepEqual(got, ["data"], "the last data stays");

  const before = r.opened.length;
  assert.equal(r.registry.retryFailed(), 1);
  assert.equal(r.opened.length, before + 1, "exactly one replacement listener");
  assert.equal(r.live().length, 1);
  assert.equal(r.registry.retryFailed(), 0, "a second click has nothing left to re-open");
  assert.equal(r.opened.length, before + 1);

  // The retry budget starts over.
  r.opened.at(-1).error(fbError("unavailable"));
  assert.equal(r.fire(), RETRY_DELAYS_MS[0]);
});

test("recovering listener: closing cancels a pending retry and silences late callbacks", () => {
  const r = rig();
  const got = [];
  const stop = createRecoveringListener({
    attach: r.attach,
    onNext: (s) => got.push(s),
    onError: () => assert.fail("no error after close"),
    registry: r.registry,
    schedule: r.schedule,
    cancel: r.cancel,
  });
  r.opened[0].error(fbError("unavailable"));
  assert.equal(r.registry.getSnapshot().reconnecting, 1);
  stop();
  assert.equal(r.timers[0].cancelled, true, "the pending retry is cancelled");
  assert.deepEqual(r.registry.getSnapshot(), { reconnecting: 0, failed: 0, retryable: 0 }, "nothing left registered");
  r.timers[0].fn(); // even if a timer slipped through
  assert.equal(r.opened.length, 1, "no listener re-opens after close");
  r.opened[0].next("late");
  r.opened[0].error(fbError("permission-denied"));
  assert.deepEqual(got, []);

  // An open, healthy listener is closed by stop().
  const r2 = rig();
  const stop2 = createRecoveringListener({ attach: r2.attach, onNext: () => {}, registry: r2.registry, schedule: r2.schedule, cancel: r2.cancel });
  assert.equal(r2.live().length, 1);
  stop2();
  assert.equal(r2.live().length, 0);
});

test("recovering listener: a synchronous failure inside attach is handled once", () => {
  const registry = createConnectionRegistry();
  const errors = [];
  let unsubscribed = 0;
  createRecoveringListener({
    attach: (_next, error) => {
      error(fbError("permission-denied"));
      return () => {
        unsubscribed += 1;
      };
    },
    onNext: () => {},
    onError: (e) => errors.push(e),
    registry,
    schedule: () => assert.fail("no retry for a permanent error"),
  });
  assert.equal(errors.length, 1);
  assert.equal(registry.retryFailed(), 1);
  assert.equal(errors.length, 2, "the retry ran and failed the same way");
  assert.equal(unsubscribed, 0, "an already-failed listener is not unsubscribed again");
});

test("connection registry: watchers are told about every change", () => {
  const reg = createConnectionRegistry();
  let calls = 0;
  const off = reg.subscribe(() => {
    calls += 1;
  });
  const a = {};
  reg.markReconnecting(a);
  reg.markFailed(a, () => {}, true);
  reg.clear(a);
  reg.clear(a); // nothing to clear: no notification
  off();
  reg.markReconnecting(a);
  assert.equal(calls, 3);
  assert.match(RECONNECTING_MESSAGE, /Reconnecting/);
  assert.match(LIVE_FAILED_MESSAGE, /out of date/);
  assert.doesNotMatch(RECONNECTING_MESSAGE + LIVE_FAILED_MESSAGE, /refresh|reload/i);
});

// ======================================================================
// 2. Real services through listenLive()
// ======================================================================

const LIVE_STANDIN = `
const __live = (globalThis.__vaxLive2 = globalThis.__vaxLive2 || { listeners: new Set() });
const __query = (ref) => {
  let rows = Object.entries(col(ref.__col)).map(([id, rec]) => ({ id, rec }));
  for (const c of ref.__clauses || []) {
    if (c && c.__t === "where" && c.op === "==") rows = rows.filter((r) => r.rec.data[c.field] === c.value);
  }
  const docs = rows.map(({ id, rec }) => ({ id, data: () => ({ ...rec.data }), exists: () => true }));
  return { docs, empty: docs.length === 0, size: docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
};
const __emit = (l) => {
  if (l.active) l.next(l.ref.__id !== undefined ? snapOf(l.ref.__col, l.ref.__id) : __query(l.ref));
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
`;

const loader = createServiceLoader();
{
  const path = join(loader.dir, "__firestore.mjs");
  const base = readFileSync(path, "utf8");
  const withoutOnce = base.replace(/export const onSnapshot = \(ref, next, _err\) => \{[\s\S]*?return \(\) => \{\};\n\};\n/, "");
  assert.notEqual(withoutOnce, base, "the single-shot onSnapshot was replaced");
  writeFileSync(path, withoutOnce + LIVE_STANDIN);
}
const deliveryService = await loader.load("deliveryService.js");
const orderService = await loader.load("orderService.js");
const riderService = await loader.load("riderService.js");
// The same module instance the services use (same URL inside the temp dir).
const { liveConnection } = await loader.load("liveConnection.js");

const LIVE = () => globalThis.__vaxLive2;
const ts = (ms) => ({ __ms: ms, toMillis() { return this.__ms; } });

function fresh(seed) {
  LIVE()?.listeners.clear();
  liveConnection.retryFailed(); // leave no failed entry from an earlier test
  LIVE()?.listeners.clear();
  const store = installStore(createStore(seed), { uid: "admin1", email: "admin@x.com" });
  // A write made by ANOTHER browser: straight into the store, then delivered.
  const external = (colName, id, data) => {
    store.collections[colName] ??= {};
    const rec = store.collections[colName][id];
    store.collections[colName][id] = { data: { ...(rec?.data ?? {}), ...data }, version: (rec?.version ?? 0) + 1 };
    LIVE().emitAll();
  };
  const remove = (colName, id) => {
    delete store.collections[colName][id];
    LIVE().emitAll();
  };
  return { external, remove, open: () => LIVE().listeners.size };
}

// The dashboards' own groupings, over the shared normalised statusKey.
const ACTIVE = new Set(["assigned", "loading", "in_transit", "delayed"]);
const activeCount = (orders) => orders.filter((o) => ACTIVE.has(o.statusKey)).length;

test("all orders: a remote add, update and remove reach the open page, newest first", () => {
  const { external, remove } = fresh({
    orders: {
      o1: { orderNumber: "VT-1", status: "pending_dispatch", createdAt: ts(1000) },
      o2: { orderNumber: "VT-2", status: "in_transit", createdAt: ts(2000) },
    },
  });
  const lists = [];
  const stop = deliveryService.subscribeDeliveries((l) => lists.push(l));
  assert.deepEqual(lists.at(-1).map((o) => o.id), ["o2", "o1"]);
  assert.equal(activeCount(lists.at(-1)), 1);

  external("orders", "o3", { orderNumber: "VT-3", status: "pending_dispatch", createdAt: ts(3000) });
  assert.deepEqual(lists.at(-1).map((o) => o.id), ["o3", "o2", "o1"], "added without a reload");

  external("orders", "o1", { status: "delayed" });
  const o1 = lists.at(-1).find((o) => o.id === "o1");
  assert.equal(o1.statusKey, "delayed");
  assert.equal(o1.statusLabel, deliveryService.mapOrderStatusLabel("delayed"), "shared normalisation");
  assert.equal(activeCount(lists.at(-1)), 2, "the KPI follows the row");

  remove("orders", "o2");
  assert.deepEqual(lists.at(-1).map((o) => o.id), ["o3", "o1"], "removed without a reload");
  assert.equal(activeCount(lists.at(-1)), 1);
  stop();
});

test("dispatch queue ↔ shipments: assigning an order moves it between the two live views", () => {
  const { external } = fresh({
    orders: {
      p1: { orderNumber: "VT-1", status: "pending_dispatch", createdAt: ts(1) },
      p2: { orderNumber: "VT-2", status: "pending_dispatch", createdAt: ts(2) },
    },
  });
  const queue = [];
  const all = [];
  const stopQ = orderService.subscribePendingDispatchOrders((l) => queue.push(l));
  const stopA = deliveryService.subscribeDeliveries((l) => all.push(l));
  assert.equal(queue.at(-1).length, 2, "Pending KPI = queue length");
  assert.equal(activeCount(all.at(-1)), 0);

  // Another dispatcher assigns p1.
  external("orders", "p1", { status: "assigned", assignedRiderId: "r1" });
  assert.deepEqual(queue.at(-1).map((o) => o.id), ["p2"], "leaves the dispatch queue");
  assert.equal(activeCount(all.at(-1)), 1, "joins the active count");
  // Queue and list never disagree about a pending order.
  const pendingInList = all.at(-1).filter((o) => o.statusKey === "pending_dispatch").map((o) => o.id);
  assert.deepEqual(pendingInList, queue.at(-1).map((o) => o.id));

  // The rider delivers it.
  external("orders", "p1", { status: "delivered" });
  assert.equal(activeCount(all.at(-1)), 0);
  assert.equal(all.at(-1).find((o) => o.id === "p1").statusKey, "delivered");
  stopQ();
  stopA();
});

test("Med Rep orders: scoped to the rep, and a query change closes the old listener first", () => {
  const { external, open } = fresh({
    orders: {
      a: { createdByUid: "rep1", status: "pending_dispatch", createdAt: ts(1) },
      b: { createdByUid: "rep2", status: "pending_dispatch", createdAt: ts(2) },
    },
  });
  const rep1 = [];
  let stop = orderService.subscribeSalesRepOrders("rep1", (l) => rep1.push(l));
  assert.deepEqual(rep1.at(-1).map((o) => o.id), ["a"]);
  assert.equal(open(), 1);

  external("orders", "c", { createdByUid: "rep2", status: "pending_dispatch", createdAt: ts(3) });
  assert.deepEqual(rep1.at(-1).map((o) => o.id), ["a"], "another rep's order never arrives");
  external("orders", "a", { status: "assigned" });
  assert.equal(rep1.at(-1)[0].status, "assigned", "a dispatcher's change reaches the rep");

  // The page switches to another rep (React runs the cleanup, then the effect).
  stop();
  assert.equal(open(), 0, "the old listener is closed");
  const heard = rep1.length;
  const rep2 = [];
  stop = orderService.subscribeSalesRepOrders("rep2", (l) => rep2.push(l));
  assert.equal(open(), 1, "exactly one listener for the new query");
  assert.deepEqual(rep2.at(-1).map((o) => o.id).sort(), ["b", "c"]);
  external("orders", "a", { status: "delivered" });
  assert.equal(rep1.length, heard, "the closed listener hears nothing");
  stop();
  assert.equal(open(), 0, "unmount closes it");
});

test("riders: an approval made elsewhere reaches every open rider list", () => {
  const { external, open } = fresh({
    users: {
      r1: { role: "rider", status: "pending", fullName: "Ana" },
      d1: { role: "dispatcher", status: "approved", name: "Dan" },
    },
  });
  const lists = [];
  const stop = riderService.subscribeRiders((l) => lists.push(l));
  assert.deepEqual(lists.at(-1).map((r) => [r.uid, r.status]), [["r1", "pending"]]);
  external("users", "r1", { status: "approved" });
  assert.equal(lists.at(-1)[0].status, "approved");
  external("users", "r2", { role: "rider", status: "approved", fullName: "Ben" });
  assert.deepEqual(lists.at(-1).map((r) => r.uid), ["r1", "r2"]);
  assert.equal(open(), 1, "one listener however many snapshots arrive");
  stop();
  assert.equal(open(), 0);
});

test("a transient service failure keeps the last data and reconnects to exactly one listener", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { external, open } = fresh({ orders: { o1: { status: "in_transit", createdAt: ts(1) } } });
    const lists = [];
    const errors = [];
    const stop = deliveryService.subscribeDeliveries((l) => lists.push(l), (e) => errors.push(e));
    assert.equal(activeCount(lists.at(-1)), 1);

    LIVE().fail((ref) => ref.__col === "orders", fbError("unavailable"));
    assert.deepEqual(errors, [], "no error state: the KPI is not replaced by — or 0");
    assert.equal(lists.length, 1, "no empty list is fabricated");
    assert.equal(liveConnection.getSnapshot().reconnecting, 1, "the shell shows Reconnecting…");
    assert.equal(open(), 0);

    // The order changed while disconnected.
    external("orders", "o1", { status: "delivered" });
    mock.timers.tick(RETRY_DELAYS_MS[0]);
    assert.equal(open(), 1, "exactly one replacement");
    assert.equal(lists.at(-1)[0].statusKey, "delivered", "the reconnect brings the latest state");
    assert.equal(liveConnection.getSnapshot().reconnecting, 0);
    stop();
    assert.equal(open(), 0);
  } finally {
    mock.timers.reset();
  }
});

test("a permanent service failure reports once; Try again re-opens one listener", () => {
  const { open } = fresh({ orders: { o1: { createdByUid: "rep1", status: "assigned", createdAt: ts(1) } } });
  const lists = [];
  const errors = [];
  const stop = orderService.subscribeSalesRepOrders("rep1", (l) => lists.push(l), (e) => errors.push(e));
  LIVE().fail(() => true, fbError("permission-denied"));
  assert.equal(errors.length, 1);
  assert.equal(liveErrorKind(errors[0]), "permission", "never confused with an empty result");
  assert.equal(lists.length, 1, "no empty snapshot after the failure");
  assert.equal(open(), 0);

  liveConnection.retryFailed();
  assert.equal(open(), 1, "one replacement, not one per click or per render");
  assert.equal(lists.length, 2);
  stop();
  assert.equal(open(), 0);
});

// ======================================================================
// 3. useLiveDraft through a minimal hook runner
// ======================================================================

/** Runs a hook like React would: state slots, and render-phase updates re-render. */
async function loadLiveDraftHook() {
  const tmp = mkdtempSync(join(tmpdir(), "vaxtrack-hook-"));
  writeFileSync(
    join(tmp, "react.mjs"),
    "export const useState = (init) => globalThis.__vaxHooks.useState(init);\n"
  );
  const src = read("src", "components", "useLiveDraft.js")
    .replace('from "react"', 'from "./react.mjs"')
    .replace('from "../services/liveFormSync"', `from ${JSON.stringify(pathToFileURL(join(root, "src", "services", "liveFormSync.js")).href)}`);
  writeFileSync(join(tmp, "useLiveDraft.mjs"), src);
  return (await import(pathToFileURL(join(tmp, "useLiveDraft.mjs")).href)).useLiveDraft;
}
// Bound to a non-hook name: this runner, not React, calls it.
const runLiveDraft = await loadLiveDraftHook();

function mountDraft(initialServer) {
  const slots = [];
  let cursor = 0;
  let changed = false;
  globalThis.__vaxHooks = {
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
      const set = (v) => {
        const next = typeof v === "function" ? v(slots[i]) : v;
        if (!Object.is(next, slots[i])) {
          slots[i] = next;
          changed = true;
        }
      };
      return [slots[i], set];
    },
  };
  let server = initialServer;
  let result;
  const render = () => {
    let passes = 0;
    do {
      changed = false;
      cursor = 0;
      result = runLiveDraft(server);
      passes += 1;
      assert.ok(passes < 20, "the hook settles");
    } while (changed);
    return result;
  };
  render();
  return {
    get h() {
      return result;
    },
    serverIs(next) {
      server = next;
      return render();
    },
    act(fn) {
      fn(result);
      return render();
    },
  };
}

test("live draft: a clean form follows the server", () => {
  const f = mountDraft({ name: "Ana", phone: "0917" });
  f.serverIs({ name: "Ana Cruz", phone: "0917" });
  assert.deepEqual(f.h.draft, { name: "Ana Cruz", phone: "0917" });
  assert.equal(f.h.dirty, false);
  assert.deepEqual(f.h.stale, []);
});

test("live draft: typed values are never replaced; the changed field is flagged", () => {
  const f = mountDraft({ name: "Ana", phone: "0917" });
  f.act((h) => h.setField("phone", "0999"));
  f.serverIs({ name: "Ana Cruz", phone: "0917" });
  assert.deepEqual(f.h.draft, { name: "Ana", phone: "0999" }, "the typed phone stays");
  assert.deepEqual(f.h.stale, ["name"], "the rename made elsewhere is reported");

  // Load latest: only the stale field changes, the user's other edit stays.
  f.act((h) => h.loadLatest());
  assert.deepEqual(f.h.draft, { name: "Ana Cruz", phone: "0999" });
  assert.deepEqual(f.h.stale, []);
  assert.equal(f.h.dirty, true);
});

test("live draft: Keep mine clears the warning and keeps every typed value", () => {
  const f = mountDraft({ name: "Ana", phone: "0917" });
  f.act((h) => h.setField("name", "Anna"));
  f.serverIs({ name: "Ana Cruz", phone: "0917" });
  assert.deepEqual(f.h.stale, ["name"]);
  f.act((h) => h.keepMine());
  assert.deepEqual(f.h.stale, []);
  assert.deepEqual(f.h.draft, { name: "Anna", phone: "0917" });
});

test("live draft: a deleted record is reported as gone", () => {
  const f = mountDraft({ name: "Ana" });
  f.act((h) => h.setField("name", "Anna"));
  f.serverIs(null);
  assert.equal(f.h.gone, true);
  assert.deepEqual(f.h.draft, { name: "Anna" }, "the typed value is still there");
});

test("live draft: the form's own save is not reported as a change made elsewhere", () => {
  const f = mountDraft({ name: "Ana" });
  f.act((h) => h.setField("name", "  Anna "));
  // The echo (stored trimmed) arrives before the awaited save resolves.
  f.serverIs({ name: "Anna" });
  f.act((h) => h.markSaved({ name: "Anna" }));
  assert.deepEqual(f.h.stale, []);
  assert.equal(f.h.dirty, false);
  assert.deepEqual(f.h.draft, { name: "Anna" });
  // And the clean form follows the server again.
  f.serverIs({ name: "Anna Cruz" });
  assert.deepEqual(f.h.draft, { name: "Anna Cruz" });
});

test("stale-edit helpers compare by value, field by field", () => {
  assert.deepEqual(editedFields({ a: [1, 2], b: "x" }, { a: [1, 2], b: "y" }), ["b"]);
  assert.deepEqual(staleFields({ a: 1, b: 2 }, { a: 1, b: 3 }), ["b"]);
  assert.deepEqual(staleFields({ a: 1 }, null), [], "a deleted record is `gone`, not stale");
  assert.deepEqual(applyLatest({ a: "mine", b: "mine" }, { a: "theirs", b: "theirs" }, ["a"]), { a: "theirs", b: "mine" });
});

// ======================================================================
// 4. Page wiring (source contracts)
// ======================================================================

const SERVICES = join(root, "src", "services");

test("every service listener goes through listenLive — onSnapshot is called in one place only", () => {
  const calls = [];
  for (const file of readdirSync(SERVICES)) {
    if (!file.endsWith(".js")) continue;
    if (/\bonSnapshot\(/.test(strip(readFileSync(join(SERVICES, file), "utf8")))) calls.push(file);
  }
  assert.deepEqual(calls, ["liveSnapshot.js"]);
  assert.match(read("src", "services", "liveSnapshot.js"), /createRecoveringListener\(\{\s*attach: \(next, error\) => onSnapshot\(ref, next, error\)/);
  for (const file of ["deliveryService.js", "orderService.js", "riderService.js", "inventoryService.js", "alertService.js", "clinicService.js", "userService.js"]) {
    assert.match(read("src", "services", file), /import \{ listenLive \} from "\.\/liveSnapshot\.js";/, file);
  }
});

test("the shell shows Reconnecting… and offers one Try again for stopped listeners", () => {
  const src = read("src", "components", "shell", "OfflineNotice.jsx");
  assert.match(src, /useSyncExternalStore\(liveConnection\.subscribe, liveConnection\.getSnapshot/);
  assert.match(src, /onClick=\{\(\) => liveConnection\.retryFailed\(\)\}/);
  assert.match(src, /RECONNECTING_MESSAGE/);
  assert.match(src, /LIVE_FAILED_MESSAGE/);
  assert.match(src, /aria-live="polite"/);
});

test("a source that recovers clears its own error — no stuck banner, no false zero", () => {
  const admin = read("src", "pages", "admin", "AdminDashboard.jsx");
  for (const source of ["deliveries", "alerts", "riders", "inventory"]) {
    assert.match(admin, new RegExp(`recover\\("${source}"\\)`), `AdminDashboard ${source}`);
  }
  assert.match(admin, /\{anyFailed && loadError && \(/);
  const disp = read("src", "pages", "dispatcher", "DispatcherDashboard.jsx");
  for (const source of ["pending", "all", "riders", "alerts"]) {
    assert.match(disp, new RegExp(`recover\\("${source}"\\)`), `DispatcherDashboard ${source}`);
  }
  assert.match(disp, /\{anyFailed && error && \(/);
  // A failed figure shows "—", never 0.
  assert.equal(kpiValue(0, { error: "x" }), "—");
  assert.equal(kpiValue(0, { loading: true }), "—");
  assert.equal(kpiValue(0, {}), 0);
});

test("stale-edit protection: each edit form flags changes made elsewhere and blocks saving", () => {
  const forms = {
    "src/components/profile/MyProfile.jsx": [/useLiveDraft\(/, /<StaleEditNotice/, /markSaved\(/, /disabled=\{saving \|\| !changed \|\| blockedByStale\}/, /if \(savingRef\.current \|\| blockedByStale\) return;/],
    "src/pages/admin/AiInventoryAnalytics.jsx": [/useLiveDraft\(configFormFrom\(config\)\)/, /<StaleEditNotice/, /markSaved\(form\)/, /disabled=\{saving \|\| staleLabels\.length > 0\}/],
    "src/pages/admin/Clinics.jsx": [/useLiveDraft\(live \? locationFields\(live\) : null\)/, /<StaleEditNotice/, /disabled=\{saving \|\| blocked\}/, /if \(savingRef\.current \|\| blocked\) return;/],
    "src/pages/admin/MedRepTerritoryDialog.jsx": [/useLiveDraft\(/, /<StaleEditNotice/, /staleLabels\.length > 0 \|\| liveDraft\.gone/],
    "src/pages/admin/Inventory.jsx": [/<StaleEditNotice[\s\S]*?<StaleEditNotice/, /disabled=\{savingPrice \|\| priceBlocked\}/, /disabled=\{savingCorrection \|\| correctionBlocked\}/, /if \(savingPrice \|\| !pricing \|\| priceBlocked\) return;/],
  };
  for (const [file, patterns] of Object.entries(forms)) {
    const src = read(...file.split("/"));
    for (const p of patterns) assert.match(src, p, `${file}: ${p}`);
  }
  // The dialogs are handed the LIVE record, not just the copy they opened with.
  assert.match(read("src", "pages", "admin", "Clinics.jsx"), /live=\{clinics\.find\(\(c\) => c\.firestoreId === managedClinic\.firestoreId\) \?\? null\}/);
  assert.match(read("src", "pages", "admin", "Settings.jsx"), /live=\{staff\.find\(\(p\) => p\.uid === territoryTarget\.uid\) \?\? null\}/);
  const notice = read("src", "components", "ui", "StaleEditNotice.jsx");
  assert.match(notice, /Load latest/);
  assert.match(notice, /Keep mine/);
});

test("territory dialog: only this Med Rep's orders, and a failure is 'unavailable', never 'none'", () => {
  const src = strip(read("src", "pages", "admin", "MedRepTerritoryDialog.jsx"));
  assert.doesNotMatch(src, /subscribeDeliveries/, "no all-orders listener for one rep's orders");
  assert.match(src, /subscribeSalesRepOrders\(\s*person\.uid,/);
  assert.match(src, /\[person\.uid\]\s*\)/, "re-subscribes only when the rep changes");
  assert.match(src, /setOrdersUnavailable\(true\)/);
  assert.match(src, /\(affected\.length > 0 \|\| ordersUnavailable\) && !confirmingOrders/, "saving asks first when orders could not be checked");
});

test("filtered-empty is never shown as collection-empty (and vice versa)", () => {
  const pages = {
    "src/pages/dispatcher/DispatcherShipments.jsx": [/No shipments yet/, /No shipments match this filter/, /orders\.length === 0 \?/],
    "src/pages/admin/Riders.jsx": [/No rider accounts found/, /No riders match your filter/],
    "src/pages/admin/Deliveries.jsx": [/No deliveries yet/, /No deliveries match your filters/],
    "src/pages/dispatcher/DispatcherAssignRider.jsx": [/No orders are waiting for a rider/, /No orders match/],
  };
  for (const [file, patterns] of Object.entries(pages)) {
    const src = read(...file.split("/"));
    for (const p of patterns) assert.match(src, p, `${file}: ${p}`);
  }
});

test("listener error kinds stay distinct", () => {
  const kinds = [
    fbError("permission-denied"),
    fbError("unauthenticated"),
    fbError("failed-precondition", "The query requires an index."),
    fbError("unavailable"),
    fbError("not-found"),
    new Error("something else"),
  ].map((e) => liveErrorKind(e));
  assert.equal(new Set(kinds).size, kinds.length, kinds.join(","));
});

test("nothing tells the user to reload, and nothing reloads the browser", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|mjs)$/.test(name)) {
        const src = readFileSync(p, "utf8");
        if (/location\.reload|reload (the|this) page|refresh (the|this) page|refresh and try/i.test(src)) offenders.push(p);
      }
    }
  };
  walk(join(root, "src"));
  assert.deepEqual(offenders, []);
});
