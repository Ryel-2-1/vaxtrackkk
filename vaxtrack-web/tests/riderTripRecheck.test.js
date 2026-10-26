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
  // 1. The control exists, labelled, with its loading state.
  assert.match(page, /className="arq-recheck"\s*onClick=\{recheckTrips\}/);
  assert.match(page, /\{rechecking \? "Re-checking…" : "Re-check trip status"\}/);
  assert.match(page, /disabled=\{rechecking \|\| saving \|\| ridersLoading \|\| approvedRiders\.length === 0\}/);
  // 2. It calls the existing Part B service — no backend logic of its own, no direct writes.
  assert.match(page, /import \{ recheckRiderTripStatesOnServer, subscribeRiderDispatchStates \} from "\.\.\/\.\.\/services\/riderDispatchService";/);
  assert.match(page, /const riderUids = approvedRiders\.map\(\(r\) => r\.uid\);/);
  assert.match(page, /await recheckRiderTripStatesOnServer\(riderUids\)/);
  assert.equal(/\b(setDoc|updateDoc|addDoc|writeBatch|runTransaction)\(/.test(page), false, "the page writes nothing to Firestore");
  // 4. Success: the friendly summary, and the corrected states arrive through
  //    the live trip-state listener that feeds the Rider list.
  assert.match(page, /setRecheckNote\(describeRecheck\(results\)\)/);
  assert.match(page, /subscribeRiderDispatchStates\(setTripStates,/);
  assert.match(page, /const tripOf = \(uid\) => riderTripStatus\(tripStates\.get\(uid\)\);/);
  // 5. Failure: a friendly sentence, logged safely — never the raw error.
  assert.match(page, /logSafeError\("Re-check trip status", error\);/);
  assert.match(page, /friendlyErrorMessage\(error, "Trip status could not be re-checked\. Nothing was changed — please try again\."\)/);
  assert.equal(/setRecheckNote\(\{[^}]*error\.message/.test(page), false);
});

test("a re-check runs once however many clicks arrive before the button disables", async () => {
  const page = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  // 3. The guard is synchronous and outside render (the disabled button is not one).
  assert.match(page, /import \{ createSingleFlight \} from "\.\.\/\.\.\/services\/singleFlight";/);
  assert.match(page, /if \(recheckFlight\.current\.busy \|\| approvedRiders\.length === 0\) return;/);
  assert.match(page, /recheckFlight\.current\.run\(async \(\) => \{/);
  // …and that guard really does collapse a burst into one call.
  const { createSingleFlight } = await import("../src/services/singleFlight.js");
  const flight = createSingleFlight();
  let calls = 0;
  let release;
  const action = () => {
    calls += 1;
    return new Promise((r) => {
      release = r;
    });
  };
  const a = flight.run(action);
  const b = flight.run(action);
  const c = flight.run(action);
  assert.equal(calls, 1);
  assert.ok(a === b && b === c);
  release();
  await a;
  flight.run(() => {
    calls += 1;
  });
  assert.equal(calls, 2, "the next click after it settles runs again");
});

test("the re-check stays in reach above a long Rider list", () => {
  // 6. It lives in a sticky bar that is a direct child of the dialog's scroll
  //    area and comes BEFORE the list — never below it.
  const page = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  const bar = page.indexOf('<div className="arq-riders-bar">');
  const button = page.indexOf('className="arq-recheck"');
  const list = page.indexOf('className="ar-rider-list arq-riders"');
  const actions = page.indexOf('className="arq-dialog-actions"');
  assert.ok(bar > 0 && bar < button && button < list && list < actions, "bar → button → list → Cancel/Confirm");
  const css = read("src/pages/dispatcher/DispatcherAssignRider.css");
  assert.match(css, /\.arq-dialog \{[^}]*max-height: calc\(100vh - 32px\);\s*overflow-y: auto;/, "the dialog scrolls internally");
  assert.match(css, /\.arq-riders-bar \{\s*position: sticky;\s*top: 0;\s*z-index: 2;[^}]*background: #ffffff;/);
});
