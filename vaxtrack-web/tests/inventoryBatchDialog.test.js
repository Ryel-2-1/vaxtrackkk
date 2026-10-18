// Admin Inventory batch-details dialog: viewport-bound, body scrolls,
// background locked and restored.
//
// LIMITATION: this suite has no DOM renderer (no jsdom / testing-library), so
// scrolling, layout and the scroll lock cannot be exercised here. These are
// narrow source and stylesheet contracts on the exact mechanisms the fix
// relies on; the behaviour itself was verified in a real browser at
// 1920×1080, 1366×768, 1280×600 and 390×844.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const rule = (css, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};

const DIALOG = read("src/pages/admin/InventoryBatchDialog.jsx");
const PAGE = read("src/pages/admin/Inventory.jsx");
const CSS = read("src/pages/admin/Inventory.css");
const HOOK = read("src/components/ui/useDialogFocus.js");

test("the batch details render inside the dedicated dialog shell", () => {
  assert.match(PAGE, /import InventoryBatchDialog from "\.\/InventoryBatchDialog";/);
  assert.match(PAGE, /\{selectedVaccine && \(\s*<InventoryBatchDialog/);
  assert.match(PAGE, /onClose=\{\(\) => setSelectedVaccine\(null\)\}/);
  // Every reservation row lives in the scrolling body (children), not the footer.
  const body = PAGE.slice(PAGE.indexOf("<InventoryBatchDialog"), PAGE.indexOf("</InventoryBatchDialog>"));
  assert.match(body, /<ReservationProvenance key=\{selectedVaccine\.id\} inventoryId=\{selectedVaccine\.id\} \/>/);
  assert.match(body, /footer=\{\s*<div className="v2-modal-actions">/);
});

test("the shell: header and footer fixed, a focusable scrolling body, accessible dialog", () => {
  assert.match(DIALOG, /role="dialog"/);
  assert.match(DIALOG, /aria-modal="true"/);
  assert.match(DIALOG, /aria-labelledby=\{titleId\}/);
  assert.match(DIALOG, /<h2 id=\{titleId\}>\{title\}<\/h2>/);
  assert.match(DIALOG, /useDialogFocus\(\{ dialogRef, initialRef: closeRef, onDismiss: onClose \}\);/);
  // Close sits in the header, so it stays visible however far the body scrolls.
  const head = DIALOG.slice(DIALOG.indexOf('<header className="inv-batch-head">'), DIALOG.indexOf("</header>"));
  assert.match(head, /ref=\{closeRef\}/);
  assert.match(head, /aria-label="Close batch details"/);
  // Keyboard users can focus the body and scroll it with arrow keys.
  assert.match(DIALOG, /<div className="inv-batch-body" tabIndex=\{0\} aria-label="Batch details">\s*\{children\}\s*<\/div>/);
  assert.match(DIALOG, /\{footer && <footer className="inv-batch-foot">\{footer\}<\/footer>\}/);
});

test("the dialog is bounded by the viewport (dvh with a vh fallback) and only the body scrolls", () => {
  const modal = rule(CSS, ".v2-inventory-modal.inv-batch-modal");
  assert.ok(modal, "batch modal rule");
  assert.match(modal, /display:\s*flex/);
  assert.match(modal, /flex-direction:\s*column/);
  assert.match(modal, /overflow:\s*hidden/, "no second scrollbar on the dialog itself");

  const base = rule(CSS, ".v2-inventory-modal");
  assert.ok(base, "base modal rule");
  assert.match(base, /max-height:\s*calc\(100vh - 48px\);\s*max-height:\s*calc\(100dvh - 48px\)/);

  const head = rule(CSS, ".inv-batch-head");
  const foot = rule(CSS, ".inv-batch-foot");
  assert.match(head, /flex:\s*none/);
  assert.match(foot, /flex:\s*none/);

  const body = rule(CSS, ".inv-batch-body");
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/, "lets the flex child shrink so it can scroll");
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overscroll-behavior:\s*contain/);
  assert.match(CSS, /\.inv-batch-body:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--green-600\)/);
});

test("narrow screens: the dialog shrinks to the viewport instead of keeping its content width", () => {
  const backdrop = rule(CSS, ".v2-inventory-modal-backdrop");
  assert.ok(backdrop, "backdrop rule");
  // An auto grid track let max-width: 100% resolve to the content width (620px at 390px wide).
  assert.match(backdrop, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 760px)"));
  assert.match(mobile, /calc\(100dvh - 24px\)/);
});

test("the shared dialog hook locks BOTH scrollers and restores their previous values", () => {
  // <html> is this app's page scroller (global overflow-x: hidden makes its
  // overflow-y auto), so a body-only lock left the page scrolling behind
  // every dialog.
  assert.match(HOOK, /const root = document\.documentElement;/);
  assert.match(HOOK, /const prevOverflow = document\.body\.style\.overflow;/);
  assert.match(HOOK, /const prevRootOverflow = root\.style\.overflow;/);
  assert.match(HOOK, /document\.body\.style\.overflow = "hidden";\s*root\.style\.overflow = "hidden";/);
  // Restored in the effect cleanup — runs on close AND on unmount.
  const cleanup = HOOK.slice(HOOK.indexOf("return () => {"));
  assert.match(cleanup, /document\.body\.style\.overflow = prevOverflow;\s*root\.style\.overflow = prevRootOverflow;/);
  // Escape and focus handling are unchanged.
  assert.match(HOOK, /dialogKeyAction\(\{ key: event\.key, busy: busyRef\.current, dismissible \}\)/);
  assert.match(cleanup, /opener\.focus\(\)/);
});

test("the batch dialog never stacks under the stock-correction dialog", () => {
  // Opening "Correct stock" closes the batch dialog, so the two hooks never
  // both hold the scroll lock.
  const open = /const openCorrectDialog = \([^)]*\) => \{([\s\S]*?)\n {2}\};/.exec(PAGE);
  assert.ok(open, "openCorrectDialog");
  assert.match(open[1], /setSelectedVaccine\(null\)/);
});
