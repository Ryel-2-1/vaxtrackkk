import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeRecheck } from "../src/services/riderTrip.js";
import { callableError, createServiceLoader, createStore, installCallables, installStore } from "./serviceHarness.js";

// "Re-check trip status" — the web side of the recovery for a Rider trip
// state left stale by a missed update. The server re-derives each named
// Rider's state from their orders (functions/src/riderDispatchOps.js
// recheckRiderTripStates, tested against a real Firestore in
// functions/test/integration/riderDispatchStale.test.js); the page only names
// the Riders and reports the outcome.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const loader = createServiceLoader();
const svc = await loader.load("riderDispatchService.js");
const DISPATCHER = { uid: "disp1", email: "d@x.test" };

test("the re-check names the Riders, in server-sized batches, and writes nothing itself", async () => {
  const store = installStore(createStore(), DISPATCHER);
  const calls = installCallables({
    recheckRiderTripStates: (data) => ({ results: data.riderUids.map((riderUid) => ({ riderUid, changed: riderUid === "r3" })) }),
  });
  const riders = Array.from({ length: 30 }, (_, i) => `r${i}`);
  const results = await svc.recheckRiderTripStatesOnServer([...riders, "r1", "", null]);
  assert.equal(svc.RECHECK_BATCH, 25, "the server's MAX_RECHECK_RIDERS");
  assert.deepEqual(calls.map((c) => c.data.riderUids.length), [25, 5], "deduplicated, then batched");
  assert.equal(calls.every((c) => c.name === "recheckRiderTripStates"), true);
  assert.equal(results.length, 30);
  assert.equal(results.find((r) => r.riderUid === "r3").changed, true);
  assert.equal(store.writes.length, 0, "the client writes no trip state");
});

test("a refusal keeps the server's code and sentence; the transport never leaks", async () => {
  installStore(createStore(), DISPATCHER);
  installCallables({
    recheckRiderTripStates: () => {
      throw callableError("wrong-role", "Your account cannot perform this action.");
    },
  });
  await assert.rejects(svc.recheckRiderTripStatesOnServer(["r1"]), (e) => {
    assert.ok(e instanceof svc.RiderDispatchError);
    assert.equal(e.code, "wrong-role");
    return true;
  });
  installCallables({});
  await assert.rejects(svc.recheckRiderTripStatesOnServer(["r1"]), (e) => /Nothing was changed/.test(e.message));
});

test("the outcome sentence: corrected, up to date, and riders that could not be checked", () => {
  assert.deepEqual(describeRecheck([{ riderUid: "a", changed: false }, { riderUid: "b", changed: false }]), {
    text: "Trip status re-checked for 2 riders: all were up to date.",
    corrected: 0,
    unknown: 0,
    tone: "success",
  });
  const mixed = describeRecheck([
    { riderUid: "a", changed: true },
    { riderUid: "b", error: "rider-state-unknown", orderIds: ["w"] },
    { riderUid: "c", error: "not-a-rider" },
  ]);
  assert.equal(mixed.corrected, 1);
  assert.equal(mixed.unknown, 1);
  assert.equal(mixed.tone, "error");
  assert.match(mixed.text, /re-checked for 1 rider: 1 status corrected/);
  assert.match(mixed.text, /1 rider could not be checked — an order needs review/);
});

test("Assign Rider offers the re-check for the riders it lists, and shows the outcome", () => {
  const page = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  assert.match(page, /recheckRiderTripStatesOnServer\(approvedRiders\.map\(\(r\) => r\.uid\)\)/);
  assert.match(page, /setRecheckNote\(describeRecheck\(results\)\)/);
  assert.match(page, /\{rechecking \? "Re-checking…" : "Re-check trip status"\}/);
  assert.match(page, /disabled=\{rechecking \|\| saving \|\| ridersLoading \|\| approvedRiders\.length === 0\}/);
  assert.match(page, /friendlyErrorMessage\(error, "Trip status could not be re-checked\./);
});
