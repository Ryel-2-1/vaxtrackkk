/**
 * AI Inventory Analytics generator (Phase 1, baseline forecasting).
 * PREPARED, NOT RUN against any real project. Dry run by default.
 *
 * Reads orders, inventory batches, the vaccine catalog and the Admin's
 * analytics configuration; computes demand, stock, a deterministic baseline
 * forecast (7/30/90 days), stockout risk and reorder recommendations through
 * the SAME pure modules the tests cover (src/inventoryAnalyticsRun.js); prints
 * every data-quality warning and the exact document counts.
 *
 *   # dry run (reads only)
 *   node scripts/generateInventoryAnalytics.mjs --project vaxtrack-staging
 *   node scripts/generateInventoryAnalytics.mjs --project vaxtrack-staging --as-of 2026-10-09
 *   # apply — only with the forecast count the dry run printed
 *   node scripts/generateInventoryAnalytics.mjs --project vaxtrack-staging --apply --confirm <N>
 *
 * Phase 1 analytics run limits (internal application safety limits, not
 * Firebase requirements — see ANALYTICS_RUN_LIMITS): at most 450 forecast
 * documents and an estimated 8 MiB of output per run. A larger run is refused
 * whole before anything is written.
 *
 * Writes ONLY inventoryForecasts and inventoryAnalyticsRuns (one transaction;
 * the run record is create-only and its id is content-derived, so a retry
 * writes nothing). Never touches orders, inventory, reservations, returns,
 * prices, invoices or the analytics configuration. Forecasts are advisory and
 * never change inventory.
 *
 * Guards (parseOptions): --project is required; production (vaxtrack-bef1b) is
 * refused always, emulator included; outside the emulator only
 * vaxtrack-staging is accepted; --apply requires --confirm, and the run refuses
 * unless --confirm equals the planned forecast count.
 *
 * Credentials: Application Default Credentials, or FIRESTORE_EMULATOR_HOST.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const {
  buildAnalyticsPlan,
  applyAnalyticsPlan,
  writeCountFor,
  runLimitProblem,
  estimatePayloadBytes,
  formatMiB,
  ANALYTICS_RUN_LIMITS,
  STAGING_DATA_WARNING,
} = require("../src/inventoryAnalyticsRun.js");
const { ANALYTICS_COLLECTIONS, PRIMARY_HORIZON } = require("../src/inventoryAnalytics.js");

export const PRODUCTION_PROJECT = "vaxtrack-bef1b";
export const ALLOWED_PROJECT = "vaxtrack-staging";
/** The only collections this tool may write. */
export const WRITABLE_COLLECTIONS = Object.freeze([ANALYTICS_COLLECTIONS.FORECASTS, ANALYTICS_COLLECTIONS.RUNS]);
const PAGE = 300;

/** Command-line options, validated. Throws (refusing) on anything unsafe. */
export function parseOptions(argv, { emulator = false } = {}) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = arg("--project");
  if (!project) throw new Error("Refusing: --project is required.");
  if (project === PRODUCTION_PROJECT) throw new Error("Refusing: production analytics generation is not approved.");
  if (!emulator && project !== ALLOWED_PROJECT) {
    throw new Error(`Refusing: only --project ${ALLOWED_PROJECT} is allowed outside the emulator.`);
  }
  const apply = argv.includes("--apply");
  const confirmRaw = arg("--confirm");
  if (apply && (confirmRaw === undefined || !/^\d+$/.test(confirmRaw))) {
    throw new Error("Refusing: --apply requires --confirm <N>, the dry run's forecast count.");
  }
  const asOf = arg("--as-of");
  if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error("Refusing: --as-of must be a YYYY-MM-DD date.");
  }
  return { project, apply, confirm: apply ? Number(confirmRaw) : null, asOf: asOf ?? null };
}

/** The as-of instant: noon in Manila on --as-of, or now. */
export function asOfInstant(asOf, clock = () => new Date()) {
  return asOf ? new Date(`${asOf}T04:00:00.000Z`) : clock();
}

async function readAll(db, collection) {
  const out = [];
  let last = null;
  for (;;) {
    let q = db.collection(collection).orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) out.push({ id: d.id, data: d.data() });
    if (snap.size < PAGE) return out;
    last = snap.docs[snap.size - 1];
  }
}

/**
 * Plan, print, and — only with --apply and a matching --confirm — write.
 * Returns { applied, runId, forecastCount, runDocumentCount, replayed, written }.
 */
export async function runGenerator({ db, FieldValue, options, now = asOfInstant(options.asOf), log = console.log }) {
  const [orders, batches, vaccines, configs] = await Promise.all([
    readAll(db, "orders"),
    readAll(db, "inventory"),
    readAll(db, "vaccines"),
    readAll(db, ANALYTICS_COLLECTIONS.CONFIG),
  ]);
  const plan = buildAnalyticsPlan({ orders, batches, vaccines, configs, now, projectId: options.project });

  if (options.project === ALLOWED_PROJECT) log(`WARNING staging_data: ${STAGING_DATA_WARNING}`);
  log(`As of ${plan.window.asOfDate} — training weeks ${plan.window.earliestWeekStart} … ${plan.window.windowEnd} (complete weeks only).`);
  log(`Engine: ${plan.run.engineLabel} (${plan.run.engineType} ${plan.run.modelVersion}). Advisory only — no inventory is changed.`);
  log(`Read: ${orders.length} orders, ${batches.length} batches, ${vaccines.length} vaccines, ${configs.length} configurations.`);
  log(`Demand lines counted: ${plan.run.inputCounts.linesCounted} of ${plan.run.inputCounts.candidateLines}.`);
  if (plan.warnings.length === 0) log("Data quality: no warnings.");
  for (const w of plan.warnings) {
    log(`WARNING ${w.code} ×${w.count}: ${w.message}${w.sampleRefs.length ? ` (e.g. ${w.sampleRefs.join(", ")})` : ""}`);
  }
  for (const f of plan.forecasts.filter((x) => x.data.horizonDays === PRIMARY_HORIZON)) {
    const d = f.data;
    log(
      JSON.stringify({
        vaccineId: d.vaccineId,
        sku: d.skuSnapshot,
        predicted30d: d.predictedDemandQuantity,
        available: d.availableQuantity,
        backordered: d.backorderedQuantity,
        shortage: d.projectedShortageQuantity,
        reorder: d.recommendedReorderQuantity,
        risk: d.stockoutRiskLevel,
        confidence: d.confidenceLevel,
      })
    );
  }
  log(
    `PROPOSED: ${plan.forecasts.length} forecast document(s) in ${ANALYTICS_COLLECTIONS.FORECASTS} and 1 run document (${plan.runId}) in ${ANALYTICS_COLLECTIONS.RUNS}. Nothing else is written.`
  );
  const limitProblem = runLimitProblem(plan);
  const payloadBytes = estimatePayloadBytes(plan);
  log(
    `Phase 1 analytics run limit: ${plan.forecasts.length} of at most ${ANALYTICS_RUN_LIMITS.maxForecastDocuments} forecast documents; estimated output payload ${formatMiB(payloadBytes)} of at most ${formatMiB(ANALYTICS_RUN_LIMITS.maxEstimatedPayloadBytes)} (application safety limits, not Firebase requirements).`
  );
  if (limitProblem) log(`WARNING run_limit: ${limitProblem.replace(/^Refusing: /, "").replace(/ Nothing was written\.$/, "")} — --apply would be refused.`);

  const summary = {
    runId: plan.runId,
    forecastCount: plan.forecasts.length,
    runDocumentCount: 1,
    writeCount: writeCountFor(plan),
    estimatedPayloadBytes: payloadBytes,
    stagingWarning: options.project === ALLOWED_PROJECT,
  };
  if (!options.apply) {
    log("Dry run only — nothing was written.");
    return { ...summary, applied: false, replayed: false, written: 0 };
  }
  // Refused whole, before anything is written — never a partial run.
  if (limitProblem) throw new Error(limitProblem);
  if (options.confirm !== plan.forecasts.length) {
    throw new Error(
      `Refusing: --confirm ${options.confirm} does not match the ${plan.forecasts.length} forecast(s) proposed. Nothing was written.`
    );
  }
  const result = await applyAnalyticsPlan({ db, FieldValue, plan });
  log(
    result.replayed
      ? `Run ${result.runId} already exists with identical content — nothing was written (retry-safe).`
      : `Applied: run ${result.runId}, ${result.written} document(s) written.`
  );
  return { ...summary, applied: true, replayed: result.replayed, written: result.written };
}

async function main(argv) {
  const options = parseOptions(argv, { emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST) });
  const app = admin.initializeApp({ projectId: options.project }, "inventory-analytics");
  try {
    await runGenerator({ db: app.firestore(), FieldValue: admin.firestore.FieldValue, options });
  } finally {
    await app.delete();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
