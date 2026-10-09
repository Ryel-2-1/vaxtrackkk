"use strict";

/**
 * Order status history against a REAL Firestore (emulator): idempotency under
 * redelivery and the once-only firstDispatchedAt milestone are transactional
 * properties a pure test cannot prove.
 *
 * Uses its own demo project so the other integration suites' wipes, running in
 * parallel, cannot touch these documents.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-status-events" }, "status-events");
const db = app.firestore();
const { Timestamp } = admin.firestore;

const { recordStatusEvent, deriveStatusEvent, STATUS_EVENTS } = require("../../src/statusEvents");

const at = (iso) => Timestamp.fromDate(new Date(iso));

async function reset(orderId, data) {
  const ref = db.collection("orders").doc(orderId);
  const events = await ref.collection(STATUS_EVENTS).get();
  await Promise.all(events.docs.map((d) => d.ref.delete()));
  await ref.set(data);
  return ref;
}

async function record(orderId, eventId, before, after, iso) {
  const event = deriveStatusEvent({ before, after });
  return recordStatusEvent({ db, orderId, eventId, event, at: at(iso) });
}

test("a redelivered trigger records its event exactly once", async () => {
  const ref = await reset("se-dup", { status: "loading" });
  const first = await record("se-dup", "evt-1", { status: "assigned" }, { status: "loading" }, "2026-10-04T01:00:00Z");
  const again = await record("se-dup", "evt-1", { status: "assigned" }, { status: "loading" }, "2026-10-04T01:00:00Z");
  assert.equal(first.recorded, true);
  assert.deepEqual(again, { recorded: false, reason: "duplicate-delivery" });
  const events = await ref.collection(STATUS_EVENTS).get();
  assert.equal(events.size, 1);
  assert.equal(events.docs[0].get("to"), "loading");
});

test("firstDispatchedAt is set by the first transit only — a resume never moves it", async () => {
  const ref = await reset("se-transit", { status: "in_transit" });
  const r1 = await record("se-transit", "evt-a", { status: "loading" }, { status: "in_transit" }, "2026-10-04T02:00:00Z");
  assert.equal(r1.stampedFirstDispatch, true);

  await record("se-transit", "evt-b", { status: "in_transit" }, { status: "delayed", delayReason: "Flat tyre" }, "2026-10-04T03:00:00Z");
  const r3 = await record("se-transit", "evt-c", { status: "delayed" }, { status: "in_transit" }, "2026-10-04T04:30:00Z");
  assert.equal(r3.stampedFirstDispatch, false);

  const order = await ref.get();
  assert.equal(order.get("firstDispatchedAt").toDate().toISOString(), "2026-10-04T02:00:00.000Z");

  const events = (await ref.collection(STATUS_EVENTS).orderBy("at").get()).docs.map((d) => [d.get("from"), d.get("to"), d.get("reason")]);
  assert.deepEqual(events, [
    ["loading", "in_transit", null],
    ["in_transit", "delayed", "Flat tyre"],
    ["delayed", "in_transit", null],
  ]);
});

test("an event for an order deleted before the trigger ran is skipped, not resurrected", async () => {
  const ref = db.collection("orders").doc("se-gone");
  await ref.delete();
  const result = await record("se-gone", "evt-x", { status: "assigned" }, { status: "cancelled" }, "2026-10-04T05:00:00Z");
  assert.deepEqual(result, { recorded: false, reason: "order-deleted" });
  assert.equal((await ref.get()).exists, false);
  assert.equal((await ref.collection(STATUS_EVENTS).get()).size, 0);
});

test.after(async () => {
  for (const id of ["se-dup", "se-transit", "se-gone"]) {
    const ref = db.collection("orders").doc(id);
    const events = await ref.collection(STATUS_EVENTS).get();
    await Promise.all(events.docs.map((d) => d.ref.delete()));
    await ref.delete();
  }
  await app.delete();
});
