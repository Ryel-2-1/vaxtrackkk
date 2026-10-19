// Rider trips — the Dispatcher pages' side.
//
// The trip state is server-owned (functions/src/riderDispatch.js, tested in
// functions/test/riderDispatch.test.js and against a real Firestore in
// functions/test/integration/riderDispatch.test.js). These tests cover how
// the pages read it (src/services/riderTrip.js, pure) and the wiring that
// cannot run without a DOM: what Cargo Loading and Assign Rider send and
// disable, and that their dialogs are portaled to the viewport.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  RIDER_TRIP_STATES,
  cargoGroupDispatch,
  indexRiderStates,
  riderTripStatus,
  ridersReturningToHub,
} from "../src/services/riderTrip.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the web's state names are the server's", () => {
  const server = createRequire(import.meta.url)("../functions/src/riderDispatch.js");
  assert.deepEqual({ ...RIDER_TRIP_STATES }, { ...server.STATE });
});

test("assignable only before departure; the reason is said, never guessed", () => {
  const at = riderTripStatus({ state: "available_at_hub" });
  assert.deepEqual([at.key, at.label, at.assignable], ["available", "At the hub", true]);
  const forming = riderTripStatus({ state: "trip_forming", orderIds: ["a", "b"] });
  assert.deepEqual([forming.label, forming.assignable], ["Trip forming · 2 orders", true]);
  assert.match(forming.note, /joins the same trip/);
  assert.equal(riderTripStatus({ state: "trip_forming", orderIds: ["a"] }).label, "Trip forming · 1 order");
  const out = riderTripStatus({ state: "on_trip" });
  assert.deepEqual([out.key, out.assignable], ["on_trip", false]);
  assert.match(out.note, /return to the hub is confirmed/);
  const back = riderTripStatus({ state: "returning_to_hub" });
  assert.deepEqual([back.key, back.assignable], ["returning", false]);
  assert.match(back.note, /Confirm their return in Cargo Loading/);
  // Not classified yet: selectable — the server classifies from their orders and decides.
  const unknown = riderTripStatus(undefined);
  assert.deepEqual([unknown.key, unknown.assignable], ["unconfirmed", true]);
});

test("Riders waiting for a return confirmation, newest first, never dropped for a missing profile", () => {
  const ms = (n) => ({ toMillis: () => n });
  const states = indexRiderStates([
    { id: "r1", state: "returning_to_hub", tripId: "T1", orderIds: ["a", "b"], settledAt: ms(100) },
    { id: "r2", state: "returning_to_hub", tripId: "T2", orderIds: ["c"], settledAt: ms(200) },
    { id: "r3", state: "on_trip", tripId: "T3", orderIds: ["d"] },
    { id: "r4", state: "returning_to_hub", tripId: null },
    { id: "ghost", state: "returning_to_hub", tripId: "T5", orderIds: [] },
  ]);
  const list = ridersReturningToHub(states, [
    { uid: "r1", fullName: "Rider One", vehiclePlate: "ABC-1" },
    { uid: "r2", name: "Rider Two" },
  ]);
  assert.deepEqual(list.map((r) => [r.riderUid, r.tripId, r.name, r.orderCount]), [
    ["r2", "T2", "Rider Two", 1],
    ["r1", "T1", "Rider One", 2],
    ["ghost", "T5", "Rider", 0],
  ]);
  assert.equal(list[1].plate, "ABC-1");
});

test("a loading group of a Rider still out cannot be finalized; a forming one sends its trip id", () => {
  for (const state of ["on_trip", "returning_to_hub"]) {
    const g = cargoGroupDispatch({ state, tripId: "T" });
    assert.equal(g.canFinalize, false, state);
    assert.match(g.reason, /next trip, after their return to the hub is confirmed/);
  }
  assert.deepEqual(cargoGroupDispatch({ state: "trip_forming", tripId: "T9" }), { canFinalize: true, tripId: "T9", reason: "" });
  assert.deepEqual(cargoGroupDispatch(undefined), { canFinalize: true, tripId: null, reason: "" });
});

// ---------------------------------------------------------------- wiring (source contracts)

test("Cargo Loading: Finalize sends the trip, holds while out, and confirms returns", () => {
  const page = strip(read("src/pages/dispatcher/DispatcherCargoLoading.jsx"));
  assert.match(page, /await finalizeRiderDispatch\(\s*group\.riderId,\s*group\.orders\.map\(\(o\) => o\.id\),\s*cargoGroupDispatch\(tripStates\.get\(group\.riderId\)\)\.tripId\s*\);/);
  assert.match(page, /tripHold=\{cargoGroupDispatch\(tripStates\.get\(group\.riderId\)\)\}/);
  assert.match(page, /group\.allLoaded && !dispatched && !finalizing && heldOrders\.length === 0 && tripHold\.canFinalize;/);
  assert.match(page, /const returning = useMemo\(\(\) => ridersReturningToHub\(tripStates, riders\), \[tripStates, riders\]\);/);
  assert.match(page, /await confirmRiderReturnToHub\(\{ riderUid: entry\.riderUid, tripId: entry\.tripId \}\);/);
  // The confirmation states what it means — a physical return.
  assert.match(page, /consequence="Confirm only once this rider is physically back at the distribution hub\. They become available for new assignments\."/);
  // Finalize says what departure locks.
  assert.match(page, /No more orders can be assigned to this rider until their return to the hub is confirmed\./);
  // Both dialogs are portaled out of the transformed content area.
  assert.equal((page.match(/<DispatcherDialogLayer>\s*<ConfirmDialog/g) || []).length, 2);
});

test("Assign Rider: Riders out on a trip are shown as such and cannot be picked", () => {
  const page = strip(read("src/pages/dispatcher/DispatcherAssignRider.jsx"));
  assert.match(page, /const trip = tripOf\(rider\.uid\);/);
  assert.match(page, /disabled=\{saving \|\| !trip\.assignable\}/);
  assert.match(page, /<small className=\{`ar-rider-trip \$\{trip\.key\}`\}>\{trip\.label\}<\/small>/);
  // The dialog is portaled out of the transformed content area.
  assert.match(page, /\{selectedOrder && \(\s*<DispatcherDialogLayer>\s*<div className="arq-backdrop" onClick=\{closeDialog\}>/);
});

test("the Dispatcher portal carries the shell scope and nothing else", () => {
  const layer = read("src/pages/dispatcher/DispatcherDialogLayer.jsx");
  assert.match(layer, /export const DISPATCHER_DIALOG_SCOPE = "dispatcher-page dispatcher-content";/);
  assert.doesNotMatch(layer, /DISPATCHER_DIALOG_SCOPE = "[^"]*route-view/, "the animated class is never applied");
  assert.match(layer, /<DialogLayer scope=\{DISPATCHER_DIALOG_SCOPE\}>\{children\}<\/DialogLayer>/);
  // The transform that makes the portal necessary is on the content area, not the shell.
  assert.match(read("src/pages/dispatcher/DispatcherLayout.jsx"), /className="dispatcher-content route-view"/);
  assert.match(read("src/styles/shell-transitions.css"), /\.route-view \{\s*animation: routeViewIn 0\.26s ease both;/);
});

test("every server-owned move goes through its callable", () => {
  const svc = read("src/services/riderDispatchService.js");
  for (const name of ["assignRiderToOrder", "finalizeRiderDispatch", "confirmRiderReturnToHub"]) {
    assert.match(svc, new RegExp(`httpsCallable\\(fns, "${name}"\\)`), name);
  }
  // No client service writes a departure or an assignment any more.
  for (const p of ["src/services/orderService.js", "src/services/cargoLoadingService.js"]) {
    const code = strip(read(p));
    assert.doesNotMatch(code, /status:\s*"in_transit"/, p);
    assert.doesNotMatch(code, /status:\s*"assigned"/, p);
    // (An order created unassigned may carry `assignedRiderId: null`.)
    assert.doesNotMatch(code, /assignedRiderId:(?!\s*null\b)/, p);
  }
});
