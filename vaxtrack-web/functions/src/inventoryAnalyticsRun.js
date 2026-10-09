"use strict";

/**
 * AI Inventory Analytics — one analysis RUN: plan (pure) and apply (Admin SDK).
 *
 * buildAnalyticsPlan turns already-read documents into the exact forecast and
 * run documents a run would write. It is pure and deterministic: the same
 * inputs and the same `now` always give the same plan, byte for byte.
 *
 * applyAnalyticsPlan writes that plan in ONE transaction (all or nothing), and
 * ONLY to the two
 * analytics collections:
 *
 *   inventoryAnalyticsRuns/{runId}      immutable, create-only. runId is derived
 *                                       from the as-of date + a fingerprint of
 *                                       the content, so a retry of the same run
 *                                       finds its own record and writes nothing
 *                                       (no duplicate runs, ever).
 *   inventoryForecasts/{forecastId}     the CURRENT advisory forecast per
 *                                       vaccine × area × horizon; a new run
 *                                       replaces it. Not an audit record — the
 *                                       run record is the audit trail.
 *
 * It never writes orders, inventory, reservations, returns, prices, invoices
 * or the analytics configuration.
 */

const crypto = require("node:crypto");
const {
  HORIZONS,
  PRIMARY_HORIZON,
  AREA_ALL,
  ANALYTICS_COLLECTIONS,
  CONFIRMED_INCOMING_TRACKED,
  WARNING,
  WARNING_TEXT,
  createWarningLog,
  toDate,
  extractDemand,
  backorderedByProduct,
  stockByProduct,
  trainingWindowFor,
  weeklySeries,
} = require("./inventoryAnalytics");
const {
  CONFIDENCE,
  DATA_QUALITY_DOWNGRADE_RATIO,
  downgradeConfidence,
  createWeightedMovingAverageEngine,
  assertForecastEngine,
  validateForecastDocument,
} = require("./forecastEngine");
const { CONFIG_FIELDS, CONFIG_STATUS, CONFIG_STATUS_TEXT, assessProduct } = require("./analyticsRisk");

/** Configuration values the calculation reads. Audit metadata is not among them. */
const CONFIG_CALCULATION_FIELDS = Object.freeze([
  "vaccineId",
  "enabled",
  "leadTimeDays",
  "safetyStockDays",
  "safetyStockQuantity",
]);

/**
 * Phase 1 analytics run limits — INTERNAL APPLICATION SAFETY LIMITS, not
 * Firebase requirements. (Firestore no longer caps a commit at 500 writes; the
 * real constraint is its documented 10 MiB request size.) They keep the first
 * implementation bounded: one run is one all-or-nothing transaction, so an
 * unexpectedly large catalog is refused whole instead of producing an
 * oversized commit or a partial run. Raising them is a deliberate decision.
 *
 *   maxForecastDocuments       450 = 150 vaccines × 3 horizons, plus the one
 *                              run record (not counted here)
 *   maxEstimatedPayloadBytes   8 MiB, kept below Firestore's documented 10 MiB
 *                              request limit. An APPLICATION ESTIMATE: the
 *                              UTF-8 JSON size of every document written — not
 *                              an exact protobuf, field-transform or index-size
 *                              calculation, which is why the margin is large.
 */
const ANALYTICS_RUN_LIMITS = Object.freeze({
  maxForecastDocuments: 450,
  maxEstimatedPayloadBytes: 8 * 1024 * 1024,
});
const FIRESTORE_DOCUMENTED_REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Version of the calculation contract (demand definition, stock rule, risk and
 * reorder formulas, document shape). Bump it whenever any of those change, so
 * a run under new rules can never share an id with one under old rules.
 */
const CALCULATION_CONTRACT_VERSION = "inventory-analytics-1";

/** Shown (and stored on the run) when the data comes from the staging project. */
const STAGING_DATA_WARNING =
  "Staging may contain seed or test orders. Forecasts must not be treated as real client demand.";

/**
 * Deterministic JSON: object keys sorted at every level, so key order never
 * changes a fingerprint. Non-finite numbers get their own spelling instead of
 * collapsing to null (JSON would make NaN and null look identical).
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(`#number:${String(value)}`);
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** A primitive as stored; a timestamp as epoch millis; anything else null. */
function plain(value) {
  if (value === undefined || value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  const d = toDate(value);
  return d ? { millis: d.getTime() } : null;
}

const pick = (data, fields) => Object.fromEntries(fields.map((f) => [f, plain(data?.[f])]));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every input field the calculation reads — and only those — in a stable form.
 * A change to any of them changes the run id; a change to anything the
 * analytics never reads (a clinic name, an event log) does not.
 */
function normalizedInputs({ orders, batches, vaccines, configs }) {
  return {
    orders: orders
      .map(({ id, data }) => ({
        id,
        ...pick(data, ["status", "requestedDeliveryDate", "createdAt", "allocationVersion", "allocationOpen"]),
        items: Array.isArray(data?.items)
          ? data.items.map((l) => pick(l, ["productKey", "inventoryId", "quantity", "reservedQuantity"]))
          : null,
      }))
      .sort(byId),
    inventory: batches
      .map(({ id, data }) => ({
        id,
        ...pick(data, [
          "vaccineId", "quantity", "reservedQuantity", "returnPendingQuantity", "quarantinedQuantity",
          "status", "expiryDate", "arrivalDate", "createdAt",
        ]),
      }))
      .sort(byId),
    vaccines: vaccines.map(({ id, data }) => ({ id, ...pick(data, ["vaccineName", "internalSku"]) })).sort(byId),
    configs: configs
      .map(({ id, data }) => ({
        id,
        ...pick(data, CONFIG_CALCULATION_FIELDS),
        // The audit stamp's VALUE never affects a result; only whether it is
        // present does (validateAnalyticsConfig treats a config without one as
        // invalid). So re-saving identical values is the same run.
        auditStampPresent: {
          updatedAt: data?.updatedAt !== undefined && data?.updatedAt !== null,
          updatedByUid: typeof data?.updatedByUid === "string" && data.updatedByUid !== "",
        },
        // Fields a config should not have make it invalid — keep their names.
        extraFields: Object.keys(data ?? {}).filter((k) => !CONFIG_FIELDS.includes(k)).sort(),
      }))
      .sort(byId),
  };
}

/**
 * The configuration exactly as the run used it, WITH its audit metadata (who
 * saved it and when). Stored on the run record for the audit trail; never part
 * of the fingerprint.
 */
function configurationSnapshot(configs) {
  return configs
    .map(({ id, data }) => ({
      vaccineId: id,
      ...pick(data, CONFIG_CALCULATION_FIELDS),
      updatedAtMillis: toDate(data?.updatedAt)?.getTime() ?? null,
      updatedByUid: typeof data?.updatedByUid === "string" ? data.updatedByUid : null,
    }))
    .sort((a, b) => (a.vaccineId < b.vaccineId ? -1 : a.vaccineId > b.vaccineId ? 1 : 0));
}

/** Deterministic forecast id: vaccine + area + horizon. */
function forecastIdFor(vaccineId, areaKey, horizonDays) {
  return `${vaccineId}__${areaKey}__${horizonDays}d`;
}

const textOrNull = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * The plan for one run.
 *
 * [orders] [batches] [vaccines] [configs]   arrays of { id, data }
 * [now]     the as-of instant (Manila calendar decides the weeks)
 * [engine]  a ForecastEngine (default: the baseline weighted moving average)
 */
function buildAnalyticsPlan({
  orders,
  batches,
  vaccines,
  configs,
  now,
  engine = createWeightedMovingAverageEngine(),
  projectId = null,
}) {
  assertForecastEngine(engine);
  const warnings = createWarningLog();
  const window = trainingWindowFor(now);

  const batchesById = new Map(batches.map((b) => [b.id, b.data]));
  const vaccinesById = new Map(vaccines.map((v) => [v.id, v.data]));
  const configsById = new Map(configs.map((c) => [c.id, c.data]));

  const demand = extractDemand({ orders, batchesById, warnings });
  const stock = stockByProduct({ batches, now, warnings });
  const backordered = backorderedByProduct(orders);

  // Confidence is lowered for EVERY forecast when too many candidate lines had
  // to be dropped for a missing date or product identity.
  const identityOrDateExcluded = warnings.count(WARNING.MISSING_ORDER_DATE) + warnings.count(WARNING.MISSING_PRODUCT_ID);
  const excludedLineRatio = demand.counts.candidateLines === 0 ? 0 : identityOrDateExcluded / demand.counts.candidateLines;
  const confidenceDowngraded = excludedLineRatio >= DATA_QUALITY_DOWNGRADE_RATIO;

  const linesByProduct = new Map();
  for (const line of demand.lines) {
    const list = linesByProduct.get(line.vaccineId) ?? [];
    list.push(line);
    linesByProduct.set(line.vaccineId, list);
  }

  // A product id becomes part of a document id; one that cannot be is reported
  // (as an unknown product) instead of being written somewhere unexpected.
  const productIds = [...new Set([...vaccinesById.keys(), ...linesByProduct.keys(), ...stock.keys()])]
    .filter((id) => {
      const ok = typeof id === "string" && /^[^/]{1,500}$/.test(id) && id !== "." && id !== "..";
      if (!ok) warnings.add(WARNING.MISSING_PRODUCT_ID, null);
      return ok;
    })
    .sort();
  const forecasts = [];
  const riskSummary = { high: 0, medium: 0, low: 0, unknown: 0 };
  let reorderConfigurationRequiredCount = 0;
  let lowConfidenceCount = 0;

  for (const vaccineId of productIds) {
    const vaccine = vaccinesById.get(vaccineId) ?? null;
    const productStock = stock.get(vaccineId) ?? {
      availableQuantity: 0, reservedQuantity: 0, onHandQuantity: 0, returnPendingQuantity: 0,
      quarantinedQuantity: 0, batchCount: 0, unavailableBatchCount: 0, inconsistentBatchCount: 0, firstArrivalDate: null,
    };
    const lines = linesByProduct.get(vaccineId) ?? [];
    const { series } = weeklySeries({ lines, firstArrivalDate: productStock.firstArrivalDate, window });
    const seriesStart = series[0]?.weekStart ?? null;
    const inWindowOrders = new Set(
      lines.filter((l) => seriesStart && l.date >= seriesStart && l.date <= window.windowEnd).map((l) => l.orderId)
    );
    const backorderedQuantity = backordered.get(vaccineId) ?? 0;
    const config = configsById.get(vaccineId) ?? null;

    const sku = textOrNull(vaccine?.internalSku);
    const name = textOrNull(vaccine?.vaccineName);
    const productWarnings = [];
    const note = (code, message = WARNING_TEXT[code]) => productWarnings.push({ code, message });
    if (!sku) {
      warnings.add(WARNING.UNKNOWN_SKU, vaccineId);
      note(WARNING.UNKNOWN_SKU, vaccine ? "This vaccine has no SKU in the catalog." : "This product id is not in the vaccine catalog.");
    }
    if (productStock.inconsistentBatchCount > 0) {
      note(WARNING.INVENTORY_INCONSISTENCY, `${productStock.inconsistentBatchCount} batch(es) have invalid or inconsistent stock counters and count as unavailable.`);
    }
    if (confidenceDowngraded) {
      note(
        "confidence_lowered",
        `${Math.round(excludedLineRatio * 100)}% of order lines in this run were excluded for a missing date or product identity, so confidence was lowered one level.`
      );
    }

    let productHasMissingConfig = false;
    let productInsufficient = false;

    for (const horizonDays of HORIZONS) {
      const assessed = assessProduct({
        engine,
        history: series,
        horizonDays,
        stock: productStock,
        backorderedQuantity,
        config,
        vaccineId,
      });
      const p = assessed.prediction;
      const confidenceLevel = confidenceDowngraded ? downgradeConfidence(p.confidenceLevel) : p.confidenceLevel;
      if (p.predictedQuantity === null) productInsufficient = true;
      if (!assessed.configComplete) productHasMissingConfig = true;

      const docWarnings = [...productWarnings];
      if (p.predictedQuantity === null) {
        docWarnings.push({ code: WARNING.INSUFFICIENT_HISTORY, message: `${p.usableWeekCount} usable week(s) of history; at least 4 are needed.` });
      }
      if (!assessed.configComplete) {
        docWarnings.push({ code: WARNING.MISSING_REORDER_CONFIG, message: CONFIG_STATUS_TEXT[assessed.configStatus] });
      }

      const explanationFactors = [
        ...p.explanationFactors,
        {
          key: "stock",
          label: "Stock used",
          value: `${productStock.availableQuantity} available (on hand ${productStock.onHandQuantity} − reserved ${productStock.reservedQuantity} − return pending ${productStock.returnPendingQuantity} − quarantined ${productStock.quarantinedQuantity}, expired/unusable batches excluded); ${backorderedQuantity} backordered on open orders.`,
        },
        {
          key: "incoming",
          label: "Confirmed incoming stock",
          value: "Not tracked in VaxTrack yet — treated as 0 (no incoming delivery is assumed).",
        },
      ];

      const forecastId = forecastIdFor(vaccineId, AREA_ALL, horizonDays);
      const data = {
        forecastId,
        vaccineId,
        vaccineNameSnapshot: name,
        skuSnapshot: sku,
        areaKey: AREA_ALL,
        horizonDays,
        predictedDemandQuantity: p.predictedQuantity,
        availableQuantity: productStock.availableQuantity,
        reservedQuantity: productStock.reservedQuantity,
        backorderedQuantity,
        confirmedIncomingQuantity: null,
        confirmedIncomingTracked: CONFIRMED_INCOMING_TRACKED,
        projectedShortageQuantity: assessed.projectedShortageQuantity,
        recommendedReorderQuantity: assessed.recommendedReorderQuantity,
        reorderConfigurationComplete: assessed.configComplete,
        reorderConfigurationStatus: assessed.configStatus,
        stockoutRiskLevel: assessed.stockoutRiskLevel,
        stockoutRiskReason: assessed.stockoutRiskReason,
        calculation: assessed.calculation,
        confidenceLevel,
        sampleOrderCount: inWindowOrders.size,
        usableWeekCount: p.usableWeekCount,
        weeklyHistory: series,
        dataQualityWarnings: docWarnings,
        explanationFactors,
        engineType: engine.engineType,
        engineLabel: engine.label,
        modelVersion: engine.version,
        trainingWindowStart: seriesStart,
        trainingWindowEnd: seriesStart ? window.windowEnd : null,
        advisoryOnly: true,
        runId: null, // set below, once the content fingerprint is known
        generatedAt: null, // server time, set on write
      };
      const problems = validateForecastDocument(data);
      if (problems.length > 0) throw new Error(`Forecast ${forecastId} breaks the contract: ${problems.join("; ")}`);
      forecasts.push({ id: forecastId, data });

      if (horizonDays === PRIMARY_HORIZON) {
        riskSummary[assessed.stockoutRiskLevel] += 1;
        if ([CONFIDENCE.INSUFFICIENT, CONFIDENCE.LOW].includes(confidenceLevel)) lowConfidenceCount += 1;
        if (!assessed.configComplete) reorderConfigurationRequiredCount += 1;
      }
    }
    if (productHasMissingConfig) warnings.add(WARNING.MISSING_REORDER_CONFIG, vaccineId);
    if (productInsufficient) warnings.add(WARNING.INSUFFICIENT_HISTORY, vaccineId);
  }

  // The run fingerprint covers everything that can change the output — the
  // normalized inputs, the as-of boundary, the horizons and areas, the engine
  // and its version, and the calculation-contract version — and the computed
  // output itself (a code change that forgot to bump the contract version
  // still yields a new id). Canonical JSON: key and document order never matter.
  const contentFingerprint = crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        calculationContractVersion: CALCULATION_CONTRACT_VERSION,
        engineType: engine.engineType,
        modelVersion: engine.version,
        horizons: [...HORIZONS],
        areaKeys: [AREA_ALL],
        asOfDate: window.asOfDate,
        trainingWindow: {
          earliestWeekStart: window.earliestWeekStart,
          lastWeekStart: window.lastWeekStart,
          windowEnd: window.windowEnd,
        },
        inputs: normalizedInputs({ orders, batches, vaccines, configs }),
        outputs: forecasts.map((f) => f.data),
      })
    )
    .digest("hex");
  const runId = `${window.asOfDate}-${contentFingerprint.slice(0, 16)}`;
  for (const f of forecasts) f.data.runId = runId;

  const run = {
    runId,
    engineType: engine.engineType,
    engineLabel: engine.label,
    modelVersion: engine.version,
    asOfDate: window.asOfDate,
    trainingWindowEnd: window.windowEnd,
    earliestTrainingWeekStart: window.earliestWeekStart,
    areaKeys: [AREA_ALL],
    horizons: [...HORIZONS],
    primaryHorizonDays: PRIMARY_HORIZON,
    vaccineCount: productIds.length,
    forecastCount: forecasts.length,
    forecastIds: forecasts.map((f) => f.id),
    inputCounts: {
      ...demand.counts,
      batchesRead: batches.length,
      vaccinesRead: vaccines.length,
      configsRead: configs.length,
    },
    riskSummary,
    reorderConfigurationRequiredCount,
    lowConfidenceCount,
    excludedLineRatio: Math.round(excludedLineRatio * 10000) / 10000,
    confidenceDowngraded,
    dataQualityWarnings: warnings.list(),
    contentFingerprint,
    calculationContractVersion: CALCULATION_CONTRACT_VERSION,
    // Audit trail of the configuration used (who/when). Not part of the fingerprint.
    configurationSnapshot: configurationSnapshot(configs),
    // Where the data came from. Not part of the fingerprint.
    projectId,
    dataEnvironmentWarning: projectId === "vaxtrack-staging" ? STAGING_DATA_WARNING : null,
    advisoryOnly: true,
    generatedBy: "scripts/generateInventoryAnalytics.mjs",
    generatedAt: null, // server time, set on write
  };

  return { runId, run, forecasts, warnings: warnings.list(), window };
}

/**
 * Write a plan: the immutable run record (create-only) and the current
 * forecasts, atomically. A retry of an already-written run writes nothing.
 * Returns { runId, replayed, written }.
 */
/** The exact document writes a plan needs: one run record + each forecast. */
function writeCountFor(plan) {
  return plan.forecasts.length + 1;
}

/**
 * Estimated output payload of a plan, in bytes: the UTF-8 JSON size of the run
 * document plus every forecast document, with their ids. An application
 * estimate for the safety limit above — not Firestore's exact wire or index size.
 */
function estimatePayloadBytes(plan) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let bytes = size({ id: plan.runId, data: plan.run });
  for (const f of plan.forecasts) bytes += size({ id: f.id, data: f.data });
  return bytes;
}

const formatMiB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

/** Null when the plan is within the Phase 1 run limits, else the refusal. */
function runLimitProblem(plan, limits = ANALYTICS_RUN_LIMITS) {
  if (plan.forecasts.length > limits.maxForecastDocuments) {
    return `Refusing: Phase 1 analytics run limit — this run has ${plan.forecasts.length} forecast documents; the limit is ${limits.maxForecastDocuments} (an internal application safety limit, not a Firebase requirement). Nothing was written.`;
  }
  const bytes = estimatePayloadBytes(plan);
  if (bytes > limits.maxEstimatedPayloadBytes) {
    return `Refusing: Phase 1 analytics run limit — estimated output payload ${formatMiB(bytes)} exceeds ${formatMiB(limits.maxEstimatedPayloadBytes)} (an application estimate of the serialized documents, kept below Firestore's documented 10 MiB request limit; not an exact protobuf or index-size calculation). Nothing was written.`;
  }
  return null;
}

async function applyAnalyticsPlan({ db, FieldValue, plan, limits = ANALYTICS_RUN_LIMITS }) {
  // Checked before ANY read or write: an over-limit run is refused whole.
  const problem = runLimitProblem(plan, limits);
  if (problem) throw new Error(problem);
  const writes = writeCountFor(plan);
  const runRef = db.collection(ANALYTICS_COLLECTIONS.RUNS).doc(plan.runId);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(runRef);
    if (existing.exists) {
      if (existing.data().contentFingerprint === plan.run.contentFingerprint) {
        return { runId: plan.runId, replayed: true, written: 0 };
      }
      throw new Error(`Refusing: run ${plan.runId} already exists with different content. Nothing was written.`);
    }
    tx.create(runRef, { ...plan.run, generatedAt: FieldValue.serverTimestamp() });
    for (const f of plan.forecasts) {
      tx.set(db.collection(ANALYTICS_COLLECTIONS.FORECASTS).doc(f.id), {
        ...f.data,
        generatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { runId: plan.runId, replayed: false, written: writes };
  });
}

module.exports = {
  ANALYTICS_RUN_LIMITS,
  FIRESTORE_DOCUMENTED_REQUEST_LIMIT_BYTES,
  estimatePayloadBytes,
  formatMiB,
  CALCULATION_CONTRACT_VERSION,
  STAGING_DATA_WARNING,
  canonicalJson,
  normalizedInputs,
  configurationSnapshot,
  CONFIG_CALCULATION_FIELDS,
  writeCountFor,
  runLimitProblem,
  forecastIdFor,
  buildAnalyticsPlan,
  applyAnalyticsPlan,
  CONFIG_STATUS,
};
