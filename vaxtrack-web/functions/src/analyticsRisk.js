"use strict";

/**
 * Stockout risk and the suggested order — deterministic and explainable.
 *
 * Every figure that decides a risk level is stored beside it (`calculation`),
 * and the reason string is built from exactly those figures, so a reviewer can
 * redo the arithmetic. Nothing here is acted on automatically: a suggestion is
 * advisory and needs a human decision.
 *
 * SEASON SETTINGS (inventoryAnalyticsConfig/{vaccineId}, Admin-managed; 2026-11-10)
 *   busyMonths            whole months 1–12, no repeats (may be empty)
 *   busyIncreasePercent   0–300: how much more is ordered in a busy month
 *   updatedAt, updatedByUid   server time + the authenticated Admin (rules)
 * The supplier lead time and safety stock settings were removed at the user's
 * request: the suggested order now simply covers the forecast period. See
 * seasonality.js for how the season adjusts the forecast.
 *
 * FORMULAS (all whole vials; incoming = confirmed incoming, which the data
 * model does not track yet, so 0; forecast = null with insufficient history)
 *   forecast           = baseline × season ratio (seasonality.js)
 *   currentBackorderShortage = max(0, backordered − available − incoming)
 *                              KNOWN, from placed orders; needs no forecast
 *   forecastShortage   = max(0, forecast − max(0, available + incoming − backordered))
 *   totalProjectedShortage = currentBackorderShortage + forecastShortage
 *   remainingAfterHorizon = available + incoming − backordered − forecast
 *   oneWeekDemand      = round(forecast × 7 / horizonDays)
 *   recommendedReorder = totalProjectedShortage   (covers the period; null without a forecast)
 *
 * RISK (first match wins; riskBasis names which)
 *   high     current_backorder_shortage — even with no forecast
 *   unknown  insufficient_history
 *   high     forecast_shortage
 *   medium   runs_low — less than one more week of expected orders left after the period
 *   low      covered
 */

const { SEASON_SOURCE, MAX_BUSY_INCREASE_PERCENT, seasonalPrediction } = require("./seasonality");

const CONFIG_FIELDS = Object.freeze(["vaccineId", "busyMonths", "busyIncreasePercent", "updatedAt", "updatedByUid"]);

const CONFIG_STATUS = Object.freeze({
  COMPLETE: "complete",
  MISSING: "missing",
  INVALID: "invalid",
});

const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Validate a stored season document (the same rules firestore.rules enforces
 * on Admin writes). Returns { ok, errors }.
 */
function validateAnalyticsConfig(config, vaccineId) {
  const errors = [];
  if (!config || typeof config !== "object") return { ok: false, errors: ["missing"] };
  for (const key of Object.keys(config)) if (!CONFIG_FIELDS.includes(key)) errors.push(`unexpected field ${key}`);
  if (vaccineId !== undefined && config.vaccineId !== vaccineId) errors.push("vaccineId must match the document id");
  const months = config.busyMonths;
  if (!Array.isArray(months) || months.length > 12 || !months.every((m) => intIn(m, 1, 12)) || new Set(months).size !== months.length) {
    errors.push("busyMonths must be distinct whole months 1–12");
  }
  if (!intIn(config.busyIncreasePercent, 0, MAX_BUSY_INCREASE_PERCENT)) {
    errors.push(`busyIncreasePercent must be a whole number 0–${MAX_BUSY_INCREASE_PERCENT}`);
  }
  if (typeof config.updatedByUid !== "string" || config.updatedByUid === "") errors.push("updatedByUid is required");
  if (config.updatedAt == null) errors.push("updatedAt is required");
  return { ok: errors.length === 0, errors };
}

/** complete | missing | invalid, for one product's stored season settings. */
function configurationStatus(config, vaccineId) {
  if (!config) return CONFIG_STATUS.MISSING;
  return validateAnalyticsConfig(config, vaccineId).ok ? CONFIG_STATUS.COMPLETE : CONFIG_STATUS.INVALID;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Risk, shortage and the suggested order for ONE product and horizon.
 *
 * [engine]   a ForecastEngine; [history] the product's weekly series.
 * [stock]    { availableQuantity, reservedQuantity }
 * [backorderedQuantity]  active backorders for the product
 * [config]   stored inventoryAnalyticsConfig document or null (season settings)
 * [asOfDate] the run's date (YYYY-MM-DD, Manila); the forecast period starts here
 *
 * Returns the risk (with `riskBasis`), the shortage figures, the suggested
 * order, the season adjustment and `allocationMayBePending` (stock that could
 * serve the reported backlog exists, so it may simply not be allocated yet).
 */
function assessProduct({ engine, history, horizonDays, stock, backorderedQuantity, config, vaccineId, asOfDate }) {
  const configStatus = configurationStatus(config, vaccineId);
  const { prediction, adjustment } = seasonalPrediction({
    engine,
    history,
    horizonDays,
    asOfDate,
    config: configStatus === CONFIG_STATUS.COMPLETE ? config : null,
  });
  const available = stock.availableQuantity;
  const incoming = 0; // confirmed incoming is not tracked (inventoryAnalytics.CONFIRMED_INCOMING_TRACKED)
  const backordered = backorderedQuantity;
  const forecast = prediction.predictedQuantity; // null = insufficient history

  // KNOWN shortage, from orders already placed — independent of any forecast.
  const currentBackorderShortage = Math.max(0, backordered - available - incoming);
  // What is left once the existing backlog is served; forecast demand draws on it.
  const leftAfterBacklog = Math.max(0, available + incoming - backordered);
  const forecastShortage = forecast === null ? null : Math.max(0, forecast - leftAfterBacklog);
  const totalShortage = forecast === null ? null : currentBackorderShortage + forecastShortage;
  const allocationMayBePending = backordered > 0 && currentBackorderShortage === 0;
  const remaining = forecast === null ? null : available + incoming - backordered - forecast;
  const oneWeek = forecast === null ? null : Math.round((forecast * 7) / horizonDays);

  const calculation = {
    horizonDays,
    baseDemandQuantity: adjustment.baseQuantity,
    seasonSource: adjustment.source,
    seasonPercent: adjustment.percent,
    predictedDemandQuantity: forecast,
    availableQuantity: available,
    backorderedQuantity: backordered,
    confirmedIncomingUsed: incoming,
    currentBackorderShortageQuantity: currentBackorderShortage,
    forecastShortageQuantity: forecastShortage,
    totalProjectedShortageQuantity: totalShortage,
    remainingAfterHorizonQuantity: remaining,
    oneWeekDemandQuantity: oneWeek,
    recommendedReorderQuantity: totalShortage,
  };

  const result = (level, basis, reason) => ({
    prediction,
    configStatus,
    seasonAdjustment: { source: adjustment.source, percent: adjustment.percent, busyMonths: adjustment.busyMonths },
    allocationMayBePending,
    stockoutRiskLevel: level,
    riskBasis: basis,
    stockoutRiskReason: reason,
    currentBackorderShortageQuantity: currentBackorderShortage,
    forecastShortageQuantity: forecastShortage,
    totalProjectedShortageQuantity: totalShortage,
    recommendedReorderQuantity: totalShortage,
    calculation,
  });

  const supplyText = `available ${available} + confirmed incoming ${incoming}`;
  const historyText = `${plural(prediction.usableWeekCount, "usable week")}; at least 4 needed`;
  const pendingText = allocationMayBePending
    ? ` Available stock (${available}) could cover all ${backordered} backordered vials — allocation may be pending.`
    : "";
  const seasonText =
    adjustment.source === SEASON_SOURCE.NONE
      ? ""
      : ` Season (${adjustment.source === SEASON_SOURCE.LAST_YEAR ? "same weeks last year" : "busy-month calendar"}): ${adjustment.percent >= 0 ? "+" : ""}${adjustment.percent}% on a baseline of ${adjustment.baseQuantity}.`;

  // 1. A shortage that already exists in placed orders is High on its own.
  if (currentBackorderShortage > 0) {
    const forecastPart =
      forecast === null
        ? ` No forecast is made: insufficient history (${historyText}).`
        : forecastShortage > 0
          ? ` The ${horizonDays}-day forecast adds a further ${forecastShortage} vials (total projected shortage ${totalShortage}).`
          : "";
    return result(
      "high",
      "current_backorder_shortage",
      `Existing backorder shortage of ${currentBackorderShortage} vials: current backorders exceed stock available to satisfy them (backordered ${backordered} vs ${supplyText}). This comes from orders already placed, not from a forecast.${forecastPart}${seasonText}`
    );
  }

  if (forecast === null) {
    return result("unknown", "insufficient_history", `Insufficient history: ${historyText}. No forecast or suggested order is made.${pendingText}`);
  }

  // 2. Forecast demand exceeding what is left after the backlog.
  if (forecastShortage > 0) {
    return result(
      "high",
      "forecast_shortage",
      `Forecast shortage of ${forecastShortage} vials within ${horizonDays} days: forecast ${forecast} + backordered ${backordered} exceeds ${supplyText}.${seasonText}`
    );
  }
  // 3. Covered for the period, but less than one more week of orders left after it.
  if (remaining < oneWeek) {
    return result(
      "medium",
      "runs_low",
      `Stock covers the ${horizonDays} days, leaving ${remaining} vials — less than one more week of expected orders (${oneWeek}).${seasonText}${pendingText}`
    );
  }
  return result(
    "low",
    "covered",
    `Stock covers the ${horizonDays} days and leaves ${remaining} vials, at least one more week of expected orders (${oneWeek}).${seasonText}${pendingText}`
  );
}

module.exports = {
  CONFIG_FIELDS,
  CONFIG_STATUS,
  validateAnalyticsConfig,
  configurationStatus,
  assessProduct,
};
