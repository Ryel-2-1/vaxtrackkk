"use strict";

/**
 * Stockout risk and reorder recommendations — deterministic and explainable.
 *
 * Every figure that decides a risk level is stored beside it (`calculation`),
 * and the reason string is built from exactly those figures, so a reviewer can
 * redo the arithmetic. Nothing here is acted on automatically: a
 * recommendation is advisory and needs a human decision.
 *
 * REORDER CONFIGURATION (inventoryAnalyticsConfig/{vaccineId}, Admin-managed)
 *   leadTimeDays         1–365, whole days
 *   safetyStockDays  OR  safetyStockQuantity   exactly one, whole, ≥ 0
 *   enabled              boolean
 *   updatedAt, updatedByUid   server time + the authenticated Admin (rules)
 * No lead time or safety stock is ever invented. Without an enabled, valid
 * configuration there is no reorder figure: "Reorder configuration required".
 *
 * FORMULAS (all whole vials; incoming = confirmed incoming, which the data
 * model does not track yet, so 0; forecast = null with insufficient history)
 *   currentBackorderShortage = max(0, backordered − available − incoming)
 *                              KNOWN, from placed orders; needs no forecast
 *   forecastShortage   = max(0, forecast − max(0, available + incoming − backordered))
 *                        null without a forecast
 *   totalProjectedShortage = currentBackorderShortage + forecastShortage
 *                          = max(0, forecast + backordered − available − incoming)
 *   leadTimeShortage   = max(0, forecast(leadTime) + backordered − available − incoming)
 *   remainingAfterHorizon = available + incoming − backordered − forecast(horizon)
 *   safetyStock        = safetyStockQuantity, or forecast(safetyStockDays)
 *   recommendedReorder = max(0, forecast(leadTime) + safetyStock + backordered
 *                               − available − incoming)   needs config AND a forecast
 *
 * RISK (first match wins; riskBasis names which)
 *   high     current_backorder_shortage — even with no forecast; confidence is
 *            left exactly as the engine reported it
 *   unknown  insufficient_history (a fully coverable backlog is flagged as
 *            "allocation may be pending", never as a shortage)
 *   high     forecast_shortage, or lead_time_shortage
 *   unknown  configuration_missing — safety stock cannot be judged
 *   medium   below_safety_stock
 *   low      above_safety_stock
 */

const MAX_LEAD_TIME_DAYS = 365;
const MAX_SAFETY_STOCK_DAYS = 365;
const MAX_SAFETY_STOCK_QUANTITY = 100000000; // the Add Stock ceiling (policy.MAX_STOCK_QUANTITY)

const CONFIG_FIELDS = Object.freeze([
  "vaccineId",
  "leadTimeDays",
  "safetyStockDays",
  "safetyStockQuantity",
  "enabled",
  "updatedAt",
  "updatedByUid",
]);

const CONFIG_STATUS = Object.freeze({
  COMPLETE: "complete",
  MISSING: "missing",
  DISABLED: "disabled",
  INVALID: "invalid",
});

const REORDER_CONFIGURATION_REQUIRED = "Reorder configuration required";

const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Validate a stored configuration document (the same rules firestore.rules
 * enforces on Admin writes). Returns { ok, errors }.
 */
function validateAnalyticsConfig(config, vaccineId) {
  const errors = [];
  if (!config || typeof config !== "object") return { ok: false, errors: ["missing"] };
  for (const key of Object.keys(config)) if (!CONFIG_FIELDS.includes(key)) errors.push(`unexpected field ${key}`);
  if (vaccineId !== undefined && config.vaccineId !== vaccineId) errors.push("vaccineId must match the document id");
  if (!intIn(config.leadTimeDays, 1, MAX_LEAD_TIME_DAYS)) errors.push(`leadTimeDays must be a whole number 1–${MAX_LEAD_TIME_DAYS}`);
  const days = config.safetyStockDays ?? null;
  const qty = config.safetyStockQuantity ?? null;
  if ((days === null) === (qty === null)) errors.push("exactly one of safetyStockDays or safetyStockQuantity is required");
  if (days !== null && !intIn(days, 0, MAX_SAFETY_STOCK_DAYS)) errors.push(`safetyStockDays must be a whole number 0–${MAX_SAFETY_STOCK_DAYS}`);
  if (qty !== null && !intIn(qty, 0, MAX_SAFETY_STOCK_QUANTITY)) errors.push(`safetyStockQuantity must be a whole number 0–${MAX_SAFETY_STOCK_QUANTITY}`);
  if (typeof config.enabled !== "boolean") errors.push("enabled must be true or false");
  if (typeof config.updatedByUid !== "string" || config.updatedByUid === "") errors.push("updatedByUid is required");
  if (config.updatedAt == null) errors.push("updatedAt is required");
  return { ok: errors.length === 0, errors };
}

/** complete | missing | disabled | invalid, for one product's stored config. */
function configurationStatus(config, vaccineId) {
  if (!config) return CONFIG_STATUS.MISSING;
  if (!validateAnalyticsConfig(config, vaccineId).ok) return CONFIG_STATUS.INVALID;
  return config.enabled ? CONFIG_STATUS.COMPLETE : CONFIG_STATUS.DISABLED;
}

const CONFIG_STATUS_TEXT = Object.freeze({
  [CONFIG_STATUS.MISSING]: `${REORDER_CONFIGURATION_REQUIRED}: no lead time or safety stock has been set for this vaccine.`,
  [CONFIG_STATUS.DISABLED]: `${REORDER_CONFIGURATION_REQUIRED}: reorder analysis is disabled for this vaccine.`,
  [CONFIG_STATUS.INVALID]: `${REORDER_CONFIGURATION_REQUIRED}: the stored configuration is not valid.`,
});

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Risk, shortage and reorder for ONE product and horizon.
 *
 * [engine]   a ForecastEngine; [history] the product's weekly series.
 * [stock]    { availableQuantity, reservedQuantity }
 * [backorderedQuantity]  active backorders for the product
 * [config]   stored inventoryAnalyticsConfig document or null
 *
 * Returns the risk (with `riskBasis`), the three shortage figures, the reorder
 * figure and `allocationMayBePending` (stock that could serve the reported
 * backlog exists, so the backlog may simply not have been allocated yet).
 */
function assessProduct({ engine, history, horizonDays, stock, backorderedQuantity, config, vaccineId }) {
  const prediction = engine.predict(history, horizonDays);
  const available = stock.availableQuantity;
  const incoming = 0; // confirmed incoming is not tracked (inventoryAnalytics.CONFIRMED_INCOMING_TRACKED)
  const backordered = backorderedQuantity;
  const configStatus = configurationStatus(config, vaccineId);
  const configComplete = configStatus === CONFIG_STATUS.COMPLETE;
  const forecast = prediction.predictedQuantity; // null = insufficient history

  // KNOWN shortage, from orders already placed — independent of any forecast.
  const currentBackorderShortage = Math.max(0, backordered - available - incoming);
  // What is left once the existing backlog is served; forecast demand draws on it.
  const leftAfterBacklog = Math.max(0, available + incoming - backordered);
  const forecastShortage = forecast === null ? null : Math.max(0, forecast - leftAfterBacklog);
  const totalShortage = forecast === null ? null : currentBackorderShortage + forecastShortage;
  const allocationMayBePending = backordered > 0 && currentBackorderShortage === 0;

  const calculation = {
    horizonDays,
    predictedDemandQuantity: forecast,
    availableQuantity: available,
    backorderedQuantity: backordered,
    confirmedIncomingUsed: incoming,
    currentBackorderShortageQuantity: currentBackorderShortage,
    forecastShortageQuantity: forecastShortage,
    totalProjectedShortageQuantity: totalShortage,
    remainingAfterHorizonQuantity: forecast === null ? null : available + incoming - backordered - forecast,
    leadTimeDays: configComplete ? config.leadTimeDays : null,
    leadTimeDemandQuantity: null,
    leadTimeShortageQuantity: null,
    safetyStockQuantity: null,
    safetyStockSource: configComplete
      ? config.safetyStockQuantity !== null && config.safetyStockQuantity !== undefined
        ? "quantity"
        : `days:${config.safetyStockDays}`
      : null,
    recommendedReorderQuantity: null,
  };

  // Lead-time demand, safety stock and the reorder figure need BOTH a complete
  // configuration and a forecast; otherwise they stay null (never invented).
  let reorder = null;
  if (configComplete && forecast !== null) {
    const lead = engine.predict(history, config.leadTimeDays).predictedQuantity;
    const safety =
      config.safetyStockQuantity !== null && config.safetyStockQuantity !== undefined
        ? config.safetyStockQuantity
        : config.safetyStockDays === 0
          ? 0
          : engine.predict(history, config.safetyStockDays).predictedQuantity;
    calculation.leadTimeDemandQuantity = lead;
    calculation.leadTimeShortageQuantity = Math.max(0, lead + backordered - available - incoming);
    calculation.safetyStockQuantity = safety;
    reorder = Math.max(0, lead + safety + backordered - available - incoming);
  }
  calculation.recommendedReorderQuantity = reorder;

  const result = (level, basis, reason) => ({
    prediction,
    configStatus,
    configComplete,
    allocationMayBePending,
    stockoutRiskLevel: level,
    riskBasis: basis,
    stockoutRiskReason: reason,
    currentBackorderShortageQuantity: currentBackorderShortage,
    forecastShortageQuantity: forecastShortage,
    totalProjectedShortageQuantity: totalShortage,
    recommendedReorderQuantity: reorder,
    calculation,
  });

  const supplyText = `available ${available} + confirmed incoming ${incoming}`;
  const historyText = `${plural(prediction.usableWeekCount, "usable week")}; at least 4 needed`;
  const pendingText = allocationMayBePending
    ? ` Available stock (${available}) could cover all ${backordered} backordered vials — allocation may be pending.`
    : "";

  // 1. A shortage that already exists in placed orders is High on its own —
  //    with or without a forecast. It is NOT a forecast judgement.
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
      `Existing backorder shortage of ${currentBackorderShortage} vials: current backorders exceed stock available to satisfy them (backordered ${backordered} vs ${supplyText}). This comes from orders already placed, not from a forecast.${forecastPart}`
    );
  }

  if (forecast === null) {
    return result(
      "unknown",
      "insufficient_history",
      `Insufficient history: ${historyText}. No forecast or reorder figure is made.${pendingText}`
    );
  }

  // 2. Forecast demand exceeding what is left after the backlog.
  if (forecastShortage > 0) {
    return result(
      "high",
      "forecast_shortage",
      `Forecast shortage of ${forecastShortage} vials within ${horizonDays} days: forecast ${forecast} + backordered ${backordered} exceeds ${supplyText}. This is a baseline forecast, not a confirmed order.`
    );
  }
  if (configComplete && calculation.leadTimeShortageQuantity > 0) {
    return result(
      "high",
      "lead_time_shortage",
      `Forecast shortage of ${calculation.leadTimeShortageQuantity} vials within the ${config.leadTimeDays}-day lead time: forecast ${calculation.leadTimeDemandQuantity} + backordered ${backordered} exceeds ${supplyText}.`
    );
  }
  if (!configComplete) {
    return result(
      "unknown",
      "configuration_missing",
      `No shortage projected within ${horizonDays} days (${calculation.remainingAfterHorizonQuantity} vials remaining), but safety stock cannot be judged. ${CONFIG_STATUS_TEXT[configStatus]}${pendingText}`
    );
  }
  if (calculation.remainingAfterHorizonQuantity < calculation.safetyStockQuantity) {
    return result(
      "medium",
      "below_safety_stock",
      `Remaining stock after ${horizonDays} days (${calculation.remainingAfterHorizonQuantity} vials) is below the safety level of ${calculation.safetyStockQuantity} vials.${pendingText}`
    );
  }
  return result(
    "low",
    "above_safety_stock",
    `Remaining stock after ${horizonDays} days (${calculation.remainingAfterHorizonQuantity} vials) stays at or above the safety level of ${calculation.safetyStockQuantity} vials.${pendingText}`
  );
}

module.exports = {
  MAX_LEAD_TIME_DAYS,
  MAX_SAFETY_STOCK_DAYS,
  MAX_SAFETY_STOCK_QUANTITY,
  CONFIG_FIELDS,
  CONFIG_STATUS,
  CONFIG_STATUS_TEXT,
  REORDER_CONFIGURATION_REQUIRED,
  validateAnalyticsConfig,
  configurationStatus,
  assessProduct,
};
