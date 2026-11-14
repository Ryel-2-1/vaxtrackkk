import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  floatingEnabled,
  movedPosition,
  pointerZone,
  resizedSize,
  HANDLE_BAND_PX,
  MIN_HEIGHT_PX,
  MIN_WIDTH_PX,
} from "../src/components/ui/floatingWindowModel.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const rect = { left: 100, top: 50, right: 800, bottom: 650, width: 700, height: 600 };
const viewport = { width: 1366, height: 850 };

// Movable, resizable windows (2026-11-14).

test("windows move and resize on screens 640px and wider, not on phones", () => {
  assert.equal(floatingEnabled(1366), true);
  assert.equal(floatingEnabled(640), true);
  assert.equal(floatingEnabled(375), false);
  assert.equal(floatingEnabled(undefined), false);
});

test("the title band moves, the bottom-right corner resizes, controls keep their own behaviour", () => {
  assert.equal(pointerZone({ x: 400, y: 60, rect, interactive: false }), "move");
  assert.equal(pointerZone({ x: 400, y: 50 + HANDLE_BAND_PX + 1, rect, interactive: false }), null, "below the band");
  assert.equal(pointerZone({ x: 400, y: 60, rect, interactive: true }), null, "a button or field in the band");
  assert.equal(pointerZone({ x: 795, y: 645, rect, interactive: false }), "resize");
  assert.equal(pointerZone({ x: 795, y: 645, rect, interactive: true }), "resize", "the corner always resizes");
  assert.equal(pointerZone({ x: 50, y: 60, rect, interactive: false }), null, "outside the window");
});

test("a moved window keeps its title band reachable", () => {
  const start = { left: 100, top: 50, width: 700, height: 600 };
  assert.deepEqual(movedPosition({ start, dx: 200, dy: 100, viewport }), { left: 300, top: 150 });
  assert.equal(movedPosition({ start, dx: 0, dy: -500, viewport }).top, 0, "never above the screen");
  assert.equal(movedPosition({ start, dx: 0, dy: 5000, viewport }).top, viewport.height - start.height, "bottom edge stays on screen");
  assert.equal(movedPosition({ start, dx: 5000, dy: 0, viewport }).left, viewport.width - start.width, "right edge stays on screen");
  assert.equal(movedPosition({ start, dx: -5000, dy: 0, viewport }).left, 0, "left edge stays on screen");
  // A window nearly as tall as the screen cannot be pushed so its buttons drop off the bottom.
  const tall = { left: 333, top: 16, width: 700, height: 818 };
  assert.equal(movedPosition({ start: tall, dx: 200, dy: 80, viewport }).top, viewport.height - 818);
});

test("a resized window stays between the minimum and the screen edge", () => {
  const start = { left: 100, top: 50, width: 700, height: 600 };
  assert.deepEqual(resizedSize({ start, dx: 100, dy: 50, viewport }), { width: 800, height: 650 });
  assert.deepEqual(resizedSize({ start, dx: -2000, dy: -2000, viewport }), { width: MIN_WIDTH_PX, height: MIN_HEIGHT_PX });
  const big = resizedSize({ start, dx: 5000, dy: 5000, viewport });
  assert.equal(big.width, viewport.width - start.left - 8);
  assert.equal(big.height, viewport.height - start.top - 8);
});

test("every modal window gets it, from one app-wide watcher; drawers are left alone", () => {
  const mod = read("src/components/ui/floatingWindow.js");
  assert.ok(mod.includes(`const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';`));
  assert.ok(mod.includes(`const SKIP_SELECTOR = ".mdl-drawer, .geo3-drawer, .rq-cart-drawer";`), "drawers are left alone");
  assert.ok(read("src/main.jsx").includes("installFloatingWindows();"));
  // A drag that ends over the backdrop must not close the window.
  assert.ok(mod.includes(`dialog.addEventListener("click", onClickCapture, true);`));
  const css = read("src/styles/dialog-fit.css");
  assert.match(css, /\.vt-float \[data-vt-footer\] \{\s*position: sticky;\s*bottom: 0;/, "buttons pinned at the bottom");
  // The footer is found inside a wrapping <form>, never the whole form.
  assert.ok(mod.includes(`const FIELDS = "input:not([type='hidden']), select, textarea, .leaflet-container, table";`));
  assert.ok(css.includes(`.vt-float[data-vt-zone="resize"] { cursor: nwse-resize; }`));
});

test("Med Rep confirmation windows render over the whole screen, not inside the page", () => {
  const reschedule = read("src/components/orders/MedRepRescheduleAction.jsx");
  assert.match(reschedule, /<DialogLayer scope="salesrep-page salesrep-main">\s*<ConfirmDialog/);
  const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.match(tracking, /<DialogLayer scope="salesrep-page salesrep-main">\s*<ConfirmDialog\s+title=\{pendingDecision === "approve"/);
});

test("on phones every window fits the screen, pins its buttons and avoids page zoom", () => {
  const css = read("src/styles/dialog-fit.css");
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /:has\(> \.vt-float:not\(\.mdl-drawer, \.geo3-drawer, \.rq-cart-drawer\)\) \{\s*padding-left: 8px !important;/);
  assert.match(css, /width: calc\(100vw - 16px\) !important;/);
  assert.match(css, /padding-bottom: max\(12px, env\(safe-area-inset-bottom\)\);/);
  assert.match(css, /\.vt-float\.vt-float\.vt-float \[data-vt-footer\] button \{\s*flex: 1 1 auto;\s*min-height: 44px !important;/);
  assert.match(css, /\.vt-float\.vt-float\.vt-float textarea \{\s*font-size: 16px !important;/);
  // Move/resize switch off when a screen narrows to phone size.
  assert.ok(read("src/components/ui/floatingWindow.js").includes("if (!floatingEnabled(window.innerWidth)) {\n      resetPlacement();"));
});
