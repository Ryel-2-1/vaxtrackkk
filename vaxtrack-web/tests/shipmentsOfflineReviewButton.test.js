import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("Review offline matches Cancel order: a half-width outline button beside it", () => {
  const css = read("src/pages/dispatcher/dispatcher-polish.css");
  const rule = css.slice(css.indexOf(".shp-actions .review-offline {"), css.indexOf("}", css.indexOf(".shp-actions .review-offline {")));
  assert.match(rule, /background: #fff;/);
  assert.doesNotMatch(rule, /grid-column/, "it stays one cell wide");
  const page = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(page, /className="shp-act-btn review-offline"/);
  assert.match(page, />\s*Review offline\s*<\/button>/);
  assert.match(page, /aria-label=\{`Review the offline delivery record for/, "screen readers keep the full meaning");
  assert.equal((page.match(/!offlineReview && /g) ?? []).length, 3, "no empty slot separates the two buttons");
});

test("the status cell keeps one line of explanation, with the rest in the tooltip", () => {
  const src = read("src/components/ui/TimingIndicator.jsx");
  assert.match(src, /detail === "primary" && miss/);
  assert.match(src, /title=\{summary\}/);
});
