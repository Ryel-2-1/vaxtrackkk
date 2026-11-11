import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORECAST_STATUS_HELP, forecastAdvice, forecastViewCounts, plainDataNote, plainFigures, plainForecastStory, plainSeasonLine, seasonSummary, shortDay } from "../src/services/inventoryAnalytics.js";

const row = (over = {}) => ({ risk: "unknown", reorderQuantity: null, insufficient: false, hasCurrentShortage: false, ...over });

test("a high-risk vaccine says how much to order", () => {
  const a = forecastAdvice(row({ risk: "high", reorderQuantity: 3 }));
  assert.deepEqual([a.view, a.status, a.action, a.button], ["attention", "Order now", "Order 3 vials", "See why"]);
  assert.equal(forecastAdvice(row({ risk: "high", reorderQuantity: 1 })).action, "Order 1 vial");
});

test("no quantity is invented: high risk without a figure asks for a review", () => {
  const a = forecastAdvice(row({ risk: "high", hasCurrentShortage: true }));
  assert.deepEqual([a.action, a.button], ["Review this vaccine", "See why"]);
  assert.match(a.why, /already placed/);
});

test("the other states each give one plain instruction", () => {
  assert.deepEqual(
    [row({ risk: "medium", reorderQuantity: 0 }), row({ risk: "low" }), row({ insufficient: true }), row()]
      .map((r) => { const a = forecastAdvice(r); return [a.view, a.status, a.action]; }),
    [
      ["attention", "Running low", "Plan an order soon"],
      ["enough", "Enough stock", "No order needed"],
      ["history", "Not enough history", "Nothing to do yet"],
      ["history", "Waiting for update", "Nothing to do yet"],
    ]
  );
});

test("the view counts add up to every vaccine", () => {
  const counts = forecastViewCounts([row({ risk: "high" }), row({ risk: "medium" }), row({ risk: "low" }), row(), row({ insufficient: true })]);
  assert.deepEqual(counts, { attention: 2, enough: 1, history: 2, all: 5 });
});

test("shortDay reads in Manila time and leaves anything else alone", () => {
  assert.equal(shortDay("2026-11-01"), "Nov 1");
  assert.equal(shortDay("not a date"), "not a date");
});

test("the help explains every status the list can show, and nothing else", () => {
  const shown = new Set([
    forecastAdvice(row({ risk: "high" })).status,
    forecastAdvice(row({ risk: "medium" })).status,
    forecastAdvice(row({ risk: "low" })).status,
    forecastAdvice(row({ insufficient: true })).status,
  ]);
  assert.deepEqual(new Set(FORECAST_STATUS_HELP.map((h) => h.status)), shown);
  assert.equal(forecastAdvice(row()).status, "Waiting for update", "only an older forecast shows this, for one update");
  for (const h of FORECAST_STATUS_HELP) assert.ok(h.meaning.length < 160, `${h.status}: one short sentence or two`);
});

test("a busy season reads as one plain line", () => {
  assert.equal(seasonSummary(null), null);
  assert.equal(seasonSummary({ busyMonths: [], busyIncreasePercent: 0 }), null);
  assert.equal(seasonSummary({ busyMonths: [12], busyIncreasePercent: 50 }), "Busy in Dec · about 50% more");
  assert.equal(seasonSummary({ busyMonths: [10, 11, 12], busyIncreasePercent: 20 }), "Busy in Oct, Nov and Dec · about 20% more");
  assert.equal(seasonSummary({ leadTimeDays: 14, safetyStockQuantity: 20 }), null, "an old reorder setting is not a season");
});

test("the season is explained in a sentence, and only when it changed the estimate", () => {
  assert.equal(plainSeasonLine({}), null, "older forecasts have no season");
  assert.equal(plainSeasonLine({ seasonAdjustment: { source: "none", percent: 0, busyMonths: [] } }), null);
  assert.equal(
    plainSeasonLine({ seasonAdjustment: { source: "calendar", percent: 50, busyMonths: [12] } }),
    "Dec is a busy month for this vaccine, so about 50% more is expected than usual."
  );
  assert.match(plainSeasonLine({ seasonAdjustment: { source: "calendar", percent: -33, busyMonths: [12, 1] } }), /are ending, so about 33% less/);
  assert.match(plainSeasonLine({ seasonAdjustment: { source: "last_year", percent: 100, busyMonths: [] } }), /Last year these same weeks were busier/);
});

test("the details panel leads with the answer; settings and workings wait to be opened", () => {
  const page = readFileSync(new URL("../src/pages/admin/AiInventoryAnalytics.jsx", import.meta.url), "utf8");
  assert.match(page, /<details className="aia-workings aia-settings">/, "the busy season waits to be opened");
  assert.doesNotMatch(page, /Reorder settings|leadTimeDays|safetyStock/, "the reorder settings are gone");
  assert.match(page, /<summary>What do these mean\?<\/summary>/);
  assert.doesNotMatch(page, /<dt>Reserved<\/dt>/, "reserved stock lives in the workings, not the headline");
  assert.match(page, /\{row\.hasBackorders && \(/);
});

const JARGON = /horizon|backorder|baseline|weighted|moving average|lead time|safety stock|confirmed incoming|insufficient|configuration|allocation|projected|engine|model version|training/i;

const forecastDoc = {
  horizonDays: 30,
  usableWeekCount: 6,
  recommendedReorderQuantity: 0,
  seasonAdjustment: { source: "none", percent: 0, busyMonths: [] },
  explanationFactors: [
    { key: "weekly_rate", label: "Weighted weekly demand", value: "4.48 vials per week" },
    { key: "recent_weeks", label: "Weeks used", value: "2026-09-21: 0, 2026-09-28: 1, 2026-10-05: 2, 2026-10-12: 10, 2026-10-19: 2, 2026-10-26: 6" },
  ],
  calculation: {
    predictedDemandQuantity: 19, availableQuantity: 788, backorderedQuantity: 0, currentBackorderShortageQuantity: 0,
    forecastShortageQuantity: 0, totalProjectedShortageQuantity: 0, remainingAfterHorizonQuantity: 769,
    oneWeekDemandQuantity: 5, recommendedReorderQuantity: 0,
  },
};

test("the workings are told in everyday words, from the stored numbers only", () => {
  const story = plainForecastStory(forecastDoc);
  assert.deepEqual(story, [
    "In the last 6 weeks, clinics ordered about 4.5 vials a week (recent weeks count more). That comes to about 19 vials in the next 30 days.",
    "You have 788 vials free to use.",
    "That leaves about 769 vials after 30 days.",
    "No order is needed for the next 30 days.",
  ]);
  for (const line of story) assert.doesNotMatch(line, JARGON, line);
  for (const f of plainFigures(forecastDoc)) assert.doesNotMatch(f.label, JARGON, f.label);
  assert.equal(plainFigures(forecastDoc).find((f) => f.label === "Suggested order").value, "0");
  const busy = {
    ...forecastDoc, recommendedReorderQuantity: 12,
    seasonAdjustment: { source: "calendar", percent: 50, busyMonths: [12] },
    calculation: { ...forecastDoc.calculation, baseDemandQuantity: 13, recommendedReorderQuantity: 12 },
  };
  const busyStory = plainForecastStory(busy);
  assert.ok(busyStory.includes("Dec is a busy month for this vaccine, so about 50% more is expected than usual."));
  assert.equal(busyStory.at(-1), "To cover the next 30 days, order 12 vials.");
  for (const line of busyStory) assert.doesNotMatch(line, JARGON, line);
  assert.match(plainForecastStory({ ...forecastDoc, usableWeekCount: 2, calculation: {} })[0], /only 2 weeks of orders/);
});

test("data notes are reworded by code, and unknown ones keep the server's sentence", () => {
  assert.equal(plainDataNote({ code: "cancelled_excluded", count: 12 }), "Cancelled orders are not counted (12).");
  assert.doesNotMatch(plainDataNote({ code: "allocation_may_be_pending" }), JARGON);
  assert.equal(plainDataNote({ code: "something_new", message: "Server text." }), "Server text.");
});

test("the lowered-certainty note says why in plain words", () => {
  const msg = "21% of order lines in this run were excluded for a missing date or product identity, so confidence was lowered one level.";
  assert.equal(
    plainDataNote({ code: "confidence_lowered", message: msg }),
    "21% of order lines had no date or no vaccine and were left out, so this estimate is less sure."
  );
});
