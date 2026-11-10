"use strict";

// Busy seasons in the forecast (2026-11-10): the same weeks last year when the
// history reaches back that far, else the Admin's busy-month calendar.

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../src/inventoryAnalytics");
const E = require("../src/forecastEngine");
const S = require("../src/seasonality");

const engine = E.createWeightedMovingAverageEngine();
/** Weekly buckets from a Monday, one per quantity. */
const series = (from, qs) => qs.map((quantity, i) => ({ weekStart: A.addDays(from, 7 * i), quantity }));
const season = (busyMonths, busyIncreasePercent) => ({ busyMonths, busyIncreasePercent });
const predict = (history, asOfDate, config, horizonDays = 30) =>
  S.seasonalPrediction({ engine, history, horizonDays, asOfDate, config });

test("no settings and no year of history: the baseline stands", () => {
  const r = predict(series("2026-10-05", Array(8).fill(70)), "2026-12-01", null);
  assert.equal(r.prediction.predictedQuantity, 300);
  assert.deepEqual(r.adjustment, { source: "none", percent: 0, busyMonths: [], baseQuantity: 300 });
});

test("calendar: a busy month ahead raises the forecast by the set increase", () => {
  // 8 quiet weeks in Oct–Nov; the next 30 days are all December, busy at +50%.
  const r = predict(series("2026-10-05", Array(8).fill(70)), "2026-12-01", season([12], 50));
  assert.equal(r.adjustment.source, "calendar");
  assert.equal(r.adjustment.percent, 50);
  assert.equal(r.prediction.predictedQuantity, 450);
  assert.ok(r.prediction.explanationFactors.some((f) => f.key === "season"));
});

test("calendar: recent busy weeks are not counted twice once the season ends", () => {
  // 8 weeks inside December (+50%), forecasting quiet February: 300 → 200.
  const r = predict(series("2026-11-30", Array(8).fill(70)), "2027-02-01", season([12, 1], 50), 28);
  assert.equal(r.adjustment.source, "calendar");
  assert.ok(r.prediction.predictedQuantity < r.adjustment.baseQuantity, "lowered after the season");
});

test("calendar: a forecast inside a busy month, from busy recent weeks, stays as it is", () => {
  const r = predict(series("2026-11-30", Array(4).fill(70)), "2026-12-28", season([12, 1], 50), 7);
  assert.equal(r.prediction.predictedQuantity, r.adjustment.baseQuantity);
});

test("last year: the same weeks a year ago set the swing, ahead of the calendar", () => {
  // 61+ weeks of 70 a week, except the 5 weeks from 2026-12-07 at 140 (twice as busy).
  const from = "2026-10-12";
  const history = series(from, Array(60).fill(70)).map((w) =>
    w.weekStart >= "2026-12-07" && w.weekStart < "2027-01-11" ? { ...w, quantity: 140 } : w
  );
  const r = predict(history, "2027-12-06", season([12], 10));
  assert.equal(r.adjustment.source, "last_year");
  assert.equal(r.adjustment.percent, 100);
  assert.equal(r.prediction.predictedQuantity, 600);
});

test("last year: an extreme week is capped at three times", () => {
  const history = series("2026-10-12", Array(60).fill(10)).map((w) =>
    w.weekStart >= "2026-12-07" && w.weekStart < "2027-01-11" ? { ...w, quantity: 1000 } : w
  );
  const r = predict(history, "2027-12-06", null);
  assert.equal(r.adjustment.source, "last_year");
  assert.equal(r.adjustment.percent, (S.MAX_LEARNED_RATIO - 1) * 100);
});

test("last year needs the whole comparison in the history, else the calendar is used", () => {
  const short = series("2027-06-07", Array(26).fill(70)); // half a year
  assert.equal(S.lastYearRatio({ history: short, asOfDate: "2027-12-06", horizonDays: 30, windowWeeks: 8 }), null);
  assert.equal(predict(short, "2027-12-06", season([12], 50)).adjustment.source, "calendar");
});

test("too little history: no forecast, nothing to adjust", () => {
  const r = predict(series("2026-11-02", [5, 5]), "2026-12-01", season([12], 50));
  assert.equal(r.prediction.predictedQuantity, null);
  assert.equal(r.adjustment.source, "none");
});

test("the history window reaches back far enough to compare with last year", () => {
  assert.ok(A.MAX_TRAINING_WEEKS >= 52 + 8 + 1);
});
