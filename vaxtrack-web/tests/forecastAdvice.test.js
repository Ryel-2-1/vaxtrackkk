import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastAdvice, forecastViewCounts, shortDay } from "../src/services/inventoryAnalytics.js";

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
