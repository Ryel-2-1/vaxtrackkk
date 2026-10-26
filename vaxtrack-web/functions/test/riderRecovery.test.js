"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const R = require("../src/riderRecovery");
const D = require("../src/riderDispatch");

const ON = R.qaResetConfig({ projectId: "vaxtrack-staging", flag: "true" });
const TS = (ms) => ({ toMillis: () => ms });

test("QA reset is enabled only for an allowed QA project WITH the server switch on — never production", () => {
  const cases = [
    [{ projectId: "vaxtrack-staging", flag: "true" }, true],
    [{ projectId: "vaxtrack-staging", flag: true }, true],
    [{ projectId: "demo-vaxtrack-rider-recovery", flag: "true" }, true],
    [{ projectId: "vaxtrack-bef1b", flag: "true" }, false],
    [{ projectId: "vaxtrack-staging", flag: "false" }, false],
    [{ projectId: "vaxtrack-staging", flag: "1" }, false],
    [{ projectId: "vaxtrack-staging", flag: undefined }, false],
    [{ projectId: "staging", flag: "true" }, false],
    [{ projectId: "demo-something-else", flag: "true" }, false],
    [{ projectId: "", flag: "true" }, false],
    [{ projectId: undefined, flag: "true" }, false],
  ];
  for (const [input, enabled] of cases) assert.equal(R.qaResetConfig(input).enabled, enabled, JSON.stringify(input));
  assert.equal(R.qaResetConfig({ projectId: "vaxtrack-bef1b", flag: "true" }).why, "production");
});

test("the server reads the switch from its own environment, never from the browser build", () => {
  const index = readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(index, /flag: process\.env\.QA_RIDER_RESET_ENABLED/);
  assert.match(index, /projectId: process\.env\.GCLOUD_PROJECT/);
  assert.equal(/VITE_/.test(index), false, "no client build variable decides anything");
  assert.match(index, /exports\.previewRiderRecovery = callable\(/);
  assert.match(index, /exports\.applyRiderRecovery = callable\(/);
});

test("loading evidence: the flag, a complete audit, or any part of one", () => {
  assert.equal(R.loadingEvidence({}), false);
  assert.equal(R.loadingEvidence({ isLoaded: false }), false);
  assert.equal(R.loadingEvidence({ isLoaded: true }), true);
  assert.equal(R.loadingEvidence({ isLoaded: false, loadedAt: TS(1), loadedByUid: "d" }), true, "unticked, audit kept");
  assert.equal(R.loadingEvidence({ loadedByUid: "d" }), true, "a partial record is still evidence");
});

test("a departure counts unless a later requeue started a new custody epoch", () => {
  assert.equal(R.travelledThisEpoch({ status: "assigned" }), false);
  assert.equal(R.travelledThisEpoch({ status: "delivered" }), true);
  assert.equal(R.travelledThisEpoch({ status: "assigned", dispatchedAt: TS(100) }), true);
  assert.equal(R.travelledThisEpoch({ status: "assigned", dispatchedAt: TS(100), requeuedAt: TS(200) }), false);
  assert.equal(R.travelledThisEpoch({ status: "assigned", dispatchedAt: TS(300), requeuedAt: TS(200) }), true);
  assert.equal(R.travelledThisEpoch({ status: "assigned", dispatchedAt: "garbled", requeuedAt: TS(200) }), true, "fails closed");
});

const forming = (orders, over = {}) => ({
  riderUid: "r1",
  rider: { role: "rider", status: "approved" },
  stored: { state: D.STATE.FORMING, tripId: "t1", orderIds: orders.map((o) => o.id), heldOrderIds: [] },
  trip: { riderUid: "r1", status: "forming", orderIds: orders.map((o) => o.id) },
  next: { unchanged: true },
  riderOrders: orders,
  memberOrders: new Map(orders.map((o) => [o.id, o.data])),
  config: ON,
  ...over,
});
const order = (id, data) => ({ id, data: { orderNumber: `VT-${id}`, assignedRiderId: "r1", dispatchTripId: "t1", status: "assigned", ...data } });

test("a clean forming trip is resettable; every blocker names the order and blocks the whole reset", () => {
  const ok = R.assessQaReset(forming([order("a"), order("b")]));
  assert.deepEqual([ok.available, ok.requeueOrderIds, ok.dissolveTripIds], [true, ["a", "b"], ["t1"]]);

  const cases = [
    [{ status: "loading", isLoaded: true }, "order-loaded"],
    [{ status: "loading" }, "loading-not-requeueable"],
    [{ isLoaded: false, loadedAt: TS(1), loadedByUid: "d" }, "order-loaded"],
    [{ status: "in_transit" }, "order-on-the-road"],
    [{ status: "delayed" }, "order-on-the-road"],
    [{ status: "delivery_failed" }, "order-failed"],
    [{ dispatchedAt: TS(5) }, "order-travelled"],
  ];
  for (const [data, code] of cases) {
    const r = R.assessQaReset(forming([order("a"), order("b", data)]));
    assert.equal(r.available, false, code);
    assert.ok(r.blockers.some((b) => b.code === code && b.orderNumber === "VT-b"), `${code}: ${JSON.stringify(r.blockers)}`);
    assert.ok(r.blockers.every((b) => !/\bb\b/.test(b.message) || /VT-b/.test(b.message)), "order numbers, never raw ids");
  }
});

test("returns, navigation, foreign trips, departure and unknown statuses each block", () => {
  const two = [order("a"), order("b")];
  const blocked = (over, code) => {
    const r = R.assessQaReset(forming(two, over));
    assert.equal(r.available, false, code);
    assert.ok(r.blockers.some((b) => b.code === code), `${code}: ${JSON.stringify(r.blockers)}`);
  };
  blocked({ returnsByOrder: new Map([["a", [{ id: "a_1", data: { status: "pending" } }]]]) }, "return-pending");
  blocked({ navigation: { state: "navigating", endedAt: null } }, "navigation-active");
  blocked({ riderOrders: [order("a"), order("b", { dispatchTripId: "t9" })], referencedTrips: new Map([["t9", { riderUid: "r2", status: "forming" }]]) }, "membership-inconsistent");
  blocked({ stored: { state: D.STATE.RETURNING, tripId: "t1", orderIds: ["a"], departedAt: TS(1) } }, "trip-departed");
  blocked({ next: { unknown: true, orderIds: ["a"] } }, "rider-state-unknown");
  blocked({ rider: { role: "dispatcher" } }, "not-a-rider");
  // A resolved return or an ended navigation session does not block.
  assert.equal(R.assessQaReset(forming(two, { returnsByOrder: new Map([["a", [{ id: "a_1", data: { status: "resolved" } }]]]) })).available, true);
  assert.equal(R.assessQaReset(forming(two, { navigation: { state: "ended", endedAt: TS(1) } })).available, true);
  // An older forming trip of the SAME Rider is closed too.
  const own = R.assessQaReset(forming([order("a"), order("b", { dispatchTripId: "t0" })], { referencedTrips: new Map([["t0", { riderUid: "r1", status: "forming" }]]) }));
  assert.deepEqual([own.available, own.dissolveTripIds], [true, ["t0", "t1"]]);
});

test("disabled config refuses before anything else; an idle Rider is a no-op", () => {
  const off = R.assessQaReset(forming([order("a")], { config: R.qaResetConfig({ projectId: "vaxtrack-bef1b", flag: "true" }) }));
  assert.deepEqual([off.enabled, off.available, off.blockers.map((b) => b.code)], [false, false, ["qa-reset-disabled"]]);
  const idle = R.assessQaReset(forming([], { stored: { state: D.STATE.AVAILABLE, tripId: null, orderIds: [] }, trip: undefined }));
  assert.deepEqual([idle.available, idle.noop], [false, true]);
});

test("confirm return follows the re-derived state and the orders on the road", () => {
  assert.equal(R.assessConfirmReturn({ cur: { state: D.STATE.RETURNING } }).available, true);
  const out = R.assessConfirmReturn({ cur: { state: D.STATE.RETURNING }, riderOrders: [order("a", { status: "in_transit" })] });
  assert.deepEqual([out.available, out.message], [false, "Still out for delivery: VT-a."]);
  for (const state of [D.STATE.AVAILABLE, D.STATE.FORMING, D.STATE.ON_TRIP]) {
    assert.equal(R.assessConfirmReturn({ cur: { state } }).available, false, state);
  }
  assert.equal(R.assessConfirmReturn({ cur: null, unknown: true }).available, false);
});
