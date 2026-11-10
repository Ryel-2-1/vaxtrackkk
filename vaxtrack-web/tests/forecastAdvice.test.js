import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORECAST_STATUS_HELP, forecastAdvice, forecastViewCounts, reorderSummary, shortDay } from "../src/services/inventoryAnalytics.js";

const row = (over = {}) => ({ risk: "unknown", reorderQuantity: null, needsConfiguration: true, insufficient: false, hasCurrentShortage: false, ...over });

test("a high-risk vaccine says how much to order", () => {
  const a = forecastAdvice(row({ risk: "high", reorderQuantity: 3, needsConfiguration: false }));
  assert.deepEqual([a.view, a.status, a.action, a.button], ["attention", "Order now", "Order 3 vials", "See why"]);
  assert.equal(forecastAdvice(row({ risk: "high", reorderQuantity: 1, needsConfiguration: false })).action, "Order 1 vial");
});

test("no quantity is invented: high risk without settings asks for them", () => {
  const a = forecastAdvice(row({ risk: "high", hasCurrentShortage: true }));
  assert.deepEqual([a.action, a.button], ["Add reorder details", "Set up"]);
  assert.match(a.why, /already placed/);
});

test("the other states each give one plain instruction", () => {
  assert.deepEqual(
    [row({ risk: "medium", needsConfiguration: false, reorderQuantity: 0 }), row({ risk: "low", needsConfiguration: false }), row({ insufficient: true }), row()]
      .map((r) => { const a = forecastAdvice(r); return [a.view, a.status, a.action]; }),
    [
      ["attention", "Running low", "Keep an eye on this"],
      ["enough", "Enough stock", "No order needed"],
      ["history", "Not enough history", "Nothing to do yet"],
      ["setup", "Needs setup", "Add reorder details"],
    ]
  );
});

test("the view counts add up to every vaccine", () => {
  const counts = forecastViewCounts([row({ risk: "high" }), row({ risk: "medium" }), row({ risk: "low" }), row(), row({ insufficient: true })]);
  assert.deepEqual(counts, { attention: 2, enough: 1, setup: 1, history: 1, all: 5 });
});

test("shortDay reads in Manila time and leaves anything else alone", () => {
  assert.equal(shortDay("2026-11-01"), "Nov 1");
  assert.equal(shortDay("not a date"), "not a date");
});

test("the help explains every status the list can show, and nothing else", () => {
  const shown = new Set([
    forecastAdvice(row({ risk: "high", needsConfiguration: false })).status,
    forecastAdvice(row({ risk: "medium" })).status,
    forecastAdvice(row({ risk: "low" })).status,
    forecastAdvice(row({ insufficient: true })).status,
    forecastAdvice(row()).status,
  ]);
  assert.deepEqual(new Set(FORECAST_STATUS_HELP.map((h) => h.status)), shown);
  for (const h of FORECAST_STATUS_HELP) assert.ok(h.meaning.length < 160, `${h.status}: one short sentence or two`);
});

test("reorder settings read as one plain line", () => {
  assert.equal(reorderSummary(null), null);
  assert.equal(reorderSummary({ leadTimeDays: null }), null);
  assert.equal(reorderSummary({ leadTimeDays: 14, safetyStockQuantity: 20 }), "Supplier takes 14 days · keep 20 vials in reserve");
  assert.equal(reorderSummary({ leadTimeDays: 1, safetyStockDays: 7 }), "Supplier takes 1 day · keep 7 days of orders in reserve");
  assert.equal(reorderSummary({ leadTimeDays: 5, safetyStockQuantity: 1 }), "Supplier takes 5 days · keep 1 vial in reserve");
  assert.equal(reorderSummary({ leadTimeDays: 5 }), "Supplier takes 5 days · no reserve set");
});

test("the details panel leads with the answer; settings and workings wait to be opened", () => {
  const page = readFileSync(new URL("../src/pages/admin/AiInventoryAnalytics.jsx", import.meta.url), "utf8");
  assert.match(page, /<details className="aia-workings aia-settings" open=\{advice\.view === "setup"\}>/);
  assert.match(page, /<summary>What do these mean\?<\/summary>/);
  assert.doesNotMatch(page, /<dt>Reserved<\/dt>/, "reserved stock lives in the workings, not the headline");
  assert.match(page, /\{row\.hasBackorders && \(/);
});
