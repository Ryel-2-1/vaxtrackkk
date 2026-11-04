"use strict";

// Rider push notifications — who is told what (src/riderPush.js), and the
// sending side with a fake FCM (src/riderPushOps.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/riderPush");
const { notifyRiderOnOrderWrite } = require("../src/riderPushOps");

const order = (over = {}) => ({
  orderNumber: "VT-ORD-1793613665790-QL0A",
  status: "assigned",
  assignedRiderId: "riderA",
  destinationName: "BFC Halang",
  ...over,
});
const kinds = (before, after) => P.riderNotificationsFor(before, after).map((n) => `${n.kind}:${n.riderUid}`);

test("a new assignment tells the assigned rider, with the order code and destination only", () => {
  const [n] = P.riderNotificationsFor(order({ status: "pending_dispatch", assignedRiderId: null }), order());
  assert.deepEqual([n.riderUid, n.kind, n.title], ["riderA", "assigned", "New delivery assigned"]);
  assert.equal(n.body, "Order QL0A to BFC Halang was assigned to you. Open VaxTrack for the details.");
  assert.deepEqual(kinds(null, order()), ["assigned:riderA"], "created already assigned");
});

test("a home delivery never names the address", () => {
  const [n] = P.riderNotificationsFor(null, order({ destinationType: "home", destinationName: "12 Secret St." }));
  assert.match(n.body, /to Doctor's private address/);
  assert.equal(n.body.includes("Secret"), false);
});

test("reassignment tells both riders; nothing is sent for unrelated changes", () => {
  assert.deepEqual(kinds(order(), order({ assignedRiderId: "riderB" })), ["assigned:riderB", "reassigned:riderA"]);
  assert.deepEqual(kinds(order(), order({ status: "loading", isLoaded: true })), []);
  assert.deepEqual(kinds(order({ status: "loading" }), order({ status: "in_transit" })), []);
  assert.deepEqual(kinds(order(), order({ assignedRiderId: null, status: "pending_dispatch" })), ["reassigned:riderA"]);
});

test("cancellation tells the rider who had it, once", () => {
  assert.deepEqual(kinds(order({ status: "in_transit" }), order({ status: "cancelled" })), ["cancelled:riderA"]);
  assert.deepEqual(kinds(order({ status: "cancelled" }), order({ status: "cancelled", updatedAt: 2 })), []);
  assert.deepEqual(kinds(order({ status: "pending_dispatch", assignedRiderId: null }), order({ status: "cancelled", assignedRiderId: null })), []);
});

test("an offline review decision tells the rider who recorded it", () => {
  const pending = { status: "pending", riderUid: "riderA" };
  const before = order({ status: "in_transit", offlineCompletionReview: pending });
  assert.deepEqual(kinds(before, order({ status: "delivered", offlineCompletionReview: { ...pending, status: "approved" } })), ["offline_approved:riderA"]);
  const [rej] = P.riderNotificationsFor(before, order({ status: "in_transit", offlineCompletionReview: { ...pending, status: "rejected" } }));
  assert.equal(rej.kind, "offline_rejected");
  assert.match(rej.body, /complete it again or report a failed delivery/);
  assert.deepEqual(kinds(order({ status: "in_transit" }), before), [], "a record going INTO review sends nothing");
});

// ---------------------------------------------------------------- sending

function fakeDb(tokensByRider) {
  const store = new Map(Object.entries(tokensByRider));
  return {
    store,
    collection: (name) => {
      assert.equal(name, P.TOKENS_COLLECTION);
      return {
        doc: (id) => ({
          get: async () => ({ exists: store.has(id), get: (k) => (k === "tokens" ? store.get(id) : undefined) }),
          update: async ({ tokens }) => store.set(id, store.get(id).filter((t) => !tokens.removed.includes(t))),
        }),
      };
    },
  };
}
const FieldValue = { arrayRemove: (...removed) => ({ removed }) };

test("sends to every phone the rider is signed in on, and removes tokens FCM reports as gone", async () => {
  const db = fakeDb({ riderA: ["good", "gone"] });
  const sent = [];
  const messaging = {
    sendEachForMulticast: async (msg) => {
      sent.push(msg);
      return {
        successCount: 1,
        responses: [{ success: true }, { success: false, error: { code: "messaging/registration-token-not-registered" } }],
      };
    },
  };
  const r = await notifyRiderOnOrderWrite({ db, messaging, FieldValue, orderId: "o1", before: null, after: order() });
  assert.deepEqual(r, [{ kind: "assigned", sent: 1, removed: 1 }]);
  assert.deepEqual(sent[0].tokens, ["good", "gone"]);
  assert.deepEqual(sent[0].data, { orderId: "o1", kind: "assigned" });
  assert.equal(sent[0].android.notification.tag, "assigned_o1");
  assert.deepEqual(db.store.get("riderA"), ["good"]);
});

test("a rider with no signed-in phone is skipped; other send errors are logged, not retried", async () => {
  const messaging = {
    sendEachForMulticast: async () => ({ successCount: 0, responses: [{ success: false, error: { code: "messaging/internal-error" } }] }),
  };
  const logged = [];
  assert.deepEqual(
    await notifyRiderOnOrderWrite({ db: fakeDb({}), messaging, FieldValue, orderId: "o1", before: null, after: order() }),
    [{ kind: "assigned", sent: 0, reason: "no-device" }],
  );
  const db = fakeDb({ riderA: ["t1"] });
  await notifyRiderOnOrderWrite({ db, messaging, FieldValue, orderId: "o1", before: null, after: order(), log: (d) => logged.push(d) });
  assert.deepEqual(logged, [{ kind: "assigned", errorCode: "messaging/internal-error" }]);
  assert.deepEqual(db.store.get("riderA"), ["t1"], "a temporary failure keeps the token");
});
