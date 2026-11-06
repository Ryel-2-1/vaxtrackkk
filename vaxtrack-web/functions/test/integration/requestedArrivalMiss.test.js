"use strict";

/**
 * Past requested arrival against a REAL Firestore (emulator): the sweep marks,
 * leaves alone and clears orders. Run: npm run test:emulator.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-requested-miss" }, "requested-miss-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const { evaluateRequestedArrivalRun } = require("../../src/requestedArrivalOps");

const NOW = new Date("2026-11-04T16:15:00.000Z"); // 12:15 AM, Nov 5 in Manila
const WINDOW = { version: 1, mode: "window", start: "17:00", end: "19:00" };
const ref = (id) => db.collection("orders").doc(id);
const get = async (id) => (await ref(id).get()).data();
const run = (now = NOW) => evaluateRequestedArrivalRun({ db, FieldValue, Timestamp, now });

async function world() {
  const snap = await db.collection("orders").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await ref("late").set({ status: "in_transit", timingStatus: "on_time", requestedDeliveryDate: "2026-11-04", requestedArrival: WINDOW });
  await ref("tomorrow").set({ status: "in_transit", requestedDeliveryDate: "2026-11-05", requestedArrival: WINDOW });
  await ref("done").set({ status: "delivered", requestedDeliveryDate: "2026-11-04", requestedArrival: WINDOW });
}

test("an order past its requested arrival is marked; its status and timing are untouched", async () => {
  await world();
  const counts = await run();
  assert.deepEqual(counts, { scanned: 2, marked: 1, cleared: 0, failed: 0 });
  const late = await get("late");
  assert.deepEqual([late.status, late.timingStatus], ["in_transit", "on_time"]);
  assert.ok(late.requestedArrivalMissedAt);
  assert.equal(late.requestedArrivalDeadlineAt.toDate().toISOString(), "2026-11-04T11:01:00.000Z");
  assert.equal((await get("tomorrow")).requestedArrivalMissedAt, undefined);
  assert.equal((await get("done")).requestedArrivalMissedAt, undefined);
});

test("a repeat run writes nothing; a reschedule to a later date clears the marker", async () => {
  await world();
  await run();
  const first = (await get("late")).requestedArrivalMissedAt;
  assert.deepEqual(await run(), { scanned: 2, marked: 0, cleared: 0, failed: 0 });
  assert.ok((await get("late")).requestedArrivalMissedAt.isEqual(first));
  await ref("late").update({ requestedDeliveryDate: "2026-11-06" });
  assert.deepEqual(await run(), { scanned: 2, marked: 0, cleared: 1, failed: 0 });
  const cleared = await get("late");
  assert.equal(cleared.requestedArrivalMissedAt, undefined);
  assert.equal(cleared.requestedArrivalDeadlineAt, undefined);
});
