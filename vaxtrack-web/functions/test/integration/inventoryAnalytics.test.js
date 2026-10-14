"use strict";

/**
 * AI Inventory Analytics generator against a REAL Firestore (emulator).
 *
 * The generator is dry-run by default, writes only with an exact --confirm,
 * writes ONLY inventoryForecasts + inventoryAnalyticsRuns, and a retry never
 * creates a second run record. Demand comes from order documents alone:
 * status events, reservations, allocation events and receipts for the same
 * orders change nothing.
 *
 * Run:  npm run test:emulator   (in functions/). Own project id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";

const app = admin.initializeApp({ projectId: "demo-vaxtrack-analytics" }, "analytics-tests");
const db = app.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const { validateForecastDocument } = require("../../src/forecastEngine");

const AS_OF = "2026-10-09";
const FORECASTS = "inventoryForecasts";
const RUNS = "inventoryAnalyticsRuns";
const OTHER = [
  "orders", "inventory", "vaccines", "inventoryAnalyticsConfig",
  "inventoryReservations", "inventoryAllocationEvents", "orderStatusEvents", "orderReceipts", "invoices",
];

let toolPromise;
const tool = () =>
  (toolPromise ??= import(pathToFileURL(path.join(__dirname, "..", "..", "scripts", "generateInventoryAnalytics.mjs")).href));

async function wipe() {
  for (const c of [FORECASTS, RUNS, ...OTHER]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Ten weeks of delivered demand for vacA, one open partial backorder, two vaccines. */
async function seed() {
  await wipe();
  await db.collection("vaccines").doc("vacA").set({ vaccineName: "Moderna COVID-19 Vaccine", internalSku: "MOD-STG-001" });
  await db.collection("vaccines").doc("vacB").set({ vaccineName: "Influenza Vaccine (Quadrivalent)", internalSku: "FLU-STG-002" });
  await db.collection("inventory").doc("b1").set({
    vaccineId: "vacA", batchId: "BT-1", quantity: 400, reservedQuantity: 4, returnPendingQuantity: 6,
    status: "OK", expiryDate: "2027-12-31", arrivalDate: "2026-07-27",
  });
  await db.collection("inventory").doc("b2").set({
    vaccineId: "vacB", batchId: "BT-2", quantity: 50, reservedQuantity: 0, status: "OK", expiryDate: "2026-10-01", arrivalDate: "2026-09-21", // 2 weeks: insufficient
  });
  for (let i = 0; i < 10; i += 1) {
    await db.collection("orders").doc(`d${i}`).set({
      status: "delivered",
      requestedDeliveryDate: addDays("2026-07-27", 7 * i),
      createdAt: Timestamp.fromDate(new Date("2026-07-20T02:00:00Z")),
      items: [{ productKey: "vacA", quantity: 70, reservedQuantity: 70, backorderedQuantity: 0 }],
    });
  }
  await db.collection("orders").doc("open1").set({
    status: "pending_dispatch",
    allocationVersion: 2,
    allocationOpen: true,
    allocationState: "partially_reserved",
    requestedDeliveryDate: "2026-10-20",
    createdAt: Timestamp.fromDate(new Date("2026-10-07T02:00:00Z")),
    items: [{ productKey: "vacA", quantity: 10, reservedQuantity: 4, backorderedQuantity: 6 }],
  });
  await db.collection("orders").doc("cx1").set({
    status: "cancelled",
    requestedDeliveryDate: "2026-09-30",
    items: [{ productKey: "vacA", quantity: 500 }],
  });
  await db.collection("inventoryAnalyticsConfig").doc("vacA").set({
    vaccineId: "vacA", leadTimeDays: 14, safetyStockDays: null, safetyStockQuantity: 20, enabled: true,
    updatedAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")), updatedByUid: "admin1",
  });
}

const options = (over = {}) => ({ project: "demo-vaxtrack-analytics", apply: false, confirm: null, asOf: AS_OF, ...over });
const quiet = () => {
  const lines = [];
  return { log: (l) => lines.push(l), lines };
};
const run = async (opts, logger = quiet()) =>
  (await tool()).runGenerator({ db, FieldValue, options: options(opts), log: logger.log });
const count = async (c) => (await db.collection(c).get()).size;

/** updateTime of every document outside the analytics collections. */
async function snapshotOthers() {
  const out = {};
  for (const c of OTHER) {
    for (const d of (await db.collection(c).get()).docs) out[`${c}/${d.id}`] = d.updateTime.toMillis();
  }
  return out;
}

test("22 · a dry run is the default and writes nothing — but prints counts and warnings", async () => {
  await seed();
  const logger = quiet();
  const r = await run({}, logger);
  assert.deepEqual([r.applied, r.written, r.forecastCount, r.runDocumentCount], [false, 0, 6, 1]);
  assert.equal(await count(FORECASTS), 0);
  assert.equal(await count(RUNS), 0);
  const text = logger.lines.join("\n");
  assert.match(text, /PROPOSED: 6 forecast document\(s\) in inventoryForecasts and 1 run document/);
  assert.match(text, /WARNING cancelled_excluded ×1/);
  assert.match(text, /WARNING insufficient_weekly_history ×1/);
  assert.match(text, /WARNING missing_lead_time_configuration ×1/);
  assert.match(text, /Dry run only — nothing was written\./);
});

test("24 · --apply refuses unless --confirm equals the forecast count", async () => {
  await seed();
  await assert.rejects(run({ apply: true, confirm: 5 }), /does not match the 6 forecast/);
  assert.equal(await count(FORECASTS), 0);
  assert.equal(await count(RUNS), 0);
});

test("25 · apply writes ONLY the analytics collections", async () => {
  await seed();
  const before = await snapshotOthers();
  const collectionsBefore = (await db.listCollections()).map((c) => c.id).sort();
  const r = await run({ apply: true, confirm: 6 });
  assert.deepEqual([r.applied, r.replayed, r.written], [true, false, 7]);
  assert.deepEqual(await snapshotOthers(), before, "no order, batch, reservation, event, config or invoice changed");
  const collectionsAfter = (await db.listCollections()).map((c) => c.id).sort();
  assert.deepEqual(
    collectionsAfter.filter((c) => !collectionsBefore.includes(c)).sort(),
    [RUNS, FORECASTS].sort()
  );

  const a30 = (await db.collection(FORECASTS).doc("vacA__all__30d").get()).data();
  assert.deepEqual(validateForecastDocument(a30), []);
  assert.ok(a30.generatedAt instanceof Timestamp, "server time");
  assert.equal(a30.runId, r.runId);
  // 10 weeks × 70 → 300 in 30 days; requested demand, cancelled excluded.
  assert.equal(a30.predictedDemandQuantity, 300);
  assert.equal(a30.availableQuantity, 390, "400 − 4 reserved − 6 return pending");
  assert.equal(a30.reservedQuantity, 4);
  assert.equal(a30.backorderedQuantity, 6);
  assert.equal(a30.recommendedReorderQuantity, Math.max(0, 140 + 20 + 6 - 390));
  const b30 = (await db.collection(FORECASTS).doc("vacB__all__30d").get()).data();
  assert.equal(b30.availableQuantity, 0, "an expired batch is not available");
  assert.equal(b30.recommendedReorderQuantity, null);

  const runDoc = (await db.collection(RUNS).doc(r.runId).get()).data();
  assert.deepEqual([runDoc.forecastCount, runDoc.advisoryOnly, runDoc.engineLabel], [6, true, "Baseline forecasting"]);
  assert.ok(runDoc.generatedAt instanceof Timestamp);
});

test("26 · a retry finds its own run record and writes nothing — never a duplicate", async () => {
  await seed();
  const first = await run({ apply: true, confirm: 6 });
  const runRef = db.collection(RUNS).doc(first.runId);
  const runBefore = await runRef.get();
  const forecastBefore = await db.collection(FORECASTS).doc("vacA__all__30d").get();

  for (let i = 0; i < 3; i += 1) {
    const again = await run({ apply: true, confirm: 6 });
    assert.deepEqual([again.runId, again.replayed, again.written], [first.runId, true, 0]);
  }
  assert.equal(await count(RUNS), 1);
  assert.ok((await runRef.get()).updateTime.isEqual(runBefore.updateTime), "the run record is never rewritten");
  assert.ok((await db.collection(FORECASTS).doc("vacA__all__30d").get()).updateTime.isEqual(forecastBefore.updateTime));

  // A record with the same id but different content is a conflict — refused, nothing written.
  await runRef.update({ contentFingerprint: "tampered" });
  const tampered = await runRef.get();
  await assert.rejects(run({ apply: true, confirm: 6 }), /already exists with different content/);
  assert.ok((await runRef.get()).updateTime.isEqual(tampered.updateTime));
});

test("26b · new data on another day is a NEW run; the old run record stays", async () => {
  await seed();
  const first = await run({ apply: true, confirm: 6 });
  const second = await run({ apply: true, confirm: 6, asOf: "2026-10-16" });
  assert.notEqual(second.runId, first.runId);
  assert.equal(await count(RUNS), 2);
  assert.equal((await db.collection(FORECASTS).doc("vacA__all__30d").get()).data().runId, second.runId, "current forecast follows the latest run");
});

test("4 · status events, reservations, allocation events and receipts do not add demand", async () => {
  await seed();
  const plain = await run({});
  // The same orders' lifecycle records — every one of them repeats an order.
  for (let i = 0; i < 10; i += 1) {
    await db.collection("orderStatusEvents").doc(`e${i}`).set({ orderId: `d${i}`, status: "delivered", quantity: 70 });
    await db.collection("inventoryAllocationEvents").doc(`a${i}`).set({ orderId: `d${i}`, productKey: "vacA", quantity: 70, eventType: "reserved" });
    await db.collection("inventoryReservations").doc(`d${i}`).set({ items: [{ productKey: "vacA", quantity: 70 }] });
    await db.collection("orderReceipts").doc(`d${i}`).set({ lines: [{ productKey: "vacA", quantityRequested: 70 }] });
  }
  const withEvents = await run({});
  assert.equal(withEvents.runId, plain.runId, "identical content: the extra records changed nothing");
});

// ---------------------------------------------------------------- Phase 1 run limits (application, not Firebase)

const RUN = require("../../src/inventoryAnalyticsRun");

/** A real plan's forecast, replicated to `n` forecasts (synthetic ids). */
async function planWith(n) {
  await seed();
  const { buildAnalyticsPlan } = RUN;
  const real = buildAnalyticsPlan({
    orders: (await db.collection("orders").get()).docs.map((d) => ({ id: d.id, data: d.data() })),
    batches: (await db.collection("inventory").get()).docs.map((d) => ({ id: d.id, data: d.data() })),
    vaccines: (await db.collection("vaccines").get()).docs.map((d) => ({ id: d.id, data: d.data() })),
    configs: [],
    now: new Date(`${AS_OF}T04:00:00.000Z`),
  });
  const template = real.forecasts[0].data;
  const runId = `limit-${n}`;
  return {
    runId,
    run: { ...real.run, runId, forecastCount: n, contentFingerprint: `limit-${n}` },
    forecasts: Array.from({ length: n }, (_, i) => {
      const id = `bulk${String(i).padStart(3, "0")}__all__30d`;
      return { id, data: { ...template, forecastId: id, vaccineId: `bulk${i}`, runId } };
    }),
  };
}

test("the configured Phase 1 cap — 450 forecasts + 1 run record — commits atomically", async () => {
  assert.equal(RUN.ANALYTICS_RUN_LIMITS.maxForecastDocuments, 450);
  const plan = await planWith(450);
  const r = await RUN.applyAnalyticsPlan({ db, FieldValue, plan });
  assert.deepEqual([r.replayed, r.written], [false, 451]);
  assert.equal(await count(FORECASTS), 450);
  assert.equal(await count(RUNS), 1);
});

test("one forecast over the Phase 1 cap is refused whole — nothing is written", async () => {
  const plan = await planWith(451);
  const before = await snapshotOthers();
  await assert.rejects(
    RUN.applyAnalyticsPlan({ db, FieldValue, plan }),
    /Phase 1 analytics run limit — this run has 451 forecast documents; the limit is 450 \(an internal application safety limit, not a Firebase requirement\)\. Nothing was written\./
  );
  assert.equal(await count(FORECASTS), 0, "no partial run");
  assert.equal(await count(RUNS), 0);
  assert.deepEqual(await snapshotOthers(), before);
});

test("an output over the estimated-payload cap is refused whole — nothing is written", async () => {
  const plan = await planWith(3);
  const limits = { maxForecastDocuments: 450, maxEstimatedPayloadBytes: RUN.estimatePayloadBytes(plan) - 1 };
  await assert.rejects(
    RUN.applyAnalyticsPlan({ db, FieldValue, plan, limits }),
    /Phase 1 analytics run limit — estimated output payload .* exceeds .*application estimate.*Nothing was written\./
  );
  assert.equal(await count(FORECASTS), 0);
  assert.equal(await count(RUNS), 0);
  // The same plan within the limit commits, all at once.
  const ok = await RUN.applyAnalyticsPlan({ db, FieldValue, plan });
  assert.equal(ok.written, 4);
  assert.equal(await count(FORECASTS), 3);
});

test("staging dry run warns that seed/test orders are not real client demand", async () => {
  await seed();
  const logger = quiet();
  const r = await run({ project: "vaxtrack-staging" }, logger);
  assert.equal(r.stagingWarning, true);
  assert.equal(r.applied, false);
  assert.match(
    logger.lines.join("\n"),
    /WARNING staging_data: Staging may contain seed or test orders\. Forecasts must not be treated as real client demand\./
  );
  assert.match(
    logger.lines.join("\n"),
    /Phase 1 analytics run limit: 6 of at most 450 forecast documents; estimated output payload \d+\.\d\d MiB of at most 8\.00 MiB \(application safety limits, not Firebase requirements\)\./
  );
  assert.doesNotMatch(logger.lines.join("\n"), /in one transaction|write limit|Firestore transaction limit/);
  const demo = quiet();
  await run({}, demo);
  assert.doesNotMatch(demo.lines.join("\n"), /staging_data/);
});
