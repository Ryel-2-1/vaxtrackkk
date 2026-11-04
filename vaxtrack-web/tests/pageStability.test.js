import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Nothing moves when something is opened or hovered. Hover changes colour or
// shadow only: a card that lifts can slide out from under the cursor, drop back
// and lift again, which reads as the page shaking.

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const hoverLifts = (css) => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  for (const m of clean.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) {
    if (/transform:\s*translateY\(-[12]px\)/.test(m[2]) && !/nav a|logout|::after|google-button|map-controls/.test(m[1])) {
      found.push(m[1].trim().replace(/\s+/g, " ").slice(0, 60));
    }
  }
  return found;
};

test("no panel, card or button lifts on hover", () => {
  for (const f of ["styles.css", "pages/admin/Deliveries.css", "pages/salesRep/SalesRep.css", "pages/dispatcher/Dispatcher.css"]) {
    assert.deepEqual(hoverLifts(read(f)), [], f);
  }
});

test("a page fades in without moving", () => {
  const css = read("styles/shell-transitions.css");
  const frames = /@keyframes routeViewIn \{[\s\S]*?\n\}/.exec(css)[0];
  assert.match(frames, /opacity: 0/);
  assert.equal(/transform/.test(frames), false);
});
