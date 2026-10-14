"use strict";

/**
 * Forecast engines — the model-independent interface, and the ONE engine that
 * exists in Phase 1: a deterministic weighted moving average.
 *
 * THE INTERFACE (what any engine — including a future Python ML model — must
 * provide; assertForecastEngine checks it):
 *
 *   engine.engineType   stable machine name, e.g. "baseline_weighted_moving_average"
 *   engine.version      the model version stamped on every prediction
 *   engine.label        what the UI calls it ("Baseline forecasting")
 *   engine.predict(history, horizonDays) →
 *     { predictedQuantity: integer ≥ 0 | null,   null = cannot forecast
 *       usableWeekCount, confidenceLevel, explanationFactors[] }
 *
 *   history: [{ weekStart: "YYYY-MM-DD", quantity: integer ≥ 0 }], oldest first,
 *            consecutive complete weeks (inventoryAnalytics.weeklySeries).
 *
 * A Python model need not run in this process: it can write documents in the
 * FORECAST_DOCUMENT_FIELDS contract below (validateForecastDocument enforces
 * it), and the Admin UI reads only those fields — so replacing the baseline
 * changes nothing in the UI.
 *
 * THIS ENGINE IS NOT MACHINE LEARNING. It is labelled "Baseline forecasting"
 * everywhere. Confidence describes data COVERAGE (how many weeks of history),
 * never a probability.
 */

const CONFIDENCE = Object.freeze({
  INSUFFICIENT: "insufficient",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

/** Usable weekly buckets → confidence (coverage, not probability). */
function confidenceFromWeeks(usableWeekCount) {
  if (usableWeekCount < 4) return CONFIDENCE.INSUFFICIENT;
  if (usableWeekCount <= 7) return CONFIDENCE.LOW;
  if (usableWeekCount <= 25) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.HIGH;
}

/**
 * When at least this share of the run's candidate order lines had to be
 * excluded for a missing date or product identity, every confidence drops one
 * level (never below Low; Insufficient stays Insufficient).
 */
const DATA_QUALITY_DOWNGRADE_RATIO = 0.1;

function downgradeConfidence(level) {
  if (level === CONFIDENCE.HIGH) return CONFIDENCE.MEDIUM;
  if (level === CONFIDENCE.MEDIUM) return CONFIDENCE.LOW;
  return level;
}

/** round-half-up(numerator / denominator) for non-negative safe integers. */
function divideRoundHalfUp(numerator, denominator) {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

const WMA_ENGINE_TYPE = "baseline_weighted_moving_average";
const WMA_MODEL_VERSION = "wma-1.0.0";
const WMA_WINDOW_WEEKS = 8;
const MIN_USABLE_WEEKS = 4;
const BASELINE_LABEL = "Baseline forecasting";

function readHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array of weekly buckets");
  return history.map((w, i) => {
    const q = w?.quantity;
    if (!Number.isSafeInteger(q) || q < 0) {
      throw new RangeError(`history[${i}].quantity must be a whole number of vials ≥ 0`);
    }
    return { weekStart: w.weekStart, quantity: q };
  });
}

/**
 * The weighted moving average engine.
 *
 *   window   = the last min(8, n) complete weeks
 *   weights  = 1, 2, …, k  (oldest → most recent)
 *   rate     = Σ wᵢ·qᵢ / Σ wᵢ                  vials per week
 *   forecast = round-half-up(rate × horizonDays / 7)   whole vials, ≥ 0
 *
 * Fewer than 4 usable weeks → predictedQuantity null ("insufficient"). All
 * arithmetic is integer; the same history always gives the same answer.
 */
function createWeightedMovingAverageEngine({ windowWeeks = WMA_WINDOW_WEEKS } = {}) {
  return Object.freeze({
    engineType: WMA_ENGINE_TYPE,
    version: WMA_MODEL_VERSION,
    label: BASELINE_LABEL,
    windowWeeks,
    predict(history, horizonDays) {
      if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
        throw new RangeError("horizonDays must be a positive whole number of days");
      }
      const weeks = readHistory(history);
      const usableWeekCount = weeks.length;
      const confidenceLevel = confidenceFromWeeks(usableWeekCount);
      if (usableWeekCount < MIN_USABLE_WEEKS) {
        return {
          predictedQuantity: null,
          usableWeekCount,
          confidenceLevel,
          weeklyRate: null,
          explanationFactors: [
            {
              key: "insufficient_history",
              label: "Insufficient history",
              value: `${usableWeekCount} usable week${usableWeekCount === 1 ? "" : "s"}; at least ${MIN_USABLE_WEEKS} are needed before a baseline forecast is made.`,
            },
          ],
        };
      }
      const recent = weeks.slice(-windowWeeks);
      let numerator = 0;
      let denominator = 0;
      recent.forEach((w, i) => {
        numerator += (i + 1) * w.quantity;
        denominator += i + 1;
      });
      const scaled = numerator * horizonDays;
      if (!Number.isSafeInteger(scaled) || !Number.isSafeInteger(2 * scaled + 7 * denominator)) {
        throw new RangeError("history is too large to forecast exactly");
      }
      const predictedQuantity = divideRoundHalfUp(scaled, denominator * 7);
      const weeklyRate = Math.round((numerator * 100) / denominator) / 100;
      return {
        predictedQuantity,
        usableWeekCount,
        confidenceLevel,
        weeklyRate,
        explanationFactors: [
          {
            key: "method",
            label: "Method",
            value: `${BASELINE_LABEL}: weighted moving average of the last ${recent.length} complete weeks (most recent week weight ${recent.length}, oldest weight 1). Not a trained machine-learning model.`,
          },
          { key: "weekly_rate", label: "Weighted weekly demand", value: `${weeklyRate} vials per week` },
          {
            key: "recent_weeks",
            label: "Weeks used",
            value: recent.map((w) => `${w.weekStart}: ${w.quantity}`).join(", "),
          },
          {
            key: "horizon",
            label: "Horizon",
            value: `${weeklyRate} × ${horizonDays} ÷ 7 = ${predictedQuantity} vials (rounded to whole vials)`,
          },
        ],
      };
    },
  });
}

/** Throws unless `engine` implements the ForecastEngine interface. */
function assertForecastEngine(engine) {
  if (!engine || typeof engine !== "object") throw new TypeError("A forecast engine is required");
  for (const key of ["engineType", "version", "label"]) {
    if (typeof engine[key] !== "string" || engine[key].trim() === "") {
      throw new TypeError(`A forecast engine must declare a non-empty ${key}`);
    }
  }
  if (typeof engine.predict !== "function") throw new TypeError("A forecast engine must implement predict()");
  return engine;
}

/**
 * THE forecast document contract (inventoryForecasts/{forecastId}). Every
 * engine's output — baseline or a future model — carries exactly these fields;
 * the Admin UI reads nothing else.
 */
const FORECAST_DOCUMENT_FIELDS = Object.freeze([
  "forecastId",
  "vaccineId",
  "vaccineNameSnapshot",
  "skuSnapshot",
  "areaKey",
  "horizonDays",
  "predictedDemandQuantity",
  "availableQuantity",
  "reservedQuantity",
  "backorderedQuantity",
  "confirmedIncomingQuantity",
  "confirmedIncomingTracked",
  "currentBackorderShortageQuantity",
  "forecastShortageQuantity",
  "totalProjectedShortageQuantity",
  "recommendedReorderQuantity",
  "reorderConfigurationComplete",
  "reorderConfigurationStatus",
  "stockoutRiskLevel",
  "riskBasis",
  "stockoutRiskReason",
  "calculation",
  "confidenceLevel",
  "sampleOrderCount",
  "usableWeekCount",
  "weeklyHistory",
  "dataQualityWarnings",
  "explanationFactors",
  "engineType",
  "engineLabel",
  "modelVersion",
  "trainingWindowStart",
  "trainingWindowEnd",
  "advisoryOnly",
  "runId",
  "generatedAt",
]);

const RISK_LEVELS = Object.freeze(["high", "medium", "low", "unknown"]);
/** Why a risk level was given (analyticsRisk.assessProduct). */
const RISK_BASES = Object.freeze([
  "current_backorder_shortage",
  "insufficient_history",
  "forecast_shortage",
  "lead_time_shortage",
  "configuration_missing",
  "below_safety_stock",
  "above_safety_stock",
]);

const isWholeOrNull = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);

/** Problems with a forecast document, [] when it honours the contract. */
function validateForecastDocument(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["not an object"];
  for (const f of FORECAST_DOCUMENT_FIELDS) if (!(f in doc)) problems.push(`missing ${f}`);
  for (const f of Object.keys(doc)) if (!FORECAST_DOCUMENT_FIELDS.includes(f)) problems.push(`unexpected ${f}`);
  for (const f of [
    "predictedDemandQuantity",
    "availableQuantity",
    "reservedQuantity",
    "backorderedQuantity",
    "confirmedIncomingQuantity",
    "currentBackorderShortageQuantity",
    "forecastShortageQuantity",
    "totalProjectedShortageQuantity",
    "recommendedReorderQuantity",
    "sampleOrderCount",
    "usableWeekCount",
  ]) {
    if (f in doc && !isWholeOrNull(doc[f])) problems.push(`${f} must be a whole number ≥ 0 or null`);
  }
  if (!RISK_LEVELS.includes(doc.stockoutRiskLevel)) problems.push("stockoutRiskLevel is not a known level");
  if (!RISK_BASES.includes(doc.riskBasis)) problems.push("riskBasis is not a known basis");
  // The known (backorder) shortage never depends on a forecast, so it is always a number.
  if ("currentBackorderShortageQuantity" in doc && !(Number.isSafeInteger(doc.currentBackorderShortageQuantity) && doc.currentBackorderShortageQuantity >= 0)) {
    problems.push("currentBackorderShortageQuantity must be a whole number ≥ 0");
  }
  // A forecast shortage needs a forecast.
  if (doc.predictedDemandQuantity === null && (doc.forecastShortageQuantity !== null || doc.totalProjectedShortageQuantity !== null)) {
    problems.push("forecast shortages must be null when there is no forecast");
  }
  if (typeof doc.stockoutRiskReason !== "string" || !doc.stockoutRiskReason) problems.push("stockoutRiskReason is required");
  if (!Object.values(CONFIDENCE).includes(doc.confidenceLevel)) problems.push("confidenceLevel is not a known level");
  if (doc.advisoryOnly !== true) problems.push("advisoryOnly must be true");
  if (doc.recommendedReorderQuantity !== null && doc.reorderConfigurationComplete !== true) {
    problems.push("a reorder recommendation requires complete reorder configuration");
  }
  return problems;
}

module.exports = {
  CONFIDENCE,
  confidenceFromWeeks,
  DATA_QUALITY_DOWNGRADE_RATIO,
  downgradeConfidence,
  divideRoundHalfUp,
  WMA_ENGINE_TYPE,
  WMA_MODEL_VERSION,
  WMA_WINDOW_WEEKS,
  MIN_USABLE_WEEKS,
  BASELINE_LABEL,
  createWeightedMovingAverageEngine,
  assertForecastEngine,
  FORECAST_DOCUMENT_FIELDS,
  RISK_LEVELS,
  RISK_BASES,
  validateForecastDocument,
};
