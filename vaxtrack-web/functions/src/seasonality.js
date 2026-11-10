"use strict";

/**
 * Busy seasons in the forecast (2026-11-10).
 *
 * Some vaccines sell more at certain times of year (flu vaccine before
 * Christmas, for example). The baseline engine only looks at recent weeks, so
 * on its own it reacts to a season late and keeps over-ordering after it ends.
 * Two sources adjust it, the better one first:
 *
 *   last_year  The same weeks one year ago, compared with the 8 weeks before
 *              them, give the seasonal swing directly from VaxTrack's own
 *              orders. Needs about 61 weeks of history, so it starts working
 *              once a vaccine has a year of orders.
 *   calendar   Until then, an Admin marks the vaccine's busy months and how much
 *              more is ordered in them (inventoryAnalyticsConfig/{vaccineId}).
 *              The recent weeks are first "un-seasoned" with the same calendar,
 *              so a forecast made during a busy month is not raised twice.
 *   none       Neither is available: the baseline stands unchanged.
 *
 * Every adjustment is a single ratio applied to the baseline forecast and is
 * stored with it (source, percent, base quantity), so the arithmetic can be
 * redone by hand. Pure: no Firestore, no clock.
 */

const SEASON_SOURCE = Object.freeze({ LAST_YEAR: "last_year", CALENDAR: "calendar", NONE: "none" });

/** A learned swing is bounded, so one odd week last year cannot dominate. */
const MIN_LEARNED_RATIO = 0.5;
const MAX_LEARNED_RATIO = 3;
const MAX_BUSY_INCREASE_PERCENT = 300;
const DAYS_PER_YEAR_BACK = 364; // 52 whole weeks, so weekdays line up

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing [iso] (the weekly series uses Monday starts). */
function weekStartOf(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, -dow);
}

const monthOf = (iso) => Number(iso.slice(5, 7));

/** The season settings in a stored config, or null when there are none to use. */
function seasonFromConfig(config) {
  if (!config || !Array.isArray(config.busyMonths) || config.busyMonths.length === 0) return null;
  const months = [...new Set(config.busyMonths)].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).sort((a, b) => a - b);
  const percent = config.busyIncreasePercent;
  if (months.length === 0 || !Number.isInteger(percent) || percent <= 0 || percent > MAX_BUSY_INCREASE_PERCENT) return null;
  return { busyMonths: months, percent };
}

/** Weighted average of the last [k] weeks, weights 1..k (oldest → newest), as the engine does. */
function weightedRate(weeks) {
  let num = 0;
  let den = 0;
  weeks.forEach((w, i) => {
    num += (i + 1) * w;
    den += i + 1;
  });
  return den === 0 ? null : num / den;
}

/**
 * The swing seen in the same weeks last year, as a ratio, or null when the
 * history does not reach back far enough (or last year had no orders to
 * compare with).
 */
function lastYearRatio({ history, asOfDate, horizonDays, windowWeeks }) {
  const byWeek = new Map(history.map((w) => [w.weekStart, w.quantity]));
  const start = weekStartOf(addDays(asOfDate, -DAYS_PER_YEAR_BACK));
  const horizonWeeks = Math.max(1, Math.ceil(horizonDays / 7));
  const seasonWeeks = [];
  for (let i = 0; i < horizonWeeks; i += 1) {
    const q = byWeek.get(addDays(start, 7 * i));
    if (q === undefined) return null;
    seasonWeeks.push(q);
  }
  const before = [];
  for (let i = windowWeeks; i >= 1; i -= 1) {
    const q = byWeek.get(addDays(start, -7 * i));
    if (q === undefined) return null;
    before.push(q);
  }
  const baseRate = weightedRate(before);
  if (!baseRate || baseRate <= 0) return null;
  const seasonRate = seasonWeeks.reduce((s, q) => s + q, 0) / seasonWeeks.length;
  return Math.min(MAX_LEARNED_RATIO, Math.max(MIN_LEARNED_RATIO, seasonRate / baseRate));
}

/** Busy-calendar ratio: the horizon's average multiplier over the recent weeks' (weighted). */
function calendarRatio({ season, history, asOfDate, horizonDays, windowWeeks }) {
  const busy = new Set(season.busyMonths);
  const m = (iso) => (busy.has(monthOf(iso)) ? (100 + season.percent) / 100 : 1);
  let horizon = 0;
  for (let d = 0; d < horizonDays; d += 1) horizon += m(addDays(asOfDate, d));
  horizon /= horizonDays;
  const recent = history.slice(-Math.min(windowWeeks, history.length));
  // Mid-week (Thursday) decides which month a week belongs to.
  const past = weightedRate(recent.map((w) => m(addDays(w.weekStart, 3))));
  return past ? horizon / past : 1;
}

/**
 * The engine's forecast for [horizonDays], adjusted for the season.
 * Returns { prediction, adjustment } where prediction has the engine's shape
 * (predictedQuantity may differ) and adjustment = { source, percent,
 * busyMonths, baseQuantity }.
 */
function seasonalPrediction({ engine, history, horizonDays, asOfDate, config }) {
  const base = engine.predict(history, horizonDays);
  const season = seasonFromConfig(config);
  const none = { source: SEASON_SOURCE.NONE, percent: 0, busyMonths: season?.busyMonths ?? [], baseQuantity: base.predictedQuantity };
  if (base.predictedQuantity === null || typeof asOfDate !== "string") return { prediction: base, adjustment: none };

  const windowWeeks = Number.isInteger(engine.windowWeeks) ? engine.windowWeeks : 8;
  let source = SEASON_SOURCE.NONE;
  let ratio = 1;
  const learned = lastYearRatio({ history, asOfDate, horizonDays, windowWeeks });
  if (learned !== null) {
    source = SEASON_SOURCE.LAST_YEAR;
    ratio = learned;
  } else if (season) {
    source = SEASON_SOURCE.CALENDAR;
    ratio = calendarRatio({ season, history, asOfDate, horizonDays, windowWeeks });
  }
  if (source === SEASON_SOURCE.NONE || Math.abs(ratio - 1) < 1e-9) {
    return { prediction: base, adjustment: { ...none, source } };
  }
  const predictedQuantity = Math.max(0, Math.round(base.predictedQuantity * ratio));
  const percent = Math.round((ratio - 1) * 100);
  const why =
    source === SEASON_SOURCE.LAST_YEAR
      ? `the same weeks last year were ${percent >= 0 ? `${percent}% busier` : `${-percent}% quieter`} than the weeks before them`
      : `busy months ${season.busyMonths.join(", ")} add ${season.percent}% (recent weeks adjusted the same way)`;
  return {
    prediction: {
      ...base,
      predictedQuantity,
      explanationFactors: [
        ...base.explanationFactors,
        { key: "season", label: "Season", value: `${base.predictedQuantity} vials × ${ratio.toFixed(2)} = ${predictedQuantity}: ${why}.` },
      ],
    },
    adjustment: { source, percent, busyMonths: season?.busyMonths ?? [], baseQuantity: base.predictedQuantity },
  };
}

module.exports = {
  SEASON_SOURCE,
  MAX_BUSY_INCREASE_PERCENT,
  MIN_LEARNED_RATIO,
  MAX_LEARNED_RATIO,
  seasonFromConfig,
  lastYearRatio,
  calendarRatio,
  seasonalPrediction,
  weekStartOf,
};
