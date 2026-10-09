"use strict";

// AI Inventory Analytics — Phase 1 pure modules: demand, stock, weekly history,
// the baseline forecast engine, risk/reorder, the output contract and the plan.
// The emulator suite (test/integration/inventoryAnalytics.test.js) covers the
// generator's writes against a real Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../src/inventoryAnalytics");
const E = require("../src/forecastEngine");
const R = require("../src/analyticsRisk");
const RUN = require("../src/inventoryAnalyticsRun");

// As of Friday 2026-10-09 (Manila). Current week starts Mon 2026-10-05, so the
// last complete week is 2026-09-28 … 2026-10-04.
const NOW = new Date("2026-10-09T04:00:00.000Z");
const ts = (iso) => ({ toDate: () => new Date(iso) });

const line = (over = {}) => ({ productKey: "vacA", quantity: 10, reservedQuantity: 0, backorderedQuantity: 10, ...over });
const order = (id, over = {}) => ({
  id,
  data: {
    status: "delivered",
    requestedDeliveryDate: "2026-09-29",
    createdAt: ts("2026-09-20T02:00:00Z"),
    items: [line({ reservedQuantity: 10, backorderedQuantity: 0 })],
    ...over,
  },
});
const batch = (id, over = {}) => ({
  id,
  data: {
    vaccineId: "vacA",
    quantity: 100,
    reservedQuantity: 0,
    status: "OK",
    expiryDate: "2027-12-31",
    arrivalDate: "2026-06-01",
    ...over,
  },
});
const demandOf = (orders, batches = []) =>
  A.extractDemand({ orders, batchesById: new Map(batches.map((b) => [b.id, b.data])) });
const total = (lines) => lines.reduce((s, l) => s + l.quantity, 0);
const engine = E.createWeightedMovingAverageEngine();
const weeks = (...qs) => qs.map((quantity, i) => ({ weekStart: A.addDays("2026-01-05", 7 * i), quantity }));

// ---------------------------------------------------------------- demand

test("1 · delivered orders count their REQUESTED quantity", () => {
  const d = demandOf([order("o1", { items: [line({ quantity: 12, reservedQuantity: 12, backorderedQuantity: 0 })] })]);
  assert.equal(total(d.lines), 12);
  assert.equal(d.counts.ordersCounted, 1);
});

test("2/3 · an active, partially reserved backorder counts its full request — once", () => {
  const o = order("o1", {
    status: "pending_dispatch",
    allocationVersion: 2,
    allocationOpen: true,
    allocationState: "partially_reserved",
    items: [line({ quantity: 10, reservedQuantity: 4, backorderedQuantity: 6 })],
  });
  const d = demandOf([o]);
  assert.deepEqual(d.lines.map((l) => [l.orderId, l.quantity]), [["o1", 10]], "requested, not reserved; one line");
  assert.equal(A.backorderedByProduct([o]).get("vacA"), 6, "the unreserved part is the active backorder");
});

test("every included status counts; multi-line orders count each line once", () => {
  const statuses = ["pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivered", "delivery_failed", "Completed", "In Transit"];
  const orders = statuses.map((status, i) => order(`o${i}`, { status }));
  assert.equal(demandOf(orders).lines.length, statuses.length);
  const two = order("m", { items: [line({ quantity: 3 }), line({ productKey: "vacB", quantity: 4 })] });
  assert.deepEqual(demandOf([two]).lines.map((l) => [l.vaccineId, l.quantity]), [["vacA", 3], ["vacB", 4]]);
});

test("5 · cancelled orders are excluded and reported", () => {
  const d = demandOf([order("c1", { status: "cancelled" }), order("c2", { status: "canceled" }), order("ok")]);
  assert.equal(total(d.lines), 10);
  assert.equal(d.warnings.count(A.WARNING.CANCELLED_EXCLUDED), 2);
});

test("an order with a missing or unknown status is excluded, never guessed", () => {
  const d = demandOf([order("x1", { status: undefined }), order("x2", { status: "rejected" }), order("x3", { status: "pending" })]);
  assert.equal(d.lines.length, 0);
  assert.equal(d.warnings.count(A.WARNING.UNRECOGNISED_STATUS), 3);
});

test("6 · a failed and requeued delivery is the SAME order document — counted once", () => {
  const failed = order("f1", { status: "delivery_failed" });
  const requeued = order("f1", { status: "pending_dispatch", allocationVersion: 2, allocationOpen: true });
  assert.equal(demandOf([failed]).lines.length, 1);
  assert.equal(demandOf([requeued]).lines.length, 1);
  // Demand is read from order documents only: the extractor has no input for
  // status events, reservations or allocation events, so they cannot add to it.
  assert.equal(A.extractDemand.length, 1, "one argument object: orders (+ batches for product lookup)");
});

test("7 · the requested delivery date is preferred over createdAt", () => {
  const [l] = demandOf([order("o1", { requestedDeliveryDate: "2026-09-30", createdAt: ts("2026-08-01T02:00:00Z") })]).lines;
  assert.deepEqual([l.date, l.dateSource], ["2026-09-30", "requested_delivery_date"]);
  const [c] = demandOf([order("o2", { requestedDeliveryDate: "2026-02-31", createdAt: ts("2026-08-01T20:00:00Z") })]).lines;
  // An impossible date is not used; createdAt in MANILA (UTC+8) is 2026-08-02.
  assert.deepEqual([c.date, c.dateSource], ["2026-08-02", "created_at"]);
});

test("8 · no usable date at all: the line is excluded with a warning — never 'today'", () => {
  const d = demandOf([order("o1", { requestedDeliveryDate: null, createdAt: null })]);
  assert.equal(d.lines.length, 0);
  assert.equal(d.warnings.count(A.WARNING.MISSING_ORDER_DATE), 1);
});

test("9 · negative, zero, fractional and non-numeric quantities are rejected", () => {
  for (const quantity of [-5, 0, 1.5, "10", null, undefined, Number.NaN, 2000000]) {
    const d = demandOf([order("o1", { items: [line({ quantity })] })]);
    assert.equal(d.lines.length, 0, String(quantity));
    assert.equal(d.warnings.count(A.WARNING.INVALID_QUANTITY), 1, String(quantity));
  }
});

test("product identity: productKey, else the quoted batch's vaccineId, else excluded", () => {
  const legacy = order("o1", { items: [{ inventoryId: "b1", quantity: 5 }] });
  assert.equal(demandOf([legacy], [batch("b1", { vaccineId: "vacZ" })]).lines[0].vaccineId, "vacZ");
  const unknown = demandOf([order("o2", { items: [{ name: "Some vaccine", quantity: 5 }] })]);
  assert.equal(unknown.lines.length, 0);
  assert.equal(unknown.warnings.count(A.WARNING.MISSING_PRODUCT_ID), 1);
});

test("warnings carry codes, counts and opaque document ids only", () => {
  const d = demandOf([order("ord-1", { status: "cancelled", clinicName: "Private Clinic", createdByEmail: "rep@x.test" })]);
  const json = JSON.stringify(d.warnings.list());
  assert.match(json, /ord-1/);
  assert.doesNotMatch(json, /Private Clinic|rep@x\.test/);
});

// ---------------------------------------------------------------- weekly history

test("10 · weekly bucketing is Monday-based, consecutive and deterministic", () => {
  assert.equal(A.weekStartOf("2026-10-04"), "2026-09-28"); // Sunday → its Monday
  assert.equal(A.weekStartOf("2026-10-05"), "2026-10-05"); // Monday
  const window = A.trainingWindowFor(NOW);
  assert.deepEqual([window.asOfDate, window.lastWeekStart, window.windowEnd], ["2026-10-09", "2026-09-28", "2026-10-04"]);
  const lines = [
    { orderId: "a", vaccineId: "vacA", quantity: 5, date: "2026-09-15" },
    { orderId: "b", vaccineId: "vacA", quantity: 7, date: "2026-09-20" }, // Sunday, same week as 09-15
    { orderId: "c", vaccineId: "vacA", quantity: 2, date: "2026-10-01" },
    { orderId: "d", vaccineId: "vacA", quantity: 99, date: "2026-10-06" }, // current week: not history
  ];
  const first = A.weeklySeries({ lines, window });
  assert.deepEqual(first.series, [
    { weekStart: "2026-09-14", quantity: 12 },
    { weekStart: "2026-09-21", quantity: 0 },
    { weekStart: "2026-09-28", quantity: 2 },
  ]);
  assert.equal(first.outsideWindowLines, 1);
  assert.deepEqual(A.weeklySeries({ lines: [...lines].reverse(), window }), first, "input order does not matter");
});

test("history starts at the product's first batch arrival when that is earlier than its first order", () => {
  const window = A.trainingWindowFor(NOW);
  const { series } = A.weeklySeries({ lines: [], firstArrivalDate: "2026-09-02", window });
  assert.deepEqual(series.map((w) => w.quantity), [0, 0, 0, 0, 0]);
  assert.equal(series[0].weekStart, "2026-08-31");
  // Never more than 52 weeks.
  assert.equal(A.weeklySeries({ lines: [], firstArrivalDate: "2020-01-01", window }).series.length, A.MAX_TRAINING_WEEKS);
});

// ---------------------------------------------------------------- engine

test("11 · the weighted moving average is the documented integer formula, and deterministic", () => {
  const h = weeks(10, 20, 30, 40);
  // weights 1..4: (10 + 40 + 90 + 160) / 10 = 30 vials/week.
  const p = engine.predict(h, 7);
  assert.equal(p.predictedQuantity, 30);
  assert.equal(engine.predict(h, 30).predictedQuantity, 129); // 30 × 30 / 7 = 128.57 → 129
  assert.equal(p.weeklyRate, 30);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(engine.predict(h, 30), engine.predict(h, 30));
  // Only the last 8 weeks are used; recent weeks weigh more than old ones.
  const long = weeks(1000, 1000, 0, 0, 0, 0, 0, 0, 0, 8);
  assert.equal(engine.predict(long, 7).predictedQuantity, 2); // 8×8/36 = 1.78 → 2; the 1000s fell out
  assert.ok(engine.predict(weeks(0, 0, 0, 40), 7).predictedQuantity > engine.predict(weeks(40, 0, 0, 0), 7).predictedQuantity);
});

test("12 · fewer than four usable weeks: insufficient — no forecast", () => {
  for (const n of [0, 1, 2, 3]) {
    const p = engine.predict(weeks(...Array(n).fill(5)), 30);
    assert.deepEqual([p.predictedQuantity, p.confidenceLevel], [null, "insufficient"], String(n));
  }
});

test("confidence is coverage, not probability: 4–7 low, 8–25 medium, 26+ high", () => {
  assert.deepEqual([3, 4, 7, 8, 25, 26, 52].map(E.confidenceFromWeeks), [
    "insufficient", "low", "low", "medium", "medium", "high", "high",
  ]);
  assert.deepEqual(["high", "medium", "low", "insufficient"].map(E.downgradeConfidence), ["medium", "low", "low", "insufficient"]);
});

test("13/14 · zero history forecasts zero; no history ever forecasts below zero", () => {
  assert.equal(engine.predict(weeks(0, 0, 0, 0, 0, 0), 90).predictedQuantity, 0);
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 48271) % 2147483647) % n);
  for (let k = 0; k < 300; k += 1) {
    const h = weeks(...Array.from({ length: 4 + rnd(30) }, () => rnd(500)));
    for (const horizon of A.HORIZONS) {
      const q = engine.predict(h, horizon).predictedQuantity;
      assert.ok(Number.isSafeInteger(q) && q >= 0);
    }
  }
  assert.throws(() => engine.predict(weeks(1, 2, 3, -1), 7), RangeError);
});

test("the engine implements the ForecastEngine interface and is labelled baseline, not ML", () => {
  assert.equal(E.assertForecastEngine(engine), engine);
  assert.equal(engine.label, "Baseline forecasting");
  assert.match(engine.predict(weeks(1, 1, 1, 1), 7).explanationFactors[0].value, /Not a trained machine-learning model/);
  assert.throws(() => E.assertForecastEngine({ engineType: "x", version: "1", label: "y" }), /predict/);
});

// ---------------------------------------------------------------- stock

test("15/16/17 · available excludes reserved, return-pending, quarantined, expired and unusable batches", () => {
  const stock = A.stockByProduct({
    now: NOW,
    batches: [
      batch("b1", { quantity: 100, reservedQuantity: 30, returnPendingQuantity: 5, quarantinedQuantity: 5 }), // 60
      batch("b2", { quantity: 50, expiryDate: "2026-10-08" }), // expired yesterday (Manila)
      batch("b3", { quantity: 40, status: "Quarantined" }), // unusable status
      batch("b4", { quantity: 20, expiryDate: null }), // undated
    ],
  }).get("vacA");
  assert.equal(stock.availableQuantity, 60);
  assert.equal(stock.reservedQuantity, 30);
  assert.equal(stock.returnPendingQuantity, 5);
  assert.equal(stock.onHandQuantity, 210);
  assert.equal(stock.unavailableBatchCount, 3);
});

test("an inconsistent batch counts as unavailable and is reported", () => {
  const warnings = A.createWarningLog();
  const stock = A.stockByProduct({
    now: NOW,
    warnings,
    batches: [batch("bad1", { quantity: 10, reservedQuantity: 20 }), batch("bad2", { quantity: "120" }), batch("bad3", { quantity: 200000000 })],
  }).get("vacA");
  assert.equal(stock.availableQuantity, 0);
  assert.equal(warnings.count(A.WARNING.INVENTORY_INCONSISTENCY), 3);
  assert.equal(stock.inconsistentBatchCount, 3);
});

// ---------------------------------------------------------------- risk + reorder

const config = (over = {}) => ({
  vaccineId: "vacA",
  leadTimeDays: 14,
  safetyStockDays: null,
  safetyStockQuantity: 20,
  enabled: true,
  updatedAt: ts("2026-10-01T00:00:00Z"),
  updatedByUid: "admin1",
  ...over,
});
const assess = (over = {}) =>
  R.assessProduct({
    engine,
    history: weeks(70, 70, 70, 70, 70, 70, 70, 70), // 10 vials/day
    horizonDays: 30,
    stock: { availableQuantity: 400, reservedQuantity: 0 },
    backorderedQuantity: 0,
    config: config(),
    vaccineId: "vacA",
    ...over,
  });

test("18 · backorders add to the projected shortage", () => {
  const none = assess({ stock: { availableQuantity: 300, reservedQuantity: 0 } }); // forecast 300
  assert.equal(none.projectedShortageQuantity, 0);
  const withBackorder = assess({ stock: { availableQuantity: 300, reservedQuantity: 0 }, backorderedQuantity: 25 });
  assert.equal(withBackorder.projectedShortageQuantity, 25);
  assert.equal(withBackorder.stockoutRiskLevel, "high");
});

test("19 · missing, disabled or invalid configuration: no reorder figure, and it says why", () => {
  for (const [cfg, status] of [
    [null, "missing"],
    [config({ enabled: false }), "disabled"],
    [config({ leadTimeDays: 0 }), "invalid"],
    [config({ safetyStockDays: 7 }), "invalid"], // both safety fields set
  ]) {
    const r = assess({ config: cfg });
    assert.equal(r.recommendedReorderQuantity, null, status);
    assert.equal(r.configStatus, status);
    assert.equal(r.stockoutRiskLevel, "unknown", "safety stock cannot be judged");
    assert.match(r.stockoutRiskReason, /Reorder configuration required/);
  }
  // A shortage is still a shortage without configuration.
  assert.equal(assess({ config: null, stock: { availableQuantity: 10, reservedQuantity: 0 } }).stockoutRiskLevel, "high");
});

test("20 · configured reorder = lead-time demand + safety + backordered − available − incoming, ≥ 0", () => {
  // lead 14 days → 140; safety 20; backordered 15; available 100 → 75.
  const r = assess({ stock: { availableQuantity: 100, reservedQuantity: 0 }, backorderedQuantity: 15 });
  assert.equal(r.calculation.leadTimeDemandQuantity, 140);
  assert.equal(r.recommendedReorderQuantity, 140 + 20 + 15 - 100 - 0);
  // Safety stock in days uses the same forecast rate: 7 days → 70.
  const days = assess({ config: config({ safetyStockQuantity: null, safetyStockDays: 7 }) });
  assert.equal(days.calculation.safetyStockQuantity, 70);
  // Plenty of stock: clamped to zero, never negative.
  assert.equal(assess({ stock: { availableQuantity: 5000, reservedQuantity: 0 } }).recommendedReorderQuantity, 0);
});

test("21 · each risk level's reason is built from its stored figures", () => {
  const high = assess({ stock: { availableQuantity: 250, reservedQuantity: 0 }, backorderedQuantity: 10 });
  const c = high.calculation;
  assert.equal(high.stockoutRiskLevel, "high");
  assert.ok(high.stockoutRiskReason.includes(`shortage of ${c.projectedShortageQuantity} vials within 30 days`));
  assert.ok(high.stockoutRiskReason.includes(`forecast ${c.predictedDemandQuantity} + backordered ${c.backorderedQuantity}`));
  assert.ok(high.stockoutRiskReason.includes(`available ${c.availableQuantity}`));
  assert.equal(c.projectedShortageQuantity, c.predictedDemandQuantity + c.backorderedQuantity - c.availableQuantity);

  // Lead time longer than the horizon can reveal a shortage the horizon misses.
  const lead = assess({ horizonDays: 7, stock: { availableQuantity: 100, reservedQuantity: 0 } });
  assert.equal(lead.stockoutRiskLevel, "high");
  assert.ok(lead.stockoutRiskReason.includes(`${lead.calculation.leadTimeShortageQuantity} vials within the 14-day lead time`));

  const medium = assess({ stock: { availableQuantity: 310, reservedQuantity: 0 } }); // 10 left < 20 safety
  assert.equal(medium.stockoutRiskLevel, "medium");
  assert.ok(medium.stockoutRiskReason.includes(`(${medium.calculation.remainingAfterHorizonQuantity} vials) is below the safety level of ${medium.calculation.safetyStockQuantity}`));

  const low = assess();
  assert.equal(low.stockoutRiskLevel, "low");
  assert.ok(low.stockoutRiskReason.includes(`(${low.calculation.remainingAfterHorizonQuantity} vials) stays at or above the safety level of 20`));

  const unknown = assess({ history: weeks(5, 5) });
  assert.equal(unknown.stockoutRiskLevel, "unknown");
  assert.match(unknown.stockoutRiskReason, /Insufficient history: 2 usable weeks/);
  assert.equal(unknown.recommendedReorderQuantity, null);
});

test("30 · configuration validation mirrors the rules: whole numbers, exactly one safety field, Admin stamp", () => {
  assert.equal(R.validateAnalyticsConfig(config(), "vacA").ok, true);
  for (const bad of [
    config({ leadTimeDays: 366 }),
    config({ leadTimeDays: 2.5 }),
    config({ safetyStockQuantity: -1 }),
    config({ safetyStockQuantity: null }), // neither
    config({ safetyStockDays: 3 }), // both
    config({ enabled: "yes" }),
    config({ updatedByUid: "" }),
    config({ extra: 1 }),
  ]) {
    assert.equal(R.validateAnalyticsConfig(bad, "vacA").ok, false, JSON.stringify(bad));
  }
  assert.equal(R.validateAnalyticsConfig(config(), "otherVaccine").ok, false, "doc id must match");
});

// ---------------------------------------------------------------- plan + contract

const planInput = () => ({
  now: NOW,
  orders: Array.from({ length: 10 }, (_, i) =>
    order(`o${i}`, { requestedDeliveryDate: A.addDays("2026-07-27", 7 * i), items: [line({ quantity: 70, reservedQuantity: 70, backorderedQuantity: 0 })] })
  ),
  // Arrived the same week as the first order, so the history is exactly 10 weeks.
  batches: [batch("b1", { quantity: 500, arrivalDate: "2026-07-27" })],
  vaccines: [
    { id: "vacA", data: { vaccineName: "Moderna COVID-19 Vaccine (Bivalent, Original and Omicron BA.4/BA.5)", internalSku: "MOD-STG-001" } },
    { id: "vacB", data: { vaccineName: "Hepatitis B Vaccine" } },
  ],
  configs: [{ id: "vacA", data: config() }],
});

test("the plan is deterministic, honours the contract, and keys forecasts by vaccine + area + horizon", () => {
  const a = RUN.buildAnalyticsPlan(planInput());
  const b = RUN.buildAnalyticsPlan(planInput());
  assert.equal(RUN.canonicalJson(a), RUN.canonicalJson(b));
  assert.equal(a.runId, b.runId);
  assert.match(a.runId, /^2026-10-09-[0-9a-f]{16}$/);
  assert.deepEqual(a.forecasts.map((f) => f.id), [
    "vacA__all__7d", "vacA__all__30d", "vacA__all__90d", "vacB__all__7d", "vacB__all__30d", "vacB__all__90d",
  ]);
  for (const f of a.forecasts) {
    assert.deepEqual(E.validateForecastDocument(f.data), [], f.id);
    assert.equal(f.data.runId, a.runId);
    assert.equal(f.data.advisoryOnly, true);
  }
  const a30 = a.forecasts.find((f) => f.id === "vacA__all__30d").data;
  assert.equal(a30.vaccineNameSnapshot, "Moderna COVID-19 Vaccine (Bivalent, Original and Omicron BA.4/BA.5)", "never truncated");
  assert.equal(a30.skuSnapshot, "MOD-STG-001");
  assert.equal(a30.predictedDemandQuantity, 300);
  assert.equal(a30.usableWeekCount, 10);
  assert.equal(a30.sampleOrderCount, 10);
  assert.deepEqual([a30.trainingWindowStart, a30.trainingWindowEnd], ["2026-07-27", "2026-10-04"]);
  const b30 = a.forecasts.find((f) => f.id === "vacB__all__30d").data;
  assert.deepEqual([b30.predictedDemandQuantity, b30.confidenceLevel, b30.stockoutRiskLevel, b30.skuSnapshot], [null, "insufficient", "unknown", null]);
  assert.ok(b30.dataQualityWarnings.some((w) => w.code === A.WARNING.UNKNOWN_SKU));
  assert.ok(b30.dataQualityWarnings.some((w) => w.code === A.WARNING.MISSING_REORDER_CONFIG));
  assert.deepEqual(a.run.riskSummary, { high: 0, medium: 0, low: 1, unknown: 1 });
  assert.equal(a.run.reorderConfigurationRequiredCount, 1);
});

test("changing any input changes the run id; the same input never does", () => {
  const base = RUN.buildAnalyticsPlan(planInput()).runId;
  const changed = planInput();
  changed.batches[0].data.quantity = 499;
  assert.notEqual(RUN.buildAnalyticsPlan(changed).runId, base);
  const nextDay = { ...planInput(), now: new Date("2026-10-10T04:00:00.000Z") };
  assert.notEqual(RUN.buildAnalyticsPlan(nextDay).runId, base);
});

test("many lines without a date or product lower every confidence one level", () => {
  const input = planInput();
  input.orders.push(order("nodate1", { requestedDeliveryDate: null, createdAt: null }));
  input.orders.push(order("noprod1", { items: [{ quantity: 3 }] }));
  const plan = RUN.buildAnalyticsPlan(input); // 2 of 12 lines = 16.7% ≥ 10%
  assert.equal(plan.run.confidenceDowngraded, true);
  const a30 = plan.forecasts.find((f) => f.id === "vacA__all__30d").data;
  assert.equal(a30.confidenceLevel, "low", "10 weeks is medium, lowered to low");
  assert.ok(a30.dataQualityWarnings.some((w) => w.code === "confidence_lowered"));
});

test("the contract validator refuses fabricated or inconsistent documents", () => {
  const good = RUN.buildAnalyticsPlan(planInput()).forecasts[0].data;
  assert.deepEqual(E.validateForecastDocument(good), []);
  assert.ok(E.validateForecastDocument({ ...good, predictedDemandQuantity: -1 }).length > 0);
  assert.ok(E.validateForecastDocument({ ...good, stockoutRiskLevel: "red" }).length > 0);
  assert.ok(E.validateForecastDocument({ ...good, advisoryOnly: false }).length > 0);
  assert.ok(E.validateForecastDocument({ ...good, reorderConfigurationComplete: false, recommendedReorderQuantity: 5 }).length > 0);
  assert.ok(E.validateForecastDocument({ ...good, sampleData: true }).length > 0, "no extra fields");
});

// ---------------------------------------------------------------- generator options

test("22/23/24 · the generator's guards: production refused, staging-only outside the emulator, apply needs --confirm", async () => {
  const { parseOptions, asOfInstant } = await import("../scripts/generateInventoryAnalytics.mjs");
  assert.throws(() => parseOptions([]), /--project is required/);
  assert.throws(() => parseOptions(["--project", "vaxtrack-bef1b"]), /production/);
  assert.throws(() => parseOptions(["--project", "vaxtrack-bef1b"], { emulator: true }), /production/, "even in the emulator");
  assert.throws(() => parseOptions(["--project", "some-other"]), /only --project vaxtrack-staging/);
  const dry = parseOptions(["--project", "vaxtrack-staging"]);
  assert.deepEqual([dry.apply, dry.confirm], [false, null], "dry run by default");
  assert.throws(() => parseOptions(["--project", "vaxtrack-staging", "--apply"]), /--confirm/);
  assert.throws(() => parseOptions(["--project", "vaxtrack-staging", "--apply", "--confirm", "abc"]), /--confirm/);
  assert.deepEqual(parseOptions(["--project", "vaxtrack-staging", "--apply", "--confirm", "6"]).confirm, 6);
  assert.equal(parseOptions(["--project", "demo-x"], { emulator: true }).project, "demo-x");
  assert.throws(() => parseOptions(["--project", "vaxtrack-staging", "--as-of", "10/09/2026"]), /--as-of/);
  assert.equal(asOfInstant("2026-10-09").toISOString(), "2026-10-09T04:00:00.000Z");
});

// ---------------------------------------------------------------- hardening

test("safety stock: a whole number from 0 to 100,000,000 vials — NaN, decimal, negative and oversized refused", () => {
  assert.equal(R.MAX_SAFETY_STOCK_QUANTITY, 100000000);
  for (const ok of [0, 1, 20, 100000000]) {
    assert.equal(R.validateAnalyticsConfig(config({ safetyStockQuantity: ok }), "vacA").ok, true, String(ok));
  }
  for (const bad of [100000001, Number.NaN, 2.5, -1, Infinity, "20", 1e20]) {
    assert.equal(R.validateAnalyticsConfig(config({ safetyStockQuantity: bad }), "vacA").ok, false, String(bad));
  }
  for (const bad of [Number.NaN, 2.5, -1, 366]) {
    assert.equal(R.validateAnalyticsConfig(config({ safetyStockQuantity: null, safetyStockDays: bad }), "vacA").ok, false, String(bad));
  }
  for (const bad of [Number.NaN, 0, 14.5, 366]) {
    assert.equal(R.validateAnalyticsConfig(config({ leadTimeDays: bad }), "vacA").ok, false, String(bad));
  }
});

/** Rebuild every object with its keys in reverse order (same content). */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object" && typeof value.toDate !== "function") {
    return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseKeys(value[k])]));
  }
  return value;
}
const runIdOf = (input) => RUN.buildAnalyticsPlan(input).runId;

test("run fingerprint: identical inputs give the same run id; key and document order never matter", () => {
  const base = runIdOf(planInput());
  assert.equal(runIdOf(planInput()), base);
  const shuffled = planInput();
  for (const key of ["orders", "batches", "vaccines", "configs"]) shuffled[key] = reverseKeys(shuffled[key]).reverse();
  assert.equal(runIdOf(shuffled), base, "object key order and document order");
  // A timestamp is fingerprinted by its instant, not by its object identity.
  const sameInstant = planInput();
  sameInstant.configs[0].data.updatedAt = ts("2026-10-01T00:00:00Z");
  assert.equal(runIdOf(sameInstant), base);
  // A field the analytics never reads does not change the run.
  const irrelevant = planInput();
  irrelevant.orders[0].data.clinicName = "Another clinic";
  irrelevant.orders[0].data.statusHistory = [{ status: "assigned" }];
  assert.equal(runIdOf(irrelevant), base);
  // NaN and null are different inputs.
  assert.notEqual(RUN.canonicalJson({ q: Number.NaN }), RUN.canonicalJson({ q: null }));
  assert.equal(RUN.canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), RUN.canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("run fingerprint: every input that can change the output changes the run id", () => {
  const base = runIdOf(planInput());
  const variants = {
    "an order's quantity": (i) => { i.orders[0].data.items[0].quantity = 71; },
    "an order's status": (i) => { i.orders[0].data.status = "cancelled"; },
    "an order's requested date": (i) => { i.orders[0].data.requestedDeliveryDate = "2026-07-28"; },
    "a new order": (i) => { i.orders.push(order("extra")); },
    "inventory on hand": (i) => { i.batches[0].data.quantity = 499; },
    "inventory reserved": (i) => { i.batches[0].data.reservedQuantity = 1; },
    "inventory expiry": (i) => { i.batches[0].data.expiryDate = "2027-01-31"; },
    "vaccine SKU": (i) => { i.vaccines[0].data.internalSku = "MOD-STG-002"; },
    "vaccine name": (i) => { i.vaccines[1].data.vaccineName = "Hepatitis B Vaccine (Adult)"; },
    "reorder lead time": (i) => { i.configs[0].data.leadTimeDays = 15; },
    "reorder safety stock": (i) => { i.configs[0].data.safetyStockQuantity = 21; },
    "reorder enabled": (i) => { i.configs[0].data.enabled = false; },
    "a new configuration": (i) => { i.configs.push({ id: "vacB", data: { ...config(), vaccineId: "vacB" } }); },
    "the as-of date": (i) => { i.now = new Date("2026-10-10T04:00:00.000Z"); },
    "the engine version": (i) => { i.engine = { ...E.createWeightedMovingAverageEngine(), version: "wma-1.0.1" }; },
    "the engine type": (i) => { i.engine = { ...E.createWeightedMovingAverageEngine(), engineType: "baseline_other" }; },
  };
  const seen = new Set([base]);
  for (const [what, change] of Object.entries(variants)) {
    const input = planInput();
    change(input);
    const id = runIdOf(input);
    assert.notEqual(id, base, what);
    seen.add(id);
  }
  assert.equal(seen.size, Object.keys(variants).length + 1, "every change gives its own id");
});

test("the fingerprint covers inputs, horizons, window, engine and the calculation-contract version", () => {
  const plan = RUN.buildAnalyticsPlan(planInput());
  assert.equal(plan.run.calculationContractVersion, RUN.CALCULATION_CONTRACT_VERSION);
  const src = require("node:fs").readFileSync(require.resolve("../src/inventoryAnalyticsRun.js"), "utf8");
  const block = src.slice(src.indexOf("const contentFingerprint"), src.indexOf(".digest(\"hex\")"));
  for (const part of [
    "calculationContractVersion: CALCULATION_CONTRACT_VERSION", "engineType: engine.engineType", "modelVersion: engine.version",
    "horizons: [...HORIZONS]", "asOfDate: window.asOfDate", "trainingWindow", "inputs: normalizedInputs(", "outputs:",
  ]) {
    assert.ok(block.includes(part), part);
  }
  const inputs = RUN.normalizedInputs(planInput());
  assert.deepEqual(Object.keys(inputs.orders[0]).sort(), [
    "allocationOpen", "allocationVersion", "createdAt", "id", "items", "requestedDeliveryDate", "status",
  ]);
  assert.deepEqual(Object.keys(inputs.inventory[0]).sort(), [
    "arrivalDate", "createdAt", "expiryDate", "id", "quantity", "quarantinedQuantity", "reservedQuantity",
    "returnPendingQuantity", "status", "vaccineId",
  ]);
});

test("Phase 1 run limits are named internal application limits — not Firebase requirements", () => {
  assert.deepEqual(RUN.ANALYTICS_RUN_LIMITS, { maxForecastDocuments: 450, maxEstimatedPayloadBytes: 8 * 1024 * 1024 });
  assert.ok(RUN.ANALYTICS_RUN_LIMITS.maxEstimatedPayloadBytes < RUN.FIRESTORE_DOCUMENTED_REQUEST_LIMIT_BYTES, "below the documented 10 MiB request limit");
  const plan = (n) => ({ runId: "r", run: { runId: "r" }, forecasts: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, data: { i } })) });
  assert.equal(RUN.runLimitProblem(plan(450)), null, "the configured cap itself is allowed");
  const over = RUN.runLimitProblem(plan(451));
  assert.match(over, /^Refusing: Phase 1 analytics run limit — this run has 451 forecast documents; the limit is 450/);
  assert.match(over, /\(an internal application safety limit, not a Firebase requirement\)\. Nothing was written\.$/);
  assert.doesNotMatch(over, /transaction limit|500-write|Firestore transaction/i);
});

test("the payload check is an application estimate of the serialized output", () => {
  const p = RUN.buildAnalyticsPlan(planInput());
  const expected =
    Buffer.byteLength(JSON.stringify({ id: p.runId, data: p.run }), "utf8") +
    p.forecasts.reduce((sum, f) => sum + Buffer.byteLength(JSON.stringify({ id: f.id, data: f.data }), "utf8"), 0);
  assert.equal(RUN.estimatePayloadBytes(p), expected, "UTF-8 JSON of the run + every forecast");
  assert.equal(RUN.runLimitProblem(p), null);
  const tight = RUN.runLimitProblem(p, { maxForecastDocuments: 450, maxEstimatedPayloadBytes: expected - 1 });
  assert.match(tight, /^Refusing: Phase 1 analytics run limit — estimated output payload .* MiB exceeds .* MiB/);
  assert.match(tight, /application estimate .* below Firestore's documented 10 MiB request limit; not an exact protobuf or index-size calculation\)\. Nothing was written\.$/);
  // Counted in UTF-8 bytes, not characters: four CJK characters (3 bytes each)
  // weigh more than four ASCII letters, 3 forecasts × 8 extra bytes each.
  const withName = (name) => {
    const input = planInput();
    input.vaccines[0].data.vaccineName = name;
    return RUN.estimatePayloadBytes(RUN.buildAnalyticsPlan(input));
  };
  assert.equal(withName("疫苗疫苗") - withName("abcd"), 3 * 8);
});

test("configuration audit metadata never changes the run id; calculation values always do", () => {
  const base = runIdOf(planInput());
  const resavedLater = planInput();
  resavedLater.configs[0].data.updatedAt = ts("2026-10-08T09:30:00Z");
  assert.equal(runIdOf(resavedLater), base, "same values re-saved at a different time");
  const otherAdmin = planInput();
  otherAdmin.configs[0].data.updatedByUid = "admin2";
  assert.equal(runIdOf(otherAdmin), base, "same values saved by a different Admin");
  for (const [what, change] of Object.entries({
    "lead time": (c) => { c.leadTimeDays = 21; },
    "safety stock quantity": (c) => { c.safetyStockQuantity = 25; },
    "safety stock as days": (c) => { c.safetyStockQuantity = null; c.safetyStockDays = 7; },
    "enabled": (c) => { c.enabled = false; },
    // A missing stamp makes the config invalid, which changes the result.
    "audit stamp removed": (c) => { delete c.updatedByUid; },
  })) {
    const input = planInput();
    change(input.configs[0].data);
    assert.notEqual(runIdOf(input), base, what);
  }
  // The audit metadata is still kept on the run record.
  const plan = RUN.buildAnalyticsPlan(otherAdmin);
  assert.deepEqual(plan.run.configurationSnapshot, [{
    vaccineId: "vacA", enabled: true, leadTimeDays: 14, safetyStockDays: null, safetyStockQuantity: 20,
    updatedAtMillis: Date.parse("2026-10-01T00:00:00Z"), updatedByUid: "admin2",
  }]);
  assert.deepEqual(RUN.CONFIG_CALCULATION_FIELDS, ["vaccineId", "enabled", "leadTimeDays", "safetyStockDays", "safetyStockQuantity"]);
  const inputs = RUN.normalizedInputs(planInput());
  assert.ok(!("updatedAt" in inputs.configs[0]) && !("updatedByUid" in inputs.configs[0]));
});

test("identical normalized inputs at the same as-of boundary stay retry-idempotent", () => {
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) {
    const input = planInput();
    input.now = new Date(`2026-10-09T0${i}:00:00.000Z`); // same Manila day, different hour
    input.configs[0].data.updatedAt = ts(`2026-10-0${i + 1}T00:00:00Z`);
    ids.add(runIdOf(input));
  }
  assert.equal(ids.size, 1);
});

test("a staging run records the seed/test-data warning; other projects do not", () => {
  const staging = RUN.buildAnalyticsPlan({ ...planInput(), projectId: "vaxtrack-staging" });
  assert.equal(
    staging.run.dataEnvironmentWarning,
    "Staging may contain seed or test orders. Forecasts must not be treated as real client demand."
  );
  assert.equal(staging.run.projectId, "vaxtrack-staging");
  assert.equal(RUN.buildAnalyticsPlan({ ...planInput(), projectId: "demo-x" }).run.dataEnvironmentWarning, null);
  assert.equal(staging.runId, runIdOf(planInput()), "where the data came from is not part of the fingerprint");
});
