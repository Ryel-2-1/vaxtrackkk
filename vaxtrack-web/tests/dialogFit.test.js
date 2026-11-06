import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every floating window fits the screen, so no dialog's buttons are ever out of
// reach. A dialog taller than the screen could only be used by zooming out.

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("every dialog is limited to the screen height, by one shared rule", () => {
  const css = read("styles/dialog-fit.css");
  assert.match(css, /\[role="dialog"\]:not\(\.mdl-drawer, \.geo3-drawer, \.rq-cart-drawer\),\s*\[role="alertdialog"\] \{/);
  assert.match(css, /max-height: calc\(100dvh - 32px\) !important;/);
  assert.match(read("main.jsx"), /import "\.\/styles\/dialog-fit\.css";/);
});

test("a dialog without its own overflow scrolls; one with a pinned footer keeps its own", () => {
  // :where() has no specificity, so any explicit overflow on a dialog wins.
  assert.match(read("styles/dialog-fit.css"), /:where\(\[role="dialog"\], \[role="alertdialog"\]\) \{\s*overflow-y: auto;/);
});

test("the map inside Register Clinic never traps the mouse wheel", () => {
  assert.match(read("pages/admin/ClinicLocationSection.jsx"), /scrollWheelZoom: false/);
});
