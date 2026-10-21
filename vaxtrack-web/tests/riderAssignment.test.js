import test from "node:test";
import assert from "node:assert/strict";
import {
  callableError,
  createServiceLoader,
  createStore,
  installCallables,
  installStore,
} from "./serviceHarness.js";

// Rider assignment — the web side.
//
// Assignment is the assignRiderToOrder CALLABLE (Rider trips): the decision
// needs the Rider's server-owned trip state, which no client write can read,
// and firestore.rules refuse the direct write, Admin included. Every check the
// old client transaction made — order still pending and unassigned (absent,
// null and "" mean unassigned; whitespace does not), date reached, fully
// reserved, the user an approved rider by exact role/status, display fields
// from the rider document, route fields cleared, attribution from the
// verified caller, nothing else touched, races serialized — is now made by
// the server and tested against a real Firestore in
// functions/test/integration/riderDispatch.test.js.
//
// What remains here: the page's service sends exactly the ids, writes
// nothing itself, and turns every server answer into the error type and
// codes the Assign Rider page already handles.

const loader = createServiceLoader();
const { assignRiderToOrder, AssignmentError } = await loader.load("orderService.js");

const ORDER_ID = "OrderDocAbc";
const RIDER_UID = "RiderDocUid123";
const DISPATCHER = { uid: "DispatcherUid", email: "dispatcher@vaxtrack.com" };

const ok = { orderId: ORDER_ID, riderUid: RIDER_UID, tripId: "TripFromServer", replayed: false };

async function expectRejection(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AssignmentError, `expected AssignmentError, got ${err?.name}`);
    assert.equal(err.code, code);
    assert.ok(err.message.length > 0, "the error must carry a displayable message");
    return true;
  });
  return code;
}

test("assignment is one callable request carrying only the two ids", async () => {
  const store = installStore(createStore({ orders: { [ORDER_ID]: { status: "pending_dispatch" } } }), DISPATCHER);
  const calls = installCallables({ assignRiderToOrder: () => ok });
  const result = await assignRiderToOrder(ORDER_ID, RIDER_UID);
  assert.deepEqual(result, ok);
  assert.deepEqual(calls, [{ name: "assignRiderToOrder", data: { orderId: ORDER_ID, riderUid: RIDER_UID } }]);
  // No display value, no audit and no timestamp is sent — the server writes them.
  assert.equal(store.writes.length, 0, "the client writes nothing to Firestore");
});

test("server refusals keep their stable code, sentence and context", async () => {
  installStore(createStore(), DISPATCHER);
  const cases = [
    ["order-not-pending", "That order is no longer awaiting dispatch. Refresh the queue.", { status: "assigned" }],
    ["order-already-assigned", "That order has already been assigned to a rider."],
    ["order-not-found", "That order no longer exists."],
    ["rider-not-approved", "That rider is not approved for assignment."],
    ["not-a-rider", "That account is not a rider."],
    ["rider-not-found", "That rider account no longer exists."],
    ["scheduled-date-not-reached", "This order is scheduled for a later date and cannot be dispatched yet."],
    ["order-not-fully-reserved", "This order is still waiting for stock."],
    ["rider-on-trip", "This rider has already left on a trip."],
    ["rider-returning", "This rider is returning to the hub."],
  ];
  for (const [code, message, info] of cases) {
    installCallables({ assignRiderToOrder: () => { throw callableError(code, message, info); } });
    await assert.rejects(assignRiderToOrder(ORDER_ID, RIDER_UID), (err) => {
      assert.ok(err instanceof AssignmentError);
      assert.deepEqual([err.code, err.message], [code, message]);
      if (info) assert.deepEqual(err.details, info, "the page reads details.status to say what happened");
      return true;
    });
  }
});

test("transport failures are worded, never passed through raw", async () => {
  installStore(createStore(), DISPATCHER);
  for (const [sdkCode, code] of [
    ["functions/unavailable", "unavailable"],
    ["functions/deadline-exceeded", "deadline-exceeded"],
    ["functions/unauthenticated", "unauthenticated"],
    ["functions/internal", "service-unavailable"],
  ]) {
    installCallables({
      assignRiderToOrder: () => {
        const e = new Error("RAW SDK TEXT with internals");
        e.code = sdkCode;
        throw e;
      },
    });
    await assert.rejects(assignRiderToOrder(ORDER_ID, RIDER_UID), (err) => {
      assert.ok(err instanceof AssignmentError);
      assert.equal(err.code, code);
      assert.doesNotMatch(err.message, /RAW SDK TEXT/);
      return true;
    });
  }
});

test("an empty identity or a signed-out session is refused before any request", async () => {
  installStore(createStore(), DISPATCHER);
  const calls = installCallables({ assignRiderToOrder: () => ok });
  await expectRejection(assignRiderToOrder("", RIDER_UID), "order-id-required");
  await expectRejection(assignRiderToOrder("   ", RIDER_UID), "order-id-required");
  await expectRejection(assignRiderToOrder(ORDER_ID, ""), "rider-uid-required");
  await expectRejection(assignRiderToOrder(ORDER_ID, null), "rider-uid-required");
  installStore(createStore(), null);
  await expectRejection(assignRiderToOrder(ORDER_ID, RIDER_UID), "not-signed-in");
  assert.equal(calls.length, 0, "nothing reached the server");
});

test("a repeated submission is answered by the server as a replay, not a second assignment", async () => {
  installStore(createStore(), DISPATCHER);
  let n = 0;
  installCallables({ assignRiderToOrder: () => ({ ...ok, replayed: n++ > 0 }) });
  assert.equal((await assignRiderToOrder(ORDER_ID, RIDER_UID)).replayed, false);
  assert.equal((await assignRiderToOrder(ORDER_ID, RIDER_UID)).replayed, true);
});

test("no client code path writes an assignment any more", async () => {
  const { readFileSync } = await import("node:fs");
  // Line endings normalised: a Windows checkout (core.autocrlf) has CRLF, and
  // the slice below looks for "\n}\n".
  const src = readFileSync(new URL("../src/services/orderService.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function assignRiderToOrder"), src.indexOf("\n}\n", src.indexOf("export async function assignRiderToOrder")));
  assert.match(fn, /return await assignRiderToOrderOnServer\(orderId, riderUid\);/);
  assert.doesNotMatch(fn, /runTransaction|updateDoc|tx\.update|assignedRiderId:/);
});
