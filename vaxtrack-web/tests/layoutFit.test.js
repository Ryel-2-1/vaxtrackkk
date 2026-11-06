// Layout fit pass (2026-10-22): source contracts for the shared layout causes
// and the dialog placement fixes found by measuring every role's screens at
// 1440 / 1280×720 / 768 / 375 px. No DOM renderer is installed in this repo, so
// these pin the rules that caused the measured overflow, not pixels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("global table sizing no longer overrides component tables", () => {
  const css = read("src/styles.css");
  // The bare !important th/td rules forced 16px cells and 18px padding on every
  // classed table; they now reach only tables with no class of their own.
  assert.equal(/^td \{\n {2}font-size: 16px !important;/m.test(css), false);
  assert.equal(/^th,\ntd \{\n {2}padding: 18px 16px !important;/m.test(css), false);
  assert.match(css, /table:not\(\[class\]\) td \{\n {2}font-size: 16px !important;/);
  // Cells inherit their table's size instead of a fixed 15px.
  assert.match(css, /td \{\n {2}font-size: inherit;/);
});

test("no page column is sized from a sidebar that is off-canvas on small screens", () => {
  for (const f of ["src/styles.css", "src/pages/salesRep/SalesRep.css"]) {
    const css = read(f);
    assert.equal(/width: calc\(100vw - (230|250|280)px\) !important/.test(css), false, `${f} still sizes a page from a fixed sidebar width`);
  }
});

test("Med Rep dialogs inside the transformed route view are portaled to the viewport", () => {
  for (const f of ["src/pages/salesRep/SalesRepAlerts.jsx", "src/pages/salesRep/SalesRepPlaceOrder.jsx"]) {
    const src = read(f);
    assert.match(src, /import DialogLayer from "\.\.\/\.\.\/components\/ui\/DialogLayer";/, f);
    assert.match(src, /<DialogLayer scope="salesrep-page salesrep-main">/, f);
  }
  const alerts = read("src/pages/salesRep/SalesRepAlerts.jsx");
  assert.match(alerts, /useDialogFocus\(\{ dialogRef, onDismiss: onClose \}\)/);
  assert.match(alerts, /role="dialog"/);
  assert.match(alerts, /aria-label="Close details"/);
});

test("Admin detail dialogs are real modals with shared focus handling", () => {
  for (const f of ["src/pages/admin/Riders.jsx", "src/pages/admin/Deliveries.jsx", "src/pages/admin/Clinics.jsx"]) {
    const src = read(f);
    assert.match(src, /import \{ useDialogFocus \} from "\.\.\/\.\.\/components\/ui\/useDialogFocus";/, f);
    assert.match(src, /aria-modal="true"/, f);
  }
});

test("the Med Rep vaccine catalog is a compact table with every field kept", () => {
  const src = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
  assert.match(src, /<table className="rq-table">/);
  assert.equal(src.includes("rq-view-switch"), false);
  // Still shown on each row: name, batch, type, status, VAT, stock, price, quantity, action.
  for (const piece of ["{product.name}", "Batch: {product.sku}", "{product.category}", "{product.vatLabel}", "Availability", "Unit price", "changeQuantity(", 'addToCart(product, "immediate")']) {
    assert.ok(src.includes(piece), `the row keeps ${piece}`);
  }
  // Blocked batches stay visible with a reason tied to the disabled action.
  assert.match(src, /className="rq-table-reason" id=\{`rq-table-reason-\$\{product\.inventoryId\}`\}/);
  // The ordinary action is disabled for a typed quantity above live stock;
  // a separate, explicit action preserves future ordering.
  assert.match(src, /disabled=\{!product\.orderable \|\| review\.kind !== "immediate"\}/);
  assert.match(src, /review\.kind === "future" && \(/);
  assert.match(src, /type="number"[\s\S]*?min="1"/);
  // One compact stock line: "7 on hand · 7 reserved or held".
  assert.match(src, /`\$\{product\.onHand \?\? 0\} on hand · \$\{Math\.max\(\(product\.onHand \?\? 0\) - product\.available, 0\)\} reserved or held`/);
  assert.match(src, /aria-describedby=\{!product\.orderable \? `rq-table-reason-\$\{product\.inventoryId\}` : review\.kind !== "immediate" \? quantityNoteId : undefined\}/);
  // The price convention is said once for the list.
  assert.match(src, /className="rq-price-convention">Unit prices are per vial · VAT-inclusive for VATable products\./);
  const css = read("src/pages/salesRep/salesrep-polish.css");
  assert.match(css, /\.salesrep-page \.rq-table-wrap \{[\s\S]*?overflow-x: auto;/);
  assert.match(css, /\.salesrep-page \.rq-table \{[\s\S]*?table-layout: fixed;/);
});

test("Request Order: the cart sits beside the catalog on wide screens and opens as a portaled drawer below", () => {
  const src = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
  const css = read("src/pages/salesRep/salesrep-polish.css");
  const cartCss = css.slice(css.indexOf("Request Order: catalog + Quick Cart layout"));

  // One breakpoint, shared by the component (it closes the drawer once the
  // side cart appears) and the stylesheet (side column vs. "View cart").
  const min = Number(src.match(/const CART_SIDE_MIN_WIDTH = (\d+);/)?.[1]);
  assert.ok(min > 0, "CART_SIDE_MIN_WIDTH is declared");
  assert.match(src, /window\.matchMedia\(`\(min-width: \$\{CART_SIDE_MIN_WIDTH\}px\)`\)/);
  const wide = cartCss.slice(cartCss.indexOf(`@media (min-width: ${min}px) {`));
  assert.ok(wide.length < cartCss.length, `a (min-width: ${min}px) block exists`);
  assert.match(wide, /grid-template-columns: minmax\(0, 1fr\) 312px !important;/);
  const narrow = cartCss.slice(cartCss.indexOf(`@media (max-width: ${min - 1}px) {`));
  assert.ok(narrow.length < cartCss.length, `a (max-width: ${min - 1}px) block exists`);
  assert.match(narrow, /aside\.rq-cart-side \{\n {4}display: none !important;/);

  // Wide: a sticky side cart; an empty cart is only as tall as it needs, a
  // full one scrolls its lines while totals and checkout stay in view.
  assert.match(src, /<aside className="quick-cart request-v2-cart rq-cart-side" aria-labelledby="rq-cart-title">/);
  assert.match(wide, /aside\.rq-cart-side \{\n(?: {4}\/\*.*\*\/\n)? {4}width: 100% !important;\n {4}max-width: none !important;\n {4}position: sticky !important;/);
  assert.match(wide, /aside\.rq-cart-side \.request-v2-cart-items \{\n {4}flex: 1 1 auto !important;\n {4}min-height: 0 !important;\n {4}max-height: none !important;/);
  // Sticky works only if no ancestor is a (never-scrolling) scroll container.
  assert.match(css, /#root > \.salesrep-page \{\n {2}overflow-x: clip !important;\n {2}overflow-y: visible !important;/);

  // Narrow: a persistent control with the live line count, portaled out of the
  // transformed route view so position: fixed is relative to the viewport...
  assert.match(src, /<DialogLayer scope="salesrep-page salesrep-main">[\s\S]*?className="rq-cart-toggle"\s*onClick=\{\(\) => setCartOpen\(true\)\}\s*aria-haspopup="dialog"\s*aria-expanded=\{cartOpen\}[\s\S]*?View cart \(\{cart\.length\}\)/);
  // Tablet / small laptop: the control sits in a sticky toolbar in the
  // catalog's flow (it never floats over a row); the floating one is phone-only.
  assert.match(src, /<div className="rq-cart-bar">\s*<button\s*type="button"\s*className="rq-cart-bar-btn"\s*onClick=\{\(\) => setCartOpen\(true\)\}\s*aria-haspopup="dialog"\s*aria-expanded=\{cartOpen\}/);
  const tablet = cartCss.slice(cartCss.indexOf("@media (min-width: 769px) and (max-width: 1100px) {"));
  assert.ok(tablet.length < cartCss.length, "a 769–1100px block exists");
  assert.match(tablet, /^@media[^\n]*\n[^@]*\.salesrep-page \.rq-cart-toggle \{\n {4}display: none !important;/);
  assert.match(tablet, /^@media[^\n]*\n[^@]*\.salesrep-page \.rq-cart-bar \{\n {4}position: sticky;/);
  const phoneCart = cartCss.slice(cartCss.indexOf("/* Phones: a floating control above the bottom navigation bar. */"));
  assert.match(phoneCart, /@media \(max-width: 768px\) \{[^@]*\.request-catalog \{\n {4}padding-bottom: 72px;[^@]*\.rq-cart-toggle \{\n {4}position: fixed;/);
  // ...and kept above the Med Rep bottom bar, never on it.
  assert.match(cartCss, /@media \(max-width: 768px\) \{\n {2}\/\* Above the bottom navigation bar, never on top of it\. \*\/\n {2}\.salesrep-page \.rq-cart-toggle \{\n {4}bottom: calc\(64px \+ 12px \+ env\(safe-area-inset-bottom, 0px\)\);/);

  // The drawer is a real modal: portaled, labelled by its heading, focus moved
  // in and trapped, Escape and an explicit Close dismiss it, focus returns.
  assert.match(src, /\{cartOpen && \(\s*<DialogLayer scope="salesrep-page salesrep-main">\s*<CartDrawer onClose=\{\(\) => setCartOpen\(false\)\}>\s*<QuickCartPanel headingId="rq-cart-drawer-title"/);
  const drawer = src.slice(src.indexOf("function CartDrawer("));
  assert.match(drawer, /useDialogFocus\(\{ dialogRef: drawerRef, onDismiss: onClose \}\)/);
  assert.match(drawer, /role="dialog"\s*aria-modal="true"\s*aria-labelledby="rq-cart-drawer-title"/);
  assert.match(drawer, /className="rq-cart-close" onClick=\{onClose\} aria-label="Close cart"/);
  // Over the whole viewport, above the bottom bar (1000) and the toggle (1001).
  assert.match(cartCss, /\.salesrep-page \.rq-cart-backdrop \{\n {2}position: fixed;\n {2}inset: 0;\n {2}z-index: 1300;/);

  // Both placements render the same panel, so they cannot drift apart.
  assert.equal(src.match(/<QuickCartPanel /g).length, 2);
  const panel = src.slice(src.indexOf("function QuickCartPanel("), src.indexOf("function CartDrawer("));
  assert.match(panel, /aria-label=\{`Remove \$\{item\.name\} \(batch \$\{item\.sku\}\) from the cart`\}/);
  assert.match(panel, /disabled=\{cartLines\.length === 0 \|\| hasBlockedCartLine\}/);
  // Removing a line by keyboard keeps focus in the cart: the next line's
  // Remove button, else the previous one, else the cart heading.
  assert.match(panel, /const next = buttons\[at \+ 1\] \|\| buttons\[at - 1\] \|\| panel\?\.querySelector\(`#\$\{headingId\}`\);\n {4}next\?\.focus\(\{ preventScroll: true \}\);\n {4}removeFromCart\(inventoryId\);/);
  assert.match(panel, /<h2 id=\{headingId\} tabIndex=\{-1\}>Quick Cart<\/h2>/);
});

test("Request Order: messages never push the vaccine list down", () => {
  const src = read("src/pages/salesRep/SalesRepRequestOrder.jsx");
  // No banner in the catalog's flow above the list (the first add moved every
  // row ~58px); an always-mounted, portaled status region instead.
  const catalog = src.slice(src.indexOf('<div className="request-catalog">'), src.indexOf('<div ref={catalogTableRef} className="rq-table-wrap"'));
  assert.ok(catalog.length > 0);
  assert.equal(catalog.includes("request-v2-notice"), false);
  assert.match(src, /<div className="rq-notice-region" role="status" aria-live="polite">\s*\{notice && \(/);
  assert.match(src, /aria-label="Dismiss message"/);
  // Add confirmations fade on their own; anything needing action stays.
  assert.match(src, /\{ transient: true \}/);
  assert.match(read("src/pages/salesRep/salesrep-polish.css"), /\.salesrep-page \.rq-notice-region \{\n {2}position: fixed;/);
});

test("the Med Rep sidebar is a bottom bar on small screens, not a column above the page", () => {
  const css = read("src/pages/salesRep/salesrep-polish.css");
  const block = css.slice(css.indexOf("Phone / small-tablet navigation (≤768px)"));
  assert.match(block, /@media \(max-width: 768px\)/);
  assert.match(block, /\.salesrep-page > aside\.salesrep-sidebar \{\n {4}position: fixed !important;/);
  assert.match(block, /\.salesrep-page > aside\.salesrep-sidebar \.salesrep-nav \{\n {4}display: flex !important;\n {4}flex-direction: row !important;/);
  // #root outranks the lazy-loaded `.salesrep-page { padding: 0 !important }`.
  assert.match(block, /#root \.salesrep-page \{\n {4}padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom, 0px\)\) !important;/, "content never sits behind the bar");
});
