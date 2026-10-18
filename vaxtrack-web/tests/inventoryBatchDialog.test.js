// Admin Inventory batch-details dialog: portaled to <body>, fixed to and
// centred in the VIEWPORT, body scrolls (and starts at the top), page scroll
// locked and restored exactly, stacked Correct-stock dialog.
//
// The screenshot bug: the dialog was rendered inside the Admin <main>, which
// keeps `transform: translateY(0)` after its entrance animation
// (shell-transitions.css, fill-mode `both`). A transformed ancestor is the
// containing block for `position: fixed`, so the "fixed" backdrop covered the
// whole long page and centred the dialog in it: opened after scrolling down,
// the dialog sat low and ran off the bottom of the screen.
//
// Two layers (this suite has no DOM renderer):
//   1. BEHAVIOUR of the shared dialog stack and page lock (useDialogFocus's
//      enterDialog / leaveDialog / isTopDialog) against stub window/document.
//   2. Source and stylesheet CONTRACTS for the portal, the viewport geometry,
//      the scroll reset and the Inventory wiring. Layout itself was verified
//      in a real browser at 1920×1080, 1366×768, 1280×600 and 390×844.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enterDialog, leaveDialog, isTopDialog } from "../src/components/ui/useDialogFocus.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const rule = (css, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};

const DIALOG = read("src/pages/admin/InventoryBatchDialog.jsx");
const LAYER = read("src/components/ui/DialogLayer.jsx");
const LAYER_CSS = read("src/components/ui/DialogLayer.css");
const PAGE = read("src/pages/admin/Inventory.jsx");
const CSS = read("src/pages/admin/Inventory.css");
const HOOK = read("src/components/ui/useDialogFocus.js");

// ------------------------------------------------------------ behaviour: page lock + dialog stack

/** A stub page scrolled to `y`, recording every scrollTo. */
function installPage({ x = 0, y = 2018, bodyOverflow = "", rootOverflow = "" } = {}) {
  const scrollCalls = [];
  const win = {
    scrollX: x,
    scrollY: y,
    scrollTo(opts) {
      scrollCalls.push(opts);
      win.scrollX = opts.left;
      win.scrollY = opts.top;
    },
  };
  const doc = {
    body: { style: { overflow: bodyOverflow } },
    documentElement: { style: { overflow: rootOverflow } },
  };
  globalThis.window = win;
  globalThis.document = doc;
  return { win, doc, scrollCalls };
}
afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

test("opening locks <html> and <body> without moving the page; closing restores the exact position and styles", () => {
  const { win, doc, scrollCalls } = installPage({ y: 2018, bodyOverflow: "auto", rootOverflow: "" });
  const batch = {};
  enterDialog(batch);
  assert.equal(doc.documentElement.style.overflow, "hidden");
  assert.equal(doc.body.style.overflow, "hidden");
  assert.deepEqual(scrollCalls, [], "opening never scrolls the page");
  assert.equal(win.scrollY, 2018);

  // Anything that moves the page while the dialog is open (focus, layout) is undone on close.
  win.scrollY = 776;
  leaveDialog(batch);
  assert.equal(doc.body.style.overflow, "auto", "previous inline value, not a blank");
  assert.equal(doc.documentElement.style.overflow, "");
  assert.deepEqual(scrollCalls, [{ left: 0, top: 2018, behavior: "instant" }]);
  assert.equal(win.scrollY, 2018, "back at the exact original scroll position");
});

test("a stacked dialog never unlocks the page early; the last one out restores it", () => {
  const { win, doc, scrollCalls } = installPage({ y: 894 });
  const batch = {};
  const correct = {};
  enterDialog(batch);
  enterDialog(correct);
  assert.equal(isTopDialog(correct), true, "Escape belongs to the top dialog");
  assert.equal(isTopDialog(batch), false, "the batch dialog ignores keys while covered");

  leaveDialog(correct);
  assert.equal(doc.documentElement.style.overflow, "hidden", "still locked under the batch dialog");
  assert.equal(doc.body.style.overflow, "hidden");
  assert.deepEqual(scrollCalls, []);
  assert.equal(isTopDialog(batch), true, "keys return to the batch dialog");

  leaveDialog(batch);
  assert.equal(doc.documentElement.style.overflow, "");
  assert.equal(doc.body.style.overflow, "");
  assert.deepEqual(scrollCalls, [{ left: 0, top: 894, behavior: "instant" }]);
  assert.equal(win.scrollY, 894);
});

test("the lock captures the page as it was BEFORE the first dialog, whatever order dialogs close in", () => {
  const { doc, scrollCalls } = installPage({ y: 1076 });
  const a = {};
  const b = {};
  enterDialog(a);
  enterDialog(b); // must not re-capture "hidden" as the previous value
  leaveDialog(a); // out of order
  assert.equal(doc.body.style.overflow, "hidden");
  leaveDialog(b);
  assert.equal(doc.body.style.overflow, "");
  assert.equal(doc.documentElement.style.overflow, "");
  leaveDialog(b); // a repeated cleanup is harmless
  assert.deepEqual(scrollCalls, [{ left: 0, top: 1076, behavior: "instant" }]);
});

test("reopening at a different scroll position locks and restores THAT position", () => {
  const { win, scrollCalls } = installPage({ y: 498 });
  const first = {};
  enterDialog(first);
  leaveDialog(first);
  win.scrollY = 2020;
  const second = {};
  enterDialog(second);
  leaveDialog(second);
  assert.deepEqual(scrollCalls.map((c) => c.top), [498, 2020]);
});

// ------------------------------------------------------------ contracts: portal + viewport

test("the batch dialog is portaled to document.body on a box-less scoped layer", () => {
  assert.match(LAYER, /import \{ createPortal \} from "react-dom";/);
  assert.match(LAYER, /createPortal\(\s*<div className=\{`vt-dialog-layer \$\{scope\}`\.trim\(\)\}>\{children\}<\/div>,\s*document\.body\s*\)/);
  // No box: the scope classes bring their descendant styles but never their
  // layout, and the layer can never be a containing block or stacking context.
  assert.match(LAYER_CSS, /body > \.vt-dialog-layer \{\s*display: contents !important;\s*\}/);

  assert.match(DIALOG, /import DialogLayer from "\.\.\/\.\.\/components\/ui\/DialogLayer";/);
  assert.match(DIALOG, /export const INVENTORY_DIALOG_SCOPE = "inventory-page adl-root";/);
  // Both Inventory dialogs render ONLY through the layer.
  const roots = DIALOG.match(/return \(\s*<(\w+)/g).map((m) => m.replace(/return \(\s*</, ""));
  assert.deepEqual(roots, ["DialogLayer", "DialogLayer"]);
  assert.equal((DIALOG.match(/<DialogLayer scope=\{INVENTORY_DIALOG_SCOPE\}>/g) || []).length, 2);
});

test("why the portal is required: the Admin <main> keeps a transform after its entrance animation", () => {
  // If this ever stops being true the portal is still correct; while it is
  // true, any overlay rendered inside <main> is positioned against <main>.
  const transitions = read("src/styles/shell-transitions.css");
  assert.match(transitions, /\.inventory-page > main \{\s*animation: routeViewIn 0\.26s ease both;/);
  assert.match(transitions, /transform: translateY\(0\);/);
  // The Inventory page itself renders no viewport overlay of its own for the batch or correction dialogs.
  assert.doesNotMatch(PAGE, /\{correcting && \(\s*<div className="v2-inventory-modal-backdrop"/);
  assert.doesNotMatch(PAGE, /\{(selectedVaccine|drawerItem) && \(\s*<div className="v2-inventory-modal-backdrop"/);
});

test("the backdrop is viewport-fixed and centres the dialog with the viewport's grid", () => {
  const backdrop = rule(CSS, ".v2-inventory-modal-backdrop");
  assert.match(backdrop, /position:\s*fixed/);
  assert.match(backdrop, /inset:\s*0/);
  assert.match(backdrop, /display:\s*grid/);
  assert.match(backdrop, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(backdrop, /place-items:\s*center/);
  assert.match(backdrop, /z-index:\s*90/, "above the sidebar (70) and top bar (25) once it is no longer trapped in <main>");
  assert.match(rule(CSS, ".v2-inventory-modal-backdrop.inv-batch-backdrop"), /padding:\s*16px/);
  assert.match(DIALOG, /<div className="v2-inventory-modal-backdrop inv-batch-backdrop">/);
});

test("the dialog is sized from the viewport only — no page height, no document-relative offsets", () => {
  const modal = rule(CSS, ".v2-inventory-modal.inv-batch-modal");
  assert.match(modal, /width:\s*min\(760px, calc\(100vw - 32px\)\)/);
  assert.match(modal, /max-width:\s*none/);
  assert.match(modal, /max-height:\s*calc\(100vh - 32px\);\s*max-height:\s*calc\(100dvh - 32px\)/);
  assert.match(modal, /margin:\s*0/);
  assert.match(modal, /display:\s*flex/);
  assert.match(modal, /flex-direction:\s*column/);
  assert.match(modal, /overflow:\s*hidden/, "one scroller: the body");
  for (const r of [modal, rule(CSS, ".v2-inventory-modal")]) {
    assert.doesNotMatch(r, /(^|[^-])top:|transform:|translate/, "no vertical offset or transform");
  }
  const body = rule(CSS, ".inv-batch-body");
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overscroll-behavior:\s*contain/);
  assert.match(rule(CSS, ".inv-batch-head"), /flex:\s*none/);
  assert.match(rule(CSS, ".inv-batch-foot"), /flex:\s*none/);
  // Long order numbers wrap, so a phone needs no horizontal scrollbar.
  assert.match(CSS, /\.inv-batch-body \.inv-prov-table th,\s*\.inv-batch-body \.inv-prov-table td \{\s*overflow-wrap: anywhere;/);
  // The stacked Correct-stock dialog fits a phone too.
  assert.match(rule(CSS, ".inv-price-modal"), /max-width:\s*min\(440px, 100%\)/);
});

test("the body starts at the top on every open and whenever the batch changes", () => {
  assert.match(DIALOG, /const bodyRef = useRef\(null\);/);
  assert.match(DIALOG, /useLayoutEffect\(\(\) => \{\s*if \(bodyRef\.current\) bodyRef\.current\.scrollTop = 0;\s*\}, \[resetKey\]\);/);
  assert.match(DIALOG, /<div ref=\{bodyRef\} className="inv-batch-body" tabIndex=\{0\} aria-label="Batch details">/);
  assert.match(PAGE, /\{drawerItem && \(\s*<InventoryBatchDialog\s*resetKey=\{drawerItem\.id\}/);
});

test("dialog semantics, close button and Escape are unchanged", () => {
  assert.match(DIALOG, /role="dialog"/);
  assert.match(DIALOG, /aria-modal="true"/);
  assert.match(DIALOG, /aria-labelledby=\{titleId\}/);
  assert.match(DIALOG, /useDialogFocus\(\{ dialogRef, initialRef: closeRef, onDismiss: onClose \}\);/);
  const head = DIALOG.slice(DIALOG.indexOf('<header className="inv-batch-head">'), DIALOG.indexOf("</header>"));
  assert.match(head, /ref=\{closeRef\}/);
  assert.match(head, /aria-label="Close batch details"/);
  assert.match(PAGE, /onClose=\{\(\) => setSelectedVaccine\(null\)\}/);
  // The batch dialog has no backdrop-click close (it never had one); the stacked one keeps its own.
  assert.doesNotMatch(DIALOG.slice(0, DIALOG.indexOf("export function InventoryStackedDialog")), /backdrop[^>]*onClick/);
});

test("the shared hook: one lock for the stack, focus that never scrolls, Escape for the top dialog only", () => {
  assert.match(HOOK, /export function enterDialog\(token\) \{\s*if \(openDialogs\.length === 0\) lockPage\(\);\s*openDialogs\.push\(token\);/);
  assert.match(HOOK, /if \(openDialogs\.length === 0\) unlockPage\(\);/);
  assert.match(HOOK, /window\.scrollTo\(\{ left: x, top: y, behavior: "instant" \}\);/);
  // Lock before focusing, and focus without scrolling the page to the element.
  assert.match(HOOK, /enterDialog\(token\);\s*const first = [^\n]*\n\s*focusQuietly\(first\);/);
  assert.match(HOOK, /const focusQuietly = \(el\) => el\?\.focus\?\.\(\{ preventScroll: true \}\);/);
  assert.doesNotMatch(HOOK, /\.focus\(\)/, "every focus call is preventScroll");
  const cleanup = HOOK.slice(HOOK.indexOf("return () => {"));
  assert.match(cleanup, /leaveDialog\(token\);/);
  assert.match(cleanup, /focusQuietly\(opener\)/, "focus returns to the opener");
  assert.match(HOOK, /if \(!isTopDialog\(token\)\) return;/);
  assert.match(HOOK, /dialogKeyAction\(\{ key: event\.key, busy: busyRef\.current, dismissible \}\)/);
});

test("Correct stock stacks ABOVE the batch dialog in the same dialog stack", () => {
  const open = /const openCorrectDialog = \([^)]*\) => \{([\s\S]*?)\n {2}\};/.exec(PAGE);
  assert.ok(open, "openCorrectDialog");
  assert.doesNotMatch(open[1], /setSelectedVaccine\(null\)/, "the batch dialog stays open underneath");
  assert.match(PAGE, /onClick=\{\(\) => openCorrectDialog\(drawerItem\)\}/);
  assert.match(PAGE, /<InventoryStackedDialog\s*labelledBy="inv-correct-title"\s*onClose=\{closeCorrectDialog\}\s*busy=\{savingCorrection\}\s*className="inv-price-modal"\s*>/);
  // Portaled after the batch dialog, so it paints above it; joins the same stack.
  const stacked = DIALOG.slice(DIALOG.indexOf("export function InventoryStackedDialog"));
  assert.match(stacked, /useDialogFocus\(\{ dialogRef, onDismiss: onClose, busy \}\);/);
  assert.match(stacked, /<div className="v2-inventory-modal-backdrop" onClick=\{onClose\}>/);
  assert.match(stacked, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(stacked, /role="dialog"/);
  // The batch dialog shows the live row, so a correction made over it is reflected at once.
  assert.doesNotMatch(PAGE.slice(PAGE.indexOf("<InventoryBatchDialog"), PAGE.indexOf("</InventoryBatchDialog>")), /selectedVaccine\./);
  assert.match(PAGE, /<ReservationProvenance key=\{drawerItem\.id\} inventoryId=\{drawerItem\.id\} \/>/);
});
