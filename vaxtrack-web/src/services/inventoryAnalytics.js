/**
 * AI Inventory Analytics — the Admin page's display model (Phase 1).
 *
 * Pure (no Firebase, no React) so node tests import it directly. The page
 * shows ONLY what the server generator stored in inventoryForecasts /
 * inventoryAnalyticsRuns (functions/src/inventoryAnalyticsRun.js). Nothing here
 * computes, estimates or fills in a forecast: a missing figure renders as "—"
 * or as the reason it is missing, never as a number.
 */

export const ANALYTICS_DISCLAIMER = "Forecasts are advisory and do not change inventory automatically.";
export const NO_FORECAST_MESSAGE = "No inventory forecast has been generated yet.";
export const REORDER_CONFIGURATION_REQUIRED = "Reorder configuration required";
export const BASELINE_LABEL = "Baseline forecasting";
/** Identical to STAGING_DATA_WARNING in functions/src/inventoryAnalyticsRun.js. */
export const STAGING_DATA_WARNING =
  "Staging may contain seed or test orders. Forecasts must not be treated as real client demand.";
export const STAGING_PROJECT = "vaxtrack-staging";
export const PRODUCTION_PROJECT = "vaxtrack-bef1b";
export const HORIZONS = Object.freeze([7, 30, 90]);
export const PRIMARY_HORIZON = 30;
/** A run older than this is flagged stale. */
export const STALE_AFTER_DAYS = 7;
const DAY_MS = 86400000;

/** Risk level → label and tone (green low, amber medium, red high, gray unknown). */
export const RISK_META = Object.freeze({
  high: { label: "High", tone: "high" },
  medium: { label: "Medium", tone: "medium" },
  low: { label: "Low", tone: "low" },
  unknown: { label: "Unknown", tone: "unknown" },
});

/**
 * Why a risk level was given (functions/src/analyticsRisk.js riskBasis). The
 * page keeps a KNOWN shortage (orders already placed) visibly separate from a
 * FORECASTED one and from "not enough history to forecast".
 */
export const RISK_BASIS_LABELS = Object.freeze({
  current_backorder_shortage: "Current shortage",
  forecast_shortage: "Forecasted shortage",
  lead_time_shortage: "Forecasted shortage (lead time)",
  insufficient_history: "Insufficient forecast history",
  configuration_missing: "Reorder configuration required",
  below_safety_stock: "Below safety stock",
  above_safety_stock: "Above safety stock",
});

export const CONFIDENCE_LABELS = Object.freeze({
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "Insufficient data",
});

const isQuantity = (v) => Number.isSafeInteger(v) && v >= 0;

/** A stored whole-vial figure, or "—" when there is none. Never invents a value. */
export function formatQuantity(value) {
  return isQuantity(value) ? value.toLocaleString("en-PH") : "—";
}

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

export function formatGeneratedAt(ts) {
  const ms = toMillis(ts);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

/** True when the run is older than STALE_AFTER_DAYS (or has no time at all). */
export function isStale(generatedAt, nowMillis = Date.now()) {
  const ms = toMillis(generatedAt);
  return ms === null || nowMillis - ms > STALE_AFTER_DAYS * DAY_MS;
}

/**
 * Which Firebase project the page (and the run) belongs to, for the header.
 * Null when unknown. Staging carries the seed/test-data warning.
 */
export function environmentNotice(projectId) {
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  const id = projectId.trim();
  if (id === STAGING_PROJECT) return { projectId: id, label: "Staging", warning: STAGING_DATA_WARNING };
  if (id === PRODUCTION_PROJECT) return { projectId: id, label: "Production", warning: null };
  return { projectId: id, label: "Other project", warning: null };
}

/** The forecasts that belong to one run, grouped per vaccine by horizon. */
export function forecastsByVaccine(forecastDocs, runId) {
  const out = new Map();
  if (!runId) return out;
  for (const d of forecastDocs) {
    if (d?.runId !== runId || !HORIZONS.includes(d.horizonDays) || typeof d.vaccineId !== "string") continue;
    const entry = out.get(d.vaccineId) ?? {};
    entry[d.horizonDays] = d;
    out.set(d.vaccineId, entry);
  }
  return out;
}

/**
 * One table row, from the stored 30-day forecast. Every number is the stored
 * one; a null stays "—"; a missing name/SKU is said to be missing.
 */
export function forecastRow(doc) {
  const risk = RISK_META[doc.stockoutRiskLevel] ? doc.stockoutRiskLevel : "unknown";
  const needsConfiguration = doc.reorderConfigurationComplete !== true;
  const insufficient = doc.confidenceLevel === "insufficient" || !isQuantity(doc.predictedDemandQuantity);
  return {
    id: doc.forecastId ?? doc.id,
    vaccineId: doc.vaccineId,
    name: typeof doc.vaccineNameSnapshot === "string" && doc.vaccineNameSnapshot ? doc.vaccineNameSnapshot : "Name not recorded",
    nameMissing: !(typeof doc.vaccineNameSnapshot === "string" && doc.vaccineNameSnapshot),
    sku: typeof doc.skuSnapshot === "string" && doc.skuSnapshot ? doc.skuSnapshot : "No SKU",
    skuMissing: !(typeof doc.skuSnapshot === "string" && doc.skuSnapshot),
    available: formatQuantity(doc.availableQuantity),
    reserved: formatQuantity(doc.reservedQuantity),
    backordered: formatQuantity(doc.backorderedQuantity),
    predicted: insufficient ? "—" : formatQuantity(doc.predictedDemandQuantity),
    // Known now, from placed orders — never depends on a forecast.
    currentShortage: formatQuantity(doc.currentBackorderShortageQuantity),
    hasCurrentShortage: isQuantity(doc.currentBackorderShortageQuantity) && doc.currentBackorderShortageQuantity > 0,
    // Forecast-based; without a forecast it says so instead of showing a number.
    forecastShortage: insufficient ? "Insufficient history" : formatQuantity(doc.forecastShortageQuantity),
    totalShortage: insufficient ? "—" : formatQuantity(doc.totalProjectedShortageQuantity),
    riskBasis: typeof doc.riskBasis === "string" ? doc.riskBasis : null,
    riskBasisLabel: RISK_BASIS_LABELS[doc.riskBasis] ?? "",
    reorder: needsConfiguration ? REORDER_CONFIGURATION_REQUIRED : formatQuantity(doc.recommendedReorderQuantity),
    needsConfiguration,
    insufficient,
    risk,
    riskLabel: RISK_META[risk].label,
    riskTone: RISK_META[risk].tone,
    riskReason: typeof doc.stockoutRiskReason === "string" ? doc.stockoutRiskReason : "",
    confidence: CONFIDENCE_LABELS[doc.confidenceLevel] ?? "Unknown",
    lowConfidence: doc.confidenceLevel === "insufficient" || doc.confidenceLevel === "low",
    generatedAt: formatGeneratedAt(doc.generatedAt),
  };
}

/** The four summary cards, from the 30-day rows. */
export function summarize(rows) {
  return {
    vaccinesAnalyzed: rows.length,
    highRisk: rows.filter((r) => r.risk === "high").length,
    configurationRequired: rows.filter((r) => r.needsConfiguration).length,
    lowConfidence: rows.filter((r) => r.lowConfidence).length,
  };
}

/** Sort: High first, then Medium, Unknown, Low; then by name. */
const RISK_ORDER = { high: 0, medium: 1, unknown: 2, low: 3 };
export function sortRows(rows) {
  return [...rows].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.name.localeCompare(b.name));
}

/** Was the vaccine's configuration changed after this forecast was generated? */
export function configChangedSinceForecast(config, forecast) {
  const c = toMillis(config?.updatedAt);
  const f = toMillis(forecast?.generatedAt);
  return c !== null && f !== null && c > f;
}

// ---------------------------------------------------------------- configuration form

export const MAX_LEAD_TIME_DAYS = 365;
export const MAX_SAFETY_STOCK_DAYS = 365;
export const MAX_SAFETY_STOCK_QUANTITY = 100000000;

/** The form's starting values for a vaccine's stored configuration (or none). */
export function configFormFrom(config) {
  if (!config) return { leadTimeDays: "", safetyMode: "quantity", safetyValue: "", enabled: true };
  const days = config.safetyStockDays;
  return {
    leadTimeDays: Number.isInteger(config.leadTimeDays) ? String(config.leadTimeDays) : "",
    safetyMode: Number.isInteger(days) ? "days" : "quantity",
    safetyValue: Number.isInteger(days)
      ? String(days)
      : Number.isInteger(config.safetyStockQuantity)
        ? String(config.safetyStockQuantity)
        : "",
    enabled: config.enabled !== false,
  };
}

const wholeIn = (text, min, max) => {
  const t = String(text ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * The configuration fields to save, validated exactly as firestore.rules and
 * functions/src/analyticsRisk.js validate them. The service adds the server
 * time and the signed-in Admin's uid. Returns { ok, value } or { ok, error }.
 */
export function analyticsConfigPayload(vaccineId, form) {
  if (typeof vaccineId !== "string" || vaccineId === "" || vaccineId.includes("/")) {
    return { ok: false, error: "This vaccine cannot be configured." };
  }
  const leadTimeDays = wholeIn(form?.leadTimeDays, 1, MAX_LEAD_TIME_DAYS);
  if (leadTimeDays === null) return { ok: false, error: `Lead time must be a whole number of days from 1 to ${MAX_LEAD_TIME_DAYS}.` };
  const byDays = form?.safetyMode === "days";
  const safety = wholeIn(form?.safetyValue, 0, byDays ? MAX_SAFETY_STOCK_DAYS : MAX_SAFETY_STOCK_QUANTITY);
  if (safety === null) {
    return {
      ok: false,
      error: byDays
        ? `Safety stock must be a whole number of days from 0 to ${MAX_SAFETY_STOCK_DAYS}.`
        : `Safety stock must be a whole number of vials from 0 to ${MAX_SAFETY_STOCK_QUANTITY.toLocaleString("en-PH")}.`,
    };
  }
  return {
    ok: true,
    value: {
      vaccineId,
      leadTimeDays,
      safetyStockDays: byDays ? safety : null,
      safetyStockQuantity: byDays ? null : safety,
      enabled: form?.enabled !== false,
    },
  };
}
