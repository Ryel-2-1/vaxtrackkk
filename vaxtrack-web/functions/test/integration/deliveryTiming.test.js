"use strict";

/**
 * Automatic delivery timing against a REAL Firestore (emulator): the attempt
 * baseline frozen by the status-history trigger on dispatch, the due-time
 * scheduled evaluator, the Rider-reported hold, the one alert + history event
 * per attempt, permanent "unknown" for an
 * attempt dispatched without a usable ETA (no post-dispatch recovery), the
 * due-time query draining without starvation, and requeue / redispatch
 * isolation. Proof/completion stay governed by the lifecycle only.
 *
 * Dispatches are written for real (as Cargo Loading's finalize writes them)
 * and their trigger is delivered with the exact before/after snapshots and
 * commit time Firestore sends — whenever, and as often as, a test chooses.
 * Run:  npm run test:emulator   (in functions/).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-timing" }, "timing-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const { placeRiderAtDestination } = require("../helpers/riderAtDestination");
const { encode } = require("../helpers/polyline");
const { canonicalProofPath, canonicalInvoicePath } = require("../../src/deliveryEvidence");
const ops = require("../../src/operations");
const flow = require("../../src/inventoryWorkflow");
const statusEvents = require("../../src/statusEvents");
const timing = require("../../src/deliveryTimingOps");
const D = require("../../src/deliveryTiming");

const NOW = new Date("2026-10-05T02:00:00.000Z");
const DELIVERY_DATE = "2026-10-10";
const SR = "rep1";
const DISPATCHER = "disp1";
const RIDER = "rider1";
const ADMIN = "admin1";
const P = "vacP";
const PRICE = 125000;
const MIN = 60000;
const ROUTE = encode([{ lat: 14.59, lng: 120.97 }, { lat: 14.6, lng: 120.98 }]);

let seq = 0;
const rid = () => `ctim${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;
let eventSeq = 0;
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const get = async (col, id) => {
  const s = await db.collection(col).doc(id).get();
  return s.exists ? s.data() : null;
};
const order = (id) => get("orders", id);
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : null);
const ref = (id) => db.collection("orders").doc(id);

async function wipe() {
  for (const c of [
    "users", "doctors", "clinics", "areas", "vaccines", "inventory", "orders", "inventoryReservations",
    "inventoryReturns", "orderRequestKeys", "orderReceipts", "inventoryAllocationEvents", "orderHistoryOutbox",
    "allocationContinuations", "riderLocations", "alerts",
  ]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map(async (d) => {
      for (const sub of await d.ref.listCollections()) {
        const s = await sub.get();
        await Promise.all(s.docs.map((x) => x.ref.delete()));
      }
      await d.ref.delete();
    }));
  }
}

async function seed() {
  await wipe();
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved", assignedAreaIds: ["area1"], assignedClinicIds: ["clinic1"] });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(RIDER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
  await db.collection("areas").doc("area1").set({ name: "Manila", active: true });
  await db.collection("clinics").doc("clinic1").set({
    clinicId: "CLN-1", name: "Clinic", location: "10 Mabini Street, Manila", areaId: "area1", area: "Manila",
    status: "active", locationVerified: true, latitude: 14.6, longitude: 120.98, geofenceRadiusM: 300,
  });
  await db.collection("doctors").doc("doctor1").set({ name: "Dr. Ana Reyes", areaId: "area1", area: "Manila", active: true });
  await db.collection("doctors").doc("doctor1").collection("deliveryAddresses").doc("clinic1").set({ active: true });
  await db.collection("vaccines").doc(P).set({ vaccineName: "Vaccine P", vaccineType: "T", vatClassification: "vatable" });
  await db.collection("inventory").doc("b1").set({
    vaccineId: P, vaccineName: "Vaccine P", batchId: "B1", status: "Stable", expiryDate: "2027-06-30",
    quantity: 500, reservedQuantity: 0, sellingPriceCentavos: PRICE, priceIsVatInclusive: true,
  });
}

async function placeOrder() {
  const r = await ops.createOrderWithReservation({
    db, FieldValue, uid: SR, now: NOW,
    payload: {
      requestId: rid(), doctorId: "doctor1", doctorAddressId: "clinic1", requestedDeliveryDate: DELIVERY_DATE,
      items: [{ inventoryId: "b1", quantity: 5, expectedUnitPriceCentavos: PRICE }],
    },
  });
  return r.orderId;
}

/** Assigned (now), loaded and given a Dispatcher route of `etaSeconds` (a fresh, valid route). */
async function loadedWithRoute(orderId, etaSeconds = 1800, extra = {}) {
  const o = await order(orderId);
  await ref(orderId).update({
    status: "loading", assignedRiderId: RIDER, assignedRiderName: "Juan Rider", assignedAt: Timestamp.fromMillis(Date.now() - 60 * MIN),
    isLoaded: true, loadedAt: Timestamp.fromMillis(Date.now() - 5 * MIN), loadedByUid: DISPATCHER,
    routePolyline: ROUTE, routeGeneratedAt: Timestamp.fromMillis(Date.now() - 10 * MIN),
    routeDurationSeconds: etaSeconds, routeDestinationRevision: o.destinationRevision ?? 0,
    ...extra,
  });
}

/**
 * Finalize Dispatch (loading → in_transit), written for real, and its
 * status-history trigger event — returned so the test decides when (and how
 * often) it is delivered, and at what server time the trigger runs.
 */
async function dispatch(orderId) {
  const before = (await ref(orderId).get()).data();
  const wr = await ref(orderId).update({
    status: "in_transit", dispatchedAt: FieldValue.serverTimestamp(), startedAt: FieldValue.serverTimestamp(),
    statusUpdatedAt: FieldValue.serverTimestamp(), statusUpdatedByUid: DISPATCHER, updatedAt: FieldValue.serverTimestamp(),
  });
  const after = (await ref(orderId).get()).data();
  const eventId = `evt${++eventSeq}`;
  const at = wr.writeTime;
  const deliver = () => statusEvents.recordStatusEvent({
    db, orderId, eventId, event: statusEvents.deriveStatusEvent({ before, after }), at, after, FieldValue, Timestamp,
  });
  return { at: at.toMillis(), deliver };
}
/** A lifecycle write by the rider (hold / resume), with its status-history event delivered. */
async function riderMove(orderId, status, extra = {}) {
  const before = (await ref(orderId).get()).data();
  const wr = await ref(orderId).update({ status, ...extra, statusUpdatedAt: FieldValue.serverTimestamp(), statusUpdatedByUid: RIDER });
  const after = (await ref(orderId).get()).data();
  await statusEvents.recordStatusEvent({
    db, orderId, eventId: `evt${++eventSeq}`, event: statusEvents.deriveStatusEvent({ before, after }),
    at: wr.writeTime, after, FieldValue, Timestamp,
  });
}
const run = (nowMs, opts = {}) => timing.evaluateDeliveryTimingRun({ db, FieldValue, Timestamp, now: new Date(nowMs), ...opts });
const advance = (orderId, nowMs) => timing.advanceDeliveryTiming({ db, FieldValue, Timestamp, orderId, now: new Date(nowMs) });
const counts = ({ scanned, advanced, delayed, deactivated, failed }) => ({ scanned, advanced, delayed, deactivated, failed });
const alerts = async () => (await db.collection("alerts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const historyOf = async (orderId, type) =>
  (await db.collection("inventoryAllocationEvents").where("orderId", "==", orderId).get()).docs
    .map((d) => ({ id: d.id, ...d.data() })).filter((e) => !type || e.eventType === type);
const lateEvents = (orderId) => historyOf(orderId, "delivery_running_late");
const updateTime = async (col, id) => (await db.collection(col).doc(id).get()).updateTime?.toMillis() ?? null;
const baselineOf = (o) => [ms(o.expectedArrivalAt), ms(o.automaticDelayedAt), o.timingEtaSeconds, ms(o.timingBaselineAt)];

async function recordEvidence(orderId) {
  await ref(orderId).update({
    proofOfDeliveryUrl: `https://storage/${orderId}/proof.jpg`, proofOfDeliveryPath: canonicalProofPath(orderId),
    proofRecipientName: "Maria", proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: RIDER,
    invoiceUrl: `https://storage/${orderId}/invoice.jpg`, invoicePath: canonicalInvoicePath(orderId),
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: RIDER,
  });
  await placeRiderAtDestination(db, Timestamp, { uid: RIDER, orderId });
}
const complete = (orderId) => ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid: RIDER, orderId });
/** delivery_failed → return confirmed → requeued (pending_dispatch). */
async function failAndRequeue(orderId) {
  const failed = await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId, reason: "Clinic closed" } });
  await flow.confirmReturnDisposition({ db, FieldValue, uid: ADMIN, now: NOW, payload: { returnId: failed.returnId, disposition: "usable" } });
  await flow.requeueFailedOrder({ db, FieldValue, uid: DISPATCHER, now: NOW, payload: { orderId } });
}
/** A dispatched order with a known baseline (ETA 15 min → grace 10: arrival +15, deadline +25). */
async function dispatchedOrder(etaSeconds = 900) {
  const id = await placeOrder();
  await loadedWithRoute(id, etaSeconds);
  const d = await dispatch(id);
  await d.deliver();
  return { id, ...d };
}

// ---------------------------------------------------------------- baseline

test("TIM-4 a valid route at dispatch freezes ONE baseline, armed to be checked at the expected arrival", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 3600); // 60 min → 12 min grace
  assert.equal((await order(id)).timingStatus, undefined, "nothing before dispatch");
  const d = await dispatch(id);
  assert.equal((await d.deliver()).timingStatus, "on_time");
  const o = await order(id);
  assert.deepEqual(
    [o.status, o.timingStatus, o.timingContractVersion, o.timingEpoch, o.timingActive, ms(o.timingNextCheckAt), ...baselineOf(o), o.timingGraceSeconds, o.timingRouteSource],
    ["in_transit", "on_time", 1, 0, true, d.at + 60 * MIN, d.at + 60 * MIN, d.at + 72 * MIN, 3600, d.at, 720, "order"]
  );
  const t = await updateTime("orders", id);
  assert.equal((await d.deliver()).recorded, false, "a redelivered trigger changes nothing");
  assert.equal(await updateTime("orders", id), t);
});

test("TIM-5 route regeneration BEFORE dispatch updates the estimate the order is measured against", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 1800);
  await ref(id).update({ routeDurationSeconds: 4200, routeGeneratedAt: Timestamp.fromMillis(Date.now() - MIN) });
  const d = await dispatch(id);
  await d.deliver();
  const o = await order(id);
  assert.deepEqual([o.timingEtaSeconds, ms(o.expectedArrivalAt), ms(o.timingNextCheckAt)], [4200, d.at + 70 * MIN, d.at + 70 * MIN]);
});

test("TIM-6 a route changed AFTER dispatch never moves the baseline — not even if the trigger runs late", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 1800);
  const d = await dispatch(id);
  await ref(id).update({ routeDurationSeconds: 7200, routeGeneratedAt: FieldValue.serverTimestamp() });
  await d.deliver();
  assert.deepEqual(baselineOf(await order(id)), [d.at + 30 * MIN, d.at + 40 * MIN, 1800, d.at], "from the dispatch write's own snapshot");
  await ref(id).update({ routeDurationSeconds: 9000 });
  await riderMove(id, "delayed", { delayReason: "Flat tyre" });
  await riderMove(id, "in_transit");
  await run(d.at + 5 * MIN);
  await run(d.at + 31 * MIN);
  const o = await order(id);
  assert.deepEqual(baselineOf(o), [d.at + 30 * MIN, d.at + 40 * MIN, 1800, d.at]);
  assert.equal(ms(o.timingNextCheckAt), d.at + 40 * MIN, "the next check follows the frozen deadline, not the new route");
});

test("TIM-3 no usable ETA at dispatch: permanent 'unknown' for the attempt — never evaluated, never initialized later", async () => {
  for (const [label, extra] of [
    ["no ETA", { routeDurationSeconds: FieldValue.delete() }],
    ["zero ETA", { routeDurationSeconds: 0 }],
    ["string ETA", { routeDurationSeconds: "1800" }],
    ["no route", { routePolyline: FieldValue.delete() }],
    ["route older than the assignment", { routeGeneratedAt: Timestamp.fromMillis(Date.now() - 5 * 60 * MIN) }],
  ]) {
    await seed();
    const id = await placeOrder();
    await loadedWithRoute(id, 1800, extra);
    const d = await dispatch(id);
    await d.deliver();
    let o = await order(id);
    assert.deepEqual([o.status, o.timingStatus, o.timingActive, ms(o.timingBaselineAt)], ["in_transit", "unknown", false, d.at], label);
    for (const f of ["expectedArrivalAt", "automaticDelayedAt", "timingNextCheckAt"]) assert.equal(f in o, false, `${label}: ${f} absent`);
    // A valid route saved afterwards, the trigger redelivered and the scheduler
    // run long past any plausible deadline: nothing initializes the timing.
    await ref(id).update({ routeDurationSeconds: 900, routePolyline: ROUTE, routeGeneratedAt: FieldValue.serverTimestamp() });
    await d.deliver();
    assert.equal((await run(d.at + 999 * MIN)).scanned, 0, `${label}: never read by the scheduler`);
    o = await order(id);
    assert.deepEqual([o.timingStatus, o.timingActive, "expectedArrivalAt" in o, "timingNextCheckAt" in o], ["unknown", false, false, false], label);
    assert.equal((await alerts()).length, 0, label);
    // The delivery itself was never blocked: it completes normally.
    await recordEvidence(id);
    await complete(id);
    assert.equal((await order(id)).status, "delivered", label);
  }
});

test("TIM-3b no server path initializes timing after dispatch: there is no recovery operation", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 1800, { routePolyline: FieldValue.delete() });
  const d = await dispatch(id);
  await d.deliver();
  await ref(id).update({ routePolyline: ROUTE, routeDurationSeconds: 900, routeGeneratedAt: FieldValue.serverTimestamp() });
  // Every timing entry point the server exposes, tried on the unknown attempt.
  const attempts = [
    () => advance(id, d.at + 30 * MIN),
    () => run(d.at + 30 * MIN),
    () => d.deliver(),
    ...Object.entries(timing)
      .filter(([name, fn]) => typeof fn === "function" && /initiali[sz]e|recover/i.test(name))
      .map(([, fn]) => () => fn({ db, FieldValue, Timestamp, uid: DISPATCHER, payload: { orderId: id }, now: new Date(d.at + 30 * MIN) })),
  ];
  for (const attempt of attempts) await codeOf(attempt());
  const o = await order(id);
  assert.deepEqual([o.timingStatus, "expectedArrivalAt" in o, "automaticDelayedAt" in o, "timingNextCheckAt" in o], ["unknown", false, false, false]);
});

// ---------------------------------------------------------------- due-time evaluation

test("TIM-7/8 On Time → At Risk → Delayed, read only when due; one history event and one alert however often the scheduler runs", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 1800); // arrival +30, deadline +40
  const d = await dispatch(id);
  await d.deliver();
  assert.deepEqual(counts(await run(d.at + 29 * MIN)), { scanned: 0, advanced: 0, delayed: 0, deactivated: 0, failed: 0 }, "not due: not read");
  assert.deepEqual(counts(await run(d.at + 30 * MIN)), { scanned: 1, advanced: 1, delayed: 0, deactivated: 0, failed: 0 });
  let o = await order(id);
  assert.deepEqual([o.timingStatus, o.timingActive, ms(o.timingNextCheckAt)], ["at_risk", true, d.at + 40 * MIN]);
  assert.equal((await alerts()).length, 0, "no alert while only at risk");
  assert.equal((await run(d.at + 39 * MIN)).scanned, 0, "not due again until the deadline");
  const r = await run(d.at + 40 * MIN);
  assert.deepEqual([r.scanned, r.advanced, r.delayed, r.deactivated], [1, 1, 1, 1]);
  o = await order(id);
  assert.deepEqual([o.status, o.timingStatus, o.timingDelayReason, o.timingActive, "timingNextCheckAt" in o], ["in_transit", "delayed", "eta_grace_exceeded", false, false]);
  assert.equal((await alerts()).length, 1);
  assert.equal((await lateEvents(id)).length, 1);
  const times = [await updateTime("orders", id), await updateTime("alerts", `delivery_delay_${id}_e0`)];
  for (const later of [41, 60, 600]) assert.equal((await run(d.at + later * MIN)).scanned, 0);
  await Promise.all([run(d.at + 70 * MIN), run(d.at + 70 * MIN), advance(id, d.at + 70 * MIN)]);
  assert.deepEqual([await updateTime("orders", id), await updateTime("alerts", `delivery_delay_${id}_e0`)], times);
  assert.equal((await alerts()).length, 1);
  assert.equal((await lateEvents(id)).length, 1);
});

test("TIM-8b a missed at-risk run goes straight to delayed; concurrent first runs record one event and one alert", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900); // arrival +15, deadline +25
  const results = await Promise.all([1, 2, 3, 4].map(() => advance(id, at + 26 * MIN)));
  assert.equal(results.filter((x) => x.firstDelay).length, 1);
  const o = await order(id);
  assert.deepEqual([o.timingStatus, o.timingActive, "timingNextCheckAt" in o], ["delayed", false, false]);
  assert.equal((await alerts()).length, 1);
  assert.equal((await lateEvents(id)).length, 1);
});

test("TIM-8c a trigger that runs after the deadline arms the baseline; the next run raises the delay once", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 900);
  const d = await dispatch(id);
  await d.deliver();
  assert.equal((await order(id)).timingStatus, "on_time");
  const r = await run(d.at + 26 * MIN);
  assert.deepEqual([r.scanned, r.delayed], [1, 1]);
  assert.equal((await order(id)).timingStatus, "delayed");
  assert.equal((await run(d.at + 30 * MIN)).scanned, 0);
  assert.equal((await lateEvents(id)).length, 1);
});

test("TIM-9 Delivered, Failed and Cancelled orders are read once when due, retired, and never re-timed", async () => {
  await seed();
  const ids = [];
  for (const end of ["delivered", "delivery_failed", "cancelled"]) {
    const { id, at } = await dispatchedOrder(900);
    if (end === "delivered") {
      await recordEvidence(id);
      await complete(id);
    } else if (end === "delivery_failed") {
      await flow.reportDeliveryFailure({ db, FieldValue, uid: RIDER, payload: { orderId: id, reason: "Clinic closed" } });
    } else {
      await ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid: DISPATCHER, orderId: id, reason: "Clinic closed", now: NOW });
    }
    ids.push([id, end, at]);
  }
  const latest = Math.max(...ids.map((x) => x[2])) + 999 * MIN;
  const first = await run(latest);
  assert.deepEqual([first.scanned, first.advanced, first.deactivated], [3, 0, 3], "read once, retired, never advanced");
  assert.equal((await run(latest)).scanned, 0);
  for (const [id, end] of ids) {
    const o = await order(id);
    assert.deepEqual([o.status, o.timingStatus, o.timingActive, "timingNextCheckAt" in o], [end, "on_time", false, false], end);
  }
  assert.equal((await alerts()).length, 0);
});

// ---------------------------------------------------------------- manual (rider-reported) delay

test("MD-1 a hold BEFORE expected arrival: the clock keeps running; the baseline never moves", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900); // arrival +15, deadline +25
  const before = baselineOf(await order(id));
  await riderMove(id, "delayed", { delayReason: "Flat tyre", delayedAt: FieldValue.serverTimestamp() });
  await run(at + 10 * MIN);
  let o = await order(id);
  assert.deepEqual([o.status, o.timingStatus, o.timingActive, ms(o.timingNextCheckAt)], ["delayed", "on_time", true, at + 15 * MIN], "on hold, still timed");
  await run(at + 16 * MIN);
  o = await order(id);
  assert.deepEqual([o.status, o.timingStatus, ms(o.timingNextCheckAt)], ["delayed", "at_risk", at + 25 * MIN], "timing advanced during the hold");
  assert.deepEqual(baselineOf(o), before);
});

test("MD-2/3 a hold during at-risk, then the deadline passes on hold: automatically late, once; status stays the hold", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900);
  const before = baselineOf(await order(id));
  await run(at + 16 * MIN);
  assert.equal((await order(id)).timingStatus, "at_risk");
  await riderMove(id, "delayed", { delayReason: "Road closed", delayedAt: FieldValue.serverTimestamp() });
  await Promise.all([run(at + 26 * MIN), run(at + 26 * MIN), advance(id, at + 27 * MIN)]);
  const o = await order(id);
  assert.deepEqual([o.status, o.delayReason, o.timingStatus, o.timingActive], ["delayed", "Road closed", "delayed", false]);
  assert.deepEqual(baselineOf(o), before);
  const [alert] = await alerts();
  assert.deepEqual([alert.id, alert.lifecycleAtDetection], [`delivery_delay_${id}_e0`, "delayed"]);
  assert.match(alert.message, /on hold/);
  assert.equal((await alerts()).length, 1);
  const events = await lateEvents(id);
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /on hold/);
});

test("MD-4/5/6 completion refused on hold; resume after the deadline: already late, no duplicates, completion allowed", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900);
  await recordEvidence(id);
  await riderMove(id, "delayed", { delayReason: "Flat tyre", delayedAt: FieldValue.serverTimestamp() });
  assert.equal(await codeOf(complete(id)), "delivery-delayed", "the manual hold still blocks completion");
  await run(at + 30 * MIN);
  const alertTime = await updateTime("alerts", `delivery_delay_${id}_e0`);
  await riderMove(id, "in_transit", { startedAt: FieldValue.serverTimestamp() });
  let o = await order(id);
  assert.deepEqual([o.status, o.timingStatus], ["in_transit", "delayed"], "resumed: already shown as automatically late");
  await run(at + 40 * MIN);
  assert.equal(await updateTime("alerts", `delivery_delay_${id}_e0`), alertTime, "no second alert on resume");
  assert.equal((await lateEvents(id)).length, 1);
  await complete(id);
  o = await order(id);
  assert.deepEqual([o.status, o.timingStatus], ["delivered", "delayed"], "automatic lateness never blocked completion");
});

// ---------------------------------------------------------------- lifecycle independence

test("TIM-11 an automatically delayed In-Transit order is completed normally", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900);
  await run(at + 30 * MIN);
  assert.deepEqual([(await order(id)).status, (await order(id)).timingStatus], ["in_transit", "delayed"]);
  await recordEvidence(id);
  await complete(id);
  assert.deepEqual([(await order(id)).status, (await order(id)).timingStatus], ["delivered", "delayed"]);
});

test("TIM-13 completion racing the evaluator: one valid outcome, never a timing write without its record", async () => {
  for (let round = 0; round < 3; round += 1) {
    await seed();
    const { id, at } = await dispatchedOrder(900);
    await recordEvidence(id);
    const [c, t] = await Promise.allSettled([complete(id), advance(id, at + 30 * MIN)]);
    assert.equal(c.status, "fulfilled", `round ${round}: completion is never blocked by timing`);
    const o = await order(id);
    assert.equal(o.status, "delivered");
    if (t.status === "fulfilled" && t.value.advanced) {
      assert.equal(o.timingStatus, "delayed");
      assert.equal((await alerts()).length, 1);
      assert.equal((await lateEvents(id)).length, 1);
    } else {
      assert.notEqual(o.timingStatus, "delayed");
      assert.equal((await alerts()).length, 0);
      assert.equal((await lateEvents(id)).length, 0);
    }
  }
});

test("TIM-14 legacy in-transit orders without timing data are never read by the scheduler and keep working", async () => {
  await seed();
  const id = await placeOrder();
  await ref(id).update({ status: "in_transit", assignedRiderId: RIDER });
  assert.equal((await run(Date.now() + 999 * MIN)).scanned, 0);
  assert.equal("timingStatus" in (await order(id)), false);
  await recordEvidence(id);
  await complete(id);
  assert.equal((await order(id)).status, "delivered");
  const id2 = await placeOrder();
  await loadedWithRoute(id2, 900);
  const before = await order(id2);
  await ref(id2).update({ status: "in_transit" });
  await statusEvents.recordStatusEvent({ db, orderId: id2, eventId: "legacy1", event: statusEvents.deriveStatusEvent({ before, after: await order(id2) }), at: Timestamp.now() });
  assert.equal("timingStatus" in (await order(id2)), false);
});

// ---------------------------------------------------------------- due query: bounded, oldest first, no starvation

test("SCH-1 only DUE orders are read — legacy, unknown, not-yet-due and finished ones never are", async () => {
  await seed();
  const timedIds = [];
  for (let i = 0; i < 7; i += 1) timedIds.push((await dispatchedOrder(900)).id);
  const legacy = await placeOrder();
  await ref(legacy).update({ status: "in_transit", assignedRiderId: RIDER });
  const unknownId = await placeOrder();
  await loadedWithRoute(unknownId, 1800, { routePolyline: FieldValue.delete() });
  await (await dispatch(unknownId)).deliver();
  const later = await dispatchedOrder(7200); // due much later
  await riderMove(timedIds[3], "delayed", { delayReason: "Traffic", delayedAt: FieldValue.serverTimestamp() });
  const at = Date.now();
  const r = await run(at + 16 * MIN, { pageSize: 2 });
  assert.deepEqual([r.scanned, r.advanced, r.failed], [7, 7, 0], "the 7 due orders, across pages of 2 — nothing else");
  for (const id of timedIds) assert.equal((await order(id)).timingStatus, "at_risk", id);
  assert.equal((await order(later.id)).timingStatus, "on_time");
  assert.equal((await run(at + 17 * MIN, { pageSize: 2 })).scanned, 0, "processed orders left the due set");
  const runs = await Promise.all([run(at + 30 * MIN, { pageSize: 3 }), run(at + 30 * MIN, { pageSize: 2 }), run(at + 30 * MIN)]);
  assert.equal(runs.reduce((n, x) => n + x.delayed, 0), 7, "concurrent runs: each order delayed exactly once");
  assert.equal((await alerts()).length, 7);
  for (const id of timedIds) assert.equal((await lateEvents(id)).length, 1, id);
});

/** A timed in-transit order written directly (the drain tests need many, cheaply). */
async function timedOrderDirect(id, { expectedMs, deadlineMs, nextMs = expectedMs, status = "at_risk_due" } = {}) {
  await ref(id).set({
    orderNumber: `VT-${id}`, status: "in_transit", assignedRiderId: RIDER, assignedRiderName: "Juan Rider", createdByUid: SR,
    clinicName: "Clinic", items: [], timingContractVersion: 1, timingEpoch: 0, timingActive: true,
    timingStatus: status === "at_risk_due" ? "on_time" : status,
    expectedArrivalAt: Timestamp.fromMillis(expectedMs), automaticDelayedAt: Timestamp.fromMillis(deadlineMs),
    timingNextCheckAt: Timestamp.fromMillis(nextMs), timingBaselineAt: Timestamp.fromMillis(expectedMs - 15 * MIN),
  });
}

test("STARVE-1 a backlog larger than one invocation drains oldest-first across runs — nothing is hidden or repeated", async () => {
  await seed();
  const now = Date.now();
  const N = 23;
  // Due at staggered times, all before the deadline (they become at_risk and
  // stay ACTIVE): exactly the case a scan-from-the-start sweep starves. Ids
  // are named so that id order is the REVERSE of due order.
  const due = [];
  for (let i = 0; i < N; i += 1) {
    const id = `drain${String(N - i).padStart(3, "0")}`;
    await timedOrderDirect(id, { expectedMs: now - (N - i) * MIN, deadlineMs: now + 60 * MIN });
    due.push(id);
  }
  const seen = [];
  let runs = 0;
  while (runs < 10) {
    runs += 1;
    const r = await run(now, { pageSize: 3, maxPages: 2 }); // at most 6 per invocation
    if (r.scanned === 0) break;
    assert.ok(r.scanned <= 6);
    for (const id of due) {
      const o = await order(id);
      if (o.timingStatus === "at_risk" && !seen.includes(id)) seen.push(id);
    }
  }
  assert.equal(seen.length, N, "every due order was processed");
  assert.deepEqual(seen, due, "in due order (oldest first), each exactly once");
  assert.equal(runs, Math.ceil(N / 6) + 1, "4 draining runs, then an empty one");
  for (const id of due) assert.equal(ms((await order(id)).timingNextCheckAt), now + 60 * MIN, `${id} re-armed at its deadline`);
});

test("STARVE-2 an order whose check keeps failing never blocks the orders due behind it", async () => {
  await seed();
  const now = Date.now();
  // Two orders that fail every time (an id the alert contract refuses), due first.
  for (const id of ["bad.one", "bad.two"]) await timedOrderDirect(id, { expectedMs: now - 60 * MIN, deadlineMs: now - 50 * MIN, nextMs: now - 90 * MIN });
  const good = [];
  for (let i = 0; i < 9; i += 1) {
    const id = `good${i}`;
    await timedOrderDirect(id, { expectedMs: now - 30 * MIN, deadlineMs: now - 20 * MIN, nextMs: now - (30 - i) * MIN });
    good.push(id);
  }
  const r1 = await run(now, { pageSize: 3, maxPages: 2 });
  assert.equal(r1.failed, 2, "the stuck orders fail");
  assert.equal(r1.delayed, 4, "the cursor moved past them in the same run");
  const r2 = await run(now, { pageSize: 3, maxPages: 2 });
  assert.deepEqual([r2.failed, r2.delayed], [2, 4]);
  const r3 = await run(now, { pageSize: 3, maxPages: 2 });
  assert.deepEqual([r3.failed, r3.delayed], [2, 1]);
  for (const id of good) assert.equal((await order(id)).timingStatus, "delayed", id);
});

// ---------------------------------------------------------------- Dispatcher-visible notification

test("NOTE-1 the late alert tells the Dispatcher what to act on — and carries no street address", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900);
  await ref(id).update({ deliveryAddress: "88 Private Lane, Quezon City", destinationName: "Clinic One" });
  await run(at + 32 * MIN);
  const [alert] = await alerts();
  const o = await order(id);
  assert.deepEqual(
    [alert.type, alert.status, alert.orderId, alert.orderNumber, alert.riderId, alert.riderName, alert.destinationLabel,
      ms(alert.expectedArrivalAt), ms(alert.automaticDelayedAt), alert.lateMinutesAtDetection, alert.dispatchAttempt, alert.path],
    ["delivery_delay", "active", id, o.orderNumber, RIDER, "Juan Rider", "Clinic One",
      at + 15 * MIN, at + 25 * MIN, 17, 0, `/dispatcher/shipments?order=${id}`]
  );
  assert.match(alert.message, new RegExp(`Order ${o.orderNumber} with Juan Rider to Clinic One was expected by`));
  assert.equal(JSON.stringify(alert).includes("88 Private Lane"), false, "no street address");
  const home = await dispatchedOrder(900);
  await ref(home.id).update({ destinationType: "home", destinationName: "Dr. Ana Reyes (home)", deliveryAddress: "7 Secret St" });
  await run(home.at + 30 * MIN);
  const homeAlert = (await alerts()).find((a) => a.orderId === home.id);
  assert.equal(homeAlert.destinationLabel, "Doctor's private address");
  assert.equal(/Secret|Reyes/.test(JSON.stringify(homeAlert)), false);
});

test("NOTE-2 reading or resolving the alert never touches the order's timing", async () => {
  await seed();
  const { id, at } = await dispatchedOrder(900);
  await run(at + 30 * MIN);
  const before = await order(id);
  await db.collection("alerts").doc(`delivery_delay_${id}_e0`).update({ read: true, status: "resolved", resolvedAt: FieldValue.serverTimestamp() });
  await run(at + 60 * MIN);
  const after = await order(id);
  assert.deepEqual(baselineOf(after), baselineOf(before));
  assert.deepEqual([after.timingStatus, ms(after.timingDelayedAt)], [before.timingStatus, ms(before.timingDelayedAt)]);
  assert.equal((await alerts()).length, 1, "a resolved alert is not re-created");
});

// ---------------------------------------------------------------- requeue / redispatch isolation

test("REQ-1 loading → in_transit → failed → requeued → assigned → loading → in_transit (twice): every attempt isolated", async () => {
  await seed();
  const id = await placeOrder();
  const attempts = [];
  for (const [n, eta] of [[0, 900], [1, 1800], [2, 3600]]) {
    await loadedWithRoute(id, eta);
    const d = await dispatch(id);
    attempts.push(d);
    // Scheduler running concurrently with the dispatch trigger and an
    // overlapping redelivery of it. A delivery that loses the contention fails
    // (the emulator closes the losing transaction; production aborts it) and
    // the platform redelivers it (retry: true) — modelled by one more delivery.
    const raced = await Promise.allSettled([d.deliver(), run(d.at + MIN), d.deliver()]);
    for (const r of raced) {
      if (r.status === "rejected") assert.match(String(r.reason?.message), /Transaction is invalid or closed|ABORTED|contention/i);
    }
    await d.deliver();
    const o = await order(id);
    const grace = D.graceMinutesFor(eta) * 60;
    assert.deepEqual(
      [o.status, o.timingEpoch, o.timingStatus, o.timingActive, ms(o.timingNextCheckAt), ...baselineOf(o)],
      ["in_transit", n, "on_time", true, d.at + eta * 1000, d.at + eta * 1000, d.at + eta * 1000 + grace * 1000, eta, d.at],
      `attempt ${n}: a new baseline from the new dispatch and route`
    );
    assert.equal(ms(o.firstDispatchedAt), attempts[0].at, "firstDispatchedAt stays the first dispatch ever");
    await run(d.at + eta * 1000 + grace * 1000 + MIN); // late
    await run(d.at + eta * 1000 + grace * 1000 + 2 * MIN); // retried
    assert.equal((await order(id)).timingStatus, "delayed");
    if (n < 2) {
      await failAndRequeue(id);
      const requeued = await order(id);
      for (const f of D.TIMING_FIELDS) assert.equal(f in requeued, false, `attempt ${n}: ${f} cleared on requeue`);
    }
  }
  assert.deepEqual((await alerts()).map((a) => a.id).sort(), [0, 1, 2].map((e) => `delivery_delay_${id}_e${e}`));
  const events = await lateEvents(id);
  assert.deepEqual(events.map((e) => e.id).sort(), [0, 1, 2].map((e) => `${id}__e${e}__running_late`));
  const e0 = (await alerts()).find((a) => a.id === `delivery_delay_${id}_e0`);
  assert.equal(ms(e0.expectedArrivalAt), attempts[0].at + 15 * MIN);
});

test("REQ-2 a late trigger or scheduler work from an EARLIER attempt never touches the current one", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 900);
  const first = await dispatch(id);
  await failAndRequeue(id);
  await first.deliver();
  let o = await order(id);
  assert.deepEqual([o.status, "timingContractVersion" in o], ["pending_dispatch", false]);
  await loadedWithRoute(id, 3600);
  const second = await dispatch(id);
  await second.deliver();
  const t = await updateTime("orders", id);
  await first.deliver();
  // A scheduler run "for" attempt 0's old due time reads the order as it is now:
  // attempt 1 is not due, so nothing is written.
  await advance(id, first.at + 16 * MIN);
  o = await order(id);
  assert.equal(await updateTime("orders", id), t);
  assert.deepEqual([o.timingEpoch, ms(o.expectedArrivalAt), ms(o.timingNextCheckAt), o.timingEtaSeconds], [1, second.at + 60 * MIN, second.at + 60 * MIN, 3600]);
  // Attempt 0's trigger arriving FIRST after the redispatch registers nothing either.
  await seed();
  const id2 = await placeOrder();
  await loadedWithRoute(id2, 900);
  const old = await dispatch(id2);
  await failAndRequeue(id2);
  await loadedWithRoute(id2, 1800);
  const fresh = await dispatch(id2);
  await old.deliver();
  assert.equal("timingContractVersion" in (await order(id2)), false, "the stale event is not this attempt");
  await fresh.deliver();
  assert.deepEqual([(await order(id2)).timingEpoch, ms((await order(id2)).expectedArrivalAt)], [1, fresh.at + 30 * MIN]);
});

test("REQ-3 an attempt that was 'unknown' gets a baseline only through failure, requeue and a new dispatch", async () => {
  await seed();
  const id = await placeOrder();
  await loadedWithRoute(id, 1800, { routePolyline: FieldValue.delete() });
  await (await dispatch(id)).deliver();
  assert.equal((await order(id)).timingStatus, "unknown");
  await failAndRequeue(id);
  await loadedWithRoute(id, 1200);
  const d = await dispatch(id);
  await d.deliver();
  const o = await order(id);
  assert.deepEqual([o.timingEpoch, o.timingStatus, o.timingActive, ms(o.expectedArrivalAt), ms(o.timingNextCheckAt)], [1, "on_time", true, d.at + 20 * MIN, d.at + 20 * MIN]);
});
